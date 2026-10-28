import os
import re
import shutil
import subprocess
import threading
from urllib.parse import urlparse, parse_qs

from ..utils import _extract_token, _now_iso, _log
from .. import sif_fetcher, traffic_compare, traffic_report, llm_client
from ..workers.ai_analysis_worker import (
    AI_SKILLS, _check_login_state, _login_lock, _login_in_progress,
)

# 不限制角色的技能：这类技能只用 SIF 的公开数据、不碰 Amazon 登录态与本机文件，
# 没必要挂 root 门禁。其余技能（如 cosmo-diagnose 要跑 Playwright 抓前台）仍限 root。
PUBLIC_SKILLS = {"traffic-compare", "rank-monitor"}


def _can_use_skill(user: dict, skill_id: str) -> bool:
    return user.get("role") == "root" or skill_id in PUBLIC_SKILLS


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_tasks(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        skill_id = (q.get("skillId") or [None])[0]
        if skill_id:
            if not _can_use_skill(user, skill_id):
                self._send_json(403, {"error": "无权限"})
                return
        elif user.get("role") != "root":
            # 不带 skillId 的「全部任务」视图只给 root，避免普通用户看到别人的记录
            self._send_json(403, {"error": "无权限"})
            return
        self._send_json(200, {"tasks": state.list_ai_tasks(skill_id)})
    GET["/api/ai/tasks"] = get_tasks

    def get_task(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
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
        if not _can_use_skill(user, task["skill_id"]):
            self._send_json(403, {"error": "无权限"})
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
        payload = self._read_json()
        if payload is None:
            return
        skill_id = (payload.get("skillId") or "").strip()
        if not _can_use_skill(user, skill_id):
            self._send_json(403, {"error": "无权限"})
            return
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
        _log(f"[ai] 创建分析任务 {tid}：{skill_id} / {asin} / {user['username']}")
        self._send_json(200, {"taskId": tid})
    POST["/api/ai/run"] = post_run

    # ---- 流量分析：取数预览（纯 SIF，不花 AI 费用） ----

    def post_traffic_preview(self):
        """取自身 + 竞品流量数据、算好指标、落盘 data.json，返回给前端预览。

        这里**不创建 AI 任务**：用户先确认数据与竞品选择对不对，再决定是否花钱生成报告。
        返回的 datasetId 会在「生成分析」时复用，避免重复取数导致两次数字不一致。
        """
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        asin = (payload.get("asin") or "").strip().upper()
        if not re.match(r"^[A-Z0-9]{10}$", asin):
            self._send_json(400, {"error": "asin 格式不正确（应为10位字母数字）"})
            return
        if not sif_fetcher.is_configured():
            self._send_json(400, {
                "error": "SIF MCP 未配置：请先在「SIF 关键词」的设置里填写密钥",
                "code": "sif_not_configured",
            })
            return

        country = (payload.get("country") or "US").strip().upper()[:4] or "US"
        # 周期二选一：periodType + periodValue（推荐），或旧版的 days
        period_type = (payload.get("periodType") or "").strip()
        period_value = payload.get("periodValue")
        if not period_type:
            period_type = "latelyDay"
            if period_value in (None, ""):
                period_value = payload.get("days") or traffic_compare.DEFAULT_DAYS
        if isinstance(period_value, (int, float)):
            period_value = str(int(period_value))

        raw_comps = payload.get("competitorAsins") or []
        if isinstance(raw_comps, str):
            raw_comps = re.split(r"[\s,;]+", raw_comps)
        comps = [str(a).strip().upper() for a in raw_comps if str(a).strip()]
        comps = [a for a in comps if re.match(r"^[A-Z0-9]{10}$", a)]
        auto = payload.get("autoCompetitors")
        auto = True if auto is None else bool(auto)

        try:
            result = traffic_compare.preview(asin, country, period_type, period_value, comps, auto)
        except (sif_fetcher.SifError, RuntimeError) as e:
            msg = str(e)
            # SIF 有 QPM 40/60秒 限制：一次完整取数约 18 次调用，连点两次就会撞。
            # 把底层英文/技术化提示换成可操作的说明，用户才知道该等多久。
            if "QPM" in msg or "限制已达上限" in msg:
                _log(f"[ai-traffic] {asin} 撞 SIF 限流：{msg[:120]}")
                self._send_json(429, {
                    "error": "SIF 接口调用过于频繁（每分钟上限 40 次），请等约 1 分钟再试",
                    "code": "sif_rate_limited",
                })
                return
            self._send_json(502, {"error": msg})
            return
        except Exception as e:
            _log(f"[ai-traffic] preview 失败 {asin}: {type(e).__name__}: {e}")
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return

        d = result.get("data") or {}
        meta = d.get("meta") or {}
        _log(f"[ai-traffic] preview {asin}/{country}/{meta.get('period_label')} 完成："
             f"dataset={result.get('datasetId')} 竞品={len(d.get('competitors') or [])} "
             f"SIF调用={meta.get('sif_calls')}"
             + (f" 纠正={meta.get('period_notes')}" if meta.get("period_notes") else ""))
        self._send_json(200, result)

    POST["/api/ai/traffic/preview"] = post_traffic_preview

    # ---- 流量分析：Markdown 报告（调模型，一次 HTTP 调用，不再是 claude 子进程） ----

    def get_traffic_llm(self):
        """模型配置摘要（不含 key）。前端据此决定是否提示"请先配置"。"""
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, llm_client.describe())
    GET["/api/ai/traffic/llm"] = get_traffic_llm

    # 注意：这是 register() 内的普通函数（闭包），不是 Handler 的方法，
    # 所以显式把 handler 当第一个参数传进来，不能写成 self._generate_report(...)
    def _generate_report(handler, payload, user):
        dataset_id = (payload.get("datasetId") or "").strip()
        if not dataset_id:
            handler._send_json(400, {"error": "datasetId required"})
            return
        force = bool(payload.get("force"))
        try:
            result = traffic_report.generate(dataset_id, force, state,
                                             (user or {}).get("username"))
        except ValueError as e:
            handler._send_json(404, {"error": str(e)})
            return
        except llm_client.LLMError as e:
            msg = str(e)
            _log(f"[ai-traffic] 报告生成失败 {dataset_id}: {msg[:200]}")
            code = getattr(e, "code", "") or ""
            status = 400 if code == "not_configured" else (429 if code == "rate_limit" else 502)
            handler._send_json(status, {"error": msg, "code": code})
            return
        except Exception as e:
            _log(f"[ai-traffic] 报告生成异常 {dataset_id}: {type(e).__name__}: {e}")
            handler._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        m = result.get("meta") or {}
        _log(f"[ai-traffic] 报告 {'命中缓存' if result.get('cached') else '生成完成'} "
             f"{dataset_id}：{m.get('report_chars')} 字 / {m.get('elapsed')}s / {m.get('model')}")
        handler._send_json(200, result)

    def post_traffic_report(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        _generate_report(self, payload, user)
    POST["/api/ai/traffic/report"] = post_traffic_report

    def get_traffic_report(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        dataset_id = (q.get("datasetId") or [""])[0]
        if not dataset_id:
            self._send_json(400, {"error": "datasetId required"})
            return
        found = traffic_report.load_report(dataset_id)
        if not found:
            self._send_json(404, {"error": "尚未生成报告"})
            return
        self._send_json(200, found)
    GET["/api/ai/traffic/report"] = get_traffic_report

    # ---- 流量分析：报告历史 + 数据集回放 ----

    def get_traffic_history(self):
        """报告历史（前端历史列表的数据源）。不限角色，任何登录用户可查自己的和他人的，
        因为流量分析本身是公共能力（只用 SIF 数据，不碰本机与 Amazon 登录态）。"""
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        asin = (q.get("asin") or [""])[0].strip().upper() or None
        try:
            rows = state.list_traffic_reports(asin, int((q.get("limit") or ["50"])[0]))
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        self._send_json(200, {"reports": rows})
    GET["/api/ai/traffic/history"] = get_traffic_history

    def delete_traffic_history(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        rid = (q.get("id") or [""])[0].strip()
        if not rid:
            self._send_json(400, {"error": "id required"})
            return
        rec = state.get_traffic_report(rid)
        if rec:
            state.delete_traffic_report(rid)
        # 文件一起删：报告和它依赖的数据集都删干净，避免残留
        for path in (traffic_report.report_path(rid, "md"),
                     traffic_report.report_path(rid, "json"),
                     traffic_compare.dataset_path(rid)):
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except Exception:
                pass
        self._send_json(200, {"ok": True})
    DELETE["/api/ai/traffic/history"] = delete_traffic_history

    def get_traffic_dataset(self):
        """按 datasetId 回放数据集：历史项点击后恢复「取数预览 + 报告」的完整上下文。"""
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        dsid = (q.get("datasetId") or [""])[0].strip()
        if not dsid:
            self._send_json(400, {"error": "datasetId required"})
            return
        data = traffic_compare.load_dataset(dsid)
        if not data:
            self._send_json(404, {"error": "数据集不存在或已清理，请重新取数"})
            return
        self._send_json(200, {"datasetId": dsid, "data": data})
    GET["/api/ai/traffic/dataset"] = get_traffic_dataset

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
                _log(f"[ai-login] {skill_id}/{user['username']} 登录脚本异常: {e}")
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
        payload = self._read_json()
        if payload is None:
            return
        tid = (payload.get("id") or "").strip()
        task = state.get_ai_task(tid) if tid else None
        if not task:
            self._send_json(404, {"error": "task not found"})
            return
        if not _can_use_skill(user, task["skill_id"]):
            self._send_json(403, {"error": "无权限"})
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
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id") or [""])[0]
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        task = state.get_ai_task(tid)
        if task and not _can_use_skill(user, task["skill_id"]):
            self._send_json(403, {"error": "无权限"})
            return
        if task:
            skill = AI_SKILLS.get(task["skill_id"])
            if skill:
                out_dir = os.path.join(skill["dir"], "report", tid)
                shutil.rmtree(out_dir, ignore_errors=True)
        state.delete_ai_task(tid)
        self._send_json(200, {"ok": True})
    DELETE["/api/ai/tasks"] = delete_task
