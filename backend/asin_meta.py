"""
ASIN 静态属性（上架时间 / 品牌）统一取数入口。

全局属性表：`rmon_asin_meta`（`asin` 主键 / `first_available_day` / `brand` / `fetched_at` / `src`）
—— 上架时间不会变，**每个 ASIN 一辈子只查一次**，查过就永久复用。

取数顺序由下面的开关决定（改这里就行，不用动业务代码）：

    SOURCES = ["sprite"]                 # 只用卖家精灵（当前默认）
    SOURCES = ["sprite", "sif"]          # 卖家精灵优先，SIF 兜底
    SOURCES = ["sif"]                    # 只用 SIF（旧行为）

⚠️ 当前按用户要求 **SIF 通道已停用**（不在 SOURCES 里，因此不会被调用）；
   代码保留 `_fill_sif()`，需要时把 "sif" 加回 SOURCES 即可恢复。
"""

import time

from . import sprite_fetch
from .utils import _log

# ============================================================
# 开关：上架时间取数来源（按顺序尝试，命中即用）
# ============================================================
SOURCES = ["sprite"]

# 想恢复 SIF 兜底时，把下面这行的注释去掉，并把上面那行注释掉：
# SOURCES = ["sprite", "sif"]

# SIF 单次批大小（SIF 的 asin_profile 最多 20 个/次）
SIF_BATCH = 20


def enabled_sources():
    return list(SOURCES)


def get_meta(state, asins):
    """只读：返回 {ASIN: {first_available_day, brand}}（含负缓存里的空值）。"""
    keys = [str(a or "").strip().upper() for a in (asins or []) if str(a or "").strip()]
    if not keys:
        return {}
    return state.get_rmon_asin_meta(keys)


def missing_dates(meta, asins):
    """返回还没有上架时间的 ASIN（保持入参顺序、去重）。"""
    out, seen = [], set()
    for a in asins or []:
        k = str(a or "").strip().upper()
        if not k or k in seen:
            continue
        seen.add(k)
        if not (meta.get(k) or {}).get("first_available_day"):
            out.append(k)
    return out


def ensure(state, asins, country="US", max_new=100):
    """确保这批 ASIN 有上架时间：先读库，缺的按 SOURCES 顺序补。

    返回 {"dates": {asin: 'YYYY-MM-DD'}, "asked": n, "fetched": n, "sources": {...}}
    """
    keys, seen = [], set()
    for a in asins or []:
        k = str(a or "").strip().upper()
        if k and k not in seen:
            seen.add(k)
            keys.append(k)
    if not keys:
        return {"dates": {}, "asked": 0, "fetched": 0, "sources": {}}

    meta = get_meta(state, keys)
    todo = missing_dates(meta, keys)[:max(1, int(max_new))]

    info = {"asked": len(keys), "to_fetch": len(todo), "fetched": 0, "sources": {}}
    if todo:
        for src in enabled_sources():
            if not todo:
                break
            if src == "sprite":
                dates, sinfo = sprite_fetch.fetch_dates(todo, country)
                info["sources"]["sprite"] = sinfo.get("status")
                if dates:
                    _persist(state, dates, "sprite")
                    got = set(dates)
                    todo = [a for a in todo if a not in got]
                    info["fetched"] += len(dates)
            elif src == "sif":
                dates, sinfo = _fill_sif(todo, country)
                info["sources"]["sif"] = sinfo.get("status")
                if dates:
                    _persist(state, dates, "sif")
                    got = set(dates)
                    todo = [a for a in todo if a not in got]
                    info["fetched"] += len(dates)
        # 负缓存：这一轮问过但确实没有的，写空串，避免下次反复问
        if todo:
            state.upsert_rmon_asin_meta([
                {"asin": a, "first_available_day": "", "brand": "", "src": None}
                for a in todo
            ])

    meta = get_meta(state, keys)
    dates = {a: (meta.get(a) or {}).get("first_available_day")
             for a in keys if (meta.get(a) or {}).get("first_available_day")}
    info["dates"] = dates
    info["covered"] = len(dates)
    return info


def _persist(state, dates, src):
    rows = [{"asin": a, "first_available_day": d, "brand": "", "src": src}
            for a, d in dates.items() if d]
    if rows:
        state.upsert_rmon_asin_meta(rows)


# ------------------------------------------------------------
# SIF 通道（当前停用；SOURCES 里加 "sif" 才会被调用）
# ------------------------------------------------------------
def _fill_sif(asins, country="US"):
    """问 SIF 的 asin_profile（≤20 个/批）。保留以便随时恢复兜底。"""
    try:
        from . import sif_fetcher as sf
    except Exception as e:
        return {}, {"status": f"import_failed:{type(e).__name__}"}
    out = {}
    for i in range(0, len(asins), SIF_BATCH):
        chunk = asins[i:i + SIF_BATCH]
        try:
            rows = sf.asin_profiles(chunk, country)
        except Exception as e:
            _log(f"[asin-meta] SIF 批量取档案失败（{len(chunk)} 个）：{e}")
            continue
        for r in rows:
            a = str(r.get("asin") or "").upper()
            d = r.get("first_available_day") or ""
            if a and d:
                out[a] = str(d)[:10]
        time.sleep(0.3)
    return out, {"status": "ok" if out else "empty", "got": len(out)}
