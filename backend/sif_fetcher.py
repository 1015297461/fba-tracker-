#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SIF (mcp.sif.com) 爆品关键词监控 —— 数据抓取器 v2
====================================================
通过 HTTP JSON-RPC 直连 SIF 的 MCP 端点（Streamable HTTP 传输），
不经过 LLM，供 FBA2「SIF 爆品关键词监控」模块的定时任务与点查使用。

端点与密钥配置（按优先级）：
  1. 环境变量 SIF_MCP_URL / SIF_MCP_KEY
  2. data/sif-config.json：{"url": "https://mcp.sif.com/mcp", "key": "..."}
     （data/ 目录已被 .gitignore 忽略，密钥不入 git）

分层抓取（SIF 按 tools/call 计费，分层是主要成本控制手段）：
  · 每日层：market_screen_keyword_opportunities（机会词发现 + 当日快照）
            ops_get_asin_traffic_trend(granularity=day)（监控池 ASIN 的逐日
            BSR/价格/销量/评论/自然vs广告流量分数 —— SIF 唯一的真日粒度接口）
            market_get_asin_profile（新入池 ASIN 补静态属性，≤20 个/次）
  · 每周层：market_get_keyword_demand（需求画像，10 词/批）
            market_get_keyword_history（周度趋势，10 词/批）
            market_get_keyword_root_competitors（词根头部竞品 → 自动扩充 ASIN 监控池）
  · 点查层（前端手动触发，不进定时）：keyword_competition / assess_promotion /
            profit_threshold / asin_keyword_signals / keyword_root_trend / discover_competitors

