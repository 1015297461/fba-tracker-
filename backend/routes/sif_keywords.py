#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SIF 爆品关键词监控 v2：路由 + 分层调度
========================================
调度（每分钟扫描一次，命中即在后台线程执行）：
  · 频率三档 freq_type：daily（每天）/ every_n（每 N 天）/ weekly（每周指定周几）
  · schedule_time：触发时刻 HH:MM；当天时刻未到则不触发
  · 每次运行内部再分层：每日层（机会词快照 + ASIN 日数据）必跑；
    距上次每周层 ≥ 7 天时附带跑每周层（需求画像 + 周度趋势补 ABA 排名 + 词根竞品）

路由（全部需登录）：
  GET    /api/sif/board?taskId=&days=&date=   看板总览（关键词榜 + 爆品榜 + 信号 + 概览）
  GET    /api/sif/tasks                       任务列表
  POST   /api/sif/tasks                       创建任务
  PUT    /api/sif/tasks                       更新任务
  DELETE /api/sif/tasks?id=                   删除任务（连带清理全部监控数据）
  POST   /api/sif/run                         {id} 立即运行（后台线程，不阻塞 HTTP）
  GET    /api/sif/runs?taskId=                运行日志（含每次 SIF 调用次数，成本透明）
  GET    /api/sif/kw-trend?taskId=&keyword=&days=    关键词自建日序列
  GET    /api/sif/asin-trend?taskId=&asin=&days=     ASIN 真日粒度序列
  GET    /api/sif/universe?taskId=            该任务监控过的全部关键词
  GET    /api/sif/pool?taskId=                ASIN 监控池
  POST   /api/sif/pool/add                    {taskId, asins[]} 手动加入并回补数据
  POST   /api/sif/pool/toggle                 {taskId, asin, active}
  POST   /api/sif/pool/remove                 {taskId, asin}
  GET    /api/sif/signals?days=&taskId=&limit=     信号列表
  GET    /api/sif/signal-top?days=&taskId=         按词/ASIN 聚合的异动榜
  POST   /api/sif/signals/ack                 {id, ack}
  GET    /api/sif/settings                    信号阈值 + 默认配额
  PUT    /api/sif/settings                    {section: thresholds|defaults, values}
  POST   /api/sif/preview                     {root, country, topN, withCompetitors} 试查词根
  POST   /api/sif/inspect                     点查重接口（competition / root_competitors /
                                               discover / root_trend / history / asin_signals /
                                               asin_profile / asin_sales / promotion / profit）
