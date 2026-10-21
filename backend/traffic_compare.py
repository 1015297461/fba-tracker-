#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 流量分析 —— 取数与指标计算层
================================
给「AI 分析 → 产品流量 / 竞品对比」提供**确定性的数据底座**：
Python 负责把数据取全、把指标算死，AI 只负责解释与写建议。

为什么不让 AI 自己调 MCP：
  · 1 自身 + 3 竞品 ≈ 20 次工具调用，慢且贵；
  · 原始 JSON 全进上下文，口径容易被 AI 混用（父体分 vs 子体明细）；
  · 同样输入两次结论不同，无法复现，也无法"先看数据再花钱"。

本模块的产出是一个 data.json（含口径元数据），可复算、可缓存、可离线核对。

口径红线（与 docs/plans/traffic-compare-ai-plan.md 第十节一致）：
  1. SIF 的 score 是**无量纲相对分**，只用于算占比 / 倍数 / 涨跌，绝不换算成 UV。
  2. 自身与所有竞品必须同一 `listingSearch`、同一时间窗。
  3. `latest_point_complete=false` 时最后一点不参与趋势与环比。
  4. 渠道缺失 = 无数据，不补 0，也不进分母。
  5. ratio 有两层：`overview.ad.sp.ratio` 是**占广告**，不是占总量；
     占总量需 `ad.ratio × channel.ratio`，本模块两种都给出且命名区分。