依赖：仅 Python 标准库（urllib + json），零第三方依赖。
"""

import json
import os
import re
import threading
import time
import urllib.request
import urllib.error

from .utils import PROJECT_ROOT, _log, _now_iso

# ---------------------------------------------------------------------------
# 全局 QPM 闸门（所有入口共用一份额度）
# ---------------------------------------------------------------------------
# SIF 订阅限制 40 次/60 秒（实测：1 次 tools/call = 1 个额度，滑动窗口）。
# 之前没有闸门，几条路各走各的：定时抓取 + 手动刷新 + 异步查询 + 批量查自然位，
# 一旦叠加就冲破 40 → 报「当期订阅QPM限制已达上限(40/40)」。
# 闸门的作用是**排队而不是失败**：超额的调用会在这里等，不往前打。
#
# 留 15% 余量（34/40）：给 SIF 侧的重试、另一个进程、或手动点查留空间。
QPM_LIMIT = int(os.environ.get("SIF_QPM_LIMIT", "34"))
QPM_WINDOW = 60.0
_SLOT_GAP = QPM_WINDOW / max(1, QPM_LIMIT)      # 均匀铺开，避免每秒 34 次爆发

_gate_lock = threading.Lock()
_next_slot = [0.0]          # 下一次允许发车的时刻
_call_count = [0]           # 累计调用数（日志用）


def _acquire_slot():
    """阻塞直到轮到自己。均匀铺开：任意两次调用间隔 >= 60/QPM_LIMIT 秒。"""
    with _gate_lock:
        now = time.time()
        slot = max(now, _next_slot[0])
        _next_slot[0] = slot + _SLOT_GAP
        _call_count[0] += 1
    delay = slot - time.time()
    if delay > 0:
        # 长时间等待（比如刚撞过限流）打一行日志，免得看起来像卡死
        if delay > 3:
            _log(f"[sif] 排队等待 {delay:.0f}s（QPM {QPM_LIMIT}/60s 已排满）")
        time.sleep(delay)


def call_stats() -> dict:
    """给路由/日志用：累计调用数与下次可用时刻。"""
    with _gate_lock:
        return {"total": _call_count[0],
                "next_in": max(0.0, _next_slot[0] - time.time()),
                "qpm_limit": QPM_LIMIT}


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DEFAULT_URL = "https://mcp.sif.com/mcp"
CONFIG_PATH = os.path.join(PROJECT_ROOT, "data", "sif-config.json")

_config_cache = {"t": 0.0, "url": None, "key": None}


def _load_config():
    """读取 SIF 端点配置（环境变量优先，其次 data/sif-config.json，缓存 30s）。"""
    now = time.time()
    if now - _config_cache["t"] < 30 and _config_cache["key"]:
        return _config_cache["url"], _config_cache["key"]
    url = os.environ.get("SIF_MCP_URL") or DEFAULT_URL
    key = os.environ.get("SIF_MCP_KEY") or ""
    if not key:
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            url = cfg.get("url") or url
            key = cfg.get("key") or ""
        except Exception:
            pass
    _config_cache.update({"t": now, "url": url, "key": key})
    return url, key


def is_configured() -> bool:
    return bool(_load_config()[1])


# 错误信息里出现这些词，说明重试也不可能成功（配置缺失 / 鉴权被拒 / 接口不存在）。
# 网络超时、5xx、限流（rate limit）、配额耗尽都不在此列——它们跨一段时间可能自愈，
# 交给调度层的退避与当日熔断处理更合适，不该把任务彻底停用。
_FATAL_HINTS = (
    "unauthorized", "forbidden", "401", "403",
    "invalid key", "invalid secret", "secret-key", "signature",
    "unknown tool", "no such tool", "tool not found", "method not found",
    "未授权", "鉴权失败", "密钥", "签名错误", "权限不足", "工具不存在",
)


def is_fatal_message(text: str) -> bool:
    """判断错误信息是否属于「重试也不会成功」的类别。"""
    low = (text or "").lower()
    return any(h in low for h in _FATAL_HINTS)


def record_error(stats: dict, label: str, e: Exception) -> None:
    """把一次调用失败记进 stats，并把不可恢复错误单独标到 stats["fatal"]。

    分层抓取里每步都自己吞掉 SifError 继续跑，所以「这一步是不是致命错误」
    必须靠 stats 传出去，否则调用方无法决定要不要直接停用任务。
    """
    stats["errors"] = stats.get("errors", 0) + 1
    stats.setdefault("error_detail", []).append(f"{label}: {str(e)[:120]}")
    if isinstance(e, SifError) and e.fatal:
        stats.setdefault("fatal", []).append(f"{label}: {str(e)[:200]}")


class SifError(Exception):
    """SIF 调用失败（未配置/网络/业务错误），message 面向用户展示。

    fatal=True 表示重试也不可能成功（密钥未配置、鉴权被拒、工具不存在等），
    调度层遇到这种错误直接停用任务，一次都不重试。
    """

    def __init__(self, message: str, fatal: bool = False):
        super().__init__(message)
        self.fatal = fatal


# ---------------------------------------------------------------------------
# 底层 JSON-RPC 调用
# ---------------------------------------------------------------------------

def _call_once(name: str, arguments: dict, timeout: int = 60) -> dict:
    """调用 SIF MCP 工具，返回结构化 JSON（dict）。失败抛 SifError。"""
    url, key = _load_config()
    if not key:
        raise SifError("SIF MCP 未配置：请设置环境变量 SIF_MCP_KEY 或创建 data/sif-config.json",
                       fatal=True)
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "secret-key": key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        code = getattr(e, "code", 0) or 0
        try:
            detail = e.read()[:200].decode("utf-8", "replace")
        except Exception:
            detail = ""
        raise SifError(f"SIF HTTP {code}: {detail}",
                       fatal=code in (401, 403) or is_fatal_message(detail)) from e
    except Exception as e:
        raise SifError(f"SIF 网络错误: {type(e).__name__}: {e}") from e

    payload = _parse_mcp_response(raw)
    if payload is None:
        raise SifError(f"SIF 响应解析失败: {raw[:200]}")
    if isinstance(payload, dict) and payload.get("error"):
        msg = payload["error"].get("message", "unknown")
        raise SifError(f"SIF 错误: {msg}", fatal=is_fatal_message(msg))
    result = payload.get("result", {}) if isinstance(payload, dict) else {}
    if result.get("isError"):
        err_text = ""
        for c in result.get("content", []) or []:
            t = c.get("text", "")
            try:
                obj = json.loads(t)
                err_text = obj.get("message") or obj.get("error") or t
            except Exception:
                err_text = t
            if err_text:
                break
        raise SifError(f"SIF 工具 {name} 失败: {err_text[:300]}",
                       fatal=is_fatal_message(err_text))
    for c in result.get("content", []) or []:
        t = c.get("text", "")
        if not t:
            continue
        try:
            return json.loads(t)
        except Exception:
            continue
    return {}


# 这些字样说明是网络/服务端临时问题，重试有机会成功
_RETRY_HINTS = ("timed out", "TimeoutError", "Connection reset", "Connection aborted",
                "RemoteDisconnected", "网络错误", "HTTP 500", "HTTP 502", "HTTP 503",
                "HTTP 504")


def _is_retryable(msg: str) -> bool:
    m = str(msg)
    return any(h in m for h in _RETRY_HINTS)


# 限流专用：等一个窗口就能恢复，和「网络抖一下」不是一回事
QPM_COOLDOWN_SEC = 15
QPM_RETRIES = 3


def _is_qpm(msg: str) -> bool:
    m = str(msg)
    return ("QPM" in m.upper()) or ("限制已达上限" in m) or ("rate limit" in m.lower())


def is_qpm_error(msg: str) -> bool:
    """供上层判断：这次失败是不是因为没额度了（而不是真的没数据）。"""
    return _is_qpm(msg)


def call_tool(name: str, arguments: dict, timeout: int = 60, retries: int = 0,
              on_retry=None) -> dict:
    """调用 SIF MCP 工具，失败抛 SifError。

    retries > 0 时对**网络类**错误自动重试（超时 / 连接断开 / 5xx），间隔 2s、4s 递增。
    SIF 按 tools/call 计费，超时那次服务端通常已收到，重试会再耗一次配额 ——
    所以只给「重接口」开重试，普通调用保持 retries=0。
    fatal 错误（配置缺失 / 鉴权被拒 / 工具不存在）一次都不重试。
    """
    attempt = 0
    qpm_attempt = 0
    while True:
        _acquire_slot()             # 所有调用统一排队，不突破订阅 QPM
        try:
            return _call_once(name, arguments, timeout)
        except SifError as e:
            msg = str(e)
            if getattr(e, "fatal", False):
                raise

            # 限流单独处理：等一个窗口再试，**不用 retries 参数控制**。
            # 限流不是真失败，等一等就过去了；直接抛出去只会让上层把数据记成 None（假的"无自然位"）。
            if _is_qpm(msg) and qpm_attempt < QPM_RETRIES:
                qpm_attempt += 1
                wait = QPM_COOLDOWN_SEC
                _log(f"[sif] {name} 撞到 QPM 限流，{wait}s 后第 {qpm_attempt} 次重试")
                if on_retry:
                    try:
                        on_retry(qpm_attempt, msg)
                    except Exception:
                        pass
                time.sleep(wait)
                continue

            if attempt >= retries or not _is_retryable(msg):
                raise
            attempt += 1
            wait = 2 * attempt
            _log(f"[sif] {name} 第 {attempt} 次失败（{msg[:120]}），{wait}s 后重试")
            if on_retry:
                try:
                    on_retry(attempt, msg)
                except Exception:
                    pass        # 进度回调失败不能影响主流程
            time.sleep(wait)


def _parse_mcp_response(raw: str):
    """兼容纯 JSON 与 SSE 两种响应格式。"""
    s = raw.strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        pass
    last = None
    for line in s.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            chunk = line[5:].strip()
            if chunk:
                try:
                    last = json.loads(chunk)
                except Exception:
                    last = None
    return last


# ---------------------------------------------------------------------------
# 响应清洗
# ---------------------------------------------------------------------------

_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")


def _clean(value):
    """去掉 markdown 链接包装（"[B0XXX](url)" -> "B0XXX"）。"""
    if isinstance(value, str):
        m = _LINK_RE.match(value.strip())
        return m.group(1) if m else value
    return value


# SIF 的排名是复合串：'p{页},{页内位次}/{每页条数}'，例如 "p1,2/48"。
# 绝不能走 _num()：它会把逗号去掉变成 "p12/48"，再正则取第一段数字 → 12，
# 于是「第 1 页第 2 位」被存成「第 12 位」——整列自然位都是脏数据。
_RANK_STR_RE = re.compile(r"^\s*p(\d+)\s*,\s*(\d+)\s*/\s*(\d+)\s*$", re.I)


def parse_rank(v):
    """把 SIF 的排名串解析成绝对位次。

    返回 {"rank": 绝对位次, "page": 页, "pos": 页内位次, "total": 每页条数}；
    纯数字/空值也兼容。无法识别返回 None。
    """
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip()
    if not s or s.lower() in ("null", "none", "-", "n/a"):
        return None

    m = _RANK_STR_RE.match(s)
    if m:
        page, pos, total = int(m.group(1)), int(m.group(2)), int(m.group(3))
        per_page = total if total > 0 else 48
        # total 实测恒为 48 = 每页条数，所以绝对位次 = (页-1)*48 + 页内位次
        return {"rank": (page - 1) * per_page + pos, "page": page,
                "pos": pos, "total": total}

    try:
        n = int(round(float(s.replace(",", ""))))
        return {"rank": n, "page": None, "pos": None, "total": None} if n > 0 else None
    except Exception:
        return None


def _num(value):
    """尽力把字符串数字（'1,234' / '45%' / '$3.20'）转成 float，失败返回 None。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    s = str(value).replace(",", "").replace("$", "").replace("%", "").strip()
    if not s or s in ("-", "null", "None", "N/A"):
        return None
    try:
        return float(s)
    except Exception:
        m = re.search(r"-?\d+(?:\.\d+)?", s)
        return float(m.group(0)) if m else None


