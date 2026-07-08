import json
import os
import subprocess
import threading
import time

from ..utils import _now_iso, PROJECT_ROOT

# 无人值守跑 `claude -p` 时收窄到 SKILL.md 自己声明允许使用的工具，
# 不用 --dangerously-skip-permissions / bypassPermissions 整体放开。
AI_ALLOWED_TOOLS = "Bash Read Write Edit mcp__playwright__* mcp__sif-mcp__*"

# 单次分析的预算上限（美元）。cosmo-diagnose 一次完整分析涉及多次 Playwright
# 抓取 + SIF 数据调用 + Alexa 反查 + 报告撰写，真实成本待首次端到端联调后
# 用返回的 total_cost_usd 校准，这里先给一个偏宽松的初始值。
AI_MAX_BUDGET_USD = "8"

AI_SKILLS = {
    "cosmo-diagnose": {
        "label": "Listing诊断（COSMO）",
        "dir": os.path.join(PROJECT_ROOT, "skills", "CosmoDiagnose"),
        "build_prompt": lambda asin, params, task_id: (
            f"使用 cosmo-diagnose skill 分析 ASIN {asin}，"
            f"Alexa 只问前 {int(params.get('alexaQuestions', 3) or 3)} 个问题。"
            f"完成后请把 Phase 3 的四个输出文件保存到当前技能目录下的 "
            f"report/{task_id}/ 子目录（而不是 report/ 根目录），文件命名规则不变。"
            f"登录态已由调用方预先检查过，如果实际执行中发现登录态缺失或过期，"
            f"不要自己尝试交互式登录（不要运行 amz_login.py），直接中止并说明原因即可。"
        ),
    },
}

# /api/ai/login 用：按 (skillId, username) 去重，防止重复点击弹出多个登录浏览器窗口
_login_lock = threading.Lock()
_login_in_progress: set = set()


def _check_login_state(skill: dict, username: str) -> str:
    """
    检查某个 skill 在某个 FBA2 用户名下的 Amazon 登录态是否有效。
    返回 'missing' / 'expired' / 'expiring_soon' / 'valid'，逻辑与
    skills/CosmoDiagnose/amz_alexa.py 里的 check_state_validity() 保持一致。
    """
    state_file = os.path.join(skill["dir"], "data", username, "amz_state.json")
    if not os.path.exists(state_file):
        return "missing"
    try:
        with open(state_file) as f:
            state = json.load(f)
        cookies = state.get("cookies", [])
        at_main = next((c for c in cookies if c["name"] == "at-main"), None)
        if not at_main:
            return "missing"
        expires = at_main.get("expires", 0)
        if expires <= 0:
            return "valid"
        remaining = expires - time.time()
        if remaining < 0:
            return "expired"
        if remaining < 7 * 86400:
            return "expiring_soon"
        return "valid"
    except Exception:
        return "missing"


