#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SIF 爆品关键词监控 —— 信号引擎
================================
每次抓取跑完后调用（纯本地计算，不消耗任何 SIF 配额），从已落库的日快照里
算出「值得看一眼」的变化，写入 sif_signals 供前端信号中心展示。

关键词信号（基于自建日序列 + 每周层的需求画像）：
  kw_volume_surge  搜索量日环比 / 7 日环比涨幅超阈值
  kw_volume_drop   搜索量日环比跌幅超阈值（可能是需求转移到长尾词）
  kw_rank_jump     ABA 排名单日大幅改善（数值变小 = 变好）
  kw_new_entry     新入榜机会词（该词首次出现在库里且搜索量达标）

ASIN 信号（基于 SIF 真日粒度数据）：
  asin_bsr_jump       BSR 单日跃升（数值变小 = 变好）→ 爆品核心信号
  asin_price_drop     价格跳水 → 竞品降价内卷 / 清仓预警
  asin_sales_surge    近30天销量周度增速超阈值
  asin_review_surge   评论数快速增长（起量佐证 / 也可能刷单）
  asin_new_hot        新品黑马：上架 N 天内 + 月销已过门槛
  asin_traffic_shift  自然流量占比骤降 → 转靠广告撑量，竞争加剧

时间口径的关键点：SIF 的 ASIN 日数据有 T+1~T+2 延迟，所以 ASIN 侧一律以
「该 ASIN 库里最新的那个数据点的日期」为基准做判断，信号也写到那个日期上，
既避免"永远等不到当天数据"，也让同一份延迟数据不会每天重复报一遍。
所有阈值来自 sif_settings.thresholds（前端设置页可改）。
"""

import datetime


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def _f(v):
    try:
        return float(v)
    except Exception:
        return None


def _pct(cur, prev):
    """普通环比 %（正=涨）。基线无效时返回 None。"""
    cur, prev = _f(cur), _f(prev)
    if cur is None or prev is None or prev == 0:
        return None
    return (cur - prev) / prev * 100.0


def _pct_lb(cur, prev):
    """排名 / BSR 这类「数值越小越好」的指标，返回改善幅度 %（正=变好）。"""
    cur, prev = _f(cur), _f(prev)
    if cur is None or prev is None or prev == 0:
        return None
    return (prev - cur) / prev * 100.0


def _date_of(pt):
    """兼容关键词（runDate）与 ASIN（date）两种序列的日期字段。"""
    return ((pt.get("runDate") or pt.get("date") or "") or "")[:10]


def _minus_days(date_str, n):
    try:
        return (datetime.date.fromisoformat(str(date_str)[:10])
                - datetime.timedelta(days=int(n))).isoformat()
    except Exception:
        return ""


def _days_since(date_str):
    """该日期距今天数；解析失败返回 None。"""
    try:
        return (datetime.date.today() - datetime.date.fromisoformat(str(date_str)[:10])).days
    except Exception:
        return None


def _prev_point(series, before_date):
    """升序序列里最后一个日期早于 before_date 的点（前一交易日基线）。"""
    prev = None
    for p in series or []:
        d = _date_of(p)
        if d and d < before_date:
            prev = p
    return prev


def _point_around(series, want_date):
    """升序序列里最接近且不晚于 want_date 的点（周环比基线）。"""
    ref = None
    for p in series or []:
        d = _date_of(p)
        if d and d <= want_date:
            ref = p
    return ref


def _sev(pct, threshold, multiplier=2.0):
    """严重度分级：超过阈值 multiplier 倍 = high，否则 warn。"""
    if pct is None:
        return "info"
    try:
        return "high" if abs(pct) >= float(threshold) * multiplier else "warn"
    except Exception:
        return "warn"


def _sig(date, task_id, direction, kind, ref_type, ref_id, title, detail, severity="info"):
    return {"date": date, "task_id": task_id, "direction": direction, "kind": kind,
            "ref_type": ref_type, "ref_id": ref_id, "title": title,
            "detail": detail or {}, "severity": severity}


def _fmt_n(v):
    return "—" if v is None else f"{float(v):,.0f}"


def _fmt_money(v):
    return "—" if v is None else f"${float(v):.2f}"


# ---------------------------------------------------------------------------
# 关键词信号
# ---------------------------------------------------------------------------

def _kw_signals(state, task_id, run_date, th, direction):
    out = []
    min_sv = _f(th.get("min_search_volume")) or 0
    thr_dod = _f(th.get("kw_dod_pct")) or 999
    thr_wow = _f(th.get("kw_wow_pct")) or 999
    thr_rank = _f(th.get("kw_rank_jump_pct")) or 999

    for row in state.list_kw_snapshots(task_id, run_date):
        kw = row["keyword"]
        sv = _f(row["searchVolume"])
        if sv is None or sv < min_sv:
            continue                       # 长尾小词的百分比波动是噪音，直接降噪
        series = state.kw_series(task_id, kw, 21)
        cur = next((p for p in reversed(series) if _date_of(p) == run_date), row)
        head = [p for p in series if _date_of(p) < run_date]
        p1 = _prev_point(head, run_date)
        p7 = _point_around(head, _minus_days(run_date, 7))

        vol1 = p1.get("searchVolume") if p1 else None
        vol7 = p7.get("searchVolume") if p7 else None
        dod = _pct(sv, vol1)
        wow = _pct(sv, vol7)
        rank_imp = _pct_lb(row.get("rank"), p1.get("rank") if p1 else None)
        base = {"searchVolume": sv, "prevVolume": vol1, "weekVolume": vol7,
                "dod": None if dod is None else round(dod, 1),
                "wow": None if wow is None else round(wow, 1),
                "rank": row.get("rank"), "cpc": row.get("cpc"), "cvr": row.get("cvr"),
                "clickShare": row.get("clickShare"), "root": row.get("root"),
                "topAsins": row.get("topAsins"), "entrySignal": row.get("entrySignal")}

        if dod is not None and dod >= thr_dod:
            out.append(_sig(run_date, task_id, direction, "kw_volume_surge", "keyword", kw,
                            f"搜索量日环比 +{dod:.0f}%（{_fmt_n(vol1)} → {_fmt_n(sv)}）",
                            base, _sev(dod, thr_dod)))
        elif wow is not None and wow >= thr_wow:
            out.append(_sig(run_date, task_id, direction, "kw_volume_surge", "keyword", kw,
                            f"搜索量 7 日环比 +{wow:.0f}%（{_fmt_n(vol7)} → {_fmt_n(sv)}）",
                            base, _sev(wow, thr_wow)))
        if dod is not None and dod <= -thr_dod:
            out.append(_sig(run_date, task_id, direction, "kw_volume_drop", "keyword", kw,
                            f"搜索量日环比 {dod:.0f}%（{_fmt_n(vol1)} → {_fmt_n(sv)}）需求可能转移到长尾词",
                            base, _sev(dod, thr_dod)))
        if rank_imp is not None and rank_imp >= thr_rank:
            d = dict(base, prevRank=p1.get("rank") if p1 else None, improve=round(rank_imp, 1))
            out.append(_sig(run_date, task_id, direction, "kw_rank_jump", "keyword", kw,
                            f"ABA 排名 #{_fmt_n(p1.get('rank') if p1 else None)} → #{_fmt_n(row.get('rank'))}"
                            f"（改善 {rank_imp:.0f}%）", d, _sev(rank_imp, thr_rank)))
        if th.get("kw_new_entry") and row.get("isNewEntry"):
            pr = (state.kw_profile(task_id, kw) or {}).get("profile") or {}
            tail = f"，{pr['diagnosis']}" if pr.get("diagnosis") else ""
            out.append(_sig(run_date, task_id, direction, "kw_new_entry", "keyword", kw,
                            f"新入榜机会词（搜索量 {_fmt_n(sv)}）{tail}",
                            dict(base, demandType=pr.get("demand_type"), trend=pr.get("trend_direction"),
                                 yoy=pr.get("yoy_change"), peakMonth=pr.get("peak_month"),
                                 weeksToPeak=pr.get("weeks_to_peak")), "info"))
    return out


# ---------------------------------------------------------------------------
# ASIN（爆品）信号
# ---------------------------------------------------------------------------

_ASIN_BASE_FIELDS = ("title", "brand", "img", "url", "price", "star", "ratingNum",
                     "category", "weightOz", "source", "sourceRef", "firstAvailableDay")


def _asin_signals(state, task_id, run_date, th, direction):
    """以「该 ASIN 库里最新数据点的日期」为基准判断（SIF 有 T+1~T+2 延迟与零星缺日）。

    同一天数据在同一天重跑时幂等（UNIQUE 键含数据日期），不会重复堆叠。
    """
    out = []
    max_lag = 3                            # 数据落后运行日超过 3 天视为陈旧，不产信号
    thr_bsr = _f(th.get("asin_bsr_jump_pct")) or 999
    thr_price = _f(th.get("asin_price_drop_pct")) or 999
    thr_sales = _f(th.get("asin_sales_wow_pct")) or 999
    thr_rev = _f(th.get("asin_review_wow_pct")) or 999
    thr_nf = _f(th.get("nf_share_drop_pct")) or 999
    max_days = _f(th.get("new_product_days")) or 180
    min_sales = _f(th.get("new_product_sales")) or 500

    for a in state.list_asins(task_id, active_only=True):
        asin = a["asin"]
        full = state.asin_series(task_id, asin, 30)
        if len(full) < 2:
            continue
        # 尾部可能碰上 SIF 缺日（关键字段全空），回退到最近一个有值的点
        cur, head = None, []
        for i in range(len(full) - 1, -1, -1):
            p = full[i]
            if p.get("price") is not None or p.get("bsr") is not None \
                    or p.get("boughtMonth") is not None or p.get("totalScore") is not None:
                cur, head = p, full[:i]
                break
        if not cur or not head:
            continue
        cur_date = _date_of(cur)
        lag = _days_since(cur_date)
        if not cur_date or lag is None or lag > max_lag:
            continue
        p1 = _prev_point(head, cur_date) or {}
        ref = _point_around(head, _minus_days(cur_date, 7)) or {}

        base = {k: a.get(k) for k in _ASIN_BASE_FIELDS}
        base.update(asin=asin, dataDate=cur_date, price=cur.get("price"), bsr=cur.get("bsr"),
                    boughtMonth=cur.get("boughtMonth"), reviewNum=cur.get("reviewNum"),
                    star=cur.get("star"))
        title_short = (a.get("title") or "")[:40]

        bsr_imp = _pct_lb(cur.get("bsr"), p1.get("bsr"))
        if bsr_imp is not None and bsr_imp >= thr_bsr and cur.get("bsr"):
            d = dict(base, prevBsr=p1.get("bsr"), improve=round(bsr_imp, 1))
            out.append(_sig(cur_date, task_id, direction, "asin_bsr_jump", "asin", asin,
                            f"BSR 跃升 #{_fmt_n(p1.get('bsr'))} → #{_fmt_n(cur.get('bsr'))}"
                            f"（改善 {bsr_imp:.0f}%）｜{title_short}", d, _sev(bsr_imp, thr_bsr)))

        price_chg = _pct(cur.get("price"), p1.get("price"))
        if price_chg is not None and price_chg <= -thr_price:
            d = dict(base, prevPrice=p1.get("price"), change=round(price_chg, 1))
            out.append(_sig(cur_date, task_id, direction, "asin_price_drop", "asin", asin,
                            f"价格下调 {abs(price_chg):.0f}%（{_fmt_money(p1.get('price'))} → "
                            f"{_fmt_money(cur.get('price'))}）竞品降价 / 清仓信号", d,
                            _sev(price_chg, thr_price)))

        sales_chg = _pct(cur.get("boughtMonth"), ref.get("boughtMonth"))
        if sales_chg is not None and sales_chg >= thr_sales and (cur.get("boughtMonth") or 0) >= 100:
            d = dict(base, prevBoughtMonth=ref.get("boughtMonth"), growth=round(sales_chg, 1))
            out.append(_sig(cur_date, task_id, direction, "asin_sales_surge", "asin", asin,
                            f"月销 7 日增速 +{sales_chg:.0f}%（{_fmt_n(ref.get('boughtMonth'))} → "
                            f"{_fmt_n(cur.get('boughtMonth'))}）爆品起量", d, _sev(sales_chg, thr_sales)))

        rev_chg = _pct(cur.get("reviewNum"), ref.get("reviewNum"))
        if rev_chg is not None and rev_chg >= thr_rev and (cur.get("reviewNum") or 0) >= 100:
            d = dict(base, prevReviewNum=ref.get("reviewNum"), growth=round(rev_chg, 1))
            out.append(_sig(cur_date, task_id, direction, "asin_review_surge", "asin", asin,
                            f"评论数 7 日增速 +{rev_chg:.0f}%（{_fmt_n(ref.get('reviewNum'))} → "
                            f"{_fmt_n(cur.get('reviewNum'))}）", d, "warn"))

        on_sale = _days_since(a.get("firstAvailableDay"))
        if on_sale is not None and 0 <= on_sale <= max_days \
                and (cur.get("boughtMonth") or 0) >= min_sales:
            d = dict(base, onSaleDays=on_sale, ratingNum=a.get("ratingNum"))
            out.append(_sig(cur_date, task_id, direction, "asin_new_hot", "asin", asin,
                            f"上架 {on_sale} 天月销已达 {_fmt_n(cur.get('boughtMonth'))} —— "
                            f"新品黑马，值得拆解｜{title_short}", d, "high"))

        def nf_share(pt):
            t, nf = _f(pt.get("totalScore")), _f(pt.get("nfScore"))
            if not t or nf is None:
                return None
            return nf / t * 100.0

        now_share, was_share = nf_share(cur), nf_share(ref)
        if now_share is not None and was_share is not None and (was_share - now_share) >= thr_nf:
            d = dict(base, nfShare=round(now_share, 1), prevNfShare=round(was_share, 1))
            out.append(_sig(cur_date, task_id, direction, "asin_traffic_shift", "asin", asin,
                            f"自然流量占比 {was_share:.0f}% → {now_share:.0f}%"
                            f"（-{was_share - now_share:.0f}pp）转靠广告撑量", d, "warn"))
    return out


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def run_engine(state, task_id: str, run_date: str, thresholds: dict = None,
               direction: str = "", errors_out: list = None) -> int:
    """抓取跑完后调用一次。返回本次产出的信号条数。

    errors_out：传入 list 则把计算异常摘要带出来。异常若只 print 到 stdout 会被服务日志
    缓冲吞掉（历史上曾导致关键词信号静默丢失），必须让调用方写进运行日志与任务状态。
    """
    if thresholds is None:
        thresholds = state.get_sif_settings().get("thresholds", {})
    rows, local_errs = [], []

    def _err(where, e):
        msg = f"{where}计算异常: {type(e).__name__}: {str(e)[:150]}"
        print(f"  [sif] {msg}")
        local_errs.append(msg)

    try:
        rows += _kw_signals(state, task_id, run_date, thresholds, direction)
    except Exception as e:
        _err("关键词信号", e)
    try:
        rows += _asin_signals(state, task_id, run_date, thresholds, direction)
    except Exception as e:
        _err("ASIN 信号", e)

    if rows:
        state.save_signals(rows)
        print(f"  [sif] {run_date} 产出 {len(rows)} 条信号")
    if errors_out is not None:
        errors_out.extend(local_errs)
    return len(rows)