# ---------------------------------------------------------------------------
# 关键词域工具封装
# ---------------------------------------------------------------------------

def screen_opportunities(keyword_root: str, country: str = "US", top_n: int = 8) -> list:
    """按词根筛选机会词。返回 [{keyword, search_volume, click_share, cvr, cpc,
    traffic_cost, entry_signal, data_period, top_asins}]"""
    data = call_tool("market_screen_keyword_opportunities", {
        "keyword_root": keyword_root, "country": country, "topN": int(top_n),
    })
    out = []
    for k in data.get("keywords") or []:
        out.append({
            "keyword":       _clean(k.get("keyword", "")),
            "search_volume": _num(k.get("search_volume")),
            "click_share":   _num(k.get("click_share_top3")),
            "cvr":           _num(k.get("cvr")),
            "cpc":           _num(k.get("cpc")),
            "traffic_cost":  _num(k.get("traffic_cost_per_unit")),
            "entry_signal":  _clean(k.get("entry_signal")),
            "data_period":   k.get("data_period"),
            "top_asins":     [_clean(a) for a in (k.get("top3_click_asins") or [])][:3],
        })
    return out


def keyword_demand(keywords: list, country: str = "US") -> dict:
    """批量关键词需求画像（≤10 词/批）。返回 {profiles: [...], timing: [...]}"""
    data = call_tool("market_get_keyword_demand", {"keywords": keywords, "country": country})
    profiles = []
    for p in data.get("profiles") or []:
        tr = p.get("trend") or {}
        cur = p.get("current") or {}
        ds = p.get("demand_structure") or {}
        profiles.append({
            "keyword":          _clean(p.get("keyword", "")),
            "demand_type":      ds.get("primary_type") or "",
            "ad_hint":          _clean(ds.get("ad_strategy_hint") or ""),
            "search_volume":    _num(cur.get("search_volume")),
            "season_position":  cur.get("season_position"),
            "trend_direction":  tr.get("direction"),
            "yoy_change":       _num(tr.get("yoy_change")),
            "momentum":         _num(tr.get("momentum")),
            "peak_month":       p.get("peak_month"),
            "trough_month":     p.get("trough_month"),
            "weeks_to_peak":    p.get("weeks_to_peak"),
            "seasonal_strength": p.get("seasonal_strength"),
            "diagnosis":        _clean(p.get("diagnosis") or ""),
            "interpretation":   _clean(p.get("interpretation") or ""),
        })
    return {"profiles": profiles, "timing": data.get("timing_summary") or []}


def keyword_history(keywords: list, country: str = "US", granularity: str = "week") -> dict:
    """关键词周度历史趋势（≤10 词/批）。SIF 的关键词历史只有周/月粒度（ABA 官方口径）。
    返回 {series: {kw: {dates, volumes, ranks, click_shares, conversion_shares,
    latest:{date,volume,rank,top_asins}}}, notice}"""
    data = call_tool("market_get_keyword_history", {
        "keywords": keywords, "country": country, "granularity": granularity,
    })
    series = {}
    for k in data.get("keywords") or []:
        kw = _clean(k.get("keyword", ""))
        latest = k.get("latest") or {}
        series[kw] = {
            "dates":             k.get("dates") or [],
            "volumes":           [_num(v) for v in (k.get("volumes") or [])],
            "ranks":             [_num(v) for v in (k.get("ranks") or [])],
            "click_shares":      [_num(v) for v in (k.get("top3_click_shares") or [])],
            "conversion_shares": [_num(v) for v in (k.get("top3_conversion_shares") or [])],
            "latest": {
                "date":    latest.get("date"),
                "volume":  _num(latest.get("volume")),
                "rank":    _num(latest.get("rank")),
                "top_asins": [_clean(a) for a in (latest.get("top3_asins") or [])],
            },
        }
    return {"series": series, "notice": data.get("data_notice") or ""}


def keyword_root_trend(keyword: str, country: str = "US", granularity: str = "week") -> dict:
    """词根市场规模与需求分散度（点查用）：精确词量 vs 词根综合量 + 长尾占比。"""
    data = call_tool("market_get_keyword_root_trend", {
        "keyword": keyword, "country": country, "granularity": granularity,
    })
    latest = data.get("latest") or {}
    return {
        "keyword": _clean(keyword),
        "dates": data.get("dates") or [],
        "keyword_volumes": [_num(v) for v in (data.get("keyword_search_volumes") or [])],
        "keyword_ranks":   [_num(v) for v in (data.get("keyword_ranks") or [])],
        "ext_volumes":     [_num(v) for v in (data.get("ext_search_volumes") or [])],
        "data_points": data.get("data_points"),
        "latest": {
            "date":      latest.get("date"),
            "keyword_volume": _num(latest.get("keyword_search_volume")),
            "rank":      _num(latest.get("keyword_rank")),
            "ext_volume": _num(latest.get("ext_search_volume")),
            "exact_demand_pct":    latest.get("exact_keyword_demand_pct"),
            "longtail_demand_pct": latest.get("longtail_demand_pct"),
        },
    }


# ---------------------------------------------------------------------------
# ASIN 域工具封装（真·日粒度数据源）
# ---------------------------------------------------------------------------

def asin_traffic_trend(asin: str, country: str = "US", last_days: int = 30) -> list:
    """ASIN 逐日趋势（SIF 唯一的真日粒度接口）。返回按日期升序的数据点：
    [{date, price, buybox_price, bsr, sub_bsr, star, review, seller, bought_month,
      total_score, nf_score, ad_score, sp_score, sb_score, sbv_score, promotion, coupon}]
    注意：仅 granularity=day 返回价格/BSR/评价等字段。"""
    return asin_traffic_trend_full(asin, country, last_days)["points"]