"""

import datetime
import json
import os
import statistics
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import sif_fetcher as sf
from .utils import PROJECT_ROOT, _now_iso, _log

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DEFAULT_DAYS = 30
MAX_COMPETITORS = 5          # 用户可选竞品上限
AUTO_SUGGEST_LIMIT = 5       # 自动推荐返回的候选数
AUTO_PICK_KEYWORDS = 3       # 用几个自身 Top 词去召回竞品
ROOT_TOP_N = 10              # 每个词取多少个头部竞品

# 周期类型：与 SIF 的 timePieceType 一一对应，不额外发明词汇
PERIOD_TYPES = ("latelyDay", "week", "month")

# latelyDay 下 SIF 只认这两个值（实测 14/45/90 均报"参数错误"）
LATELY_DAYS = (7, 30)

DATASET_DIR = os.path.join(PROJECT_ROOT, "data", "ai-traffic")

# 并发度：点查场景，SIF 单次 1~2 秒，3 路并发把 20 次调用压到 ~9 秒
_WORKERS = 3

# SIF 调用计数按「请求」隔离：用 threading.local 存 [n]，_pmap 把父线程的计数器
# 显式带进工作线程。用全局计数器时，两个用户同时点预览会互相污染 meta.sif_calls，
# 而报告里要展示这个数字，必须是真的。
_tls = threading.local()


def _count_call():
    c = getattr(_tls, "counter", None)
    if c is not None:
        c[0] += 1


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def _median(vals):
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else None


def _mean(vals):
    vals = [v for v in vals if v is not None]
    return sum(vals) / len(vals) if vals else None


def _safe_div(a, b):
    if a is None or b in (None, 0):
        return None
    return a / b


# ---------------------------------------------------------------------------
# 时间维度归一化（所有时间入参的唯一入口）
# ---------------------------------------------------------------------------

def _parse_date(value):
    """宽容解析日期：'2026-10-01' / '2026/10/01' / '2026-10' / '20261001'。"""
    s = str(value or "").strip().replace("/", "-").replace(".", "-")
    if not s:
        return None
    if len(s) == 7 and s[4:5] == "-":        # YYYY-MM → 月初
        s += "-01"
    elif len(s) == 8 and s.isdigit():        # YYYYMMDD
        s = f"{s[:4]}-{s[4:6]}-{s[6:]}"
    try:
        return datetime.date.fromisoformat(s[:10])
    except ValueError:
        return None


def _week_sunday(d):
    """SIF 以周日为每周第一天：返回 d 所在周的周日。

    实测传非周日（如周三 2026-10-15）**不会报错，而是静默返回空数据**，
    所以必须在这里对齐，不能指望 SIF 纠错。
    """
    return d - datetime.timedelta(days=(d.weekday() + 1) % 7)


def _month_end(d):
    nxt = (d.replace(day=1) + datetime.timedelta(days=32)).replace(day=1)
    return nxt - datetime.timedelta(days=1)


def normalize_period(period_type="latelyDay", period_value=None):
    """把任意用户输入归一化成 SIF 合法的时间参数 —— 所有时间入参都必须过这里。

    实测的 SIF 约束（2026-10-21，调 ops_get_listing_traffic_overview 验证）：
      · `latelyDay` 只接受 '7' / '30'：传 14 / 45 / 90 直接返回「参数错误」
      · `week` 必须是该周**周日**日期（YYYY-MM-DD）：传周三不报错，但 total=None
      · `month` 接受 'YYYY-MM-01' 与 'YYYY-MM' 两种写法

    因此在入口做「纠正 + 说明」而不是把错误抛给用户：宁可把 45 天收敛成 30 天
    并提示一句，也不要让整次取数因为一个数字失败，或静默拿到空数据。

    返回（同时供取数与前端展示）：
      type / value     归一化后的 timePieceType / timePieceValue
      days             窗口天数（文案与图表用）
      trend            传给 asin_traffic_trend_full 的窗口参数
      window_start/end 精确区间；latelyDay 为 None（SIF 按最新数据日回溯）
      label            人类可读，如「近 7 天」「2026-10-11 ~ 2026-10-17（周）」
      notes            自动纠正说明；非空表示用户输入被改过
    """
    notes = []
    today = datetime.date.today()

    pt = str(period_type or "").strip()
    if not pt:
        # 完全没传周期：按默认窗口（30 天）处理，而不是悄悄变成 7 天
        pt = "latelyDay"
        if period_value in (None, ""):
            period_value = DEFAULT_DAYS
    # 兼容旧前端只传天数（days=30）的写法
    if pt in ("day", "days"):
        pt = "latelyDay"
    if pt not in PERIOD_TYPES:
        if pt:
            notes.append(f"未知的时间类型「{pt}」，已按「近 7 天」处理")
        pt = "latelyDay"
        # 必须丢弃原值：periodType=year + periodValue='2026' 时，
        # 若继续把 '2026' 当天数会得到"已把 2026 天调整为 30 天"这种荒谬结果
        period_value = 7

    if pt == "latelyDay":
        try:
            d = int(period_value or 7)
        except (TypeError, ValueError):
            d = 7
        if d not in LATELY_DAYS:
            # 取最近的合法档位：14 天更该看 7 天，45 天更该看 30 天
            fixed = min(LATELY_DAYS, key=lambda x: abs(x - d))
            notes.append(f"SIF 的「近 N 天」只支持 7 或 30 天，已把 {d} 天调整为 {fixed} 天")
            d = fixed
        return {
            "type": "latelyDay",
            "value": str(d),
            "days": d,
            "trend": {"last_days": d},
            "window_start": None,
            "window_end": None,
            "label": f"近 {d} 天",
            "notes": notes,
        }

    if pt == "week":
        d = _parse_date(period_value)
        if d is None:
            # 直接取上一个完整周的周日，避免"默认值还要再对齐一次"的多余提示
            d = _week_sunday(today) - datetime.timedelta(days=7)
            notes.append("未指定周，默认取上一个完整周")
        sunday = _week_sunday(d)
        if sunday != d:
            notes.append(
                f"周参数必须是周日（SIF 以周日为每周第一天），已把 {d.isoformat()} "
                f"对齐到 {sunday.isoformat()}"
            )
        end = sunday + datetime.timedelta(days=6)
        if end > today:
            notes.append("该周尚未走完（SIF 数据有 T+1 延迟），后期日期可能缺数据")
        return {
            "type": "week",
            "value": sunday.isoformat(),
            "days": 7,
            "trend": {"begin_date": sunday.isoformat(), "end_date": end.isoformat()},
            "window_start": sunday.isoformat(),
            "window_end": end.isoformat(),
            "label": f"{sunday.isoformat()} ~ {end.isoformat()}（周）",
            "notes": notes,
        }

    # month
    d = _parse_date(period_value)
    if d is None:
        d = today.replace(day=1) - datetime.timedelta(days=1)   # 上个月
        notes.append("未指定月份，默认取上个月")
    start = d.replace(day=1)
    end = _month_end(start)
    if start == today.replace(day=1):
        notes.append("本月尚未走完（SIF 数据有 T+1 延迟），月末日期可能缺数据")
    return {
        "type": "month",
        "value": start.isoformat(),
        "days": end.day,
        "trend": {"begin_date": start.isoformat(), "end_date": end.isoformat()},
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "label": f"{start.isoformat()[:7]}（月）",
        "notes": notes,
    }


def _same_category(own_prof, other_prof):
    """判断两个 ASIN 是否同一（根）类目。

    实测 SIF 的 `category_name` 层级不统一：同一个父体下
    自身可能返回 `Baby`，竞品返回 `Baby Burp Cloths`，直接字符串相等会误判"跨类目"。
    因此优先用 `category_id` 的路径前缀（`baby-products` vs `baby-products/7874767011`），
    取不到 id 时退化为名称包含关系。
    返回 True / False / None（信息不足，不判断）。
    """
    a = ((own_prof or {}).get("category_id") or "").strip().lower()
    b = ((other_prof or {}).get("category_id") or "").strip().lower()
    if a and b:
        if a == b:
            return True
        return b.startswith(a + "/") or a.startswith(b + "/")
    na = ((own_prof or {}).get("category") or "").strip().lower()
    nb = ((other_prof or {}).get("category") or "").strip().lower()
    if na and nb:
        return na in nb or nb in na
    return None


def _r(v, nd=4):
    """统一保留小数，避免 JSON 里出现 0.17637091000000002 这类噪声。"""
    if v is None:
        return None
    try:
        return round(float(v), nd)
    except (TypeError, ValueError):
        return None


def _slope_weekly_pct(values):
    """最小二乘斜率，归一化成「每周变化 %」。

    用最小二乘而不是「期末 − 期初」，是为了不被单日异常点带偏。
    均值 ≤ 0 或有效点 < 3 时返回 None（样本不足不下结论）。
    """
    pts = [(i, v) for i, v in enumerate(values) if v is not None]
    if len(pts) < 3:
        return None
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    if my <= 0:
        return None
    var = sum((p[0] - mx) ** 2 for p in pts)
    if var == 0:
        return None
    cov = sum((p[0] - mx) * (p[1] - my) for p in pts)
    b = cov / var
    return b * 7.0 / my * 100.0


def _pmap(fn, items, workers=_WORKERS):
    """并发执行并保持输入顺序；单个失败不影响其他（失败项返回 (None, err)）。

    工作线程会继承父线程的调用计数器，保证 SIF 调用次数统计不串请求。
    """
    out = [None] * len(items)
    parent_counter = getattr(_tls, "counter", None)

    def run(i, item):
        if parent_counter is not None:
            _tls.counter = parent_counter
        try:
            out[i] = (fn(item), None)
        except Exception as e:      # SifError / 网络 / 解析都吞掉，交给调用方决定
            out[i] = (None, f"{type(e).__name__}: {e}")

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        list(ex.map(lambda p: run(*p), list(enumerate(items))))
    return out


# ---------------------------------------------------------------------------
# 自身：取数
# ---------------------------------------------------------------------------

def _slim_trend(points):
    """把日序列裁成前端画图与 AI 阅读都够用的窄表。"""
    return {
        "dates": [p.get("date") for p in points],
        "total": [_r(p.get("total_score"), 2) for p in points],
        "nf": [_r(p.get("nf_score"), 2) for p in points],
        "ad": [_r(p.get("ad_score"), 2) for p in points],
        "price": [_r(p.get("price"), 2) for p in points],
        "bsr": [_r(p.get("bsr"), 0) for p in points],
        "star": [_r(p.get("star"), 2) for p in points],
        "review": [_r(p.get("review"), 0) for p in points],
    }


def trend_stats(points, latest_complete=True):
    """从日序列算指标。所有结论口径都从这里出，AI 不允许自己重算。

    返回：
      avg_total / avg_nf / avg_ad        窗口内均值（无量纲分）
      natural_ratio_median               自然流量占比中位数（用中位数，不被单日尖峰带偏）
      ad_ratio_median                    广告流量占比中位数
      slope_total / slope_nf / slope_ad  每周变化 %（最小二乘）
      peak / trough                      总流量分的最高/最低日
      last_week_vs_prev_week_pct         最近 7 天均值 vs 前 7 天均值
      volatility_cv                      变异系数（std/mean），衡量波动剧烈程度
      price / bsr / review               首末值与变化
    """
    # 末点未出完：整条序列都保留，但涉及"最近"的判断排除最后一个点
    usable = points[:-1] if (points and not latest_complete) else points
    valid = [p for p in usable if p.get("total_score")]
    empty = {
        "days": 0, "avg_total": None, "avg_nf": None, "avg_ad": None,
        "natural_ratio_median": None, "ad_ratio_median": None,
        "slope_total": None, "slope_nf": None, "slope_ad": None,
        "peak": None, "trough": None, "last_week_vs_prev_week_pct": None,
        "volatility_cv": None, "price": None, "bsr": None, "review": None,
        "excluded_last_point": bool(points and not latest_complete),
    }
    if len(valid) < 2:
        return empty

    totals = [p["total_score"] for p in valid]
    nfs = [p.get("nf_score") for p in valid]
    ads = [p.get("ad_score") for p in valid]
    ratios = [_safe_div(p.get("nf_score"), p.get("total_score")) for p in valid]
    ad_ratios = [_safe_div(p.get("ad_score"), p.get("total_score")) for p in valid]

    peak = max(valid, key=lambda p: p["total_score"])
    trough = min(valid, key=lambda p: p["total_score"])

    lw = totals[-7:]
    pw = totals[-14:-7]
    lw_vs_pw = None
    if lw and pw:
        a, b = _mean(lw), _mean(pw)
        if a is not None and b:
            lw_vs_pw = (a - b) / b * 100.0

    mt = _mean(totals)
    cv = None
    if mt and len(totals) >= 3:
        cv = statistics.pstdev(totals) / mt

    def first_last(key, nd=2):
        vals = [(p.get("date"), p.get(key)) for p in valid if p.get(key) is not None]
        if len(vals) < 2:
            return None
        (d0, v0), (d1, v1) = vals[0], vals[-1]
        return {
            "from_date": d0, "to_date": d1,
            "first": _r(v0, nd), "last": _r(v1, nd),
            "change_pct": _r((v1 - v0) / v0 * 100.0 if v0 else None, 2),
        }

    price = first_last("price", 2)
    bsr = first_last("bsr", 0)
    if bsr and bsr.get("change_pct") is not None:
        # BSR 数值越小越好：把"变小"表达成正的改善幅度，避免读者看反
        bsr["improve_pct"] = _r(-bsr["change_pct"], 2)
    review = first_last("review", 0)

    return {
        "days": len(valid),
        "date_from": valid[0].get("date"),
        "date_to": valid[-1].get("date"),
        "avg_total": _r(mt, 2),
        "avg_nf": _r(_mean(nfs), 2),
        "avg_ad": _r(_mean(ads), 2),
        "natural_ratio_median": _r(_median(ratios), 4),
        "ad_ratio_median": _r(_median(ad_ratios), 4),
        "slope_total": _r(_slope_weekly_pct(totals), 2),
        "slope_nf": _r(_slope_weekly_pct(nfs), 2),
        "slope_ad": _r(_slope_weekly_pct(ads), 2),
        "peak": {"date": peak.get("date"), "total": _r(peak["total_score"], 2)},
        "trough": {"date": trough.get("date"), "total": _r(trough["total_score"], 2)},
        "last_week_vs_prev_week_pct": _r(lw_vs_pw, 2),
        "volatility_cv": _r(cv, 3),
        "price": price,
        "bsr": bsr,
        "review": review,
        "excluded_last_point": bool(points and not latest_complete),
    }


def _overview_with_shares(ov):
    """给渠道补上「占总量」口径。

    SIF 的 ad.<channel>.ratio 是**占广告**的比例；很多报告会误读成占总量。
    这里同时给 share_of_ad 与 share_of_total，两种都说清。
    """
    ad_ratio = (ov.get("ad") or {}).get("ratio")
    channels = []
    for key, c in (ov.get("channels") or {}).items():
        share_ad = c.get("ratio")
        channels.append({
            "key": key,
            "name": c.get("name"),
            "score": _r(c.get("score"), 2),
            "share_of_ad": _r(share_ad, 4),
            "share_of_total": _r((ad_ratio or 0) * share_ad if (ad_ratio is not None and share_ad is not None) else None, 4),
        })
    channels.sort(key=lambda x: -(x.get("score") or 0))
    return channels


def _slim_variants(structure, keyword_rows):
    """把「流量结构」与「词覆盖」按 ASIN 拼成一张变体表。

    两个接口的返回顺序不同，不能按下标配对，必须按 ASIN join。
    """
    kw_map = {r.get("asin"): r for r in (keyword_rows or []) if r.get("asin")}
    out = []
    for v in (structure or {}).get("variants") or []:
        asin = v.get("asin")
        kw = kw_map.get(asin) or {}
        nf = v.get("nf") or {}
        ad = v.get("ad") or {}
        out.append({
            "asin": asin,
            "features": v.get("features") or [],
            "img": v.get("img"),
            "is_variant": v.get("is_variant"),
            "flow_ratio": _r(v.get("ratio"), 4),          # 占 listing 总流量
            "flow_score": _r(v.get("sum_score"), 2),
            "nf_score": _r(nf.get("score"), 2),
            "ad_score": _r(ad.get("score"), 2),
            "nf_share_in_variant": _r(nf.get("dist"), 4),  # 该变体内部自然流量占比
            "kw_total": kw.get("total"),
            "kw_natural": kw.get("natural"),
            "kw_ad": kw.get("ad"),
            "kw_sp": kw.get("sp"),
            "kw_sb": kw.get("brand"),
            "kw_sbv": kw.get("video"),
            "price": kw.get("price"),
            "rating_num": kw.get("rating_num"),
            "is_best_seller": kw.get("is_best_seller"),
        })
    out.sort(key=lambda x: -(x.get("flow_score") or 0))
    return out


def _variant_concentration(variants):
    """变体集中度：Top1 占比 + HHI（各变体流量占比平方和，1=单变体垄断）。

    保留占比为 0 的变体参与计数（0 对平方和无贡献），否则"共几个变体"会失真；
    只排除 ratio 缺失（None）的。
    """
    ratios = [v.get("flow_ratio") for v in (variants or []) if v.get("flow_ratio") is not None]
    if not ratios:
        return None
    return {
        "variant_count": len(ratios),
        "variants_with_flow": len([r for r in ratios if r > 0]),
        "top1_share": _r(max(ratios), 4),
        "hhi": _r(sum(r * r for r in ratios), 4),
    }


def own_snapshot(asin, country="US", period=None, listing_search=True):
    """自身数据：概览 + 趋势 + 变体 + 词覆盖 + 静态属性（5 次 SIF 调用）。

    period 必须是 normalize_period() 的产物：概览/结构/词覆盖用它的
    type+value，趋势用它的 trend 窗口参数，保证四个接口取的是同一段时间。
    """
    period = period or normalize_period()
    tp, tv = period["type"], period["value"]

    def get_overview():
        _count_call()
        return sf.listing_traffic_overview(asin, country, tp, tv, listing_search)

    def get_trend():
        _count_call()
        return sf.asin_traffic_trend_full(asin, country, listing_search=listing_search,
                                          **period["trend"])

    def get_structure():
        _count_call()
        return sf.listing_traffic_structure(asin, country, tp, tv, "asin", 100)

    def get_keywords():
        _count_call()
        return sf.asin_listing_keywords(asin, country, dimension="asin",
                                        time_piece_type=tp, time_piece_value=tv)

    def get_profile():
        _count_call()
        rows = sf.asin_profiles([asin], country)
        return rows[0] if rows else {}

    results = _pmap(lambda fn: fn(), [get_overview, get_trend, get_structure, get_keywords, get_profile], 3)
    ov, ov_err = results[0]
    tf, tf_err = results[1]
    st, st_err = results[2]
    kw, kw_err = results[3]
    prof, prof_err = results[4]

    # 概览与趋势是报告主干，取不到就没法分析 → 直接抛给上层报错
    if ov_err:
        raise RuntimeError(f"取流量构成失败：{ov_err}")
    if tf_err:
        raise RuntimeError(f"取流量趋势失败：{tf_err}")

    points = tf.get("points") or []
    latest_complete = tf.get("latest_point_complete")
    stats = trend_stats(points, latest_complete is not False)
    variants = _slim_variants(st, kw if not kw_err else [])

    return {
        "asin": asin,
        "profile": prof if not prof_err else {},
        "overview": {
            "total": _r(ov.get("total"), 2),
            "nf": {"name": (ov.get("nf") or {}).get("name"),
                   "score": _r((ov.get("nf") or {}).get("score"), 2),
                   "ratio": _r((ov.get("nf") or {}).get("ratio"), 4)},
            "ad": {"name": (ov.get("ad") or {}).get("name"),
                   "score": _r((ov.get("ad") or {}).get("score"), 2),
                   "ratio": _r((ov.get("ad") or {}).get("ratio"), 4)},
            "channels": _overview_with_shares(ov),
            "recommend": [{"name": r.get("name"), "ratio": _r(r.get("ratio"), 4),
                           "score": _r(r.get("score"), 2)} for r in (ov.get("recommend") or [])],
            "notice": ov.get("notice"),
        },
        "trend": _slim_trend(points),
        "trend_meta": {
            "latest_point_date": tf.get("latest_point_date"),
            "latest_point_complete": latest_complete,
            "notice": tf.get("notice"),
        },
        "stats": stats,
        "variants": variants,
        "variant_concentration": _variant_concentration(variants),
        "keywords": kw if not kw_err else [],
        "period": period,
        "errors": {k: v for k, v in (("structure", st_err), ("keywords", kw_err),
                                      ("profile", prof_err)) if v},
    }


# ---------------------------------------------------------------------------
# 竞品：自动推荐
# ---------------------------------------------------------------------------

def _root_of(keyword):
    """从流量词里取「词根」喂给 root_competitors。

    SIF 的此接口接受完整词也能返回结果（实测 'burp cloths' 可召回 10 个），
    所以这里不做过度的词干化，只去掉首尾空白与常见修饰词，避免误伤。
    """
    kw = (keyword or "").strip().lower()
    for prefix in ("for ", "the ", "a "):
        if kw.startswith(prefix):
            kw = kw[len(prefix):]
    return kw.strip()


def suggest_competitors(asin, country="US", own_profile=None, limit=AUTO_SUGGEST_LIMIT):
    """自动推荐竞品：自身 Top 流量词 → 词根头部竞品 → 频次聚合 → 同类目/价格带过滤。

    返回 {candidates:[{asin, hit_keywords, hits, covered_volume, profile, warnings}],
          used_keywords:[...], note}
    失败不抛错：返回空候选 + note，前端降级为「手工填写」。
    """
    own_profile = own_profile or {}
    own_brand = (own_profile.get("brand") or "").strip().lower()
    own_price = own_profile.get("price")

    try:
        _count_call()
        sig = sf.asin_keyword_signals(asin, country, min(30, 30), 10)
        kws = [k for k in (sig.get("top_keywords") or []) if k.get("keyword")]
    except Exception as e:
        return {"candidates": [], "used_keywords": [], "note": f"取自身流量词失败：{e}"}

    if not kws:
        return {"candidates": [], "used_keywords": [],
                "note": "自身没有可用的流量词数据（新品或被收录词过少），请手工填写竞品 ASIN"}

    # 按流量份额取前 N 个词（份额缺失时退化为原顺序）
    kws.sort(key=lambda k: -(k.get("traffic_share") or 0))
    picked = [_root_of(k["keyword"]) for k in kws[:AUTO_PICK_KEYWORDS]]
    picked = [k for k in picked if k]

    fetch = lambda kw: sf.root_competitors(kw, country, ROOT_TOP_N)
    results = _pmap(fetch, picked, 3)

    agg = {}
    ok_keywords = []
    errors = []
    for kw, (res, err) in zip(picked, results):
        if err or not res:
            errors.append(f"{kw}: {err}")
            continue
        ok_keywords.append(kw)
        for c in res.get("competitors") or []:
            a = (c.get("asin") or "").strip().upper()
            if not a or a == asin:
                continue          # 排除自己
            item = agg.setdefault(a, {"asin": a, "hit_keywords": [], "hits": 0,
                                      "covered_volume": 0, "rank1_count": 0})
            item["hits"] += 1
            item["hit_keywords"].append(kw)
            item["covered_volume"] += c.get("covered_volume") or 0
            item["rank1_count"] += c.get("rank1_count") or 0

    if not agg:
        return {"candidates": [], "used_keywords": ok_keywords,
                "note": "词根竞品接口未返回可用对象，请手工填写竞品 ASIN"}

    # 批量取静态属性（≤20/批）
    pool = sorted(agg.values(), key=lambda x: (-x["hits"], -x["covered_volume"]))[:20]
    profiles = {}
    try:
        _count_call()
        for p in sf.asin_profiles([x["asin"] for x in pool], country):
            profiles[p.get("asin")] = p
    except Exception as e:
        errors.append(f"竞品属性失败：{e}")

    out = []
    for item in pool:
        p = profiles.get(item["asin"]) or {}
        brand = (p.get("brand") or "").strip().lower()
        price = p.get("price")
        warnings = []

        # 同品牌变体不是竞品（同一父体的兄弟体在结构里已单独统计）
        if own_brand and brand and brand == own_brand:
            continue
        if _same_category(own_profile, p) is False:
            warnings.append(f"跨类目（{(p.get('category') or '未知').strip()}）")
        price_gap = None
        if own_price and price:
            price_gap = (price - own_price) / own_price
            if abs(price_gap) > 0.5:
                warnings.append(f"价差 {price_gap * 100:+.0f}%")

        out.append({
            "asin": item["asin"],
            "hits": item["hits"],
            "hit_keywords": item["hit_keywords"],
            "covered_volume": item["covered_volume"],
            "rank1_count": item["rank1_count"],
            "profile": {
                "title": (p.get("title") or "")[:120],
                "brand": p.get("brand"),
                "price": _r(p.get("price"), 2),
                "star": _r(p.get("star"), 2),
                "rating_num": p.get("rating_num"),
                "bsr": p.get("bsr"),
                "category": p.get("category"),
                "category_id": p.get("category_id"),
                "variation_num": p.get("variation_num"),
                "img": p.get("img"),
            },
            "price_gap_pct": _r(price_gap * 100 if price_gap is not None else None, 1),
            "warnings": warnings,
            "suggested": False,
        })

    # 排序：警告少的优先 → 命中词多 → 覆盖搜索量大。
    # 注意 warnings 只是"标注可比性"，不构成排除；否则一个类目层级差异
    # 就会把候选全滤掉（实测曾出现 0 个竞品入选）。
    out.sort(key=lambda x: (len(x["warnings"]), -x["hits"], -x["covered_volume"]))
    for i, c in enumerate(out):
        c["suggested"] = i < limit

    return {
        "candidates": out,
        "used_keywords": ok_keywords,
        "note": ("；".join(errors) if errors else ""),
    }


# ---------------------------------------------------------------------------
# 竞品：取数 + 对比指标
# ---------------------------------------------------------------------------

def competitor_snapshot(asin, country="US", period=None, listing_search=True, profile=None):
    """单个竞品：概览 + 趋势 + 属性（3 次调用，profile 已批量传入时只 2 次）。

    period 与自身共用同一份（normalize_period 的产物），保证对比同口径。
    profile 由 build_dataset 批量预取后传入，避免每个竞品各查一次属性
    （SIF 有 QPM 限流，少 4 次调用就少一分撞 40/40 的风险）。
    """
    period = period or normalize_period()
    tp, tv = period["type"], period["value"]

    def get_overview():
        _count_call()
        return sf.listing_traffic_overview(asin, country, tp, tv, listing_search)

    def get_trend():
        _count_call()
        return sf.asin_traffic_trend_full(asin, country, listing_search=listing_search,
                                          **period["trend"])

    def get_profile():
        if profile:
            return profile
        _count_call()
        rows = sf.asin_profiles([asin], country)
        return rows[0] if rows else {}

    results = _pmap(lambda fn: fn(), [get_overview, get_trend, get_profile], 3)
    ov, ov_err = results[0]
    tf, tf_err = results[1]
    prof, prof_err = results[2]

    if ov_err or tf_err:
        return {"asin": asin, "error": ov_err or tf_err, "profile": prof or {}}

    points = tf.get("points") or []
    return {
        "asin": asin,
        "profile": prof or {},
        "overview": {
            "total": _r(ov.get("total"), 2),
            "nf_ratio": _r((ov.get("nf") or {}).get("ratio"), 4),
            "ad_ratio": _r((ov.get("ad") or {}).get("ratio"), 4),
            "channels": _overview_with_shares(ov),
        },
        "stats": trend_stats(points, tf.get("latest_point_complete") is not False),
        "trend": _slim_trend(points),
        "trend_meta": {"latest_point_date": tf.get("latest_point_date"),
                       "latest_point_complete": tf.get("latest_point_complete")},
        "errors": {"profile": prof_err} if prof_err else {},
    }


def compare_with_own(own, comp):
    """自家 vs 单个竞品的可比指标。缺数据就返回 None，不猜。"""
    os_ = own.get("stats") or {}
    cs = comp.get("stats") or {}
    own_avg = os_.get("avg_total")
    comp_avg = cs.get("avg_total")

    multiple = _r(_safe_div(comp_avg, own_avg), 2)

    # 渠道结构差异：逐渠道「竞品占比 − 自身占比」，单位 pp
    own_ch = {c["key"]: c.get("share_of_total") for c in (own.get("overview") or {}).get("channels") or []}
    comp_ch = {c["key"]: c.get("share_of_total") for c in (comp.get("overview") or {}).get("channels") or []}
    diff = {}
    for key in set(own_ch) | set(comp_ch):
        a, b = comp_ch.get(key), own_ch.get(key)
        diff[key] = _r((a - b) * 100 if (a is not None and b is not None) else None, 2)

    own_prof = own.get("profile") or {}
    comp_prof = comp.get("profile") or {}
    warnings = []
    if _same_category(own_prof, comp_prof) is False:
        warnings.append(f"跨类目（自身 {own_prof.get('category') or '未知'} / "
                        f"竞品 {comp_prof.get('category') or '未知'}）")
    price_gap = None
    if own_prof.get("price") and comp_prof.get("price"):
        price_gap = (comp_prof["price"] - own_prof["price"]) / own_prof["price"] * 100
        if abs(price_gap) > 50:
            warnings.append(f"价差 {price_gap:+.0f}%，仅作规模参照")

    return {
        "total_multiple_vs_own": multiple,
        "natural_ratio_diff_pp": _r(
            (cs["natural_ratio_median"] - os_["natural_ratio_median"]) * 100
            if (cs.get("natural_ratio_median") is not None and os_.get("natural_ratio_median") is not None)
            else None, 2),
        "slope_diff_pct_per_week": _r(
            cs["slope_total"] - os_["slope_total"]
            if (cs.get("slope_total") is not None and os_.get("slope_total") is not None) else None, 2),
        "channel_share_diff_pp": diff,
        "price_gap_pct": _r(price_gap, 1),
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# 数据集组装 / 落盘
# ---------------------------------------------------------------------------

def _new_dataset_id():
    return uuid.uuid4().hex[:12]


def build_dataset(asin, country="US", period=None, competitor_asins=None,
                  auto_competitors=True, listing_search=True, counter=None):
    """组装完整数据包：自身 + 竞品（用户指定优先，否则用自动推荐）+ 元数据。

    period 为空时按默认「近 30 天」；传字符串/数字也可（走 normalize_period 兼容路径），
    但推荐直接传 normalize_period() 的结果，便于把纠正说明回显给前端。
    competitor_asins 为空且 auto_competitors=True 时走自动推荐；
    自动推荐失败则返回空列表并给出 note，由前端提示手工填写。
    counter 是本请求的 SIF 调用计数器（list 单元素），为 None 时新建。
    """
    if period is None or isinstance(period, (str, int, float)):
        period = normalize_period("latelyDay", period or DEFAULT_DAYS)
    if not isinstance(period, dict) or "type" not in period:
        period = normalize_period()

    counter = counter if counter is not None else [0]
    _tls.counter = counter

    own = own_snapshot(asin, country, period, listing_search)

    auto = {"candidates": [], "used_keywords": [], "note": ""}
    picked = [a for a in (competitor_asins or []) if a and a.upper() != asin]

    if not picked and auto_competitors:
        auto = suggest_competitors(asin, country, own.get("profile"), AUTO_SUGGEST_LIMIT)
        picked = [c["asin"] for c in auto["candidates"] if c.get("suggested")][:AUTO_SUGGEST_LIMIT]

    picked = [a.strip().upper() for a in picked][:MAX_COMPETITORS]

    # 竞品属性一次性批量取（≤20/批），省掉每个竞品各查一次
    comp_profiles = {}
    if picked:
        try:
            _count_call()
            for p in sf.asin_profiles(picked, country):
                comp_profiles[p.get("asin")] = p
        except Exception as e:
            # 批量失败不阻断：退回各竞品自行取（异常路径，多花几次调用但能出结果）
            _log(f"[traffic] 批量取竞品属性失败，退回逐个取：{e}")

    # 竞品之间并发；每个竞品内部 3 路并发，总并发由 _pmap 的 3 控制
    results = _pmap(
        lambda a: competitor_snapshot(a, country, period, listing_search, comp_profiles.get(a)),
        picked, 3,
    ) if picked else []
    competitors = []
    for a, (snap, err) in zip(picked, results):
        if err or not snap:
            competitors.append({"asin": a, "error": err or "取数失败"})
            continue
        if snap.get("error"):
            competitors.append({"asin": a, "error": snap["error"], "profile": snap.get("profile")})
            continue
        snap["compare"] = compare_with_own(own, snap)
        competitors.append(snap)

    return {
        "meta": {
            "asin": asin,
            "country": country,
            "days": period["days"],
            # 周期三元组：前端要显示"你选了什么"与"SIF 实际收到什么"
            "period_type": period["type"],
            "period_value": period["value"],
            "period_label": period["label"],
            "period_window_start": period.get("window_start"),
            "period_window_end": period.get("window_end"),
            "period_notes": period.get("notes") or [],
            "listing_search": bool(listing_search),
            "generated_at": _now_iso(),
            "sif_calls": counter[0],
            "data_notice": (own.get("trend_meta") or {}).get("notice"),
            "latest_point_date": (own.get("trend_meta") or {}).get("latest_point_date"),
            "latest_point_complete": (own.get("trend_meta") or {}).get("latest_point_complete"),
            # 口径声明：写进报告页脚，避免读者误读
            "metric_notes": {
                "score_is_relative": "SIF score 为无量纲相对分，仅用于占比/倍数/涨跌，不代表 UV 或绝对流量",
                "ratio_layers": "overview.ad.<channel>.share_of_ad 是占广告比例；share_of_total = ad.ratio × share_of_ad",
                "natural_ratio": "自然流量占比 = nf_score / total_score 的窗口内中位数",
                "slope": "斜率 = 最小二乘趋势，归一化为每周变化 %",
                "listing_search": "true=父体+全部子体聚合；自身与全部竞品同口径",
                "period": "周期由 normalize_period() 归一化为 SIF 合法格式：latelyDay(7/30) / week(周日日期) / month(月初日期)",
            },
        },
        "own": own,
        "competitors": competitors,
        "auto_competitor_pool": auto.get("candidates") or [],
        "auto_note": auto.get("note") or "",
        "auto_used_keywords": auto.get("used_keywords") or [],
    }


def dataset_path(dataset_id):
    return os.path.join(DATASET_DIR, f"{dataset_id}.json")


def save_dataset(data, dataset_id=None):
    os.makedirs(DATASET_DIR, exist_ok=True)
    dsid = dataset_id or _new_dataset_id()
    with open(dataset_path(dsid), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    return dsid


def load_dataset(dataset_id):
    """读取已落盘的数据集；不存在 / 损坏返回 None（调用方决定是重取还是报错）。"""
    p = dataset_path(dataset_id)
    if not dataset_id or not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def preview(asin, country="US", period_type="latelyDay", period_value=None,
            competitor_asins=None, auto_competitors=True, listing_search=True):
    """预览用：归一化周期 → 取数 → 算指标 → 落盘 → 返回 {datasetId, data}。

    period_type / period_value 走 normalize_period()，任何非法输入都会被纠正成
    SIF 合法格式并在 meta.period_notes 里说明，不会因传参把整次取数打挂。
    落盘是为了「生成分析」时能直接用同一份数据，避免重复取数（SIF 按调用计费）
    与前后两次数字不一致。
    """
    # 兼容旧签名 preview(asin, country, days)
    if isinstance(period_type, (int, float)) and period_value is None:
        period_value, period_type = int(period_type), "latelyDay"

    period = normalize_period(period_type, period_value)

    counter = [0]
    _tls.counter = counter
    try:
        data = build_dataset(asin, country, period, competitor_asins,
                             auto_competitors, listing_search, counter)
    finally:
        _tls.counter = None
    dsid = save_dataset(data)
    data["meta"]["dataset_id"] = dsid
    # dataset_id 写回文件，便于按 id 反查
    try:
        with open(dataset_path(dsid), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except Exception:
        pass
    return {"datasetId": dsid, "data": data}
