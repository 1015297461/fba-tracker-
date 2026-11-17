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
GET    /api/catmon/detail?asin=&marketplace=&date=&refresh=  详情按天快照（一天一条，同日覆盖）
GET    /api/catmon/detail/dates?asin=&marketplace=      有快照的日期列表（弹窗日历用）
"""

import datetime
import threading
import time
from urllib.parse import urlparse, parse_qs

from ..utils import _extract_token, _now_iso, _log, time_window_error
from .. import asin_meta
from .. import catmon_fetcher
from .. import sprite_fetch

# 同一 target 同时只允许一个采集任务（模块级，单进程有效）
_running = set()
_running_lock = threading.Lock()
# tid → {"pause": Event, "cancel": Event}：暂停在「每个榜单开始前」生效，
# 这样暂停点永远落在两个榜单之间，不会把半截榜单写进库。
_ctl = {}

DEFAULT_LIST_TYPES = ["bestsellers", "new-releases"]

PAUSE_HINT = "已暂停（点「继续」接着跑）"

# 详情落地缓存的有效期：24 小时。详情是商品档案（标题/图片/五点/规格/评论摘要），
# 变动很慢；以前只放进程内存 + 10 分钟，隔十几分钟再看同一个 ASIN 就又抓一遍。
DETAIL_TTL = 24 * 3600


def _detail_fresh(ts):
    """fetched_at 是否还在有效期内。解析失败当作过期（宁可重抓一次）。"""
    if not ts:
        return False
    try:
        t = time.mktime(time.strptime(str(ts)[:19].replace("T", " "),
                                      "%Y-%m-%d %H:%M:%S"))
    except Exception:
        return False
    return (time.time() - t) < DETAIL_TTL


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


def _kick_asin_dates(state, tid, asins):
    """采集完成后**后台**补上架时间，不阻塞状态落库、也不拖慢下一次定时任务。

    上架时间不会变，每个 ASIN 一辈子只查一次（`asin_meta.ensure` 先读库再补），
    所以日常增量通常只有几个新面孔，几乎不耗时；已全有缓存时连浏览器都不会启动。
    """
    keys = [str(a or "").strip().upper() for a in (asins or []) if str(a or "").strip()]
    keys = list(dict.fromkeys(keys))
    if not keys:
        return

    def _worker():
        try:
            res = asin_meta.ensure(state, keys, max_new=len(keys))
            _log(f"[catmon] 自动补上架时间 {tid}：覆盖 {res.get('covered')}/{res.get('asked')}"
                 f"，本次新取 {res.get('fetched')}（待取 {res.get('to_fetch')}）"
                 f"，来源 {res.get('sources') or '缓存'}")
        except Exception as e:
            _log(f"[catmon] 自动补上架时间失败 {tid}：{type(e).__name__}: {e}")

    threading.Thread(target=_worker, daemon=True, name="CatmonAsinDates").start()


def _run_target(state, target, ctl=None):
    tid = target["id"]
    run_id = state.add_catmon_run(tid)
    started = _now_iso()
    state.set_catmon_target_status(tid, "running", None, started, progress="开始采集")

    total_pages = total_reqs = total_items = 0
    errors = []
    cancelled = False
    run_asins = []                              # 本次采到的全部 ASIN（采集完后台补上架时间）
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
                run_asins.extend(it.get("asin") for it in res["items"] if it.get("asin"))
            if res.get("label") and not target.get("label"):
                state.update_catmon_target(tid, {"label": res["label"]})
                target["label"] = res["label"]
            if res["status"] != "ok":
                # 只记 "bestsellers:error" 用户根本没法判断是网络、被拦还是结构变了。
                # fetch_listing 里已经把最后一条具体错误存在 error 字段，带上。
                detail = str(res.get("error") or "").strip()
                errors.append(f"{lt}:{res['status']}" + (f"（{detail}）" if detail else ""))
            state.set_catmon_target_status(
                tid, "running", None, None,
                progress=f"{list_label} 完成 {len(res['items'])} 条")

        if cancelled:
            state.set_catmon_target_status(tid, "cancelled", None, _now_iso(), progress="")
            state.finish_catmon_run(run_id, "cancelled", total_pages, total_reqs,
                                    total_items, "已取消")
            _log(f"[catmon] {tid} 已取消（已采集 {total_items} 条已保留）")
            _kick_asin_dates(state, tid, run_asins)      # 已采到的照样补
            return

        status = "ok" if not errors else ("partial" if total_items else "error")
        err = "; ".join(errors) or None
        state.set_catmon_target_status(tid, status, err, _now_iso(), progress="")
        state.finish_catmon_run(run_id, status, total_pages, total_reqs, total_items, err)
        _log(f"[catmon] {target['marketplace']}/{target['nodeId']} 完成："
             f"{total_items} 条 / {total_pages} 页 / {total_reqs} 请求")
        # 上架时间在后台补（不阻塞状态、不影响用户点「立即采集」）
        _kick_asin_dates(state, tid, run_asins)
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

    # 查询记录分类（与排名监测共用同一套实现，scope 区分）
    from .record_groups import register_groups as _register_groups
    _register_groups("catmon", "/api/catmon", GET, POST, PUT, DELETE, state, _verify)

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
        err = time_window_error(payload.get("scheduleTime"))
        if err:
            self._send_json(400, {"error": err})
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
        snap = state.list_catmon_snapshot(tid, lt, date)
        # 上架时间来自全局属性表（按 ASIN，与快照日期无关）；顺带把品牌补上
        if snap and snap.get("items"):
            try:
                meta = asin_meta.get_meta(state, [it.get("asin") for it in snap["items"]])
                for it in snap["items"]:
                    m = meta.get(str(it.get("asin") or "").upper()) or {}
                    it["firstAvailable"] = m.get("first_available_day") or None
            except Exception as e:
                _log(f"[catmon] 合并上架时间失败：{type(e).__name__}: {e}")
        self._send_json(200, {"snapshot": snap})
    GET["/api/catmon/snapshot"] = get_snapshot

    # ---- 补齐上架时间（卖家精灵通道） ----

    def post_fill_dates(self):
        """给指定快照里缺上架时间的 ASIN 补数据。

        取数来源由 `backend/asin_meta.py` 的 SOURCES 开关决定（当前只有 sprite）。
        """
        if not _verify(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = (payload.get("targetId") or "").strip()
        lt = (payload.get("listType") or "bestsellers").strip()
        date = payload.get("date") or None
        if not tid:
            self._send_json(400, {"error": "targetId required"})
            return
        # 两种调用方式：
        #   ① 传 asins：补这批（矩阵页补齐区间内的全部 ASIN 用）
        #   ② 不传：补该 target+榜单某天快照的 100 条
        raw_asins = payload.get("asins")
        if isinstance(raw_asins, list) and raw_asins:
            asins = [str(a or "").strip().upper() for a in raw_asins if str(a or "").strip()]
        else:
            snap = state.list_catmon_snapshot(tid, lt, date)
            items = (snap or {}).get("items") or []
            if not items:
                self._send_json(200, {"ok": True, "asked": 0, "fetched": 0, "covered": 0,
                                      "sources": {}, "note": "该快照没有数据"})
                return
            asins = [it.get("asin") for it in items if it.get("asin")]
        try:
            # 手动补齐：允许把「15 天前查过但没取到」的负缓存再问一次
            res = asin_meta.ensure(state, asins, max_new=len(asins) or 1, retry_days=15)
        except Exception as e:
            _log(f"[catmon] 补齐上架时间失败：{type(e).__name__}: {e}")
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"[:200]})
            return
        self._send_json(200, {
            "ok": True,
            "asked": res.get("asked", 0),
            "toFetch": res.get("to_fetch", 0),
            "fetched": res.get("fetched", 0),
            "covered": res.get("covered", 0),
            "sources": res.get("sources", {}),
            "dates": res.get("dates", {}),
        })
    POST["/api/catmon/asin-dates/fill"] = post_fill_dates

    def get_sprite_status(self):
        """诊断用：专用浏览器是否在跑、登录态是否有效。"""
        if not _verify(self):
            return
        try:
            st = sprite_fetch.status()
        except Exception as e:
            st = {"running": False, "logged_in": False, "error": f"{type(e).__name__}: {e}"}
        st["sources"] = asin_meta.enabled_sources()
        self._send_json(200, st)
    GET["/api/catmon/sprite/status"] = get_sprite_status

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
        payload = state.list_catmon_matrix(tid, lt, start, end)
        # 上架时间按 ASIN 从全局属性表带出（只读，不在 GET 里触发抓取，避免接口变慢）
        if payload.get("rows"):
            try:
                meta = asin_meta.get_meta(state, [r.get("asin") for r in payload["rows"]])
                for r in payload["rows"]:
                    m = meta.get(str(r.get("asin") or "").upper()) or {}
                    r["firstAvailable"] = m.get("first_available_day") or None
            except Exception as e:
                _log(f"[catmon] 矩阵合并上架时间失败：{type(e).__name__}: {e}")
        self._send_json(200, payload)
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

    # ---- 详情（按天快照：一天一条，同日覆盖；打开只看快照，重抓靠手动） ----

    def get_detail(self):
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        asin = (q.get("asin") or [""])[0].strip().upper()
        mk = (q.get("marketplace") or ["US"])[0].strip().upper() or "US"
        date = ((q.get("date") or [""])[0] or "").strip()[:10] or None
        refresh = (q.get("refresh") or ["0"])[0].lower() in ("1", "true", "yes")
        if not asin:
            self._send_json(400, {"error": "asin required"})
            return

        def _wrap(snap, cached):
            return dict(snap["data"], cached=cached,
                        snapDate=snap["snap_date"], fetchedAt=snap["fetched_at"])

        # ① 不刷新 → 只读快照（指定日期，或最新一天）
        if not refresh:
            snap = state.get_asin_detail_snapshot(asin, mk, date)
            if snap:
                self._send_json(200, _wrap(snap, True))
                return
            if date:
                # 指定日期没有快照：明确告诉前端，别偷偷抓一条塞进那天
                self._send_json(404, {"error": "no_snapshot_for_date", "date": date,
                                      "asin": asin})
                return
            # ② 一条快照都没有（首次点开）→ 抓一次，落今天的快照

        # 抓取（内部有 10 分钟内存缓存 + 并发闸门）
        try:
            data = catmon_fetcher.fetch_detail(asin, mk, refresh=True)
        except Exception as e:
            _log(f"[catmon] 详情失败 {asin}: {type(e).__name__}: {e}")
            self._send_json(502, {"error": f"{type(e).__name__}: {e}", "asin": asin})
            return
        if data.get("error") and not data.get("title"):
            self._send_json(502, data)
            return

        # 落库：写/覆盖**当天**快照（一天最多一条，超出保留条数的自动清掉）
        saved = None
        if data.get("title"):
            try:
                payload = {k: v for k, v in data.items() if k not in ("cached", "cachedAt")}
                saved = state.save_asin_detail_snapshot(asin, mk, payload)
            except Exception as e:
                _log(f"[catmon] 详情快照写入失败 {asin}: {type(e).__name__}: {e}")

        body = dict(data, cached=False)
        if saved:
            body["snapDate"] = saved["snap_date"]
            body["fetchedAt"] = saved["fetched_at"]
        _log(f"[catmon] 详情 {asin} 已采集 → 快照 {saved['snap_date'] if saved else '(未落库)'}")
        self._send_json(200, body)
    GET["/api/catmon/detail"] = get_detail

    def get_detail_dates(self):
        """某个 ASIN 有哪些日期的详情快照（给弹窗日历）。"""
        if not _verify(self):
            return
        q = parse_qs(urlparse(self.path).query)
        asin = (q.get("asin") or [""])[0].strip().upper()
        mk = (q.get("marketplace") or ["US"])[0].strip().upper() or "US"
        if not asin:
            self._send_json(400, {"error": "asin required"})
            return
        self._send_json(200, {"asin": asin, "marketplace": mk,
                              "dates": state.list_asin_detail_dates(asin, mk)})
    GET["/api/catmon/detail/dates"] = get_detail_dates


# ---------------------------------------------------------------------------
# 定时调度：每分钟扫描；到点且当天没跑过就触发
#   · daily   ：每天 schedule_time 之后跑一次
#   · weekly  ：每周 schedule_weekday 的 schedule_time 之后跑一次
#   · every_n ：距上次运行 >= every_n_days 且在 schedule_time 之后
# 进程重启后，只要当天已过时间点且没跑过，会自动补跑一次。
# ---------------------------------------------------------------------------
# 失败后自动重试：2026-11-10 凌晨 05:00~06:16 一波网络故障，14 个榜单全 error，
# 而「当天跑过就不再跑」让它们一整天没有数据、也没人察觉。现在失败会自己补。
# 失败重试节奏（用户 2026-11-10 定）：5 分钟 → 5 分钟 → 3 小时，最多 4 次（含首次）
CATMON_RETRY_GAP_SEC = 5 * 60
CATMON_LONG_RETRY_GAP_SEC = 3 * 3600
CATMON_MAX_ATTEMPTS = 4


def _is_due(t, now=None):
    """判断某个 target 此刻是否该触发。抽出来便于单测。"""
    now = now or datetime.datetime.now()
    if not t.get("enabled"):
        return False
    ft = t.get("freqType") or "daily"
    if now.strftime("%H:%M") < (t.get("scheduleTime") or "09:00"):
        return False
    if (t.get("lastRunAt") or "")[:10] == now.strftime("%Y-%m-%d"):
        # 今天跑过：成功/部分成功就到此为止；**失败**则隔 5 分钟再试（次数由调度器限制）
        if (t.get("lastStatus") or "") != "error":
            return False
        try:
            last_dt = datetime.datetime.fromisoformat(str(t["lastRunAt"]))
        except (ValueError, TypeError):
            return False
        # 次数存库里（retryCount/retryDate），重启不会把上限清零。
        # 前两次补跑只隔 5 分钟，第 4 次（即已失败 3 次后）隔 3 小时。
        n = int(t.get("retryCount") or 0) if (t.get("retryDate") or "") == now.strftime("%Y-%m-%d") else 0
        if n >= CATMON_MAX_ATTEMPTS:
            return False
        gap = CATMON_RETRY_GAP_SEC if n < 3 else CATMON_LONG_RETRY_GAP_SEC
        if (now - last_dt).total_seconds() < gap:
            return False
        return True
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
        while True:
            try:
                now = datetime.datetime.now()
                today = now.strftime("%Y-%m-%d")
                for t in state.list_catmon_targets():
                    if not _is_due(t, now):
                        continue
                    if t.get("lastStatus") == "paused":
                        continue          # 用户手动暂停的，定时任务不抢跑
                    if not _start_run(state, t):
                        continue
                    n = int(t.get("retryCount") or 0) if (t.get("retryDate") or "") == today else 0
                    _log(f"[catmon] 定时触发 {t['id']} {t.get('label') or t['nodeId']} @ {now:%H:%M}"
                         + (f"（今日第 {n + 1} 次尝试）" if n else ""))
            except Exception as e:
                _log(f"[catmon] 调度异常: {type(e).__name__}: {e}")
            time.sleep(60)
    threading.Thread(target=loop, daemon=True, name="CatmonScheduler").start()