def asin_traffic_trend_full(asin: str, country: str = "US", last_days: int = 30,
                            listing_search: bool = True,
                            begin_date: str = None, end_date: str = None) -> dict:
    """同 asin_traffic_trend，但额外返回序列元信息，供「趋势结论」做守卫：
    {points, dates, latest_point_date, latest_point_complete, notice}

    latest_point_complete=False 表示最后一天仍在采集/计算中 —— 做趋势判断、
    环比或「最近一天涨跌」时必须排除该点，否则会误报「今天暴跌/暴涨」。

    时间窗口二选一：传 begin_date（可选 end_date）走精确区间，否则用 last_days。
    与 SIF 语义一致：beginDate/endDate 为 yyyy-MM-dd 且含当日。
    """
    args = {
        "asin": asin, "country": country, "granularity": "day",
        "listingSearch": bool(listing_search),
    }
    if begin_date:
        args["beginDate"] = str(begin_date)[:10]
        if end_date:
            args["endDate"] = str(end_date)[:10]
    else:
        args["lastDays"] = int(last_days)
    data = call_tool("ops_get_asin_traffic_trend", args)
    dates = data.get("dates") or []

    def arr(name):
        v = data.get(name)
        return v if isinstance(v, list) else []

    prices, buybox = arr("dealPrice"), arr("buyboxPrice")
    bsr, star, review, seller = arr("bsr"), arr("star"), arr("review"), arr("seller")
    bought = arr("boughtInPastMonth")
    total, nf, ad = arr("totalScore"), arr("nfScore"), arr("adScore")
    sp, sb, sbv = arr("spScore"), arr("sbScore"), arr("sbvScore")
    promo, coupon = arr("promotion"), arr("couponInfo")
    sub_bsr = data.get("subBsr")

    def pick(lst, i):
        return _num(lst[i]) if i < len(lst) else None

    points = []
    for i, d in enumerate(dates):
        price = pick(prices, i)
        if price is None:
            price = pick(buybox, i)
        points.append({
            "date": d,
            "price": price,
            "buybox_price": pick(buybox, i),
            "bsr": pick(bsr, i),
            "sub_bsr": (sub_bsr[i] if isinstance(sub_bsr, list) and i < len(sub_bsr) else None),
            "star": pick(star, i),
            "review": pick(review, i),
            "seller": pick(seller, i),
            "bought_month": pick(bought, i),
            "total_score": pick(total, i),
            "nf_score": pick(nf, i),
            "ad_score": pick(ad, i),
            "sp_score": pick(sp, i),
            "sb_score": pick(sb, i),
            "sbv_score": pick(sbv, i),
            "promotion": (promo[i] if i < len(promo) else None),
            "coupon": (coupon[i] if i < len(coupon) else None),
        })
    return {
        "points": points,
        "dates": dates,
        "latest_point_date": data.get("latest_point_date"),
        "latest_point_complete": data.get("latest_point_complete"),
        "notice": data.get("data_notice"),
    }


def asin_profiles(asins: list, country: str = "US") -> list:
    """ASIN 静态属性快照（≤20 个/批）：标题/品牌/价格/评分/评论/BSR/上架日期/变体/尺寸重量。"""
    if not asins:
        return []
    data = call_tool("market_get_asin_profile", {"asins": asins[:20], "country": country})
    out = []
    for a in data.get("list") or []:
        dims = a.get("package_dims_in") or a.get("dims_in") or {}
        weight = a.get("package_weight_oz")
        if weight is None:
            weight = a.get("weight_oz")
        bsr_list = a.get("bsr_list") or []
        top = bsr_list[0] if bsr_list else {}
        asin = _clean(a.get("asin", ""))
        out.append({
            "asin": asin,
            "title": a.get("title") or "",
            "brand": a.get("brand") or "",
            "img": a.get("img"),
            "price": _num(a.get("price")),
            "star": _num(a.get("star_rating")),
            "rating_num": _num(a.get("rating_num")),
            "bought_month": _num(a.get("bought_in_past_month")),
            "first_available_day": a.get("first_available_day"),
            "variation_num": a.get("variation_num"),
            "weight_oz": _num(weight),
            "dims_in": {k: _num(v) for k, v in dims.items()} if isinstance(dims, dict) else {},
            "category": top.get("category_name"),
            "category_id": top.get("category_id"),
            "bsr": _num(top.get("rank")),
            "url": "https://www.amazon.com/dp/" + asin,
        })
    return out


def asin_sales_list(asins: list, country: str = "US", dimension: str = "asin",
                    recent_days: int = 30) -> list:
    """ASIN/变体销量列表（近 N 天滚动窗口，可按 color/size 维度）。"""
    data = call_tool("ops_get_asin_sales_list", {
        "asins": asins[:100], "country": country, "dimension": dimension,
        "timePieceType": "latelyDay", "timePieceValue": str(int(recent_days)),
        "pageSize": 100,
    })
    out = []
    for a in data.get("list") or []:
        out.append({
            "asin": _clean(a.get("asin", "")),
            "price": _num(a.get("price")),
            "color": a.get("color"),
            "size": a.get("size"),
            "bought_in_past_month": _num(a.get("boughtInPastMonth")),
            "bought_in_month": _num(a.get("boughtInMonth")),
        })
    return out


def asin_listing_keywords(asin: str, country: str = "US", recent_days: int = 7,
                          dimension: str = "asin",
                          time_piece_type: str = None, time_piece_value: str = None) -> list:
    """Listing 各变体的关键词覆盖量（自然 / SP / SB / SBV 分渠道）。

    周期二选一：传 time_piece_type + time_piece_value 走精确周期；
    只传 recent_days 时按 SIF 的 latelyDay 约束收敛到 7 / 30。

    注意：SIF 返回的顶层键是 `asins`（不是 `list`），历史上这里误写为 `list`
    导致恒返回空列表 —— 2026-10-21 实测修正。字段含义：
      · `total`  该变体覆盖的总词数（不是行数）
      · `brand`  是 **SB 广告词数**，不是品牌名；品牌名在 `brand_name`
    """
    if time_piece_type and time_piece_value:
        tp, tv = time_piece_type, str(time_piece_value)
    else:
        tp, tv = _days_to_piece(recent_days)
    data = call_tool("ops_get_listing_keyword_distribution", {
        "asin": asin, "country": country, "timePieceType": tp,
        "timePieceValue": tv, "dimension": dimension, "pageSize": 100,
    })
    out = []
    for a in data.get("asins") or []:
        out.append({
            "asin": _clean(a.get("asin", "")),
            "features": a.get("features") or [],
            "brand_name": a.get("brandName"),
            "price": _num(a.get("price")),
            "rating_num": _num(a.get("ratingNum")),
            "star": _num(a.get("star")),
            "is_best_seller": bool(a.get("isBestSeller")),
            "first_available_day": a.get("firstAvailableDay"),
            "dimensionValue": a.get("dimension"),
            "total": _num(a.get("total")),
            "natural": _num(a.get("natural")),
            "ad": _num(a.get("ad")),
            "sp": _num(a.get("sp")),
            "sp_rec": _num(a.get("spRec")),
            "rec": _num(a.get("rec")),
            "brand": _num(a.get("brand")),
            "video": _num(a.get("vedio")),
            "ac": _num(a.get("ac")),
        })
    return out