"""

import datetime
import threading
import time
from urllib.parse import urlparse, parse_qs

from .. import sif_fetcher, sif_signals
from ..db import SIF_MAX_RETRIES_PER_DAY
from ..utils import _extract_token, _now_iso

# 正在执行的任务 id 集合（调度器与手动触发共用，避免同一任务并发跑）
_running: set = set()
_running_lock = threading.Lock()

WEEKLY_INTERVAL_DAYS = 7      # 每周层的最小间隔（天）
DEFAULT_KEEP_DAYS = 365       # 快照保留天数（设置页 defaults.keepDays 可调）
SIF_STALE_RUNNING_MIN = 30    # running 状态超过这个分钟数才判定为僵死（服务重启遗留）


def _is_running(tid: str) -> bool:
    with _running_lock:
        return tid in _running


def _mark(tid: str, on: bool):
    with _running_lock:
        if on:
            _running.add(tid)
        else:
            _running.discard(tid)


def _iso_week(d: datetime.date = None) -> str:
    y, w, _ = (d or datetime.date.today()).isocalendar()
    return f"{y}-W{w:02d}"


def _today() -> str:
    return datetime.date.today().isoformat()


def _days_between(a: str, b: str):
    """b - a 的天数（ISO 日期字符串），解析失败返回 None。"""
    try:
        return (datetime.date.fromisoformat(b[:10]) - datetime.date.fromisoformat(a[:10])).days
    except Exception:
        return None


# ---------------------------------------------------------------------------
# 任务执行编排
# ---------------------------------------------------------------------------

def _asin_backfill_days(task: dict, asin_row: dict) -> int:
    """本次要拉多少天：首次入池按任务回补天数，之后拉滚动窗口（+2 天容错）。"""
    last = (asin_row.get("lastStatDate") or "")[:10]
    if not last:
        return int(task.get("backfillDays") or 90)
    gap = _days_between(last, _today())
    if gap is None or gap <= 0:
        return 3
    return max(3, min(45, gap + 2))


def _pull_asins(state, task: dict, pool: list, stats: dict, th: sif_fetcher._Throttle):
    """拉一批 ASIN 的逐日数据并落库（含首次回补）。"""
    tid = task["id"]
    country = task.get("country") or "US"
    for a in pool:
        asin = a.get("asin")
        if not asin:
            continue
        days = int(a.get("_backfillDays") or _asin_backfill_days(task, a))
        th.wait()
        try:
            points = sif_fetcher.asin_traffic_trend(asin, country, days)
            stats["asin_trend_calls"] = stats.get("asin_trend_calls", 0) + 1
            stats["calls"] += 1
            if points:
                state.save_asin_snapshots(tid, asin, points)
                stats["asin_points_saved"] = stats.get("asin_points_saved", 0) + len(points)
        except sif_fetcher.SifError as e:
            stats["errors"] += 1
            stats["error_detail"].append(f"asin_trend({asin}): {str(e)[:120]}")


def _grow_pool(state, task: dict, candidates: list, stats: dict, th: sif_fetcher._Throttle) -> int:
    """候选 ASIN 入池（受 asinLimit 约束）→ 补静态属性 → 回补日数据。"""
    tid = task["id"]
    limit = int(task.get("asinLimit") or 20)
    known = {a["asin"] for a in state.list_asins(tid, active_only=False)}
    rows, seen = [], set()
    for c in candidates or []:
        asin = (c.get("asin") or "").strip().upper()
        if not asin or asin in known or asin in seen:
            continue
        seen.add(asin)
        rows.append(dict(c, asin=asin))
    if not rows:
        return 0
    active = len([a for a in state.list_asins(tid) if a.get("active")])
    rows = rows[:max(0, limit - active)]
    if not rows:
        return 0
    added = state.add_asins(tid, rows)
    stats["asin_new"] = stats.get("asin_new", 0) + added
    if not added:
        return 0
    codes = [r["asin"] for r in rows]
    # 静态属性（价格/评分/BSR/上架日期/尺寸重量）——新品黑马判定依赖上架日期
    for p in sif_fetcher.enrich_asin_profiles(codes, stats, th, task.get("country") or "US"):
        if p.get("asin"):
            state.update_asin_profile(tid, p["asin"], p)
    pool = [a for a in state.list_asins(tid) if a["asin"] in set(codes)]
    for a in pool:
        a["_backfillDays"] = int(task.get("backfillDays") or 90)
    _pull_asins(state, task, pool, stats, th)
    return added


def execute_task(state, task: dict) -> dict:
    """执行一次任务：每日层必跑，每周层按间隔附带跑；落库 + 产信号 + 记运行日志。"""
    tid = task["id"]
    started = _now_iso()
    run_date = started[:10]
    settings = state.get_sif_settings()
    thresholds = settings.get("thresholds", {})
    th = sif_fetcher._Throttle()
    stats = sif_fetcher.new_stats()

    # 记下本次运行的开始时间：lastRunAt 同时用于判定「running 是否已僵死」
    state.set_sif_task_status(tid, "running", error=None, run_at=started)

    last_weekly = (task.get("lastWeeklyAt") or "")[:10]
    gap = _days_between(last_weekly, run_date) if last_weekly else None
    weekly_due = (gap is None) or (gap >= WEEKLY_INTERVAL_DAYS)

    # ---------- 每日层 ----------
    pool = state.list_asins(tid)
    for a in pool:
        a["_backfillDays"] = _asin_backfill_days(task, a)

    def on_kw_snapshot(rows):
        state.save_kw_snapshots(tid, run_date, _now_iso(), rows)

    def on_asin_points(asin, points):
        state.save_asin_snapshots(tid, asin, points)

    kw_rows = sif_fetcher.run_daily_layer(task, pool, stats, th, on_kw_snapshot, on_asin_points)
    stats["tiers"] = "daily"

    # 机会词 Top3 点击 ASIN → 自动入池（其画像与日数据回补也计入每日层成本）
    tracked = {a["asin"] for a in state.list_asins(tid, active_only=False)}
    cands = sif_fetcher.collect_asin_candidates(
        kw_rows, tracked, int(task.get("asinLimit") or 20))
    _grow_pool(state, task, cands, stats, th)

    # 每日层运行日志（在入池回补之后写，调用数才完整）
    state.log_sif_run(tid, run_date, "daily", started, _now_iso(),
                      "done" if not stats["errors"] else "partial", dict(stats),
                      "; ".join(stats["error_detail"][:3]) or None)

    # ---------- 每周层 ----------
    if weekly_due:
        w_started = _now_iso()
        w_stats = {"calls": 0, "screen_calls": 0, "demand_calls": 0, "history_calls": 0,
                   "asin_trend_calls": 0, "profile_calls": 0, "competitor_calls": 0,
                   "discovered": 0, "profiles_updated": 0, "asin_new": 0,
                   "asin_monitored": 0, "asin_points_saved": 0, "errors": 0,
                   "error_detail": [], "fatal": []}
        iso_week = _iso_week()
        keywords = [r["keyword"] for r in kw_rows if r.get("keyword")]
        if not keywords:
            keywords = [r["keyword"] for r in state.list_kw_snapshots(tid, run_date)]
        w_stats["discovered"] = len(keywords)

        def on_profile(profiles):
            state.save_kw_profiles(tid, iso_week, profiles)

        def on_trend(series):
            # screen 不返回 ABA 排名，用周度历史最新一期补进当日快照
            for kw, s in (series or {}).items():
                ranks = [r for r in (s.get("ranks") or []) if r]
                shares = [v for v in (s.get("click_shares") or []) if v is not None]
                state.update_kw_rank(tid, run_date, kw,
                                     int(ranks[-1]) if ranks else None,
                                     float(shares[-1]) if shares else None)

        def on_competitors(root, comps):
            state.save_asin_weekly(tid, root, iso_week,
                                   [dict(c, root=root) for c in (comps or [])])

        new_comps = sif_fetcher.run_weekly_layer(task, keywords, w_stats, th,
                                                on_profile=on_profile, on_trend=on_trend,
                                                on_competitors=on_competitors)
        if new_comps:
            _grow_pool(state, task, new_comps, stats, th)
        stats["calls"] += w_stats["calls"]
        stats["errors"] += w_stats["errors"]
        stats["error_detail"].extend(w_stats["error_detail"][:5])
        stats["weekly"] = w_stats
        stats["tiers"] = "daily+weekly"
        state.log_sif_run(tid, run_date, "weekly", w_started, _now_iso(),
                          "done" if not w_stats["errors"] else "partial", w_stats,
                          "; ".join(w_stats["error_detail"][:3]) or None)

    # ---------- 过期清理 ----------
    keep = int((settings.get("defaults") or {}).get("keepDays") or DEFAULT_KEEP_DAYS)
    cutoff = (datetime.date.today() - datetime.timedelta(days=max(30, keep))).isoformat()
    state.prune_kw_snapshots(tid, cutoff)

    # ---------- 信号引擎（纯本地，0 配额） ----------
    sig_errs = []
    signals = sif_signals.run_engine(state, tid, run_date, thresholds,
                                     task.get("direction") or "", errors_out=sig_errs)
    stats["signals"] = signals
    if sig_errs:
        stats["errors"] += len(sig_errs)
        stats["error_detail"].extend(sig_errs)
    state.patch_sif_run_stats(tid, run_date, "daily",
                              {"signals": signals, "pruneBefore": cutoff,
                               "signalErrors": sig_errs})

    # ---------- 不可恢复错误：直接停用，别让它每天白烧一份配额 ----------
    fatal = list(stats.get("fatal") or [])
    fatal += list((stats.get("weekly") or {}).get("fatal") or [])
    if fatal:
        msg = "不可恢复错误，任务已停用：" + "; ".join(fatal[:2])
        state.set_sif_task_status(tid, "error", error=msg[:500], run_at=_now_iso())
        state.update_sif_task(tid, {"enabled": False})
        stats["disabled"] = True
        print(f"  [sif] 任务 {task['name']} {msg}")
        return stats

    err = (f"{stats['errors']} 次调用失败：" + "; ".join(stats["error_detail"][:3])
           if stats["errors"] else None)
    state.set_sif_task_status(tid, "done" if not stats["errors"] else "partial", error=err,
                              run_at=_now_iso(), daily_at=run_date,
                              weekly_at=(run_date if weekly_due else None))
    print(f"  [sif] 任务 {task['name']} 完成[{stats['tiers']}]: 词 {stats['discovered']} / "
          f"ASIN {stats['asin_monitored']}(新{stats['asin_new']}) / 调用 {stats['calls']} / 信号 {signals}")
    return stats


def _note_failure(state, tid: str, task: dict, error: str):
    """记录一次硬失败：累计当日次数，按指数退避排下次重试，到上限即熔断。"""
    print(f"  [sif] 任务 {task['name']} 失败: {str(error)[:200]}")
    try:
        r = state.mark_sif_task_failed(tid, str(error)[:500])
        state.log_sif_run(tid, _today(), "daily", None, _now_iso(), "error", {}, str(error)[:500])
        if r["tripped"]:
            print(f"  [sif] 任务 {task['name']} 当天第 {r['failCount']} 次失败，已熔断，次日自动恢复")
        elif r["nextRetryAt"]:
            print(f"  [sif] 任务 {task['name']} 将在 {r['nextRetryAt'][11:]} 重试"
                  f"（当天第 {r['failCount']} 次失败）")
    except Exception:
        pass


def _disable_task(state, tid: str, task: dict, reason: str):
    """不可恢复错误（密钥失效 / 鉴权被拒 / 接口不存在）：直接停用，一次都不重试。

    这类错误重试多少次都不会成功，继续跑只是白烧配额，所以要人工确认后手动启用。
    """
    print(f"  [sif] 任务 {task['name']} 遇到不可恢复错误，已停用: {str(reason)[:200]}")
    try:
        state.set_sif_task_status(tid, "error", error=f"[已停用] {str(reason)[:480]}",
                                  run_at=_now_iso())
        state.update_sif_task(tid, {"enabled": False})
        state.log_sif_run(tid, _today(), "daily", None, _now_iso(), "error", {}, str(reason)[:500])
    except Exception:
        pass


def _launch(state, task: dict):
    """后台线程执行一次任务抓取。"""
    tid = task["id"]
    if _is_running(tid):
        return
    _mark(tid, True)

    def _run():
        try:
            execute_task(state, state.get_sif_task(tid) or task)
        except sif_fetcher.SifError as e:
            # 分层抓取内部会吞掉各步的 SifError，能冒到这里的通常是未加保护的调用
            if e.fatal:
                _disable_task(state, tid, task, str(e))
            else:
                _note_failure(state, tid, task, str(e))
        except Exception as e:
            print(f"  [sif] 任务 {task['name']} 异常: {e}")
            _note_failure(state, tid, task, str(e))
        finally:
            _mark(tid, False)

    threading.Thread(target=_run, daemon=True, name=f"SifTask-{tid[:8]}").start()


def _freq_hit(t: dict, today: str, weekday: int, now_hm: str, now_iso: str = "") -> bool:
    """判断任务是否应在本次扫描触发。

    失败退避由 fail_count / next_retry_at 承担：当天失败过且未到下次重试时刻、
    或失败次数已达上限（熔断），都直接跳过。跨天后 fail_date != today，这两个
    条件自动失效，任务在次日计划时刻重新参与调度——这是熔断能自愈的关键。

    注意：失败时不会推进 lastDailyAt（见 db.mark_sif_task_failed），所以「今天
    已跑过」这个判断拦不住失败重试，闸门必须落在这里。
    """
    sch = (t.get("scheduleTime") or "").strip()
    if not sch or ":" not in sch:
        return False
    if now_hm < sch:                                  # 未到设定时刻
        return False
    if (t.get("lastDailyAt") or "")[:10] == today:     # 今天已跑过（成功/部分成功）
        return False
    if (t.get("failDate") or "")[:10] == today:        # 当天失败过：走退避或熔断
        if int(t.get("failCount") or 0) >= SIF_MAX_RETRIES_PER_DAY:
            return False                               # 已熔断，次日自动恢复
        nra = (t.get("nextRetryAt") or "")[:16]
        if nra and (now_iso or "")[:16] < nra:
            return False                               # 退避未到期
    freq = t.get("freqType") or "daily"
    if freq == "weekly":
        if int(t.get("scheduleWeekday") or 1) != weekday:
            return False
    elif freq == "every_n":
        last = (t.get("lastDailyAt") or "")[:10]
        if last:
            gap = _days_between(last, today)
            n = max(1, int(t.get("everyNDays") or 2))
            if gap is not None and gap < n:
                return False
    return True


def start_scheduler(state):
    """后台守护线程：每分钟扫描一次，按各任务的频率档位触发抓取。"""

    def loop():
        # 崩溃恢复：重启后把残留 running 状态的任务标记为失败。
        # _is_running 是内存集合，进程一重启就丢了，所以这里用 last_run_at 做老化
        # 判断：只有明显跑超单次运行时长的才算僵死，避免误判刚启动的任务。
        try:
            stale = (datetime.datetime.now() -
                     datetime.timedelta(minutes=SIF_STALE_RUNNING_MIN)).strftime("%Y-%m-%dT%H:%M")
            for t in state.list_sif_tasks():
                if t.get("lastStatus") != "running":
                    continue
                if (t.get("lastRunAt") or "")[:16] > stale:
                    continue
                print(f"  [sif] 任务 {t['name']} 上次运行被中断，已标记失败")
                _note_failure(state, t["id"], t, "上次运行被中断（服务重启）")
        except Exception as e:
            print(f"  [sif] 启动恢复检查异常: {e}")

        while True:
            try:
                today, weekday = _today(), datetime.date.today().isoweekday()
                now_hm = time.strftime("%H:%M")
                now_iso = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")
                for t in state.list_sif_tasks():
                    if not t.get("enabled"):
                        continue
                    if not _freq_hit(t, today, weekday, now_hm, now_iso):
                        continue
                    print(f"  [sif] 定时触发 {t['name']}（{t.get('freqType')} {t.get('scheduleTime')}）@ {now_hm}")
                    _launch(state, t)
            except Exception as e:
                print(f"  [sif] 调度循环异常: {e}")
            time.sleep(60)

    th = threading.Thread(target=loop, daemon=True, name="SifScheduler")
    th.start()
    print("[sif] 爆品关键词监控调度线程已启动（每天 / 每 N 天 / 每周周几 + 自定义时刻，分层抓取）")


# ---------------------------------------------------------------------------
# 看板数据组装
# ---------------------------------------------------------------------------

def _pct_chg(cur, prev):
    if cur is None or prev in (None, 0):
        return None
    try:
        return round((float(cur) - float(prev)) / float(prev) * 100.0, 1)
    except Exception:
        return None


def _pct_lb(cur, prev):
    """排名/BSR 类指标（数值越小越好）的改善幅度：正数 = 变好。"""
    if cur is None or prev in (None, 0):
        return None
    try:
        return round((float(prev) - float(cur)) / float(prev) * 100.0, 1)
    except Exception:
        return None


def _enrich_keywords(state, task_id: str, run_date: str, rows: list, profiles: dict) -> list:
    """给当日关键词行补日环比 / 7 日环比 + 每周需求画像字段。"""
    out = []
    for r in rows:
        kw = r["keyword"]
        series = state.kw_series(task_id, kw, 21)
        idx = next((i for i in range(len(series) - 1, -1, -1)
                    if series[i]["runDate"] == run_date), len(series) - 1)
        cur = series[idx] if idx < len(series) and idx >= 0 else r
        p1 = series[idx - 1] if idx >= 1 else None
        p7 = series[idx - 7] if idx >= 7 else None
        item = dict(r)
        item["spark"] = [x.get("searchVolume") for x in series[-7:]]
        item["dod"] = _pct_chg(cur.get("searchVolume"), p1.get("searchVolume") if p1 else None)
        item["wow"] = _pct_chg(cur.get("searchVolume"), p7.get("searchVolume") if p7 else None)
        item["prevVolume"] = p1.get("searchVolume") if p1 else None
        item["rankDod"] = _pct_chg(cur.get("rank"), p1.get("rank") if p1 else None)
        pr = profiles.get(kw) or {}
        item["profile"] = {
            "trendDirection": pr.get("trend_direction"),
            "yoyChange":      pr.get("yoy_change"),
            "demandType":     pr.get("demand_type"),
            "peakMonth":      pr.get("peak_month"),
            "weeksToPeak":    pr.get("weeks_to_peak"),
            "seasonPosition": pr.get("season_position"),
            "diagnosis":      pr.get("diagnosis"),
            "adHint":         pr.get("ad_hint"),
        }
        out.append(item)
    out.sort(key=lambda x: (x.get("searchVolume") or 0), reverse=True)
    return out


def _enrich_asins(state, task_id: str, pool: list, latest: dict, prev7: dict) -> list:
    """给监控池每行补最新日数据 + BSR/价格/销量环比。"""
    out = []
    for a in pool:
        asin = a["asin"]
        series_all = state.asin_series(task_id, asin, 30)
        # SIF 偶有某日数据缺口：最后一天三个关键字段全空时，回退到最近一个有值的点
        cur = {}
        for p in reversed(series_all):
            if p.get("price") is not None or p.get("bsr") is not None \
                    or p.get("boughtMonth") is not None:
                cur = p
                break
        if not cur:
            cur = latest.get(asin) or {}
        series = series_all[-10:]
        p1 = {}
        for p in reversed(series[:-1] if len(series) > 1 else []):
            if p.get("date") and p["date"] < (cur.get("date") or ""):
                p1 = p
                break
        ref = prev7.get(asin) or {}
        days = None
        if a.get("firstAvailableDay"):
            try:
                d = datetime.date.fromisoformat(a["firstAvailableDay"][:10])
                days = (datetime.date.today() - d).days
            except Exception:
                days = None
        item = dict(a)
        item.update({
            "latest":     cur,
            "statDate":   cur.get("date"),
            "bsrPrev":    p1.get("bsr"),
            "bsrChg":     _pct_lb(cur.get("bsr"), p1.get("bsr")),
            "pricePrev":  p1.get("price"),
            "priceChg":   _pct_chg(cur.get("price"), p1.get("price")),
            "salesPrev":  ref.get("boughtMonth"),
            "salesWow":   _pct_chg(cur.get("boughtMonth"), ref.get("boughtMonth")),
            "reviewWow":  _pct_chg(cur.get("reviewNum"), ref.get("reviewNum")),
            "nfShare":    (round(cur["nfScore"] / cur["totalScore"] * 100.0, 1)
                           if cur.get("totalScore") and cur.get("nfScore") is not None else None),
            "onSaleDays": days,
            "statDays":   len(state.asin_kw_dates(task_id, asin)),
        })
        out.append(item)
    out.sort(key=lambda x: (x["latest"].get("boughtMonth") or 0), reverse=True)
    return out


# ---------------------------------------------------------------------------
# 点查（重接口，手动触发，不进定时）
# ---------------------------------------------------------------------------

def _do_inspect(payload: dict):
    kind = (payload.get("type") or "").strip()
    country = (payload.get("country") or "US").upper()
    kw = (payload.get("keyword") or "").strip()
    asin = (payload.get("asin") or "").strip().upper()

    if kind == "competition":
        if not kw:
            raise ValueError("keyword required")
        return sif_fetcher.keyword_competition(kw, country)
    if kind == "root_competitors":
        if not kw:
            raise ValueError("keyword required")
        return sif_fetcher.root_competitors(kw, country, int(payload.get("topN") or 10))
    if kind == "discover":
        if not kw:
            raise ValueError("keyword required")
        return sif_fetcher.discover_competitors(kw, country, {
            k: payload.get(k) for k in
            ("price_min", "price_max", "max_reviews", "posture_filter", "my_asin", "max_results")})
    if kind == "root_trend":
        if not kw:
            raise ValueError("keyword required")
        return sif_fetcher.keyword_root_trend(kw, country, payload.get("granularity") or "week")
    if kind == "history":
        kws = payload.get("keywords") or ([kw] if kw else [])
        kws = [k.strip() for k in kws if k and k.strip()][:10]
        if not kws:
            raise ValueError("keywords required")
        return sif_fetcher.keyword_history(kws, country, payload.get("granularity") or "week")
    if kind == "screen":
        if not kw:
            raise ValueError("keyword required")
        return {"keywords": sif_fetcher.screen_opportunities(
            kw, country, min(int(payload.get("topN") or 10), 20))}
    if kind == "listing_keywords":
        if not asin:
            raise ValueError("asin required")
        return {"list": sif_fetcher.asin_listing_keywords(
            asin, country, int(payload.get("recentDays") or 7), payload.get("dimension") or "asin")}
    if kind == "asin_signals":
        if not asin:
            raise ValueError("asin required")
        return sif_fetcher.asin_keyword_signals(asin, country,
                                                int(payload.get("recentDays") or 7),
                                                int(payload.get("topN") or 30))
    if kind == "asin_profile":
        codes = [a.strip().upper() for a in (payload.get("asins") or ([asin] if asin else []))
                 if a and a.strip()][:20]
        if not codes:
            raise ValueError("asin required")
        return {"list": sif_fetcher.asin_profiles(codes, country)}
    if kind == "asin_sales":
        codes = [a.strip().upper() for a in (payload.get("asins") or ([asin] if asin else []))
                 if a and a.strip()][:100]
        if not codes:
            raise ValueError("asin required")
        return {"list": sif_fetcher.asin_sales_list(codes, country,
                                                    payload.get("dimension") or "asin",
                                                    int(payload.get("recentDays") or 30))}
    if kind == "promotion":
        kws = payload.get("keywords") or ([kw] if kw else [])
        kws = [k.strip() for k in kws if k and k.strip()][:20]
        if not kws:
            raise ValueError("keywords required")
        return sif_fetcher.assess_promotion(kws, country, payload.get("ownPrice"),
                                            payload.get("ownMargin"), payload.get("benchmarkAsins"))
    if kind == "profit":
        required = ("price", "category", "weight_oz", "freight_cost", "target_margin")
        optional = ("length_in", "width_in", "height_in", "tariff_rate", "is_apparel",
                    "turnover_days", "price_currency")
        args = {k: payload.get(k) for k in required + optional}
        for k in required:
            if args.get(k) in (None, ""):
                raise ValueError(f"{k} required")
        args["country"] = country
        return sif_fetcher.profit_threshold(args)
    raise ValueError("unknown inspect type: " + kind)


# ---------------------------------------------------------------------------
# 路由注册
# ---------------------------------------------------------------------------

def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def _user(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return None
        return user

    def _q(self):
        return parse_qs(urlparse(self.path).query)

    def _need_config(self):
        if not sif_fetcher.is_configured():
            self._send_json(400, {"error": "SIF MCP 未配置：请设置 SIF_MCP_KEY 环境变量"
                                            " 或 data/sif-config.json"})
            return False
        return True

    # ---- 看板 ----

    def get_board(self):
        if not _user(self):
            return
        q = _q(self)
        task_id = (q.get("taskId") or [""])[0]
        days = max(1, min(90, int((q.get("days") or ["30"])[0])))
        tasks = state.list_sif_tasks()
        board = {
            "overview": state.sif_overview(),
            "settings": state.get_sif_settings(),
            "tasks": tasks,
            "signals": state.list_signals(days=min(days, 30), task_id=task_id or None),
            "signalCounts": state.signal_counts(days=min(days, 30)),
            "weeklyInterval": WEEKLY_INTERVAL_DAYS,
        }
        if not task_id and tasks:
            task_id = tasks[0]["id"]
        board["taskId"] = task_id
        board["task"] = state.get_sif_task(task_id) if task_id else None
        board["dates"] = state.kw_dates(task_id, 120) if task_id else []
        board["runs"] = state.list_sif_runs(task_id, 20) if task_id else []
        if task_id:
            run_date = (q.get("date") or [None])[0]
            if run_date not in board["dates"]:
                run_date = board["dates"][0] if board["dates"] else _today()
            rows = state.list_kw_snapshots(task_id, run_date)
            board["runDate"] = run_date
            board["keywords"] = _enrich_keywords(state, task_id, run_date, rows,
                                                 state.latest_kw_profiles(task_id))
            board["asins"] = _enrich_asins(state, task_id, state.list_asins(task_id),
                                           state.asin_latest_map(task_id),
                                           state.asin_prev_map(task_id, 7))
            lw = ((board["task"] or {}).get("lastWeeklyAt") or "")[:10]
            g = _days_between(lw, _today()) if lw else None
            board["weeklyDue"] = g is None or g >= WEEKLY_INTERVAL_DAYS
        self._send_json(200, board)
    GET["/api/sif/board"] = get_board

    # ---- 任务 CRUD ----

    def get_tasks(self):
        if not _user(self):
            return
        self._send_json(200, {"tasks": state.list_sif_tasks()})
    GET["/api/sif/tasks"] = get_tasks

    def post_tasks(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        if not (payload.get("name") or "").strip():
            self._send_json(400, {"error": "name required"})
            return
        mode = payload.get("mode") or "root"
        if mode not in ("root", "keywords"):
            self._send_json(400, {"error": "mode must be root or keywords"})
            return
        if mode == "root" and not (payload.get("roots") or []):
            self._send_json(400, {"error": "roots required"})
            return
        if mode == "keywords" and not (payload.get("keywords") or []):
            self._send_json(400, {"error": "keywords required"})
            return
        if payload.get("freqType") not in ("daily", "every_n", "weekly"):
            payload["freqType"] = "daily"
        defaults = state.get_sif_settings().get("defaults", {})
        for key, dkey in (("topN", "topN"), ("quotaLimit", "quotaLimit"),
                          ("asinLimit", "asinLimit"), ("backfillDays", "backfillDays")):
            if not payload.get(key):
                payload[key] = defaults.get(dkey)
        tid = state.create_sif_task(payload)
        manual = [a.strip().upper() for a in (payload.get("asins") or []) if a and a.strip()]
        if manual:
            state.add_asins(tid, [{"asin": a, "source": "manual"} for a in manual])
        self._send_json(200, {"task": state.get_sif_task(tid)})
    POST["/api/sif/tasks"] = post_tasks

    def put_tasks(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = payload.get("id")
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        if _is_running(tid):
            self._send_json(400, {"error": "任务正在运行，请稍后再改"})
            return
        state.update_sif_task(tid, payload)
        if payload.get("asins") is not None:
            manual = [a.strip().upper() for a in payload["asins"] if a and a.strip()]
            if manual:
                state.add_asins(tid, [{"asin": a, "source": "manual", "force_reactivate": True}
                                      for a in manual])
        self._send_json(200, {"task": state.get_sif_task(tid)})
    PUT["/api/sif/tasks"] = put_tasks

    def delete_task(self):
        if not _user(self):
            return
        tid = (_q(self).get("id") or [""])[0]
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        if _is_running(tid):
            self._send_json(400, {"error": "任务正在运行，无法删除"})
            return
        state.delete_sif_task(tid)
        self._send_json(200, {"ok": True})
    DELETE["/api/sif/tasks"] = delete_task

    # ---- 运行 ----

    def post_run(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = payload.get("id") or payload.get("taskId")
        task = state.get_sif_task(tid) if tid else None
        if not task:
            self._send_json(404, {"error": "task not found"})
            return
        if not _need_config(self):
            return
        if _is_running(tid):
            self._send_json(400, {"error": "该任务正在运行中"})
            return
        _launch(state, task)
        self._send_json(200, {"ok": True, "taskId": tid})
    POST["/api/sif/run"] = post_run

    def get_runs(self):
        if not _user(self):
            return
        self._send_json(200, {"runs": state.list_sif_runs(
            (_q(self).get("taskId") or [None])[0], 60)})
    GET["/api/sif/runs"] = get_runs

    # ---- 趋势序列 ----

    def get_kw_trend(self):
        if not _user(self):
            return
        q = _q(self)
        tid, kw = (q.get("taskId") or [""])[0], (q.get("keyword") or [""])[0]
        if not tid or not kw:
            self._send_json(400, {"error": "taskId & keyword required"})
            return
        days = max(2, min(365, int((q.get("days") or ["90"])[0])))
        self._send_json(200, {"keyword": kw, "daily": state.kw_series(tid, kw, days),
                              "profile": state.kw_profile(tid, kw)})
    GET["/api/sif/kw-trend"] = get_kw_trend

    def get_asin_trend(self):
        if not _user(self):
            return
        q = _q(self)
        tid, asin = (q.get("taskId") or [""])[0], (q.get("asin") or [""])[0].upper()
        if not tid or not asin:
            self._send_json(400, {"error": "taskId & asin required"})
            return
        days = max(2, min(365, int((q.get("days") or ["90"])[0])))
        prof = next((a for a in state.list_asins(tid, False) if a["asin"] == asin), None)
        self._send_json(200, {"asin": asin, "series": state.asin_series(tid, asin, days),
                              "profile": prof})
    GET["/api/sif/asin-trend"] = get_asin_trend

    def get_universe(self):
        if not _user(self):
            return
        tid = (_q(self).get("taskId") or [""])[0]
        if not tid:
            self._send_json(400, {"error": "taskId required"})
            return
        self._send_json(200, {"keywords": state.kw_universe(tid)})
    GET["/api/sif/universe"] = get_universe

    # ---- ASIN 监控池 ----

    def get_pool(self):
        if not _user(self):
            return
        tid = (_q(self).get("taskId") or [""])[0]
        if not tid:
            self._send_json(400, {"error": "taskId required"})
            return
        pool = state.list_asins(tid, active_only=False)
        latest = state.asin_latest_map(tid)
        for a in pool:
            a["latest"] = latest.get(a["asin"]) or {}
        self._send_json(200, {"pool": pool,
                              "limit": (state.get_sif_task(tid) or {}).get("asinLimit") or 20})
    GET["/api/sif/pool"] = get_pool

    def post_pool_add(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = payload.get("taskId")
        codes = [a.strip().upper() for a in (payload.get("asins") or []) if a and a.strip()]
        if not tid or not codes:
            self._send_json(400, {"error": "taskId & asins required"})
            return
        if not _need_config(self):
            return
        task = state.get_sif_task(tid) or {"id": tid, "country": "US"}
        added = state.add_asins(tid, [{"asin": a, "source": "manual"} for a in codes])
        stats = sif_fetcher.new_stats()
        stats["asin_new"] = added
        th = sif_fetcher._Throttle()
        new_rows = [a for a in state.list_asins(tid)
                    if a["asin"] in set(codes) and not a.get("lastStatDate")]
        if new_rows:
            for p in sif_fetcher.enrich_asin_profiles([a["asin"] for a in new_rows], stats, th,
                                                      task.get("country") or "US"):
                if p.get("asin"):
                    state.update_asin_profile(tid, p["asin"], p)
            for a in new_rows:
                a["_backfillDays"] = int(task.get("backfillDays") or 90)
            _pull_asins(state, task, new_rows, stats, th)
            try:
                sif_signals.run_engine(state, tid, _today(),
                                       state.get_sif_settings().get("thresholds", {}),
                                       task.get("direction") or "")
            except Exception as e:
                print(f"  [sif] 入池信号计算失败: {e}")
        self._send_json(200, {"ok": True, "added": added, "calls": stats["calls"],
                              "errors": stats["error_detail"][:3]})
    POST["/api/sif/pool/add"] = post_pool_add

    def post_pool_toggle(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid, asin = payload.get("taskId"), (payload.get("asin") or "").strip().upper()
        if not tid or not asin:
            self._send_json(400, {"error": "taskId & asin required"})
            return
        state.set_asin_active(tid, asin, bool(payload.get("active", True)))
        self._send_json(200, {"ok": True})
    POST["/api/sif/pool/toggle"] = post_pool_toggle

    def post_pool_remove(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid, asin = payload.get("taskId"), (payload.get("asin") or "").strip().upper()
        if not tid or not asin:
            self._send_json(400, {"error": "taskId & asin required"})
            return
        state.delete_asin(tid, asin)
        self._send_json(200, {"ok": True})
    POST["/api/sif/pool/remove"] = post_pool_remove

    # ---- 信号 ----

    def get_signals(self):
        if not _user(self):
            return
        q = _q(self)
        days = int((q.get("days") or ["14"])[0])
        self._send_json(200, {
            "signals": state.list_signals(days, (q.get("taskId") or [None])[0],
                                          int((q.get("limit") or ["400"])[0])),
            "counts": state.signal_counts(days),
        })
    GET["/api/sif/signals"] = get_signals

    def get_signal_top(self):
        """按词/ASIN 聚合的异动榜（同一对象命中多种信号 = 更值得关注）。"""
        if not _user(self):
            return
        q = _q(self)
        days = int((q.get("days") or ["14"])[0])
        rows = state.list_signals(days, (q.get("taskId") or [None])[0])
        agg = {}
        for r in rows:
            key = (r["refType"], r["refId"])
            a = agg.setdefault(key, {"refType": r["refType"], "refId": r["refId"],
                                     "kinds": [], "severity": "info",
                                     "direction": r.get("direction") or ""})
            a["kinds"].append(r["kind"])
            if r["severity"] == "high":
                a["severity"] = "high"
            elif r["severity"] == "warn" and a["severity"] != "high":
                a["severity"] = "warn"
        order = {"high": 0, "warn": 1, "info": 2}
        items = sorted(agg.values(),
                       key=lambda x: (-len(x["kinds"]), order.get(x["severity"], 3)))
        self._send_json(200, {"items": items[:60], "days": days})
    GET["/api/sif/signal-top"] = get_signal_top

    def post_signal_ack(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        sid = payload.get("id")
        if sid is None:
            self._send_json(400, {"error": "id required"})
            return
        state.ack_signal(sid, bool(payload.get("ack", True)))
        self._send_json(200, {"ok": True})
    POST["/api/sif/signals/ack"] = post_signal_ack

    # ---- 设置（阈值 / 默认配额，前端可配） ----

    def get_settings(self):
        if not _user(self):
            return
        self._send_json(200, state.get_sif_settings())
    GET["/api/sif/settings"] = get_settings

    def put_settings(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        section, values = payload.get("section"), payload.get("values") or {}
        if section not in ("thresholds", "defaults"):
            self._send_json(400, {"error": "section must be thresholds or defaults"})
            return
        self._send_json(200, state.save_sif_settings(section, values))
    PUT["/api/sif/settings"] = put_settings

    # ---- 试查 / 点查 ----

    def post_preview(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        root = (payload.get("root") or "").strip()
        if not root:
            self._send_json(400, {"error": "root required"})
            return
        if not _need_config(self):
            return
        top_n = min(int(payload.get("topN") or 8), 20)
        country = (payload.get("country") or "US").upper()
        try:
            found = sif_fetcher.screen_opportunities(root, country, top_n)
            comps = (sif_fetcher.root_competitors(root, country, 10)
                     if payload.get("withCompetitors") else {"competitors": []})
        except sif_fetcher.SifError as e:
            self._send_json(502, {"error": str(e)})
            return
        self._send_json(200, {"root": root, "keywords": found,
                              "competitors": comps.get("competitors") or []})
    POST["/api/sif/preview"] = post_preview

    def post_inspect(self):
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        if not _need_config(self):
            return
        try:
            data = _do_inspect(payload)
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        except sif_fetcher.SifError as e:
            self._send_json(502, {"error": str(e)})
            return
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        self._send_json(200, {"type": payload.get("type"), "data": data})
    POST["/api/sif/inspect"] = post_inspect
