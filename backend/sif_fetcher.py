#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SIF (mcp.sif.com) 关键词数据抓取器
=====================================
通过 HTTP JSON-RPC 直连 SIF 的 MCP 端点（Streamable HTTP 传输），
不需要经过 Claude Code / LLM，供「关键词监测」工具模块的定时任务使用。

端点与密钥配置（按优先级）：
  1. 环境变量 SIF_MCP_URL / SIF_MCP_KEY
  2. data/sif-config.json：{"url": "https://mcp.sif.com/mcp", "key": "..."}
     （data/ 目录已被 .gitignore 忽略，密钥不入 git）

支持的核心工具（P1）：
  - market_screen_keyword_opportunities  按词根筛机会词（方向发现）
  - market_get_keyword_demand            批量关键词需求画像（季节/时机）
  - market_get_keyword_history           关键词历史趋势（量/排名/点击份额）

依赖：仅 Python 标准库（urllib + ThreadPoolExecutor + json），
与 backend/rank_fetcher.py 保持零第三方依赖约定。
"""

import json
import os
import re
import threading
import time
import urllib.request
import urllib.parse
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


class SifError(Exception):
    """SIF 调用失败（未配置/网络/业务错误），message 面向用户展示。"""


# ---------------------------------------------------------------------------
# 底层 JSON-RPC 调用
# ---------------------------------------------------------------------------

def call_tool(name: str, arguments: dict, timeout: int = 60) -> dict:
    """调用 SIF MCP 工具，返回结构化 JSON（dict）。失败抛 SifError。"""
    url, key = _load_config()
    if not key:
        raise SifError("SIF MCP 未配置：请设置环境变量 SIF_MCP_KEY 或创建 data/sif-config.json")
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
        raise SifError(f"SIF HTTP {e.code}: {e.read()[:200]}") from e
    except Exception as e:
        raise SifError(f"SIF 网络错误: {type(e).__name__}: {e}") from e

    # 响应可能是纯 JSON，也可能是 SSE 流（逐行 data:）
    payload = _parse_mcp_response(raw)
    if payload is None:
        raise SifError(f"SIF 响应解析失败: {raw[:200]}")
    if isinstance(payload, dict) and payload.get("error"):
        msg = payload["error"].get("message", "unknown")
        raise SifError(f"SIF 错误: {msg}")
    result = payload.get("result", {}) if isinstance(payload, dict) else {}
    if result.get("isError"):
        # 错误信息在 content[0].text 里，通常带 error/message 字段
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
        raise SifError(f"SIF 工具 {name} 失败: {err_text[:300]}")
    # 取出 content 里的 JSON 文本
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
    # SSE：取最后一个 data: 行
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
# 响应清洗：去掉 markdown 链接包装（"[B0XXX](url)" -> "B0XXX"）
# ---------------------------------------------------------------------------

_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")


def _clean(value):
    if isinstance(value, str):
        m = _LINK_RE.match(value.strip())
        return m.group(1) if m else value
    return value


def _clean_recursive(obj):
    if isinstance(obj, list):
        return [_clean_recursive(v) for v in obj]
    if isinstance(obj, dict):
        return {k: (_clean_recursive(v) if k != "_formatted" else "<formatted>") for k, v in obj.items()}
    return _clean(obj)


# ---------------------------------------------------------------------------
# 工具封装
# ---------------------------------------------------------------------------

def screen_opportunities(keyword_root: str, country: str = "US", top_n: int = 8) -> list:
    """按词根筛选机会词，返回 [{keyword, search_volume, click_share_top3, cvr,
    cpc, traffic_cost_per_unit, entry_signal, data_period, top3_click_asins}]"""
    data = call_tool("market_screen_keyword_opportunities", {
        "keyword_root": keyword_root, "country": country, "topN": int(top_n),
    })
    kws = data.get("keywords") or []
    out = []
    for k in kws:
        asins = [_clean(a) for a in (k.get("top3_click_asins") or [])]
        out.append({
            "keyword":        _clean(k.get("keyword", "")),
            "search_volume":  k.get("search_volume"),
            "click_share":    k.get("click_share_top3"),
            "cvr":            k.get("cvr"),
            "cpc":            k.get("cpc"),
            "traffic_cost":   k.get("traffic_cost_per_unit"),
            "entry_signal":   _clean(k.get("entry_signal")),
            "data_period":    k.get("data_period"),
            "top_asins":      asins[:3],
        })
    return out


def keyword_demand(keywords: list, country: str = "US") -> dict:
    """批量关键词需求画像。返回 {profiles: [{keyword, demand_structure, trend,
    seasonality, peak_month, trough_month, weeks_to_peak, diagnosis, ...}],
    timing_summary: [...]}"""
    data = call_tool("market_get_keyword_demand", {
        "keywords": keywords, "country": country,
    })
    profiles = []
    for p in data.get("profiles") or []:
        tr = p.get("trend") or {}
        profiles.append({
            "keyword":        _clean(p.get("keyword", "")),
            "demand_type":    ((p.get("demand_structure") or {}).get("primary_type")) or "",
            "ad_hint":        _clean(((p.get("demand_structure") or {}).get("ad_strategy_hint")) or ""),
            "search_volume":  (p.get("current") or {}).get("search_volume"),
            "season_position": (p.get("current") or {}).get("season_position"),
            "trend_direction": tr.get("direction"),
            "yoy_change":     tr.get("yoy_change"),
            "momentum":       tr.get("momentum"),
            "peak_month":     p.get("peak_month"),
            "trough_month":   p.get("trough_month"),
            "weeks_to_peak":  p.get("weeks_to_peak"),
            "seasonal_strength": p.get("seasonal_strength"),
            "diagnosis":      _clean(p.get("diagnosis") or ""),
            "interpretation": _clean(p.get("interpretation") or ""),
        })
    return {"profiles": profiles, "timing": data.get("timing_summary") or []}


def keyword_history(keywords: list, country: str = "US", granularity: str = "weekly") -> dict:
    """关键词历史趋势（量/排名/点击份额），返回 {series: {keyword: {dates,
    volumes, ranks, top3_click_shares, latest}}}}"""
    data = call_tool("market_get_keyword_history", {
        "keywords": keywords, "country": country, "granularity": granularity,
    })
    series = {}
    for k in data.get("keywords") or []:
        kw = _clean(k.get("keyword", ""))
        series[kw] = {
            "dates":   k.get("dates") or [],
            "volumes": k.get("volumes") or [],
            "ranks":   k.get("ranks") or [],
            "click_shares": k.get("top3_click_shares") or [],
            "latest":  k.get("latest") or {},
        }
    return {"series": series, "notice": data.get("data_notice") or ""}


# ---------------------------------------------------------------------------
# 任务编排（供 routes / 调度器调用）
# ---------------------------------------------------------------------------

MIN_INTERVAL = 0.3   # 两次 SIF 调用之间的最小间隔（秒），避免触发限流
MAX_DEMAND_BATCH = 10  # keyword_demand 单次批量上限


def _throttle(prev: list):
    """简单节流：距上一次调用至少 MIN_INTERVAL 秒。"""
    if prev:
        dt = time.time() - prev[0]
        if dt < MIN_INTERVAL:
            time.sleep(MIN_INTERVAL - dt)
    prev[0] = time.time()


def run_task(task: dict, progress_cb=None) -> dict:
    """执行一次任务抓取，返回 {items: [快照行 dict], stats: {...}}。
    不写数据库（由调用方决定落库），保证纯函数可测。"""
    mode = task.get("mode") or "root"
    country = (task.get("country") or "US").upper()
    top_n = int(task.get("topN") or 8)
    quota = max(1, int(task.get("quotaLimit") or 30))
    throttle = [0.0]
    stats = {"screen_calls": 0, "demand_calls": 0, "history_calls": 0,
             "discovered": 0, "enriched": 0, "errors": 0}

    # ---- 1) 发现候选关键词 ----
    candidates: dict = {}   # keyword -> screen 信息
    if mode == "root":
        roots = [r.strip() for r in (task.get("roots") or []) if r and r.strip()]
        for root in roots:
            _throttle(throttle)
            try:
                found = screen_opportunities(root, country, top_n)
                stats["screen_calls"] += 1
                for f in found:
                    kw = f["keyword"]
                    if kw and kw not in candidates:
                        candidates[kw] = f
            except SifError as e:
                stats["errors"] += 1
                print(f"  [sif] screen '{root}' 失败: {e}")
    else:
        for kw in (task.get("keywords") or []):
            kw = (kw or "").strip()
            if kw:
                candidates[kw] = {"keyword": kw}

    stats["discovered"] = len(candidates)
    if not candidates:
        return {"items": [], "stats": stats}

    # 按搜索量降序，截断到配额
    ordered = sorted(candidates.values(),
                     key=lambda x: (x.get("search_volume") or 0), reverse=True)
    ordered = ordered[:quota]

    # ---- 2) 批量需求画像 ----
    demand_map = {}
    kws = [f["keyword"] for f in ordered]
    for i in range(0, len(kws), MAX_DEMAND_BATCH):
        _throttle(throttle)
        try:
            d = keyword_demand(kws[i:i + MAX_DEMAND_BATCH], country)
            stats["demand_calls"] += 1
            for p in d["profiles"]:
                demand_map[p["keyword"]] = p
        except SifError as e:
            stats["errors"] += 1
            print(f"  [sif] demand 批量失败: {e}")
    stats["enriched"] = len(demand_map)

    # ---- 3) 头部词补历史趋势（最多 5 个，供趋势图） ----
    top_kws = [f["keyword"] for f in ordered[:5] if f["keyword"] in demand_map]
    if top_kws:
        _throttle(throttle)
        try:
            h = keyword_history(top_kws, country, "weekly")
            stats["history_calls"] += 1
        except SifError as e:
            h = {"series": {}}
            stats["errors"] += 1
            print(f"  [sif] history 失败: {e}")
    else:
        h = {"series": {}}

    # ---- 4) 组装快照行 ----
    items = []
    for f in ordered:
        kw = f["keyword"]
        d = demand_map.get(kw, {})
        s = h["series"].get(kw, {})
        rank = None
        if s.get("ranks"):
            rank = s["ranks"][-1]
        elif d.get("search_volume") is None:
            rank = None
        items.append({
            "keyword": kw,
            "search_volume": d.get("search_volume") if d.get("search_volume") is not None
                             else f.get("search_volume"),
            "rank": rank,
            "cpc": f.get("cpc") or d.get("cpc"),
            "entry_signal": f.get("entry_signal") or d.get("diagnosis") or "",
            "demand": d,
            "detail": {
                "screen": {k2: f[k2] for k2 in ("click_share", "cvr", "traffic_cost",
                                                "data_period", "top_asins") if k2 in f},
                "history": {"dates": s.get("dates", [])[:60],
                            "volumes": s.get("volumes", [])[:60],
                            "ranks": s.get("ranks", [])[:60]},
            },
        })
    return {"items": items, "stats": stats}


def execute_and_save(state, task: dict) -> dict:
    """执行任务并落库：更新任务状态 -> 抓取 -> 写 sif_snapshots -> 回写状态。
    返回 stats；失败抛 SifError（状态已由调用方处理）。"""
    tid = task["id"]
    state.set_sif_task_status(tid, "running", error=None)
    try:
        result = run_task(task)
    except Exception as e:
        state.set_sif_task_status(tid, "error", error=str(e)[:500], run_at=_now_iso())
        raise
    run_date = _now_iso()[:10]
    captured_at = _now_iso()
    items = result["items"]
    if items:
        state.save_sif_snapshots(tid, run_date, captured_at, items)
    err = result["stats"].get("errors") and f"{result['stats']['errors']} 次工具调用失败" or None
    state.set_sif_task_status(tid, "done", error=err, run_at=captured_at)
    result["run_date"] = run_date
    return result