def _days_to_piece(days) -> tuple:
    """把「天数」收敛成 SIF 合法的 latelyDay 取值。

    实测（2026-10-21）：`ops_get_listing_traffic_*` 的 timePieceValue 在
    latelyDay 下**只接受 '7' / '30'**，传 14/45/90 会直接返回「参数错误」。
    所以这里做收敛而不是透传，避免调用方传了别的天数就整条链路报错。
    """
    try:
        d = int(days or 7)
    except (TypeError, ValueError):
        d = 7
    return "latelyDay", ("30" if d > 7 else "7")


def listing_traffic_overview(asin: str, country: str = "US",
                             time_piece_type: str = "latelyDay",
                             time_piece_value: str = "7",
                             listing_search: bool = True) -> dict:
    """Listing 流量构成（指定周期快照）。

    time_piece_type / time_piece_value 必须与 SIF 要求严格一致，否则不是报错就是
    静默空数据（实测 week 传非周日会返回 total=None 而不报错）：
      · latelyDay → '7' 或 '30'
      · week      → 该周周日日期，如 '2026-10-18'（SIF 以周日为每周第一天）
      · month     → 月份首日，如 '2026-10-01'
    归一化由 `traffic_compare.normalize_period()` 统一负责，调用方不要自己拼。

    返回 {total, nf, ad, channels, recommend, notice}：
      · nf / ad 各为 {name, score, ratio}，ratio 是占 total 的比例（0~1）
      · channels 是广告内部按 SP(常规) / SP(推荐) / SB / SBV 的拆解
      · recommend 是「推荐专栏来源分布」（如 Trending now / 4 stars and above），
        **键名动态，必须遍历，不可假设固定渠道**
    """
    data = call_tool("ops_get_listing_traffic_overview", {
        "asin": asin, "country": country,
        "timePieceType": time_piece_type, "timePieceValue": str(time_piece_value),
        "isListingSearch": bool(listing_search),
    })
    ov = data.get("overview") or {}

    def node(d):
        d = d or {}
        return {"name": d.get("name"), "score": _num(d.get("score")), "ratio": _num(d.get("ratio"))}

    ad_raw = data.get("ad") or {}
    channels = {}
    for key, label in (("sp", "SP(常规)"), ("recommend", "SP(推荐)"), ("sb", "SB"), ("sbv", "SBV")):
        n = node(ad_raw.get(key))
        if n["score"] is None and n["ratio"] is None:
            continue   # 该渠道无数据，不补 0
        channels[key] = {"name": n["name"] or label, "score": n["score"], "ratio": n["ratio"]}

    rec = []
    for k, v in (data.get("recommend") or {}).items():
        n = node(v)
        rec.append({"key": k, "name": n["name"] or k, "score": n["score"], "ratio": n["ratio"]})
    rec.sort(key=lambda x: -(x["score"] or 0))

    return {
        "total": _num(data.get("total")),
        "nf": node(ov.get("nf")),
        "ad": node(ov.get("ad")),
        "channels": channels,
        "recommend": rec,
        "notice": data.get("data_notice"),
    }


def listing_traffic_structure(asin: str, country: str = "US",
                              time_piece_type: str = "latelyDay",
                              time_piece_value: str = "7",
                              dimension: str = "asin", page_size: int = 100) -> dict:
    """各变体的流量结构拆解（周期参数约束同 listing_traffic_overview）。

    SIF 返回的是**多条平行数组**：`chars.dims[i]` 与 `chars.nfs[i]/ads[i]/sps[i]/...`
    同下标即同一变体，这里按配对标好再返回，避免调用方自己错位。
    每个渠道行是 {score, ratio, dist}：
      · ratio 是**纵向占比**（该渠道内部，各变体之间比）
      · dist  是**横向占比**（该变体内部，各渠道之间比）
      · None 表示该渠道无数据，不得当作 0
    """
    data = call_tool("ops_get_listing_traffic_structure", {
        "asin": asin, "country": country,
        "timePieceType": time_piece_type, "timePieceValue": str(time_piece_value),
        "dimension": dimension, "pageSize": int(page_size),
    })
    chars = data.get("chars") or {}
    dims = chars.get("dims") or []
    keys = ("nfs", "ads", "sps", "sbs", "sbvs", "recs")
    arrays = {k: (chars.get(k) or []) for k in keys}

    def at(name, i):
        lst = arrays.get(name) or []
        if i >= len(lst):
            return None
        row = lst[i] or {}
        if row.get("score") is None and row.get("ratio") is None and row.get("dist") is None:
            return None
        return {"score": _num(row.get("score")), "ratio": _num(row.get("ratio")),
                "dist": _num(row.get("dist"))}

    variants = []
    for i, d in enumerate(dims):
        if not isinstance(d, dict):
            continue
        variants.append({
            "asin": _clean(d.get("val", "")),
            "features": d.get("features") or [],
            "img": d.get("img"),
            "sum_score": _num(d.get("sumScore")),
            "ratio": _num(d.get("ratio")),
            "is_variant": bool(d.get("isVariant")),
            "nf": at("nfs", i),
            "ad": at("ads", i),
            "sp": at("sps", i),
            "sb": at("sbs", i),
            "sbv": at("sbvs", i),
            "rec": at("recs", i),
        })
    return {
        "total_rows": _num(data.get("total")),
        "total_score": _num(data.get("totalScore")),
        "variants": variants,
        "notice": data.get("data_notice"),
    }


def asin_keyword_signals(asin: str, country: str = "US", recent_days: int = 7,
                         top_n: int = 30) -> dict:
    """ASIN 关键词级流量信号（点查用）：流失词 / 增长词 / 排名断档 + 主要词清单。"""
    data = call_tool("market_get_asin_keyword_signals", {
        "asin": asin, "country": country, "time_type": "lately",
        "time_value": str(int(recent_days)), "topN": int(top_n),
    })
    ps = data.get("primary_signals") or {}

    def slim(items):
        return [{
            "keyword":       _clean(i.get("keyword", "")),
            "traffic_share": _num(i.get("traffic_share")),
            "contri_change": _num(i.get("contri_change")),
            # organic_rank 原始是 "p1,2/48"，必须走 parse_rank（见上面的说明）
            "organic_rank":  _rk["rank"] if (_rk := parse_rank(i.get("organic_rank"))) else None,
            "organic_page":  _rk["page"] if _rk else None,
            "organic_pos":   _rk["pos"] if _rk else None,
            "organic_rank_time": i.get("organic_rank_time_cn") or i.get("organic_rank_time_us"),
            "rank_evolution": i.get("rank_evolution"),
            "health":        i.get("keyword_health"),
            "search_volume": _num(i.get("search_volume")),
            "natural_ratio": _num(i.get("natural_ratio")),
            "top3_click_share": _num(i.get("top3_click_share")),
        } for i in (items or [])]

    return {
        "asin": asin,
        "declining":   slim(ps.get("declining")),
        "gaining":     slim(ps.get("gaining")),
        "rank_gaps":   slim(ps.get("rank_gaps")),
        "top_keywords": slim(data.get("top_keywords")),
    }


