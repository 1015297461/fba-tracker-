#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
类目榜单监控路由（catmon）
================================
GET    /api/catmon/targets              监控对象列表
POST   /api/catmon/targets              新建（支持直接传榜单 URL）
PUT    /api/catmon/targets              更新（频率/开关/标签/榜单类型）
DELETE /api/catmon/targets?id=          删除（级联清理监控数据）
POST   /api/catmon/run                  立即采集（后台线程，不阻塞 HTTP）
GET    /api/catmon/snapshot?targetId=&listType=&date=   某次快照（100 条）
GET    /api/catmon/trend?targetId=&listType=&asin=      某 ASIN 排名历史
GET    /api/catmon/events?targetId=&days=               进出榜/升降榜
GET    /api/catmon/runs?targetId=                       运行日志
GET    /api/catmon/detail?asin=&marketplace=&refresh=   按需采集详情（进程内存缓存）
"""

import datetime
import threading
import time
from urllib.parse import urlparse, parse_qs

from ..utils import _extract_token, _now_iso, _log
from .. import catmon_fetcher

# 同一 target 同时只允许一个采集任务（模块级，单进程有效）
_running = set()
_running_lock = threading.Lock()
# tid → {"pause": Event, "cancel": Event}：暂停在「每个榜单开始前」生效，
# 这样暂停点永远落在两个榜单之间，不会把半截榜单写进库。
_ctl = {}

DEFAULT_LIST_TYPES = ["bestsellers", "new-releases"]

PAUSE_HINT = "已暂停（点「继续」接着跑）"


def _wait_if_paused(state, tid, ctl):
    """暂停闸门。返回 True 表示被取消（调用方应停止后续榜单）。"""
    if not ctl or not ctl["pause"].is_set():
        return bool(ctl and ctl["cancel"].is_set())
    state.set_catmon_target_status(tid, "paused", None, None, progress=PAUSE_HINT)
    _log(f"[catmon] {tid} 已暂停（当前榜单完成后停在原地）")
    while ctl["pause"].is_set():
        if ctl["cancel"].is_set():
            return True
        time.sleep(0.5)
    if ctl["cancel"].is_set():
        return True
    state.set_catmon_target_status(tid, "running", None, None, progress="继续采集…")
    _log(f"[catmon] {tid} 已继续")
    return False


def _start_run(state, target):
    """起一个后台采集线程。已在跑则返回 False。"""
    tid = target["id"]
    with _running_lock:
        if tid in _running:
            return False
        _running.add(tid)
        ctl = {"pause": threading.Event(), "cancel": threading.Event()}
        _ctl[tid] = ctl
    threading.Thread(target=_run_target, args=(state, target, ctl),
                     daemon=True, name="CatmonRun").start()
    return True


def _run_target(state, target, ctl=None):
    tid = target["id"]
    run_id = state.add_catmon_run(tid)
    started = _now_iso()
    state.set_catmon_target_status(tid, "running", None, started, progress="开始采集")

    total_pages = total_reqs = total_items = 0
    errors = []
    cancelled = False
    try:
        for lt in (target.get("listTypes") or DEFAULT_LIST_TYPES):
            # 暂停点：只在「开始下一个榜单之前」等，绝不停在两个榜单中间，
            # 否则下次继续时得重抓半截榜单（且会重复写同日快照）。
            if _wait_if_paused(state, tid, ctl):
                cancelled = True
                break
            list_label = {"bestsellers": "畅销榜", "new-releases": "新品榜"}.get(lt, lt)
            state.set_catmon_target_status(tid, "running", None, None, progress=f"正在采集 {list_label}…")
            res = catmon_fetcher.fetch_listing(
                target["marketplace"], target.get("nodePath"), target["nodeId"], lt)
            total_pages += res["pages"]
            total_reqs += res["requests"]
            if res["items"]:
                state.save_catmon_snapshot(tid, lt, res["runDate"], res["items"], res["status"])
                total_items += len(res["items"])
            if res.get("label") and not target.get("label"):
                state.update_catmon_target(tid, {"label": res["label"]})
                target["label"] = res["label"]
            if res["status"] != "ok":
                errors.append(f"{lt}:{res['status']}")
            state.set_catmon_target_status(
                tid, "running", None, None,
                progress=f"{list_label} 完成 {len(res['items'])} 条")

        if cancelled:
            state.set_catmon_target_status(tid, "cancelled", None, _now_iso(), progress="")
            state.finish_catmon_run(run_id, "cancelled", total_pages, total_reqs,
                                    total_items, "已取消")
            _log(f"[catmon] {tid} 已取消（已采集 {total_items} 条已保留）")
            return

        status = "ok" if not errors else ("partial" if total_items else "error")
        err = "; ".join(errors) or None
        state.set_catmon_target_status(tid, status, err, _now_iso(), progress="")
        state.finish_catmon_run(run_id, status, total_pages, total_reqs, total_items, err)
        _log(f"[catmon] {target['marketplace']}/{target['nodeId']} 完成："
             f"{total_items} 条 / {total_pages} 页 / {total_reqs} 请求")
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        state.set_catmon_target_status(tid, "error", msg, _now_iso(), progress="")
        state.finish_catmon_run(run_id, "error", total_pages, total_reqs, total_items, msg)
        _log(f"[catmon] {tid} 失败：{msg}")
    finally:
        with _running_lock:
            _running.discard(tid)
            _ctl.pop(tid, None)


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def _verify(handler):
        """返回当前用户；未登录时已写回 401，返回 None。"""
        user = auth.verify(_extract_token(handler))
        if not user:
            handler._send_json(401, {"error": "请先登录"})
        return user

    # ---- 监控对象 ----

    def get_targets(self):
        if not _verify(self):
            return
        self._send_json(200, {"targets": state.list_catmon_targets()})
    GET["/api/catmon/targets"] = get_targets

    def post_target(self):
        if not _verify(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        url = (payload.get("url") or "").strip()
        try:
            if url:
                info = catmon_fetcher.parse_category_url(url)
                info.setdefault("label", payload.get("label"))
                info["listTypes"] = payload.get("listTypes") or DEFAULT_LIST_TYPES
                tid = state.create_catmon_target(info)
            else:
                tid = state.create_catmon_target(payload)
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        target = state.get_catmon_target(tid)
        _log(f"[catmon] 新建监控 {tid} {target['marketplace']}/{target['nodeId']} "
             f"{target.get('label') or ''}")
        self._send_json(200, {"target": target})
    POST["/api/catmon/targets"] = post_target

    def put_target(self):
        if not _verify(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = (payload.get("id") or "").strip()
        if not tid or not state.get_catmon_target(tid):
            self._send_json(404, {"error": "target not found"})
            return
        state.update_catmon_target(tid, payload)
        self._send_json(200, {"target": state.get_catmon_target(tid)})
    PUT["/api/catmon/targets"] = put_target

    # ---- 查询记录拖拽排序 ----

    def put_order(self):
        if not _verify(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        ids = payload.get("ids") or []
        if not isinstance(ids, list) or not ids:
            self._send_json(400, {"error": "ids required"})
            return
        known = {t["id"] for t in state.list_catmon_targets()}
        ids = [i for i in ids if i in known]
        if not ids:
            self._send_json(400, {"error": "no valid ids"})
            return
        state.reorder_catmon_targets(ids)
        self._send_json(200, {"ok": True, "ids": ids})
    PUT["/api/catmon/targets/order"] = put_order

    def delete_target(self):
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        # 删除前先叫停在跑的线程，避免它继续往已删的 target 写快照
        with _running_lock:
            ctl = _ctl.get(tid)
        if ctl:
            ctl["cancel"].set()
            ctl["pause"].clear()      # 让暂停中的线程能走到取消分支
        state.delete_catmon_target(tid)
        self._send_json(200, {"ok": True})
    DELETE["/api/catmon/targets"] = delete_target

    # ---- 立即采集 ----

    def post_run(self):
        if not _verify(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = (payload.get("id") or "").strip()
        target = state.get_catmon_target(tid) if tid else None
        if not target:
            self._send_json(404, {"error": "target not found"})
            return
        # 若当前是"已暂停"状态点立即采集：等价于继续（先清暂停标记，避免新线程一进来就被挡住）
        with _running_lock:
            ctl = _ctl.get(tid)
        if ctl:
            ctl["pause"].clear()
        started = _start_run(state, target)
        self._send_json(200, {"ok": True, "already": not started})
    POST["/api/catmon/run"] = post_run

    # ---- 暂停 / 继续 ----

    def _ctl_target(handler):
        payload = handler._read_json()
        if payload is None:
            return None, None
        tid = (payload.get("id") or "").strip()
        if not tid:
            handler._send_json(400, {"error": "id required"})
            return None, None
        target = state.get_catmon_target(tid)
        if not target:
            handler._send_json(404, {"error": "target not found"})
            return None, None
        return tid, target

    def post_pause(self):
        if not _verify(self):
            return
        tid, target = _ctl_target(self)
        if not tid:
            return
        with _running_lock:
            ctl = _ctl.get(tid)
            alive = tid in _running
        if not alive or not ctl:
            self._send_json(200, {"ok": True, "already": False})
            return
        ctl["pause"].set()
        # 立刻改状态，让界面马上看到「已暂停」，不用等线程跑到下一个榜单
        state.set_catmon_target_status(tid, "paused", None, None, progress=PAUSE_HINT)
        self._send_json(200, {"ok": True})
    POST["/api/catmon/pause"] = post_pause

    def post_resume(self):
        if not _verify(self):
            return
        tid, target = _ctl_target(self)
        if not tid:
            return
        with _running_lock:
            ctl = _ctl.get(tid)
            alive = tid in _running
        if alive and ctl:
            ctl["pause"].clear()
            state.set_catmon_target_status(tid, "running", None, None, progress="继续采集…")
            self._send_json(200, {"ok": True, "resumed": True})
            return
        # 线程已不在（例如后端重启过），继续 = 重新起一轮
        started = _start_run(state, target)
        self._send_json(200, {"ok": True, "resumed": False, "started": started})
    POST["/api/catmon/resume"] = post_resume

    # ---- 查询 ----

    def get_snapshot(self):
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "targetId required"})
            return
        lt = (q.get("listType") or ["bestsellers"])[0]
        date = (q.get("date") or [None])[0]
        self._send_json(200, {"snapshot": state.list_catmon_snapshot(tid, lt, date)})
    GET["/api/catmon/snapshot"] = get_snapshot

    def get_snapshots(self):
        """历史快照日期列表（供「榜单列表」选择历史快照）。"""
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "targetId required"})
            return
        lt = (q.get("listType") or ["bestsellers"])[0]
        self._send_json(200, {"snapshots": state.list_catmon_snapshot_dates(tid, lt)})
    GET["/api/catmon/snapshots"] = get_snapshots

    def get_trend(self):
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [""])[0].strip()
        lt = (q.get("listType") or ["bestsellers"])[0]
        start = (q.get("start") or [None])[0]
        end = (q.get("end") or [None])[0]
        asins_raw = (q.get("asins") or [""])[0]
        single = (q.get("asin") or [""])[0].strip().upper()
        try:
            top_n = int((q.get("topN") or ["5"])[0])
        except ValueError:
            top_n = 5
        if not tid:
            self._send_json(400, {"error": "targetId required"})
            return
        asin_list = [a.strip() for a in asins_raw.split(",") if a.strip()]
        if not asin_list and single:
            asin_list = [single]
        self._send_json(200, state.list_catmon_trend_range(tid, lt, asin_list, start, end, top_n))
    GET["/api/catmon/trend"] = get_trend

    def get_events(self):
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [None])[0]
        start = (q.get("start") or [None])[0]
        end = (q.get("end") or [None])[0]
        try:
            days = int((q.get("days") or ["7"])[0])
            limit = int((q.get("limit") or ["200"])[0])
        except ValueError:
            days, limit = 7, 200
        self._send_json(200, {"events": state.list_catmon_events(tid, days, limit, start, end)})
    GET["/api/catmon/events"] = get_events

    def get_matrix(self):
        """区间内出现过的全部 ASIN 的每日位次矩阵（前端「全部 ASIN 位次」用）。"""
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [""])[0].strip()
        lt = (q.get("listType") or ["bestsellers"])[0]
        start = (q.get("start") or [None])[0]
        end = (q.get("end") or [None])[0]
        if not tid:
            self._send_json(400, {"error": "targetId required"})
            return
        self._send_json(200, state.list_catmon_matrix(tid, lt, start, end))
    GET["/api/catmon/matrix"] = get_matrix

    def get_runs(self):
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "targetId required"})
            return
        self._send_json(200, {"runs": state.list_catmon_runs(tid)})
    GET["/api/catmon/runs"] = get_runs

    # ---- 详情（点击才采集；进程内存缓存 + refresh 强制刷新） ----

    def get_detail(self):
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        asin = (q.get("asin") or [""])[0].strip().upper()
        mk = (q.get("marketplace") or ["US"])[0].strip().upper() or "US"
        refresh = (q.get("refresh") or ["0"])[0].lower() in ("1", "true", "yes")
        if not asin:
            self._send_json(400, {"error": "asin required"})
            return
        try:
            data = catmon_fetcher.fetch_detail(asin, mk, refresh=refresh)
        except Exception as e:
            _log(f"[catmon] 详情失败 {asin}: {type(e).__name__}: {e}")
            self._send_json(502, {"error": f"{type(e).__name__}: {e}"})
            return
        if data.get("error") and not data.get("title"):
            self._send_json(502, data)
            return
        _log(f"[catmon] 详情 {asin} {'刷新' if refresh else ''} "
             f"{'命中缓存' if data.get('cached') else '已采集'}")
        self._send_json(200, data)
    GET["/api/catmon/detail"] = get_detail


# ---------------------------------------------------------------------------
# 定时调度：每分钟扫描；到点且当天没跑过就触发
#   · daily   ：每天 schedule_time 之后跑一次
#   · weekly  ：每周 schedule_weekday 的 schedule_time 之后跑一次
#   · every_n ：距上次运行 >= every_n_days 且在 schedule_time 之后
# 进程重启后，只要当天已过时间点且没跑过，会自动补跑一次。
# ---------------------------------------------------------------------------
def _is_due(t, now=None):
    """判断某个 target 此刻是否该触发。抽出来便于单测。"""
    now = now or datetime.datetime.now()
    if not t.get("enabled"):
        return False
    ft = t.get("freqType") or "daily"
    if now.strftime("%H:%M") < (t.get("scheduleTime") or "09:00"):
        return False
    if (t.get("lastRunAt") or "")[:10] == now.strftime("%Y-%m-%d"):
        return False          # 当天已跑过
    if ft == "weekly":
        return now.isoweekday() == int(t.get("scheduleWeekday") or 1)
    if ft == "every_n":
        last = (t.get("lastRunAt") or "")[:10]
        if not last:
            return True
        try:
            gap = (now.date() - datetime.date.fromisoformat(last)).days
        except ValueError:
            return True
        return gap >= int(t.get("everyNDays") or 1)
    return True               # daily


def start_scheduler(state):
    def loop():
        done = set()  # (target_id, 'YYYY-MM-DD') 防当天重复触发
        while True:
            try:
                now = datetime.datetime.now()
                today = now.strftime("%Y-%m-%d")
                for t in state.list_catmon_targets():
                    if not _is_due(t, now):
                        continue
                    if t.get("lastStatus") == "paused":
                        continue          # 用户手动暂停的，定时任务不抢跑
                    key = (t["id"], today)
                    if key in done:
                        continue
                    if not _start_run(state, t):
                        continue
                    done.add(key)
                    _log(f"[catmon] 定时触发 {t['id']} {t.get('label') or t['nodeId']} @ {now:%H:%M}")
            except Exception as e:
                _log(f"[catmon] 调度异常: {type(e).__name__}: {e}")
            time.sleep(60)
    threading.Thread(target=loop, daemon=True, name="CatmonScheduler").start()