class AiAnalysisWorker:
    """
    后台常驻线程，轮询 ai_analysis_tasks 表中 pending 任务，
    串行（最多1个并发）shell 出去跑 `claude -p` headless 会话执行 Skill 分析。
    不复用 ExportWorker：职责不同（本地计算 vs 调起一次可能耗时数分钟、
    真花钱的 Claude Code 会话），且并发上限也不同（这里强制串行）。
    """

    def __init__(self, state):
        self._state = state
        self._executor = None
        self._active: dict = {}   # task_id -> Future
        self._procs: dict = {}    # task_id -> Popen（仅运行中的任务才有）
        self._cancelled: set = set()   # 已被用户请求终止、等待 _run_job 收尾确认的 task_id
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="AiAnalysisWorker")

    def start(self):
        import concurrent.futures
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="AiAnalysisJob")
        self._thread.start()

    def _loop(self):
        while True:
            try:
                self._tick()
            except Exception as e:
                print(f"[ai-worker] tick error: {e}")
            threading.Event().wait(3.0)

    def _tick(self):
        with self._lock:
            done = [tid for tid, fut in self._active.items() if fut.done()]
            for tid in done:
                del self._active[tid]
        if len(self._active) >= 1:
            return
        task = self._state.get_pending_ai_task()
        if not task:
            return
        tid = task["id"]
        with self._lock:
            if tid in self._active:
                return
            self._state.update_ai_task(tid, status="running")
            fut = self._executor.submit(self._run_job, task)
            self._active[tid] = fut

    def cancel(self, task_id: str):
        """终止一个正在跑的任务（不可恢复）。找不到对应进程也无妨——
        _run_job 收尾时仍会看到 task_id 在 self._cancelled 里，按 cancelled 处理。"""
        with self._lock:
            self._cancelled.add(task_id)
            proc = self._procs.get(task_id)
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass

    def _run_job(self, task: dict):
        tid = task["id"]
        skill = AI_SKILLS.get(task["skill_id"])
        if not skill:
            self._state.update_ai_task(
                tid, status="failed", error=f"unknown skillId: {task['skill_id']}",
                completed_at=_now_iso(),
            )
            return

        asin = task["asin"]
        params = task.get("params") or {}
        username = task.get("username") or "default"
        prompt = skill["build_prompt"](asin, params, tid)
        skill_dir = skill["dir"]
        out_dir = os.path.join(skill_dir, "report", tid)

        stdout, stderr, returncode = "", "", None
        error_msg = None
        proc = None
        try:
            proc = subprocess.Popen(
                ["claude", "-p", prompt,
                 "--output-format", "json",
                 "--allowedTools", AI_ALLOWED_TOOLS,
                 "--max-budget-usd", AI_MAX_BUDGET_USD],
                cwd=skill_dir,
                env={**os.environ, "COSMO_FBA_USER": username},
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            with self._lock:
                self._procs[tid] = proc
            try:
                stdout, stderr = proc.communicate(timeout=1800)
                returncode = proc.returncode
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
                error_msg = "分析超时（超过30分钟）"
        except Exception as e:
            error_msg = str(e)
        finally:
            with self._lock:
                self._procs.pop(tid, None)
                was_cancelled = tid in self._cancelled
                self._cancelled.discard(tid)

        if was_cancelled:
            self._state.update_ai_task(
                tid, status="cancelled", error="用户手动结束", completed_at=_now_iso(),
            )
            print(f"[ai-worker] task {tid} cancelled by user")
            return

        if error_msg:
            self._state.update_ai_task(tid, status="failed", error=error_msg, completed_at=_now_iso())
            print(f"[ai-worker] task {tid} failed: {error_msg}")
            return

        files = []
        if os.path.isdir(out_dir):
            for fn in sorted(os.listdir(out_dir)):
                ext = fn.rsplit(".", 1)[-1].lower() if "." in fn else ""
                if ext in ("html", "md"):
                    files.append({"name": fn, "type": ext})

        result_obj = None
        try:
            result_obj = json.loads(stdout)
        except (json.JSONDecodeError, TypeError):
            pass

        is_error = bool(result_obj.get("is_error")) if result_obj else (returncode != 0)
        denials = (result_obj or {}).get("permission_denials") or []

        if is_error or not files:
            err = (result_obj or {}).get("result") or (stderr or "")[-2000:] or "分析未产出任何文件"
            self._state.update_ai_task(
                tid, status="failed", error=err[:2000], files=files, completed_at=_now_iso(),
            )
            print(f"[ai-worker] task {tid} failed, returncode={returncode}")
            return

        summary = ((result_obj or {}).get("result") or "")[:500]
        if denials:
            summary += f"\n⚠ 有 {len(denials)} 个工具调用被权限拦截，报告内容可能不完整。"

        cost = (result_obj or {}).get("total_cost_usd") or 0
        self._state.update_ai_task(
            tid, status="done", summary=summary, files=files, completed_at=_now_iso(),
        )
        print(f"[ai-worker] task {tid} done, {len(files)} files, cost=${cost:.4f}")