def aba_footprint(asin: str, country: str = "US", top_n: int = 500) -> dict:
    """ASIN 反查 ABA 卡位地图：它在哪些搜索词上进了 top3（买家点击口径）。

    与 asin_keyword_signals 互补，别混用：
      · 本接口 = **ABA 买家真实点击**视角（rank1/2/3 卡位强弱，词数少而准）
      · signals  = **SIF 自建流量**视角（自然排名、广告位、健康度，词多而宽）
    同一个 ASIN 可能「signals 里有 30 个词带自然排名，ABA 只卡住 4 个词的 top3」。
    """
    data = call_tool("market_get_asin_aba_footprint", {
        "asin": asin, "country": country, "topN": int(top_n),
    }, timeout=90, retries=1)
    rd = data.get("rank_distribution") or {}
    kws = []
    for k in (data.get("keywords") or [])[:200]:
        kws.append({
            "keyword": k.get("keyword"),
            "search_volume": _num_r(k.get("search_volume"), 0),
            "aba_rank": _num_r(k.get("rank"), 0),
        })
    return {
        "asin": asin,
        "rank_distribution": {
            "rank1": _num_r(rd.get("rank1"), 0),
            "rank2": _num_r(rd.get("rank2"), 0),
            "rank3": _num_r(rd.get("rank3"), 0),
        },
        "total_keyword_count": _num_r(data.get("total_keyword_count"), 0),
        "total_covered_volume": _num_r(data.get("total_covered_volume"), 0),
        "keywords": kws,
        "notice": data.get("data_notice"),
    }


def root_competitors(keyword_root: str, country: str = "US", top_n: int = 10) -> dict:
    """词根头部竞品（ABA 买家点击口径）。返回 {competitors:[{asin,url,keyword_count,
    covered_volume,rank1_count,...}], total}"""
    data = call_tool("market_get_keyword_root_competitors", {
        "keyword_root": keyword_root, "country": country, "topN": int(top_n),
    })
    comps = []
    for c in data.get("competitors") or []:
        comps.append({
            "asin": _clean(c.get("asin", "")),
            "url": c.get("url"),
            "keyword_count": _num(c.get("keyword_count")),
            "covered_volume": _num(c.get("covered_volume")),
            "rank1_count": _num(c.get("rank1_count")),
            "rank2_count": _num(c.get("rank2_count")),
            "rank3_count": _num(c.get("rank3_count")),
        })
    return {"competitors": comps, "total": data.get("total") or len(comps)}


def discover_competitors(keyword: str, country: str = "US", filters: dict = None) -> dict:
    """关键词 Top100 格局四维分析（点查用，可按价格带/评论门槛/竞争姿态收敛）。"""
    args = {"keyword": keyword, "country": country}
    for k in ("price_min", "price_max", "max_reviews", "posture_filter", "my_asin", "max_results"):
        if (filters or {}).get(k) not in (None, ""):
            args[k] = (filters or {})[k]
    data = call_tool("market_discover_competitors", args)
    comps = []
    for c in data.get("competitors") or []:
        comps.append({
            "asin": _clean(c.get("asin", "")),
            "url": c.get("url"),
            "price": _num(c.get("price")),
            "review_count": _num(c.get("review_count")),
            "monthly_orders": _num(c.get("monthly_orders")),
            "posture": c.get("posture"),
            "serp_share": _num(c.get("serp_share")),
        })
    return {"landscape": data.get("landscape") or {}, "competitors": comps,
            "filter_applied": data.get("filter_applied")}


# ---------------------------------------------------------------------------
# 市场 / 决策类点查工具
# ---------------------------------------------------------------------------

def keyword_competition(keyword: str, country: str = "US") -> dict:
    """关键词竞争格局（重接口，仅点查）。裁掉 _formatted 并截断竞品列表避免响应过大。"""
    data = call_tool("market_get_keyword_competition", {"keyword": keyword, "country": country})
    out = {k: v for k, v in data.items() if k not in ("_formatted", "_next_step")}
    if isinstance(out.get("top_competitors"), list):
        out["top_competitors"] = out["top_competitors"][:20]
    return out


def _num_r(value, nd=2):
    """_num 的带精度版本。nd=0 时返回 int —— 排名、评论数这类整数指标不能返回 1.0。"""
    x = _num(value)
    if x is None:
        return None
    try:
        return int(round(float(x))) if nd == 0 else round(float(x), nd)
    except (TypeError, ValueError):
        return None


def _plain_asin(v) -> str:
    """SIF 的 asin 字段常带 markdown 链接 `[B0XXX](url)`，这里只留 ASIN 本身。"""
    s = str(v or "").strip()
    m = re.match(r"\[([^\]]+)\]", s)
    if m:
        return m.group(1).strip().upper()
    return s.upper()


