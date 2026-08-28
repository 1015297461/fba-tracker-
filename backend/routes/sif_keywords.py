#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SIF 关键词监测：路由 + 每日定时调度
=====================================
路由（全部需登录）：
  GET    /api/sif/tasks            任务列表
  POST   /api/sif/tasks            创建任务
  PUT    /api/sif/tasks            更新任务
  DELETE /api/sif/tasks?id=        删除任务（含快照）
  POST   /api/sif/run              {id} 立即运行（后台线程，不阻塞）
  GET    /api/sif/snapshots?taskId=&date=   快照（缺省 date 返回全部，按 run_date 倒序）
  GET    /api/sif/runs?taskId=     该任务的历史运行日期
  POST   /api/sif/preview          {root, country, topN} 试查词根（不落库）
  GET    /api/sif/history?keywords=&country=  按需查趋势（≤5 词）

调度器：start_scheduler(state) 每分钟检查一次，命中「启用 + 已到每日时刻 +
今天未跑过」的任务就在后台线程执行（同一任务去重，防止重复触发）。
"""

import datetime
import threading
import time
from urllib.parse import urlparse, parse_qs

from .. import sif_fetcher
from ..utils import _extract_token, _now_iso

# 正在执行的任务 id 集合（调度器与手动触发共用，避免同一任务并发跑）
_running: set = set()
_running_lock = threading.Lock()


def _is_running(tid: str) -> bool:
    with _running_lock:
        return tid in _running


def _mark_running(tid: str):
    with _running_lock:
        _running.add(tid)


def _mark_done(tid: str):
    with _running_lock:
        _running.discard(tid)


def _launch(state, task: dict):
    """后台线程执行一次任务抓取。"""
    if _is_running(task["id"]):
        return
    _mark_running(task["id"])
    tid = task["id"]

    def _run():
        try:
            result = sif_fetcher.execute_and_save(state, task)
            stats = result.get("stats", {})
            print(f"  [sif] 任务 {task['name']} 完成: 发现 {stats.get('discovered', 0)} 词, "
                  f"画像 {stats.get('enriched', 0)} 词, 调用 screen={stats.get('screen_calls', 0)} "
                  f"demand={stats.get('demand_calls', 0)} history={stats.get('history_calls', 0)}")
        except Exception as e:
            print(f"  [sif] 任务 {task['name']} 异常: {e}")
        finally:
            _mark_done(tid)

    threading.Thread(target=_run, daemon=True, name=f"SifTask-{tid[:8]}").start()


def start_scheduler(state):
    """后台守护线程：每分钟检查每日定时任务（自定义时刻，一天最多跑一次）。"""

    def loop():
        # 崩溃恢复：重启后把残留 running 状态的任务标记为失败（H3 模式）
        try:
            for t in state.list_sif_tasks():
                if t.get("lastStatus") == "running":
                    state.set_sif_task_status(t["id"], "error",
                                              error="上次运行被中断（服务重启）")
                    print(f"  [sif] 任务 {t['name']} 上次运行被中断，已标记失败")
        except Exception as e:
            print(f"  [sif] 启动恢复检查异常: {e}")

        while True:
            try:
                now_hm = time.strftime("%H:%M")
                today = time.strftime("%Y-%m-%d")
                today_wd = datetime.date.today().isoweekday()  # 1=周一 .. 7=周日
                for t in state.list_sif_tasks():
                    if not t.get("enabled"):
                        continue
                    sch = (t.get("scheduleTime") or "").strip()
                    if not sch or ":" not in sch:
                        continue
                    # 周几匹配（默认周一），非匹配日跳过
                    wd = int(t.get("scheduleWeekday") or 1)
                    if wd != today_wd:
                        continue
                    # 已跑过今天的不重复执行
                    last_run = t.get("lastRunAt") or ""
                    if last_run[:10] == today:
                        continue
                    # 到达或已过定时时刻则触发（后台线程执行，避免阻塞调度循环）
                    if now_hm >= sch:
                        print(f"  [sif] 定时触发 {t['name']} @ 周{today_wd} {now_hm} (计划 {sch})")
                        _launch(state, t)
            except Exception as e:
                print(f"  [sif] 调度循环异常: {e}")
            time.sleep(60)

    th = threading.Thread(target=loop, daemon=True, name="SifScheduler")
    th.start()
    print("[sif] 关键词监测调度线程已启动（每分钟检查：每周指定周几+时刻，一天最多跑一次）")


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def _user(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return None
        return user

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
        tid = state.create_sif_task(payload)
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
        self._send_json(200, {"task": state.get_sif_task(tid)})
    PUT["/api/sif/tasks"] = put_tasks

    def delete_task(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id") or [""])[0]
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        if _is_running(tid):
            self._send_json(400, {"error": "任务正在运行，无法删除"})
            return
        state.delete_sif_task(tid)
        self._send_json(200, {"ok": True})
    DELETE["/api/sif/tasks"] = delete_task

    # ---- 运行 / 快照 ----

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
        if not sif_fetcher.is_configured():
            self._send_json(400, {"error": "SIF MCP 未配置：请设置 SIF_MCP_KEY 环境变量或 data/sif-config.json"})
            return
        _launch(state, task)
        self._send_json(200, {"ok": True, "taskId": tid})
    POST["/api/sif/run"] = post_run

    def get_snapshots(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        run_date = (q.get("date") or [None])[0]
        if not task_id:
            self._send_json(400, {"error": "taskId required"})
            return
        snaps = state.list_sif_snapshots(task_id, run_date)
        # 只返回最近一次运行的数据（避免一次返回全部历史）
        if not run_date and snaps:
            latest = snaps[0]["runDate"]
            snaps = [s for s in snaps if s["runDate"] == latest]
        self._send_json(200, {"taskId": task_id, "runDate": snaps[0]["runDate"] if snaps else None,
                              "snapshots": snaps})
    GET["/api/sif/snapshots"] = get_snapshots

    def get_runs(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "taskId required"})
            return
        self._send_json(200, {"runs": state.list_sif_run_dates(task_id)})
    GET["/api/sif/runs"] = get_runs

    # ---- 试查 / 按需趋势 ----

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
        if not sif_fetcher.is_configured():
            self._send_json(400, {"error": "SIF MCP 未配置"})
            return
        top_n = min(int(payload.get("topN") or 8), 20)
        country = (payload.get("country") or "US").upper()
        try:
            found = sif_fetcher.screen_opportunities(root, country, top_n)
        except sif_fetcher.SifError as e:
            self._send_json(502, {"error": str(e)})
            return
        self._send_json(200, {"root": root, "keywords": found})
    POST["/api/sif/preview"] = post_preview

    def get_history(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        keywords = [(q.get("keywords") or [""])[0].split(",")]
        keywords = [k.strip() for k in keywords[0] if k and k.strip()][:5]
        if not keywords:
            self._send_json(400, {"error": "keywords required"})
            return
        if not sif_fetcher.is_configured():
            self._send_json(400, {"error": "SIF MCP 未配置"})
            return
        country = (q.get("country") or ["US"])[0].upper()
        try:
            data = sif_fetcher.keyword_history(keywords, country, "weekly")
        except sif_fetcher.SifError as e:
            self._send_json(502, {"error": str(e)})
            return
        self._send_json(200, data)
    GET["/api/sif/history"] = get_history
