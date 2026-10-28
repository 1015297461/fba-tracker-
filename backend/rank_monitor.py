#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
排名监测：抓取 / 快照 / 变动检测 / 定时调度
================================================
**两条完全独立的链路，数据与调度都分开**：

1) SIF 链路（ABA 周数据，本文件主体）
   两种监测目标（rank_targets.kind）：
     · keyword  一个关键词 → 该词下的竞品份额榜 + 我的卡位
     · asin     一个 ASIN  → 它在各关键词上的自然排名 + ABA 卡位
   注意：SIF 的自然位与份额都是**周期内取值**，同一周内重复抓结果完全一样，
   所以 daily 目标也按「距上次 ≥6 天」调度，避免存七份相同的快照。

2) 前台实测链路（爬虫抓搜索结果页，实现在 search_fetcher.py）
   · rmon_srps       每次抓取的整页榜单（自然位 + 广告位 + 标题/价格）
   · rmon_srp_cfg    每个关键词自己的抓取页数
   · rmon_srp_targets 每天定时抓取的目标
   这部分是**实时数据**，每天都会变，与 SIF 那套不做任何交叉对比。

**三种「排名」口径不同，报告与页面都必须分开标注**：
  · `share_rank`  该词下的流量份额排名（按 total_share 排，1 起）
  · `organic_rank` SIF 观测的自然搜索位（第 N 位，null = 无自然位）
  · `aba_rank`     ABA 买家实际点击的第 1/2/3 位
同一 ASIN 同一个词上「不在份额榜」+「自然第 130 位」+「ABA 没进 top3」可以同时成立。