def keyword_competition_rank(keyword: str, country: str = "US", asin: str = None,
                             time_type: str = None, time_value: str = None,
                             top_n: int = 100, on_retry=None) -> dict:
    """关键词竞争格局（排名监测专用）：精简版竞品榜 + 市场结构 + 我的卡位。

    **三种「排名」口径不同，字段名刻意区分，不要混用**：
      · `competitors[].share_rank` 该词下的**流量份额排名**（按 total_share 排序，1 起）
      · `my_position.rank`         我方份额排名；null = 不在榜
      · `my_position.rank_tier`    absent / top3 / ... 卡位分档
    自然搜索位不在这里，在 `asin_keyword_signals().top_keywords[].organic_rank`。

    time_type/time_value 走 ABA 周/月（week 需传周日日期），不传则取最新一期。
    """
    args = {"keyword": keyword, "country": country}
    if asin:
        args["asin"] = asin
    if time_type:
        args["time_type"] = time_type
        if time_value:
            args["time_value"] = time_value
    data = call_tool("market_get_keyword_competition", args, timeout=90, retries=1,
                    on_retry=on_retry)

    comps = []
    for c in (data.get("top_competitors") or [])[:int(top_n)]:
        comps.append({
            "asin":            _plain_asin(c.get("asin")),
            "price":           _num_r(c.get("price")),
            "rating":          _num_r(c.get("rating"), 1),
            "review_count":    _num_r(c.get("review_count"), 0),
            "monthly_orders":  c.get("monthly_orders"),
            "organic_share":   _num_r(c.get("organic_share"), 4),
            "sp_share":        _num_r(c.get("sp_share"), 4),
            "brand_share":     _num_r(c.get("brand_share"), 4),
            "video_share":     _num_r(c.get("video_share"), 4),
            "total_share":     _num_r(c.get("total_share"), 4),
            "share_rank":      _num_r(c.get("rank"), 0),
            "competition_mode": c.get("competition_mode"),
            "listed_age_days": _num_r(c.get("listed_age_days"), 0),
        })
    # 排序与「补名次」的原则：**以 SIF 给的 rank 为准**，不自己另起一套口径。
    # 实测 SIF 的 rank 恒为 1..N 且与 total_share 严格降序一致；只有它真的缺了才兜底，
    # 且必须打上 rank_derived 标记 —— 否则用户分不清哪是 SIF 给的、哪是我们算的。
    comps.sort(key=lambda x: (x["share_rank"] if x["share_rank"] else 10 ** 6,
                              -(x["total_share"] or 0)))
    derived = 0
    for i, c in enumerate(comps, 1):
        if not c["share_rank"]:
            c["share_rank"] = i
            c["rank_derived"] = True
            derived += 1
    if derived:
        _log(f"[sif] keyword_competition {keyword}: {derived} 条缺 rank，已按份额顺序兜底")

    ms = data.get("market_structure") or {}
    conc = (data.get("concentration_profile") or {})
    cur = conc.get("current") or {}
    trend = conc.get("trend") or {}
    gap_hist = conc.get("conversion_gap_history") or {}
    lead = conc.get("leadership") or {}
    pos = data.get("my_position") or {}

    # SIF 会回一个 query_context 告诉我们**这份数据是哪一期**。
    # 不传 time_type 时它自动对齐到「最新一期 ABA 周」，同一周内每天抓到的都是同一份，
    # 所以必须把这个周期存下来，否则用户看到「每天数据一模一样」会以为程序坏了。
    qc = data.get("query_context") or {}
    dw = qc.get("data_window") or {}
    period = {
        "granularity": dw.get("granularity") or qc.get("time_type"),
        "start":       dw.get("week_start") or qc.get("time_value"),
        "end":         dw.get("week_end"),
        "auto_aligned": dw.get("auto_aligned"),
    } if (dw or qc) else None

    return {
        "keyword":          keyword,
        "country":          country,
        "time":             {"type": time_type, "value": time_value} if time_type else None,
        # 数据周期（例：{"granularity":"week","start":"2026-10-18","end":"2026-10-24"}）
        "period":           period,
        "data_notice":      data.get("data_notice"),
        "competitor_count": len(comps),
        "competitors":      comps,
        "market_structure": {
            "visible_asin_count":    _num_r(ms.get("visible_asin_count"), 0),
            "concentration_level":   ms.get("concentration_level"),
            "competition_mode":      ms.get("competition_mode"),
            "top3_click_share":      _num_r(ms.get("top3_click_share"), 4),
            "top3_conversion_share": _num_r(ms.get("top3_conversion_share"), 4),
            "conversion_gap":        ms.get("conversion_gap"),
            "insight":               ms.get("conversion_gap_insight"),
        },
        "concentration": {
            "top3_click_share":      _num_r(cur.get("top3_click_share"), 4),
            "top3_conversion_share": _num_r(cur.get("top3_conversion_share"), 4),
            "click_direction":       (trend.get("click") or {}).get("direction"),
            "click_annual_rate":     _num_r((trend.get("click") or {}).get("annual_rate"), 4),
            "conversion_direction":  (trend.get("conversion") or {}).get("direction"),
            "divergence":            conc.get("divergence"),
            "divergence_insight":    conc.get("divergence_insight"),
            "gap_open":              gap_hist.get("currently_open"),
            "gap_weeks":             _num_r(gap_hist.get("consecutive_weeks"), 0),
            "gap_insight":           gap_hist.get("gap_insight"),
            "click_leader":          _plain_asin(lead.get("click_leader")),
            "click_leader_stability": lead.get("click_leader_stability"),
            "leader_diverge":        lead.get("leader_diverge"),
            "leader_diverge_insight": lead.get("leader_diverge_insight"),
        },
        "my_position": {
            "asin":      _plain_asin(pos.get("asin")) if pos.get("asin") else (asin or None),
            "share_rank": _num_r(pos.get("rank"), 0),
            "rank_tier": pos.get("rank_tier"),
            "position":  pos.get("competition_position"),
            "insight":   pos.get("key_insight"),
        } if pos else None,
        "notice": data.get("data_notice"),
    }


def assess_promotion(keywords: list, country: str = "US", own_price: float = None,
                     own_margin: float = None, benchmark_asins: list = None) -> dict:
    """关键词推广可行性评估（≤20 词）：出价区间 + 盈亏平衡 + 该不该打广告的结论。"""
    args = {"keywords": keywords[:20], "country": country}
    if own_price:
        args["own_price"] = float(own_price)
    if own_margin:
        args["own_margin"] = float(own_margin)
    if benchmark_asins:
        args["benchmark_asins"] = benchmark_asins[:3]
    data = call_tool("market_assess_keyword_promotion", args)
    out = []
    for a in data.get("assessments") or []:
        f = a.get("_formatted") or {}
        out.append({
            "keyword":        _clean(a.get("keyword", "")),
            "judgment":       a.get("judgment") or f.get("judgment"),
            "recommendation": a.get("recommendation") or f.get("recommendation"),
            "anchor_sentence": f.get("anchor_sentence"),
            "evidence_block":  f.get("evidence_block"),
            "econ_table":      f.get("econ_table"),
            "cpc_table":       f.get("cpc_table"),
            "cpc_action_hint": f.get("cpc_action_hint"),
        })
    return {"assessments": out}


def profit_threshold(args: dict) -> dict:
    """采购成本上限反推（本地费率计算，无外部数据依赖）。入参/出参直接透传。"""
    data = call_tool("market_estimate_profit_threshold", args)
    return data if isinstance(data) else {}


# ---------------------------------------------------------------------------
# 任务编排（分层）
# ---------------------------------------------------------------------------

