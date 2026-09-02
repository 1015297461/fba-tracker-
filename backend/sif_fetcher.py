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
import time
import urllib.request
import urllib.error

from .utils import PROJECT_ROOT, _now_iso

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

def call_tool(name: str, arguments: dict, timeout: int = 60) -> dict:
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
    data = call_tool("ops_get_asin_traffic_trend", {
        "asin": asin, "country": country, "granularity": "day", "lastDays": int(last_days),
    })
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
    return points


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
                          dimension: str = "asin") -> list:
    """Listing 各变体的关键词覆盖量（自然 / SP / SB / SBV 分渠道）。"""
    data = call_tool("ops_get_listing_keyword_distribution", {
        "asin": asin, "country": country, "timePieceType": "latelyDay",
        "timePieceValue": str(int(recent_days)), "dimension": dimension, "pageSize": 100,
    })
    out = []
    for a in data.get("list") or []:
        out.append({
            "asin": _clean(a.get("asin", "")),
            "dimensionValue": a.get("dimensionValue"),
            "total": _num(a.get("total")),
            "natural": _num(a.get("natural")),
            "ad": _num(a.get("ad")),
            "sp": _num(a.get("sp")),
            "rec": _num(a.get("rec")),
            "brand": _num(a.get("brand")),
            "video": _num(a.get("vedio")),
        })
    return out


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
            "organic_rank":  _num(i.get("organic_rank")),
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