变动检测只看「和上一次快照比变了什么」，首次抓取不产生事件（没有基准，
否则全是噪音）。规则阈值集中在本文件顶部，改这里就能调灵敏度。
"""

import datetime
import hashlib
import json
import re
import threading
import time

from . import sif_fetcher as sf
from . import search_fetcher as srp
from .utils import _log, _now_iso

# ---------------------------------------------------------------------------
# 变动阈值（调灵敏度只改这里）
# ---------------------------------------------------------------------------

RANK_STEP_ALERT = 10        # ASIN 维度：自然排名变差 ≥10 位报警
SHARE_RANK_STEP = 5         # 词维度：份额排名变化 ≥5 位报警
TOP3_SHARE_STEP = 0.05      # 词维度：Top3 点击份额变化 ≥5pp 报警
TOP_N_KEEP = 100            # 词维度快照存全量前 100（前端分页展示，别在这里截断）

# 两个目标之间的最小间隔（秒）。SIF 有 QPM 40/60秒 限制，
# 批量抓取时串行 + 间隔是防止撞限流最直接的办法。
MAX_EXTRA_ASINS = 10         # 额外指定的 ASIN 上限（每个 +1 次 SIF 调用）
RUN_GAP_SEC = 1.5

LEVEL_ORDER = {"high": 0, "mid": 1, "low": 2}


# ---------------------------------------------------------------------------
# 抓取
# ---------------------------------------------------------------------------

def _now_date() -> str:
    return datetime.date.today().isoformat()


def parse_extra_asins(v) -> list:
    """把「额外指定的 ASIN」统一成大写去重列表。

    库里存的是 JSON 字符串，但也兼容直接传 list 或 "B0..., B0..." 这种手写串
    （前端输入框就是让人手敲的，别指望格式绝对规整）。
    """
    if not v:
        return []
    if isinstance(v, (list, tuple)):
        items = list(v)
    else:
        raw = str(v).strip()
        try:
            obj = json.loads(raw)
            items = obj if isinstance(obj, list) else [obj]
        except Exception:
            items = re.split(r"[,;\s、，；]+", raw)
    out, seen = [], set()
    for a in items:
        a = str(a or "").strip().upper()
        if re.fullmatch(r"[A-Z0-9]{10}", a) and a not in seen:
            seen.add(a)
            out.append(a)
    return out[:MAX_EXTRA_ASINS]


def organic_rank_in_keyword(asin: str, keyword: str, country: str = "US") -> dict:
    """查某 ASIN 在指定关键词上的**自然搜索位**。1 次 SIF 调用。

    份额榜（keyword_competition）只给「份额排名」，不给自然搜索位，
    所以要画自然位趋势必须单独查这个。
    """
    sig = sf.asin_keyword_signals(asin, country, 30, 50)
    hit = next((k for k in (sig.get("top_keywords") or [])
                if (k.get("keyword") or "").strip().lower() == keyword.strip().lower()), None)
    h = hit or {}
    return {
        # 绝对位次（SIF 原始是 "p1,2/48"，已在 sif_fetcher.parse_rank 里换算好）
        "organic_rank": _rank_of(h.get("organic_rank")),
        # 原始是「第几页第几位」，这才是 SIF 前台显示的形态，页面优先展示它
        "organic_page": h.get("organic_page"),
        "organic_pos":  h.get("organic_pos"),
        # 这个值是哪天抓的 —— SIF 的说法是「周期内最后一次抓取值」，
        # 没有它就无法解释「为什么两天数据一样」
        "organic_rank_time": h.get("organic_rank_time"),
        "traffic_share": (hit or {}).get("traffic_share"),
        "natural_ratio": (hit or {}).get("natural_ratio"),
        "search_volume": (hit or {}).get("search_volume"),
        "in_list": bool(hit),
    }


def fetch_keyword(target: dict, on_retry=None, track_organic: int = None) -> dict:
    """关键词维度：份额榜前 100 + 市场结构 + 我的卡位 + **自然位**。

    调用量：1 次份额榜 + (n+1) 次自然位 + 1 次批量档案。
    n = target["competitor_n"]（1~15，默认 10），也决定趋势图画几条线 ——
    **采集数和展示数必须是同一个 n**，否则多出来的线永远是空的。
    """
    kw = target["value"]
    country = target.get("country") or "US"
    own = target.get("own_asin")
    raw = sf.keyword_competition_rank(kw, country, asin=own, top_n=100, on_retry=on_retry)

    top = []
    for c in (raw.get("competitors") or [])[:TOP_N_KEEP]:
        top.append({
            "asin": c.get("asin"),
            "share_rank": c.get("share_rank"),
            "total_share": c.get("total_share"),
            "price": c.get("price"),
            "rating": c.get("rating"),
            "review_count": c.get("review_count"),
            "monthly_orders": c.get("monthly_orders"),
            "organic_share": c.get("organic_share"),
            "sp_share": c.get("sp_share"),
            "brand_share": c.get("brand_share"),
            "video_share": c.get("video_share"),
            "competition_mode": c.get("competition_mode"),
            "listed_age_days": c.get("listed_age_days"),
        })

    ms = raw.get("market_structure") or {}
    conc = raw.get("concentration") or {}
    my = raw.get("my_position") or None

    # 兜底：SIF 的 my_position 有时判 absent（卡位不足），但该 ASIN 其实还在份额榜里。
    if my and my.get("asin") and not my.get("share_rank"):
        hit = next((c for c in top if c.get("asin") == my["asin"]), None)
        if hit:
            my = {**my, "share_rank": hit.get("share_rank"), "in_list": True,
                  "note": "卡位判定为 absent，但该 ASIN 仍在份额榜内"}

    # ---- 自然位采集 ----
    # 份额榜没有自然搜索位这一列，趋势要画「谁的自然位在往上爬」只能逐个查。
    # 只查「我的 ASIN + 份额前 N 名」，控制配额（每个目标 +N 次调用）。
    # 注意：SIF 的自然位是周维度数据，n 调大不会带来更多信息量，只是每次查询多烧配额。
    n = track_organic if track_organic is not None else (target.get("competitor_n") or 10)
    try:
        n = max(0, min(15, int(n)))
    except (TypeError, ValueError):
        n = 10

    # 采集范围 = 我的 ASIN + 份额前 n 名 + 用户额外指定的 ASIN（去重，保持顺序）
    extras = parse_extra_asins(target.get("extra_asins"))
    organic = {}
    organic_detail = {}
    watch = []
    if my and my.get("asin"):
        watch.append(my["asin"])
    for c in top[:n]:
        a = c.get("asin")
        if a and a not in watch:
            watch.append(a)
    for a in extras:
        if a not in watch:
            watch.append(a)
    organic_failed = []
    for a in watch:
        try:
            r = organic_rank_in_keyword(a, kw, country)
            organic[a] = r["organic_rank"]
            organic_detail[a] = {"page": r["organic_page"], "pos": r["organic_pos"],
                                 "at": r["organic_rank_time"]}
            if my and my.get("asin") == a:
                my = {**my, "asin_organic_rank": r["organic_rank"],
                      "asin_organic_page": r["organic_page"],
                      "asin_organic_pos": r["organic_pos"],
                      "asin_organic_at": r["organic_rank_time"],
                      "asin_search_volume": r["search_volume"], "organic_checked": True}
        except Exception as e:
            # 关键：调用失败**不能写 None**。None 的语义是「查了，确实没有自然位」，
            # 失败却写成 None 会让趋势图显示成「自然位消失」，是假数据。
            # 只记进 organic_failed，key 根本不落进 organic。
            _log(f"[rank-monitor] 查自然位失败 {a}/{kw}: {str(e)[:120]}")
            organic_failed.append({"asin": a, "error": str(e)[:160]})
        # QPM 由 sif_fetcher 的全局闸门统一排队，这里不用再 sleep

    # ---- 批量预取档案 ----
    # 悬浮弹窗要主图/标题/价格。用 SIF 的 asin_profiles（≤20 个/批，1 次调用），
    # 不碰产品采集爬虫 —— 那个每个 ASIN 要 3~10 秒还有反爬风险。
    profiles = {}
    try:
        batch = [c["asin"] for c in top[:20] if c.get("asin")]
        if batch:
            for p in sf.asin_profiles(batch, country):
                a = p.get("asin")
                if a:
                    profiles[a] = {
                        "title": p.get("title") or "",
                        "img": p.get("img") or "",
                        "price": p.get("price"),
                        "star": p.get("star"),
                        "rating_num": p.get("rating_num"),
                        "brand": p.get("brand") or "",
                    }
    except Exception as e:
        _log(f"[rank-monitor] 批量取 ASIN 档案失败 {kw}: {e}")

    return {
        "kind": "keyword",
        "keyword": kw,
        "country": country,
        "captured_at": _now_iso(),
        "competitor_count": raw.get("competitor_count"),
        # 数据周期：份额榜是 ABA 周数据，同一周内重跑内容完全一样（用户会以为"没抓新的"）
        "period": raw.get("period"),
        "data_notice": raw.get("data_notice"),
        "competitor_n": n,
        # 额外指定的 ASIN：不在份额榜里，靠 organic 单独记录；趋势图靠这个字段知道要画它们
        "extra_asins": extras,
        "top": top,
        "profiles": profiles,
        # 自然位：{asin: organic_rank}。趋势图读这个，不读 share_rank。
        # 没采到的不出现在这里（不是 None），另记在 organic_failed。
        "organic": organic,
        # 每个 ASIN 的「第几页第几位 + 抓取时间」，页面优先展示这个
        "organic_detail": organic_detail,
        "organic_failed": organic_failed,
        "my": {
            "asin": my.get("asin"),
            "share_rank": my.get("share_rank"),
            "rank_tier": my.get("rank_tier"),
            "position": my.get("position"),
            "in_list": my.get("in_list"),
            "note": my.get("note"),
            "organic_checked": my.get("organic_checked"),
            "asin_organic_rank": my.get("asin_organic_rank"),
            "asin_search_volume": my.get("asin_search_volume"),
        } if my else None,
        "market": {
            "visible_asin_count": ms.get("visible_asin_count"),
            "concentration_level": ms.get("concentration_level"),
            "competition_mode": ms.get("competition_mode"),
            "top3_click_share": ms.get("top3_click_share"),
            "top3_conversion_share": ms.get("top3_conversion_share"),
            "conversion_gap": ms.get("conversion_gap"),
            "gap_weeks": conc.get("gap_weeks"),
            "click_direction": conc.get("click_direction"),
        },
        "notice": raw.get("data_notice"),
    }


def fetch_asin(target: dict) -> dict:
    """ASIN 维度：各词自然排名 + ABA top3 卡位。2 次 SIF 调用。"""
    asin = target["value"]
    country = target.get("country") or "US"

    sig = sf.asin_keyword_signals(asin, country, 30, 50)
    kws = []
    no_organic = []
    for k in (sig.get("top_keywords") or [])[:40]:
        rank = k.get("organic_rank")
        row = {
            "keyword": k.get("keyword"),
            "organic_rank": rank,
            # 「第几页第几位」+ 抓取时间：SIF 前台就是这么展示的
            "organic_page": k.get("organic_page"),
            "organic_pos": k.get("organic_pos"),
            "organic_rank_time": k.get("organic_rank_time"),
            "traffic_share": k.get("traffic_share"),
            "natural_ratio": k.get("natural_ratio"),
            "search_volume": k.get("search_volume"),
            "health": k.get("health"),
            "contri_change": k.get("contri_change"),
        }
        kws.append(row)
        if rank is None:
            no_organic.append(k.get("keyword"))

    # ABA 卡位（补充视角：买家真实点击的 top3）
    aba = {}
    try:
        fp = sf.aba_footprint(asin, country, 200) if hasattr(sf, "aba_footprint") else {}
        rd = (fp or {}).get("rank_distribution") or {}
        aba = {
            "rank1": rd.get("rank1"),
            "rank2": rd.get("rank2"),
            "rank3": rd.get("rank3"),
            "total_keyword_count": (fp or {}).get("total_keyword_count"),
            "total_covered_volume": (fp or {}).get("total_covered_volume"),
        }
    except Exception as e:
        _log(f"[rank-monitor] ABA 卡位取数失败 {asin}: {e}")

    return {
        "kind": "asin",
        "asin": asin,
        "country": country,
        "captured_at": _now_iso(),
        "keyword_count": len(kws),
        "no_organic_count": len(no_organic),
        "keywords": kws,
        "no_organic": no_organic[:20],
        "aba": aba or None,
        "declining": [k.get("keyword") for k in (sig.get("declining") or [])[:10]],
        "gaining": [k.get("keyword") for k in (sig.get("gaining") or [])[:10]],
    }


# ---------------------------------------------------------------------------
# 变动检测
# ---------------------------------------------------------------------------

def _ev(level: str, kind: str, subject: str, detail: str,
        prev=None, curr=None) -> dict:
    return {"level": level, "kind": kind, "subject": subject,
            "detail": detail, "prev_value": prev, "curr_value": curr}


def diff_keyword(prev: dict, curr: dict) -> list:
    """词维度变动：我方卡位、Top3 名单、集中度。"""
    if not prev:
        return []
    out = []

    # 我方卡位变化（最重要：从不在榜 → 上榜，或反过来）
    pm = (prev.get("my") or None)
    cm = (curr.get("my") or None)
    p_tier = (pm or {}).get("rank_tier")
    c_tier = (cm or {}).get("rank_tier")
    p_rank = (pm or {}).get("share_rank")
    c_rank = (cm or {}).get("share_rank")

    if p_tier == "absent" and c_tier not in (None, "absent"):
        out.append(_ev("high", "rank_rise", curr.get("keyword") or "",
                       f"我方已进入榜单（卡位 {c_tier}，份额排名 {c_rank}）",
                       p_tier, c_tier))
    elif p_tier not in (None, "absent") and c_tier == "absent":
        out.append(_ev("high", "drop_out", curr.get("keyword") or "",
                       "我方已跌出榜单（不再有稳定份额排名）", p_tier, c_tier))
    elif p_rank is not None and c_rank is not None:
        delta = int(c_rank) - int(p_rank)     # 排名数字变大 = 变差
        if abs(delta) >= SHARE_RANK_STEP:
            out.append(_ev(
                "mid", "rank_drop" if delta > 0 else "rank_rise",
                curr.get("keyword") or "",
                f"我方份额排名 {p_rank} → {c_rank}（{'下滑' if delta > 0 else '上升'} {abs(delta)} 位）",
                p_rank, c_rank))

    # Top3 名单进出
    p_top = {c.get("asin") for c in (prev.get("top") or []) if (c.get("share_rank") or 99) <= 3}
    c_top = {c.get("asin") for c in (curr.get("top") or []) if (c.get("share_rank") or 99) <= 3}
    for a in sorted(c_top - p_top):
        out.append(_ev("mid", "new_entrant", a, f"新进入该词 Top3（份额排名 "
                                               f"{next((c.get('share_rank') for c in curr.get('top') or [] if c.get('asin') == a), '')}）",
                       None, a))
    for a in sorted(p_top - c_top):
        out.append(_ev("mid", "drop_out", a, "退出该词 Top3", a, None))

    # Top3 点击集中度
    p_s = ((prev.get("market") or {}).get("top3_click_share"))
    c_s = ((curr.get("market") or {}).get("top3_click_share"))
    if p_s is not None and c_s is not None and abs(c_s - p_s) >= TOP3_SHARE_STEP:
        out.append(_ev("low", "share_shift", curr.get("keyword") or "",
                       f"Top3 点击份额 {p_s:.1%} → {c_s:.1%}", p_s, c_s))
    return out


def diff_asin(prev: dict, curr: dict) -> list:
    """ASIN 维度变动：每个词的自然排名、掉出/新增。"""
    if not prev:
        return []
    out = []
    p_map = {k.get("keyword"): k for k in (prev.get("keywords") or []) if k.get("keyword")}
    c_map = {k.get("keyword"): k for k in (curr.get("keywords") or []) if k.get("keyword")}

    for kw, c in c_map.items():
        p = p_map.get(kw)
        if not p:
            continue             # 新出现的词单独按 low 报，不混在排名变动里
        p_rank, c_rank = p.get("organic_rank"), c.get("organic_rank")
        if p_rank is not None and c_rank is None:
            out.append(_ev("high", "drop_out", kw,
                           f"自然排名消失（原第 {p_rank} 位）", p_rank, None))
        elif p_rank is None and c_rank is not None:
            out.append(_ev("mid", "rank_rise", kw,
                           f"新获得自然排名：第 {c_rank} 位", None, c_rank))
        elif p_rank is not None and c_rank is not None:
            delta = int(c_rank) - int(p_rank)
            if abs(delta) >= RANK_STEP_ALERT:
                out.append(_ev(
                    "mid", "rank_drop" if delta > 0 else "rank_rise", kw,
                    f"自然排名 {p_rank} → {c_rank}（{'下滑' if delta > 0 else '上升'} {abs(delta)} 位）",
                    p_rank, c_rank))

    for kw in c_map:
        if kw not in p_map:
            out.append(_ev("low", "new_keyword", kw, "新进入该 ASIN 的流量词清单", None, kw))

    # ABA top3 卡位总数变化
    pa, ca = (prev.get("aba") or {}), (curr.get("aba") or {})
    p_n = sum(int(pa.get(k) or 0) for k in ("rank1", "rank2", "rank3"))
    c_n = sum(int(ca.get(k) or 0) for k in ("rank1", "rank2", "rank3"))
    if pa and ca and p_n != c_n:
        out.append(_ev("low", "aba_shift", curr.get("asin") or "",
                       f"ABA top3 卡位词数 {p_n} → {c_n}", p_n, c_n))

    out.sort(key=lambda e: LEVEL_ORDER.get(e["level"], 9))
    return out


# ---------------------------------------------------------------------------
# 执行
# ---------------------------------------------------------------------------

# 同一时间只允许一个抓取在跑：定时任务、手动刷新、异步查询如果并发，
# 会同时消耗 QPM 额度（40/60s），而且写同一目标会互相覆盖快照。
_capture_lock = threading.Lock()


def is_capture_busy() -> bool:
    return _capture_lock.locked()


def run_target(state, target: dict) -> dict:
    """抓一次 → 存快照 → 与上一次快照比 → 写事件。

    拿不到抓取锁时直接返回 busy（不排队、不报错），避免多路并发把额度烧穿。
    """
    if not _capture_lock.acquire(blocking=False):
        _log(f"[rank-monitor] 已有抓取在进行，跳过 {target.get('kind')}={target.get('value')}")
        return {"ok": False, "busy": True, "error": "已有抓取任务在进行，请稍候"}
    try:
        return _run_target_locked(state, target)
    finally:
        _capture_lock.release()


def _run_target_locked(state, target: dict) -> dict:
    tid = target["id"]
    kind = target["kind"]
    today = _now_date()
    try:
        data = fetch_keyword(target) if kind == "keyword" else fetch_asin(target)
    except Exception as e:
        state.update_rank_target(tid, last_run_at=_now_iso(), last_status="failed",
                                 last_error=str(e)[:300])
        _log(f"[rank-monitor] {kind}={target.get('value')} 抓取失败：{e}")
        return {"ok": False, "error": str(e)}

    # 先取旧快照再写新快照，否则「上一次」会拿到刚写的这条
    latest = state.get_latest_snapshot(tid)
    same_day_rerun = bool(latest and latest.get("snap_date") == today)
    prev = latest
    if same_day_rerun:
        prev = state.get_snapshot_before(tid, today)   # 基准取上一个不同的日期

    state.add_rank_snapshot(tid, today, data)

    # 同步写入查询历史（同日去重）：左栏「查询记录」统一从 rmon_queries + rmon_srps 取数，
    # 定时监测跑出的最新结果同步写入这里，用户在左栏列表就能直接看到并点击查看。
    try:
        summary = (f"{len(data.get('top') or [])} 个竞品" if kind == "keyword"
                   else f"{data.get('keyword_count') or 0} 个词")
        state.add_rank_query(
            kind, target.get("value"), target.get("country") or "US",
            target.get("own_asin"), summary, data, target.get("username"),
            sif_fingerprint(data))
    except Exception as e:
        _log(f"[rank-monitor] 同步写入查询记录失败（不影响快照）：{e}")

    events = []
    if prev:
        try:
            events = diff_keyword(prev.get("data") or {}, data) if kind == "keyword" \
                else diff_asin(prev.get("data") or {}, data)
        except Exception as e:
            _log(f"[rank-monitor] {kind}={target.get('value')} 变动检测失败：{e}")
    if same_day_rerun:
        # 同一天重跑：基准还是昨天，diff 出来的还是同一批变动。
        # 不先清掉当日事件的话，每刷一次就重复追加一遍（用户看到的「两条一样的记录」之一）。
        state.clear_rank_events_on(tid, today)
    for ev in events:
        state.add_rank_event(tid, ev["level"], ev["kind"], ev["subject"],
                             ev["detail"], ev["prev_value"], ev["curr_value"])

    state.update_rank_target(tid, last_run_at=_now_iso(), last_status="ok", last_error=None)
    _log(f"[rank-monitor] {kind}={target.get('value')} 完成：快照 {today}，变动 {len(events)} 条")
    return {"ok": True, "events": len(events), "snapshot_date": today}


def run_due(state) -> dict:
    """调度入口：跑所有启用的目标。返回汇总。"""
    targets = state.list_rank_targets(enabled_only=True)
    done, failed = 0, 0
    for i, t in enumerate(targets):
        r = run_target(state, t)
        if r.get("ok"):
            done += 1
        else:
            failed += 1
        if i < len(targets) - 1:
            time.sleep(RUN_GAP_SEC)      # 防撞 QPM
    return {"total": len(targets), "done": done, "failed": failed}


# ---------------------------------------------------------------------------
# 定时线程
# ---------------------------------------------------------------------------

class RankMonitorWorker(threading.Thread):
    """每 5 分钟检查一次：到各自 run_at 且当天还没跑的目标补跑。

    daily 目标每天跑一次；weekly 目标只看周一（周一是 SIF ABA 周切换点）。
    """

    def __init__(self, state, interval_sec: int = 300):
        super().__init__(daemon=True, name="rank-monitor")
        self.state = state
        self.interval = interval_sec
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()

    def _due(self, t: dict) -> bool:
        if t.get("paused"):
            return False
        last = (t.get("last_run_at") or "")[:10]
        today = _now_date()
        if last == today:
            return False
        # SIF 的份额榜与 organic_rank 都是**周维度**（同一周期内重复抓结果完全一样，
        # 官方口径：自然位是「周期内最后一次抓取值」）。所以即使是 daily 目标，
        # 也按「距上次至少 6 天」限制 —— 否则每天存一份完全相同的数据，
        # 趋势图上是一串重合的点，纯属浪费 SIF 配额。
        if last:
            try:
                gap = (datetime.date.fromisoformat(today)
                       - datetime.date.fromisoformat(last)).days
            except ValueError:
                gap = 99
            if gap < 6:
                return False
        if (t.get("freq") or "daily") == "weekly":
            if datetime.date.today().weekday() != 0:
                return False
        # 采集时刻看**这个关键词自己的** run_at（空值 = 不限制，当天首次检查就跑）。
        # 之前是全局一个时刻，用户要求下沉到单个关键词维度。
        run_at = (t.get("run_at") or "").strip()
        if run_at:
            try:
                hh, mm = [int(x) for x in run_at.split(":")[:2]]
            except (ValueError, AttributeError):
                return True
            now = datetime.datetime.now()
            if (now.hour, now.minute) < (hh, mm):
                return False
        return True

    def _srp_due(self, t: dict) -> bool:
        """前台实测目标：同一天只跑一次，到点才跑。"""
        if not t.get("enabled"):
            return False
        if (t.get("last_run_at") or "")[:10] == _now_date():
            return False
        at = (t.get("daily_at") or "").strip()
        if at:
            try:
                hh, mm = [int(x) for x in at.split(":")[:2]]
            except (ValueError, AttributeError):
                return True
            now = datetime.datetime.now()
            if (now.hour, now.minute) < (hh, mm):
                return False
        return True

    def _refresh_trend(self, kw: str, country: str = "US"):
        """定时任务跑完顺带把「关键词搜索趋势」刷到最新（force 绕过 12 小时缓存）。

        这样卡片上的周线就是「定时跑完那一刻的 SIF 最新周」，而不是「你打开时才去要」。
        一个词一次调用，weekly 目标一周一次、爬虫目标一天一次，成本可忽略。
        """
        if not kw:
            return
        try:
            if not sf.is_configured():
                return
            keyword_trend(self.state, kw, country or "US", weeks=104, force=True)
            _log(f"[rank-monitor] 趋势已刷新：{kw}")
        except Exception as e:
            _log(f"[rank-monitor] 趋势刷新失败「{kw}」: {str(e)[:120]}")

    def _run_srp_target(self, t: dict):
        """抓一个词的搜索页榜单并落库。

        与手动异步抓取共用 _SRP_RUN_LOCK 互斥：若用户正在手动抓，本轮跳过，
        等 5 分钟后下一轮检查再跑，避免两路爬虫并发撞 Amazon 503。
        """
        kw = t.get("keyword") or ""
        if not _SRP_RUN_LOCK.acquire(blocking=False):
            _log(f"[srp] 手动抓取进行中，定时抓取「{kw}」顺延至下一轮")
            return
        country = (t.get("country") or "US").upper()
        pages = srp.clamp_pages(t.get("pages"))
        try:
            _log(f"[srp] 定时抓取「{kw}」{country} {pages} 页")
            res = srp.fetch_srp(kw, country, pages)
            if res.get("ok"):
                info = self.state.save_rmon_srp(kw, country, res, t.get("username"),
                                                srp_fingerprint(res))
                if info.get("changed") is False:
                    self.state.add_rmon_check("scrape", kw, country,
                                              "定时抓取：内容与上次一致", t.get("username"))
                    _log(f"[srp] 定时抓取「{kw}」内容无变化，未新增快照")
            self.state.mark_srp_target_run(
                t["id"], "ok" if res.get("ok") else "failed",
                None if res.get("ok") else (res.get("warn") or "抓取失败"))
            _log(f"[srp] 定时抓取{'完成' if res.get('ok') else '失败'}「{kw}」"
                 f"{res.get('pages_ok')}/{res.get('pages_requested')} 页")
            if res.get("ok"):
                # 定时抓完顺手刷趋势，避免「定时跑了但趋势还是旧的」
                self._refresh_trend(kw, country)
        except Exception as e:
            _log(f"[srp] 定时抓取异常「{kw}」: {str(e)[:120]}")
            self.state.mark_srp_target_run(t["id"], "failed", f"{type(e).__name__}: {e}")
        finally:
            _SRP_RUN_LOCK.release()

    def run(self):
        while not self._stop.is_set():
            try:
                due = [t for t in self.state.list_rank_targets(enabled_only=True) if self._due(t)]
                if due:
                    _log(f"[rank-monitor] 本轮待抓 {len(due)} 个目标")
                    for i, t in enumerate(due):
                        if self._stop.is_set():
                            break
                        run_target(self.state, t)
                        # SIF 目标跑完，把该词的趋势也刷到最新（周数据，一次调用）
                        self._refresh_trend(t.get("value"), t.get("country"))
                        if i < len(due) - 1:
                            time.sleep(RUN_GAP_SEC)

                # 前台实测目标（爬虫）：与 SIF 目标完全分开调度
                srp_due = [t for t in self.state.list_srp_targets(enabled_only=True)
                           if self._srp_due(t)]
                for t in srp_due:
                    if self._stop.is_set():
                        break
                    self._run_srp_target(t)
            except Exception as e:
                _log(f"[rank-monitor] 调度异常：{type(e).__name__}: {e}")
            self._stop.wait(self.interval)


# ---------------------------------------------------------------------------
# 异步查询任务：用于前端展示实时进度
# ---------------------------------------------------------------------------
# 同步查询等 30~90 秒时前端只能干等，看不出卡在哪。这里把查询丢到后台线程，
# 前端轮询 stage 字段，就能看到「正在调 SIF / 超时重试中 / 解析中」。
# 任务记录只放内存（10 分钟过期），重启丢失可接受 —— 查询结果本身已落 rmon_queries。

import threading
import uuid

_QUERY_TASKS = {}
_TASK_LOCK = threading.Lock()
TASK_TTL_SEC = 600


def _task_set(tid: str, **kw):
    with _TASK_LOCK:
        t = _QUERY_TASKS.get(tid)
        if t is not None:
            t.update(kw)


def _task_gc():
    now = time.time()
    with _TASK_LOCK:
        for k, v in list(_QUERY_TASKS.items()):
            if now - (v.get("started_at") or now) > TASK_TTL_SEC:
                _QUERY_TASKS.pop(k, None)


def start_query_task(state, kind: str, value: str, country: str,
                     own_asin: str = None, username: str = None) -> str:
    """起一个后台查询任务，立即返回 taskId。"""
    _task_gc()
    tid = "qt" + uuid.uuid4().hex[:10]
    with _TASK_LOCK:
        _QUERY_TASKS[tid] = {
            "id": tid, "status": "running", "stage": "排队中",
            "attempt": 1, "started_at": time.time(),
            "kind": kind, "value": value,
            "result": None, "error": None, "query_id": None, "code": None,
        }
    th = threading.Thread(target=_run_query_task,
                          args=(state, tid, kind, value, country, own_asin, username),
                          daemon=True, name=f"rank-query-{tid}")
    th.start()
    return tid


def get_query_task(tid: str):
    with _TASK_LOCK:
        t = _QUERY_TASKS.get(tid)
        if not t:
            return None
        out = dict(t)
    out["elapsed"] = round(time.time() - (out.get("started_at") or time.time()), 1)
    # 结果太大，轮询时没必要每 800ms 传一遍
    if out.get("status") == "running":
        out.pop("result", None)
    out.pop("started_at", None)
    return out


def _run_query_task(state, tid, kind, value, country, own_asin, username):
    target = {"kind": kind, "value": value, "country": country, "own_asin": own_asin}
    try:
        if kind == "keyword":
            _task_set(tid, stage="正在调用 SIF（拉前 100 名竞品，通常 30~60 秒）")

            def on_retry(attempt, msg):
                _task_set(tid, attempt=attempt + 1,
                          stage=f"SIF 超时，正在第 {attempt + 1} 次尝试")
            data = fetch_keyword(target, on_retry=on_retry)
        else:
            _task_set(tid, stage="正在调用 SIF（自然排名 + ABA 卡位）")
            data = fetch_asin(target)

        _task_set(tid, stage="保存查询历史")
        summary = (f"{len(data.get('top') or [])} 个竞品" if kind == "keyword"
                   else f"{data.get('keyword_count') or 0} 个词")
        qid = None
        changed = None
        try:
            info = state.add_rank_query(kind, value, country, own_asin,
                                        summary, data, username, sif_fingerprint(data))
            qid = info.get("id")
            changed = info.get("changed")
            if changed is False:
                state.add_rmon_check("sif", value, country, "内容与上次一致", username)
        except Exception as e:
            _log(f"[rank-monitor] 存查询历史失败: {e}")

        _task_set(tid, status="done", stage="完成", result=data,
                  query_id=qid, changed=changed)
        _log(f"[rank-monitor] 异步查询完成 {kind}={value}")
    except Exception as e:
        msg = str(e)
        _log(f"[rank-monitor] 异步查询失败 {kind}={value}: {msg[:160]}")
        _task_set(tid, status="failed", stage="失败", error=msg,
                  code="sif_timeout" if "timed out" in msg.lower() or "超时" in msg else "error")


# ---------------------------------------------------------------------------
# 趋势聚合：把每天的快照拼成「某个 ASIN 的排名随时间变化」
# ---------------------------------------------------------------------------
# 前台 SIF 有「变体自然位排名趋势」，但 MCP 没开放变体级接口。
# 好在监测快照本来每天就存了 Top 100 的份额排名 —— 攒几天就是真实曲线，
# 而且这是我们自己抓的，不额外消耗 SIF 配额。


def _rank_of(v):
    """排名统一取整；None 保持 None（连续线断点用）。"""
    if v is None:
        return None
    try:
        return round(float(v))
    except (TypeError, ValueError):
        return None


def _series_from_docs(kind: str, docs: list, top_n: int, my_asin: str = None) -> dict:
    """docs: [{"date": str, "data": {...}}] 旧→新。两种数据源（快照 / 查询历史）共用。

    关键词维度画的是**自然搜索位**（`organic` 字段），不是份额排名 ——
    份额排名只说明「谁吃走流量最多」，用户要看的是「谁的自然位在往上爬」。
    """
    dates = [d["date"] for d in docs]

    if kind == "keyword":
        def org_of(doc, a):
            if not a:
                return None
            data = doc.get("data") or {}
            org = data.get("organic") or {}
            if a in org:
                return _rank_of(org.get(a))
            # 兼容补采前的老快照：只有「我的 ASIN」可能存过 asin_organic_rank
            my = data.get("my") or {}
            if (my.get("asin") or "").upper() == str(a).upper():
                return _rank_of(my.get("asin_organic_rank"))
            return None

        my_ranks = [org_of(d, my_asin) for d in docs] if my_asin else []
        last = docs[-1]["data"] or {}
        asins = [c.get("asin") for c in (last.get("top") or [])[:top_n] if c.get("asin")]
        # 额外指定的 ASIN 不在份额榜里，但用户就是要盯它们，必须单独出线
        for a in parse_extra_asins(last.get("extra_asins")):
            if a not in asins:
                asins.append(a)
        comps = [{"asin": a, "ranks": [org_of(d, a) for d in docs]} for a in asins]
        return {"dates": dates, "my_ranks": my_ranks, "competitors": comps}

    # ASIN 维度：本来就是自然排名
    last = docs[-1]["data"] or {}
    kws = sorted((last.get("keywords") or []),
                 key=lambda k: -(k.get("traffic_share") or 0))[:top_n]
    series = []
    for k in kws:
        kw = k.get("keyword")
        ranks = []
        for d in docs:
            hit = next((x for x in ((d["data"].get("keywords")) or [])
                        if x.get("keyword") == kw), None)
            ranks.append(_rank_of((hit or {}).get("organic_rank")))
        series.append({"keyword": kw, "ranks": ranks})
    return {"dates": dates, "keywords": series}


def build_trend(state, target_id: str = None, asin: str = None, top_n: int = 5,
                kind: str = None, value: str = None) -> dict:
    """排名趋势（旧→新），直接喂前端折线图。

    两个数据源，优先监测快照：
      1. `target_id` → 每日快照（每天一条，规则间隔，最准）
      2. `kind` + `value` → 该目标的**查询历史**（用户手动查的时间点，间隔不规则）
         没建监测目标时也能看趋势——反复查同一个词本身就是时间序列。

    · 关键词维度：我方份额排名 + 前 N 名竞品的份额排名
    · ASIN 维度：主要 N 个词的自然排名
    ⚠ 排名**越小越好**，折线往下走是变好。
    """
    if target_id:
        target = state.get_rank_target(target_id)
        if not target:
            return {"error": "目标不存在"}
        kind = target.get("kind")
        value = target.get("value")
        snaps = state.list_rank_snapshots_full(target_id, 90)
        docs = [{"date": s.get("snap_date"), "data": s.get("data") or {}} for s in snaps]
        source = "snapshot"
        my_asin = (target.get("own_asin") or "").upper() or None
    elif kind and value:
        rows = state.list_rank_queries_by_target(kind, value, 60)
        # 同一天查了多次 → 只留最后一次，避免一天多点在图上挤成锯齿
        by_date = {}
        for r in rows:
            day = (r.get("created_at") or "")[:10]
            if day:
                by_date[day] = r
        docs = [{"date": d, "data": (by_date[d].get("data") or {})} for d in sorted(by_date)]
        source = "queries"
        my_asin = (rows[-1].get("own_asin") or "").upper() if rows else None
    else:
        return {"error": "需要 targetId，或 kind + value"}

    if not docs:
        return {"kind": kind, "dates": [], "count": 0, "source": source,
                "note": ("还没有快照，先点「立即刷新」抓一次" if source == "snapshot"
                         else "这个目标还没有历史查询记录，查两次以上才能连成趋势")}

    core = _series_from_docs(kind, docs, top_n, my_asin)
    out = {
        "kind": kind,
        "source": source,
        # 关键词维度画自然位；ASIN 维度本来也是自然位，统一标同一个口径
        "metric": "organic_rank",
        "dates": core["dates"],
        "count": len(core["dates"]),
    }
    if kind == "keyword":
        out["keyword"] = value
        # 数据周期（ABA 周）：同一周内每天抓到的都是同一份，趋势点会重复，
        # 前端要据此告诉用户「为什么这几天的数一样」
        out["period"] = ((docs[-1]["data"] or {}).get("period"))
        out["my"] = {"asin": my_asin, "ranks": core["my_ranks"]} if my_asin else None
        out["competitors"] = core["competitors"]
        out["note"] = (f"自然搜索位（不是份额排名）。数字越小越好，折线往下 = 变好。"
                       f"竞品取最近一次份额榜的前 {top_n} 名。"
                       + ("来自每日快照。" if source == "snapshot"
                          else "来自你的查询历史（间隔不规则，同一天只取最后一次）。"))
    else:
        out["asin"] = value
        out["keywords"] = core["keywords"]
        out["note"] = ("来自每日快照。自然排名数字越小越好。只统计最近一次流量占比最高的 N 个词。"
                       if source == "snapshot" else
                       "来自你的查询历史（间隔不规则，同一天只取最后一次）。自然排名数字越小越好。")
    return out


# ---------------------------------------------------------------------------
# 搜索页抓取（爬虫实测榜单）
# ---------------------------------------------------------------------------
# 与上面的 SIF 查询任务分开管理，原因：
#   · 交互不同 —— 抓取要按页报进度，用户还要能中途停
#   · 时长不同 —— 3 页约 1~2 分钟（页间必须限速），中途关页面不能白跑
# 任务记录只放内存（15 分钟过期）。抓取结果本身已落 rmon_srps，过期不影响数据。

_SCRAPE_TASKS = {}
_SCRAPE_LOCK = threading.Lock()
_SRP_RUN_LOCK = threading.Lock()   # 手动抓取与定时抓取共用的执行互斥锁
SCRAPE_TASK_TTL = 900


def _scrape_set(tid: str, **kw):
    with _SCRAPE_LOCK:
        t = _SCRAPE_TASKS.get(tid)
        if t is not None:
            t.update(kw)


def _scrape_gc():
    now = time.time()
    with _SCRAPE_LOCK:
        for k, v in list(_SCRAPE_TASKS.items()):
            if now - (v.get("started_at") or now) > SCRAPE_TASK_TTL:
                _SCRAPE_TASKS.pop(k, None)


def scrape_busy() -> bool:
    """是否已有抓取任务在跑（含手动异步任务与后台定时抓取）。

    同一时间只允许一个：并发抓只会互相加剧限流，两边都更容易被 503。
    """
    if _SRP_RUN_LOCK.locked():
        return True
    with _SCRAPE_LOCK:
        return any(v.get("status") == "running" for v in _SCRAPE_TASKS.values())


def start_scrape_task(state, keyword: str, country: str = "US",
                      pages: int = srp.DEFAULT_PAGES, username: str = None) -> str:
    """起一个搜索页抓取任务，立即返回 taskId。"""
    _scrape_gc()
    tid = "sc" + uuid.uuid4().hex[:10]
    pages = srp.clamp_pages(pages)
    with _SCRAPE_LOCK:
        _SCRAPE_TASKS[tid] = {
            "id": tid, "status": "running", "stage": "准备抓取",
            "started_at": time.time(), "keyword": keyword, "country": country,
            "pages": pages, "page_done": 0, "page_total": pages,
            "result": None, "snap_id": None, "error": None, "stop": False,
        }
    th = threading.Thread(target=_run_scrape_task,
                          args=(state, tid, keyword, country, pages, username),
                          daemon=True, name=f"srp-{tid}")
    th.start()
    return tid


def get_scrape_task(tid: str):
    with _SCRAPE_LOCK:
        t = _SCRAPE_TASKS.get(tid)
        if not t:
            return None
        out = dict(t)
    out["elapsed"] = round(time.time() - (out.get("started_at") or time.time()), 1)
    out.pop("started_at", None)
    out.pop("stop", None)
    if out.get("status") == "running":
        out.pop("result", None)
    return out


def stop_scrape_task(tid: str) -> bool:
    """请求停止：当前页抓完就收尾，不会强行掐断请求（掐断会留下半截数据）。"""
    with _SCRAPE_LOCK:
        t = _SCRAPE_TASKS.get(tid)
        if not t or t.get("status") != "running":
            return False
        t["stop"] = True
        t["stage"] = "正在停止（等当前页抓完）"
    return True


def _run_scrape_task(state, tid, keyword, country, pages, username):
    def on_progress(stage, done, total):
        _scrape_set(tid, stage=stage, page_done=done, page_total=total)

    def should_stop():
        with _SCRAPE_LOCK:
            t = _SCRAPE_TASKS.get(tid)
            return bool(t and t.get("stop"))

    if not _SRP_RUN_LOCK.acquire(blocking=False):
        _scrape_set(tid, status="failed", stage="失败",
                    error="已有定时抓取任务在进行，请稍候再试")
        return
    try:
        res = srp.fetch_srp(keyword, country, pages,
                            on_progress=on_progress, should_stop=should_stop)
        sid = None
        changed = None
        if res.get("ok"):
            _scrape_set(tid, stage="保存榜单快照")
            try:
                info = state.save_rmon_srp(keyword, country, res, username,
                                           srp_fingerprint(res))
                sid = info.get("id")
                changed = info.get("changed")
                if changed is False:
                    state.add_rmon_check("scrape", keyword, country,
                                         "内容与上次一致", username)
            except Exception as e:
                _log(f"[srp] 存快照失败: {e}")
        ok = bool(res.get("ok"))
        _scrape_set(tid,
                    status="done" if ok else "failed",
                    stage="完成" if ok else "失败",
                    result=res, snap_id=sid, changed=changed,
                    error=None if ok else (res.get("warn") or "抓取失败"))
        _log(f"[srp] {keyword} 抓取{'完成' if ok else '失败'}："
             f"{res.get('pages_ok')}/{res.get('pages_requested')} 页，"
             f"{res.get('org_total')} 个自然位，耗时 {res.get('elapsed')}s")
    except Exception as e:
        _log(f"[srp] {keyword} 抓取异常: {str(e)[:160]}")
        _scrape_set(tid, status="failed", stage="异常",
                    error=f"{type(e).__name__}: {e}")
    finally:
        _SRP_RUN_LOCK.release()


# ---------------------------------------------------------------------------
# 内容指纹（实现在 fingerprint.py，db 层补老数据也要用，单独成文件避免循环依赖）
# ---------------------------------------------------------------------------
from .fingerprint import sif_fingerprint, srp_fingerprint  # noqa: E402


# ---------------------------------------------------------------------------
# ASIN 静态属性（上架日期 / 品牌）：搜索结果页没有这个字段，只能问 SIF
# ---------------------------------------------------------------------------
# 亚马逊搜索页只给标题/价格/评分/评论数/偶尔的销量，**没有上架时间**
# （实测 1.6MB 原始 HTML 里 "Date First Available" 出现 0 次）。
# 上架日期只在详情页有 —— 但一个词 60 个 ASIN 就是 60 次网页请求，必被封。
# 所以走 SIF 的 market_get_asin_profile（20 个/次），并且**按 ASIN 永久缓存**：
# 上架日期不会变，每个 ASIN 一辈子只查一次，日常增量只是榜单上的新面孔。

def _age_days_map(state, keyword: str, country: str = "US") -> dict:
    """从该词最近一次 SIF 竞品查询里取「上架天数」，转成 {ASIN: 日期}。

    为什么优先用它：`market_get_asin_profile` 的 `first_available_day` 覆盖率极低
    （实测某词 145 个 ASIN 只有 6 个有值，连 2013 年的老品都是空串），
    而竞品份额榜里的 `listed_age_days` 是 100/100 齐全的 —— 而且**这份数据 B 区本来就要拉**，
    从已存的查询结果里读，等于零额外成本。
    """
    if not keyword:
        return {}
    try:
        for q in state.list_rank_queries(200):
            if (q.get("kind") or "") != "keyword":
                continue
            if str(q.get("value") or "").strip().lower() != keyword.strip().lower():
                continue
            row = state.get_rank_query(q["id"]) or {}
            top = (row.get("data") or {}).get("top") or []
            out = {}
            today = datetime.date.today()
            for t in top:
                asin = str(t.get("asin") or "").upper()
                age = t.get("listed_age_days")
                if not asin or age in (None, ""):
                    continue
                try:
                    d = today - datetime.timedelta(days=int(float(age)))
                except (TypeError, ValueError):
                    continue
                out[asin] = d.isoformat()
            return out
    except Exception as e:
        _log(f"[srp-meta] 读竞品榜上架天数失败：{e}")
    return {}


def enrich_asin_meta(state, asins: list, country: str = "US", limit: int = 200,
                     keyword: str = None) -> dict:
    """补齐 ASIN 的上架日期。三路取数，按可靠性从高到低：

      1. `rmon_asin_meta` 缓存（查到过就不再问）
      2. 该词 SIF 竞品榜的 `listed_age_days`（覆盖率 100%，零额外调用）
      3. `market_get_asin_profile` 的 `first_available_day`（覆盖率很低，只兜底）

    返回 {"meta": {ASIN: {...}}, "asked": 实际问 SIF 的个数, "calls": 调用次数}
    """
    keys = []
    for a in asins or []:
        k = str(a or "").upper()
        if k and k not in keys:
            keys.append(k)
    keys = keys[:max(1, limit)]
    if not keys:
        return {"meta": {}, "asked": 0, "calls": 0}

    cached = state.get_rmon_asin_meta(keys)

    # 第 2 路：竞品榜的上架天数。**优先于缓存里的空值** —— 早期版本用 asin_profile
    # 查询时把「没有日期」也缓存成了空串（负缓存），不覆盖的话永远补不上。
    ages = _age_days_map(state, keyword or "", country)
    filled = []
    for a in keys:
        day = ages.get(a)
        if day and (cached.get(a) or {}).get("first_available_day") != day:
            filled.append({"asin": a, "first_available_day": day, "src": "age",
                           "brand": (cached.get(a) or {}).get("brand") or ""})
    if filled:
        state.upsert_rmon_asin_meta(filled)
        cached = state.get_rmon_asin_meta(keys)

    # 第 3 路：还没有日期的才去问 asin_profile
    missing = [a for a in keys if not (cached.get(a) or {}).get("first_available_day")]
    calls = 0
    if missing:
        fresh = []
        for i in range(0, len(missing), 20):
            chunk = missing[i:i + 20]
            try:
                rows = sf.asin_profiles(chunk, country)
                calls += 1
            except Exception as e:
                _log(f"[srp-meta] 批量取 ASIN 档案失败（{len(chunk)} 个）：{e}")
                continue
            got = {str(r.get("asin") or "").upper(): r for r in rows}
            for a in chunk:
                r = got.get(a)
                day = (r or {}).get("first_available_day") or ""
                fresh.append({
                    "asin": a,
                    "first_available_day": day,
                    "src": "asin" if day else None,   # 空值不覆盖已有的 age 来源
                    "brand": (r or {}).get("brand") or (cached.get(a) or {}).get("brand") or "",
                })
        state.upsert_rmon_asin_meta(fresh)
        cached = state.get_rmon_asin_meta(keys)

    return {"meta": cached, "asked": len(missing), "calls": calls,
            "fromRank": sum(1 for a in keys if ages.get(a))}


# ---------------------------------------------------------------------------
# 关键词搜索趋势（SIF ABA 周数据，类似「产品时光机」的时长序列）
# ---------------------------------------------------------------------------
# 只做「这个词自己」的量与排名，不做词根长尾拆分（那是 root_trend 的事）。
# 缓存 12 小时：ABA 是周数据，一天之内不该反复变化，也不该反复烧调用。

def keyword_trend(state, keyword: str, country: str = "US",
                  weeks: int = 104, granularity: str = "week",
                  force: bool = False) -> dict:
    keyword = (keyword or "").strip()
    country = (country or "US").upper()[:4]
    if not keyword:
        return {"keyword": keyword, "dates": [], "volumes": [], "ranks": [], "note": "关键词为空"}

    # force=True 绕过缓存：定时任务跑完顺带刷新，保证「定时跑完就是最新的」
    cached, fetched_at = (None, None) if force else \
        state.get_rmon_kw_trend(keyword, country, granularity)
    if cached:
        data = dict(cached, source="cache", fetched_at=fetched_at)
    else:
        raw = sf.keyword_history([keyword], country, granularity)
        ser = (raw.get("series") or {}).get(keyword)
        if ser is None:
            # SIF 回填的 key 可能被规范化过（大小写/空格），取第一条兜底
            vals = list((raw.get("series") or {}).values())
            ser = vals[0] if vals else {}
        data = {
            "keyword": keyword,
            "country": country,
            "granularity": granularity,
            "dates": ser.get("dates") or [],
            "volumes": ser.get("volumes") or [],
            "ranks": ser.get("ranks") or [],
            "latest": ser.get("latest") or {},
            "notice": raw.get("notice") or "",
            "source": "sif",
        }
        if data["dates"]:
            state.save_rmon_kw_trend(keyword, country, granularity,
                                     {k: v for k, v in data.items()
                                      if k not in ("source",)})

    # 截取最近 N 周（默认 2 年，够看季节性）
    n = max(8, min(400, int(weeks or 104)))
    dates = data.get("dates") or []
    vols = data.get("volumes") or []
    ranks = data.get("ranks") or []
    if len(dates) > n:
        cut = len(dates) - n
        dates, vols, ranks = dates[cut:], vols[cut:], ranks[cut:]

    def _avg(xs):
        vals = [x for x in xs if isinstance(x, (int, float))]
        return round(sum(vals) / len(vals)) if vals else None

    vol_last = vols[-1] if vols else None
    vol_prev = vols[-2] if len(vols) > 1 else None
    vol_4w = _avg(vols[-4:]) if len(vols) >= 4 else None
    rank_last = ranks[-1] if ranks else None
    rank_4w_ago = ranks[-5] if len(ranks) >= 5 else None
    peak_i = max(range(len(vols)), key=lambda i: vols[i] or 0) if vols else None

    return {
        "keyword": keyword,
        "country": country,
        "granularity": granularity,
        "dates": dates,
        "volumes": vols,
        "ranks": ranks,
        "count": len(dates),
        "summary": {
            "volumeLast": vol_last,
            "volumePrev": vol_prev,
            "wowPct": (round((vol_last - vol_prev) / vol_prev * 100, 1)
                       if vol_last and vol_prev else None),
            "volume4wAvg": vol_4w,
            "rankLast": rank_last,
            "rank4wAgo": rank_4w_ago,
            "peakDate": dates[peak_i] if peak_i is not None and dates else None,
            "peakVolume": vols[peak_i] if peak_i is not None and vols else None,
        },
        "latestDate": dates[-1] if dates else None,
        "notice": data.get("notice") or "",
        "source": data.get("source"),
        "fetchedAt": data.get("fetched_at"),
        "note": ("SIF 的 ABA 周数据（亚马逊官方搜索词报表口径，非第三方估算）。"
                 "搜索量是「该词一周被搜了多少次」，ABA 排名是它在全部搜索词里的名次"
                 "（数字越小越热门）。周报有 2~3 周发布滞后，最新一周可能是空值。"),
    }


# ---------------------------------------------------------------------------
# 榜单趋势聚合：把每日榜单拼成「ASIN × 日期」的位次矩阵
# ---------------------------------------------------------------------------
# 一个词一次 144 条，30 天就是 4300 条 —— 存储没问题，但画图会糊成一片。
# 所以这里只保留「出现过 2 天以上」或「最近一次仍在榜」的 ASIN：
# 长尾 ASIN 天天换，给它画趋势没有意义（折线要么断成点，要么连出误导性的直线）。

def build_srp_trend(state, keyword: str, country: str = "US", limit: int = 60) -> dict:
    docs = state.list_rmon_srp_series(keyword, country, limit)
    if not docs:
        return {"keyword": keyword, "country": country, "dates": [], "asins": [],
                "count": 0, "note": "还没有抓取记录，先抓一次"}

    dates, by_day = [], {}
    for d in docs:
        day = d.get("snap_date") or (d.get("created_at") or "")[:10]
        if not day or day in by_day:
            # 同一天可能有多条（内容有变化才会追加）。docs 按 created_at DESC 排，
            # 所以每格第一次命中的就是「当天最后一条」—— 这正是一天一个点的正确取值。
            continue
        dates.append(day)
        by_day[day] = (d.get("data") or {}).get("items") or []

    seen = {}
    for day in dates:
        for it in by_day.get(day) or []:
            asin = (it.get("asin") or "").upper()
            if not asin:
                continue
            s = seen.setdefault(asin, {"asin": asin, "title": it.get("title"),
                                       "ranks": {}, "best": None, "last_seen": None})
            if it.get("title") and not s["title"]:
                s["title"] = it["title"]
            org = it.get("org")
            if org:
                s["ranks"][day] = org
                if s["best"] is None or org < s["best"]:
                    s["best"] = org
                s["last_seen"] = day

    last_day = dates[-1] if dates else None
    rows = []
    for s in seen.values():
        ranks = [s["ranks"].get(d) for d in dates]
        days = sum(1 for r in ranks if r)
        if days < 2 and s["last_seen"] != last_day:
            continue
        rows.append({
            "asin": s["asin"], "title": s["title"], "best": s["best"],
            "days": days, "ranks": ranks,
            "last": s["ranks"].get(last_day) if last_day else None,
        })
    rows.sort(key=lambda r: (r["last"] is None, r["last"] or 9999, -(r["days"])))

    return {
        "keyword": keyword,
        "country": country,
        "dates": dates,
        "asins": rows,
        "count": len(dates),
        "note": ("每格是该 ASIN 当天的自然位（数字越小越好，空白 = 当天不在抓取页数范围内）。"
                 "只列出出现 2 天以上、或最近一次仍在榜的 ASIN。"),
    }


# ---------------------------------------------------------------------------
# 榜单异动：比较相邻两天的快照，找出进榜 / 掉榜 / 大涨大跌
# ---------------------------------------------------------------------------
# 阈值不能设太小：亚马逊搜索结果本身就有 ±2~3 位抖动，甚至同一时刻不同 IP
# 抓到的顺序都不完全一样。设成 3 位会天天报警，报警一多用户就再也不看了。
SRP_TOP_N = 20          # 只看前 20 名的进出
SRP_STEP_ALERT = 10     # 位次变化 ≥10 才算异动


def build_srp_events(state, keyword: str, country: str = "US",
                     top_n: int = SRP_TOP_N, step: int = SRP_STEP_ALERT) -> dict:
    docs = state.list_rmon_srp_series(keyword, country, 2)
    if len(docs) < 2:
        return {"keyword": keyword, "country": country, "events": [],
                "prev_date": (docs[0].get("snap_date") if docs else None),
                "curr_date": None,
                "note": "异动要两天快照对比才能算，现在只有 1 天（明天再抓一次就有了）"}

    prev, curr = docs[0], docs[1]

    def org_map(doc):
        m = {}
        for it in (doc.get("data") or {}).get("items") or []:
            asin = (it.get("asin") or "").upper()
            org = it.get("org")
            if asin and org:
                m[asin] = {"org": org, "title": it.get("title")}
        return m

    pm, cm = org_map(prev), org_map(curr)
    events = []
    for asin, c in cm.items():
        p = pm.get(asin)
        if p is None:
            if c["org"] <= top_n:
                events.append({"kind": "enter_top", "asin": asin, "title": c["title"],
                               "prev": None, "curr": c["org"], "delta": None})
        elif abs(p["org"] - c["org"]) >= step:
            up = c["org"] < p["org"]
            events.append({"kind": "up" if up else "down", "asin": asin,
                           "title": c["title"], "prev": p["org"], "curr": c["org"],
                           "delta": c["org"] - p["org"]})
    # 掉榜：昨天还在前 N，今天在今天抓到的范围内找不到
    for asin, p in pm.items():
        if asin not in cm and p["org"] <= top_n:
            events.append({"kind": "drop_out", "asin": asin, "title": p["title"],
                           "prev": p["org"], "curr": None, "delta": None})

    order = {"drop_out": 0, "enter_top": 1, "down": 2, "up": 3}
    events.sort(key=lambda e: (order.get(e["kind"], 9),
                               -abs(e.get("delta") or 0),
                               e.get("curr") or 9999))

    return {
        "keyword": keyword,
        "country": country,
        "prev_date": prev.get("snap_date"),
        "curr_date": curr.get("snap_date"),
        "events": events,
        "note": (f"对比 {prev.get('snap_date')} 与 {curr.get('snap_date')}。"
                 f"只统计前 {top_n} 名的进出、以及位次变化 ≥{step} 位的情况 —— "
                 f"亚马逊自身排序就有 ±2~3 位抖动，阈值设太小会天天报警。"),
    }