MIN_INTERVAL   = 0.3    # 两次 SIF 调用之间的最小间隔（秒）
DEMAND_BATCH   = 10     # keyword_demand 单次批量上限
HISTORY_BATCH  = 10     # keyword_history 单次批量上限
PROFILE_BATCH  = 20     # asin_profile 单次批量上限

ASIN_BACKFILL_DAYS = 90   # 新入池 ASIN 首次回补天数
ASIN_WINDOW_DAYS   = 30   # 每日层滚动窗口（重叠部分靠 UNIQUE 约束幂等覆盖）


class _Throttle:
    """简单节流：保证两次调用间隔 ≥ MIN_INTERVAL 秒。"""

    def __init__(self):
        self.last = 0.0

    def wait(self):
        dt = time.time() - self.last
        if dt < MIN_INTERVAL:
            time.sleep(MIN_INTERVAL - dt)
        self.last = time.time()


def new_stats() -> dict:
    return {"calls": 0, "screen_calls": 0, "demand_calls": 0, "history_calls": 0,
            "asin_trend_calls": 0, "profile_calls": 0, "competitor_calls": 0,
            "discovered": 0, "profiles_updated": 0, "asin_monitored": 0,
            "asin_new": 0, "asin_points_saved": 0, "errors": 0, "error_detail": [],
            "fatal": []}


def run_daily_layer(task: dict, pool: list, stats: dict, th: _Throttle,
                    on_kw_snapshot=None, on_asin_points=None) -> list:
    """每日层：机会词发现 + 当日关键词快照 + 监控池 ASIN 逐日数据。
    pool = [{asin, _backfillDays?}, ...]；返回本次关键词候选行（由调用方落库）。"""
    country = (task.get("country") or "US").upper()
    top_n = int(task.get("topN") or 8)
    mode = task.get("mode") or "root"

    # 1) 关键词发现 → 当日快照
    candidates = {}
    if mode == "root":
        for root in [r.strip() for r in (task.get("roots") or []) if r and r.strip()]:
            th.wait()
            try:
                for f in screen_opportunities(root, country, top_n):
                    kw = f["keyword"]
                    if kw and kw not in candidates:
                        f["root"] = root
                        candidates[kw] = f
                stats["screen_calls"] += 1
                stats["calls"] += 1
            except SifError as e:
                record_error(stats, f"screen({root})", e)
    else:
        for kw in (task.get("keywords") or []):
            kw = (kw or "").strip()
            if kw:
                candidates[kw] = {"keyword": kw}

    quota = max(1, int(task.get("quotaLimit") or 30))
    ordered = sorted(candidates.values(), key=lambda x: (x.get("search_volume") or 0), reverse=True)
    ordered = ordered[:quota]
    stats["discovered"] = len(ordered)
    if on_kw_snapshot and ordered:
        on_kw_snapshot(ordered)

    # 2) ASIN 监控池逐日数据
    items = [a for a in (pool or []) if a.get("asin")]
    stats["asin_monitored"] = len(items)
    for it in items:
        asin = it["asin"]
        need = int(it.get("_backfillDays") or ASIN_WINDOW_DAYS)
        need = max(3, min(need, 180))
        th.wait()
        try:
            points = asin_traffic_trend(asin, country, need)
            stats["asin_trend_calls"] += 1
            stats["calls"] += 1
            if points and on_asin_points:
                on_asin_points(asin, points)
                stats["asin_points_saved"] += len(points)
        except SifError as e:
            record_error(stats, f"asin_trend({asin})", e)
    return ordered


def run_weekly_layer(task: dict, keywords: list, stats: dict, th: _Throttle,
                     on_profile=None, on_trend=None, on_competitors=None) -> list:
    """每周层：需求画像 + 周度趋势 + 词根头部竞品（自动扩充监控池）。返回竞品 ASIN 候选。"""
    country = (task.get("country") or "US").upper()
    top_n = int(task.get("topN") or 8)
    kws = [k for k in (keywords or []) if k]
    new_asins = []

    for i in range(0, len(kws), DEMAND_BATCH):
        th.wait()
        try:
            d = keyword_demand(kws[i:i + DEMAND_BATCH], country)
            stats["demand_calls"] += 1
            stats["calls"] += 1
            if on_profile and d["profiles"]:
                on_profile(d["profiles"])
                stats["profiles_updated"] += len(d["profiles"])
        except SifError as e:
            record_error(stats, "demand", e)

    for i in range(0, len(kws), HISTORY_BATCH):
        th.wait()
        try:
            h = keyword_history(kws[i:i + HISTORY_BATCH], country, "week")
            stats["history_calls"] += 1
            stats["calls"] += 1
            if on_trend and h["series"]:
                on_trend(h["series"])
        except SifError as e:
            record_error(stats, "history", e)

    if (task.get("mode") or "root") == "root" and task.get("autoAsin", True):
        for root in [r.strip() for r in (task.get("roots") or []) if r and r.strip()]:
            th.wait()
            try:
                rc = root_competitors(root, country, top_n=10)
                stats["competitor_calls"] += 1
                stats["calls"] += 1
                if on_competitors:
                    on_competitors(root, rc["competitors"])
                for c in rc["competitors"]:
                    if c.get("asin"):
                        new_asins.append({
                            "asin": c["asin"], "url": c.get("url"),
                            "covered_volume": c.get("covered_volume"),
                            "keyword_count": c.get("keyword_count"),
                            "rank1_count": c.get("rank1_count"),
                            "source": "competitor", "root": root,
                        })
            except SifError as e:
                record_error(stats, f"competitors({root})", e)
    return new_asins


def collect_asin_candidates(kw_rows: list, existing: set, limit: int) -> list:
    """从机会词快照的 Top3 点击 ASIN 收集候选监控 ASIN（去重、不超过上限）。"""
    out = []
    seen = set(existing)
    budget = max(0, limit - len(existing))
    for r in kw_rows or []:
        for a in (r.get("top_asins") or []):
            if not a or a in seen:
                continue
            seen.add(a)
            out.append({"asin": a, "source": "opportunity", "keyword": r.get("keyword")})
            if len(out) >= budget:
                return out
    return out


def enrich_asin_profiles(asins: list, stats: dict, th: _Throttle, country: str = "US") -> list:
    """批量补 ASIN 静态属性（每批 ≤20 个）。"""
    out = []
    codes = [a for a in asins if a]
    for i in range(0, len(codes), PROFILE_BATCH):
        th.wait()
        try:
            out.extend(asin_profiles(codes[i:i + PROFILE_BATCH], country))
            stats["profile_calls"] += 1
            stats["calls"] += 1
        except SifError as e:
            record_error(stats, "asin_profile", e)
    return out
