import os
import re
import shutil
import subprocess
import threading
from urllib.parse import urlparse, parse_qs

from ..utils import _extract_token, _now_iso
from ..workers.ai_analysis_worker import (
    AI_SKILLS, _check_login_state, _login_lock, _login_in_progress,
)


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_tasks(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        if user.get("role") != "root":
            self._send_json(403, {"error": "无权限"})
            return
        q = parse_qs(urlparse(self.path).query)
        skill_id = (q.get("skillId") or [None])[0]
        self._send_json(200, {"tasks": state.list_ai_tasks(skill_id)})
    GET["/api/ai/tasks"] = get_tasks

    def get_task(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        if user.get("role") != "root":
            self._send_json(403, {"error": "无权限"})
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id") or [""])[0]
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        task = state.get_ai_task(tid)
        if not task:
            self._send_json(404, {"error": "task not found"})
            return
        self._send_json(200, task)
    GET["/api/ai/task"] = get_task

    def get_file(self):
        # 不做 Bearer 头校验：iframe/<img>/直接下载链接等浏览器原生导航不会带自定义头，
        # 和现有 /api/pdf/download 一致，靠不可猜测的 taskId + 文件名白名单做访问控制。
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("taskId") or [""])[0]
        name = (q.get("name") or [""])[0]
        mode = (q.get("mode") or ["download"])[0]
        task = state.get_ai_task(tid) if tid else None
        if not task:
            self._send_json(404, {"error": "task not found"})
            return
        allowed_names = {f["name"] for f in task.get("files", [])}
        if name not in allowed_names:
            self._send_json(404, {"error": "file not found"})
            return
        skill = AI_SKILLS.get(task["skill_id"])
        if not skill:
            self._send_json(404, {"error": "skill not found"})
            return
        fpath = os.path.join(skill["dir"], "report", tid, name)
        if not os.path.isfile(fpath):
            self._send_json(404, {"error": "文件不存在"})
            return
        self._send_file(fpath, download_name=name, inline=(mode == "inline"))
    GET["/api/ai/file"] = get_file

    def post_run(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        if user.get("role") != "root":
            self._send_json(403, {"error": "无权限"})
            return
        payload = self._read_json()
        if payload is None:
            return
        skill_id = (payload.get("skillId") or "").strip()
        if skill_id not in AI_SKILLS:
            self._send_json(400, {"error": f"unsupported skillId: {skill_id}"})
            return
        asin = (payload.get("asin") or "").strip().upper()
        if not re.match(r"^[A-Z0-9]{10}$", asin):
            self._send_json(400, {"error": "asin 格式不正确（应为10位字母数字）"})
            return
        login_state = _check_login_state(AI_SKILLS[skill_id], user["username"])
        if login_state in ("missing", "expired"):
            self._send_json(400, {
                "error": "需要登录 Amazon 账号才能开始分析",
                "code": "login_required",
            })
            return
        params = payload.get("params") or {}
        tid = state.create_ai_task(skill_id, asin, user["username"], params)
        print(f"  [ai] 创建分析任务 {tid}：{skill_id} / {asin} / {user['username']}")
        self._send_json(200, {"taskId": tid})
    POST["/api/ai/run"] = post_run

    def post_login(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        if user.get("role") != "root":
            self._send_json(403, {"error": "无权限"})
            return
        payload = self._read_json()
        if payload is None:
            return
        skill_id = (payload.get("skillId") or "").strip()
        if skill_id not in AI_SKILLS:
            self._send_json(400, {"error": f"unsupported skillId: {skill_id}"})
            return
        skill = AI_SKILLS[skill_id]
        dedup_key = (skill_id, user["username"])
        with _login_lock:
            if dedup_key in _login_in_progress:
                self._send_json(200, {"ok": True, "already": True})
                return
            _login_in_progress.add(dedup_key)

        def _run_login():
            try:
                subprocess.run(
                    ["python3", "amz_login.py"],
                    cwd=skill["dir"],
                    env={**os.environ, "COSMO_FBA_USER": user["username"]},
                    timeout=330,
                )
            except Exception as e:
                print(f"[ai-login] {skill_id}/{user['username']} 登录脚本异常: {e}")
            finally:
                with _login_lock:
                    _login_in_progress.discard(dedup_key)

        threading.Thread(target=_run_login, daemon=True, name="AiLogin").start()
        self._send_json(200, {"ok": True})
    POST["/api/ai/login"] = post_login

    def post_cancel(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        if user.get("role") != "root":
            self._send_json(403, {"error": "无权限"})
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = (payload.get("id") or "").strip()
        task = state.get_ai_task(tid) if tid else None
        if not task:
            self._send_json(404, {"error": "task not found"})
            return
        if task["status"] == "pending":
            state.update_ai_task(tid, status="cancelled", error="用户手动结束", completed_at=_now_iso())
        elif task["status"] == "running":
            ai_worker.cancel(tid)
        else:
            self._send_json(400, {"error": f"任务当前状态为 {task['status']}，无法终止"})
            return
        self._send_json(200, {"ok": True})
    POST["/api/ai/cancel"] = post_cancel

    def delete_task(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        if user.get("role") != "root":
            self._send_json(403, {"error": "无权限"})
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id") or [""])[0]
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        task = state.get_ai_task(tid)
        if task:
            skill = AI_SKILLS.get(task["skill_id"])
            if skill:
                out_dir = os.path.join(skill["dir"], "report", tid)
                shutil.rmtree(out_dir, ignore_errors=True)
        state.delete_ai_task(tid)
        self._send_json(200, {"ok": True})
    DELETE["/api/ai/tasks"] = delete_task
