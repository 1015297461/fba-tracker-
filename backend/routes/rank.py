import datetime
import queue
import random
import re
import threading
import time
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

from .. import rank_fetcher
from ..utils import _extract_token, _now_iso, _log

# 可选时区：定时档位按哪个时区的时间解释（用户可切中国/美东/美西）
TIMEZONES = {
    "Asia/Shanghai": {"label": "中国时间（北京）", "short": "中国"},
    "America/New_York": {"label": "美国东部时间（纽约）", "short": "美东"},
    "America/Los_Angeles": {"label": "美国西部时间（洛杉矶）", "short": "美西"},
}
DEFAULT_TZ = "Asia/Shanghai"

# 定时档位命中后的容忍窗口（秒）。服务重启/进程卡顿时，只要还在窗口内就补跑一次，
# 不会因为「刚好错过那一分钟」整天不采。
SLOT_GRACE_SEC = 600


def task_tz(task):
    """任务时区对象；配错/未知一律退回中国时间，不让调度线程挂掉。"""
    name = (task.get("timezone") or DEFAULT_TZ).strip()
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def _due_slot(task, now_utc=None):
    """返回此刻命中的档位（任务本地时间当天），没命中返回 None。

    档位统一是 "HH:MM"（db._norm_schedule 已归一化），old 数据也转好了。
    """
    slots = task.get("schedule") or []
    if not slots:
        return None
    tz = task_tz(task)
    now = now_utc.astimezone(tz) if now_utc else datetime.datetime.now(tz)
    for slot in slots:
        m = re.match(r"^(\d{2}):(\d{2})$", str(slot))
        if not m:
            continue
        target = now.replace(hour=int(m.group(1)), minute=int(m.group(2)),
                             second=0, microsecond=0)
        delta = (now - target).total_seconds()
        if 0 <= delta < SLOT_GRACE_SEC:
            return target
    return None


# 每个任务最多允许几个词走「真实浏览器」兜底。
#
# 一次 CDP 约 31 秒/页（实测连测两次都是 31~35s，主要是冷启动 Chrome + 1.5MB 页面加载），
# 而一个词平均要翻 1.96 页（11-09 正常批次实测：26 词 51 页）。
# 所以：5 个词的小任务全走 ≈ 5 分钟（可接受，直接全给）；
#       26 个词的大批全走 ≈ 26 分钟（太久，限 3 个，剩下的交给冷却后重试）。
CDP_BUDGET_PER_TASK = 3
CDP_FULL_GRANT_MAX_KW = 5


def _cdp_budget(n_kw):
    return n_kw if n_kw <= CDP_FULL_GRANT_MAX_KW else CDP_BUDGET_PER_TASK


def run_rank_task(state, task, delay_between_kw=(3.0, 7.0)):
    """串行采集任务下所有关键词，写入快照，返回结果列表。

    task["keywords"] 只留一个词时，就是「只采这个词」（立即采集按钮用）。
    """
    results = []
    kws = task.get("keywords", [])
    cdp_budget = _cdp_budget(len(kws))
    for i, kw in enumerate(kws):
        kw = (kw or "").strip()
        if not kw:
            continue
        allow_cdp = cdp_budget > 0
        try:
            res = rank_fetcher.locate_rank(task["asin"], task["marketplace"], kw,
                                           max_pages=3, allow_cdp=allow_cdp)
        except Exception as e:
            res = {
                "asin": task["asin"], "keyword": kw,
                "marketplace": task["marketplace"], "status": "error",
                "organic_rank": None, "organic_page": None, "sponsored": [],
                "error": f"fetch_exc:{type(e).__name__}", "captured_at": _now_iso(),
            }
        if res.get("via") == "cdp":
            cdp_budget -= 1
            _log(f"[rank] 「{kw}」HTTP 被拦，已用真实浏览器兜底成功（本批剩 {cdp_budget} 次额度）")
        state.add_snapshot(task["id"], res)
        results.append(res)
        if i < len(kws) - 1:
            time.sleep(random.uniform(*delay_between_kw))
    state.mark_task_run(task["id"])
    return results


# ---------------------------------------------------------------------------
# 采集队列：定时与手动采集都走这里，**全局串行**
#
# 为什么需要：9 个任务都定在 12:00 时，原来的调度线程同步跑一个接一个，
# 一个任务 5 个词约 40 秒 → 调度线程被占 6 分钟，期间不再检查新档位；
# 而「手动立即采集」在 HTTP 线程里执行，会和定时任务**同时抓 Amazon**，
# 既容易撞反爬、又互相拖慢。现在统一入队，由唯一的 worker 顺序消费。
# ---------------------------------------------------------------------------
_RQ = queue.Queue()
_RQ_LOCK = threading.Lock()
_RQ_PENDING = {}                 # job_key -> job（含正在执行的那个）
_RQ_RUNNING = {"job": None}
_RQ_WORKER = {"started": False}


def _job_brief(j):
    if not j:
        return None
    return {"taskId": j["taskId"], "name": j["name"], "keyword": j["keyword"],
            "words": j["words"], "source": j["source"], "submittedAt": j["submittedAt"]}


def _queue_snapshot():
    """调用方必须持有 _RQ_LOCK。"""
    running = _RQ_RUNNING["job"]
    waiting = [j for j in _RQ_PENDING.values() if j is not running]
    return {
        "running": _job_brief(running),
        "waiting": len(waiting),
        "items": [_job_brief(j) for j in waiting][:20],
    }


def queue_status():
    with _RQ_LOCK:
        snap = _queue_snapshot()
    # 风控冷却剩余秒数（>0 表示自动采集已暂停，前端据此提示）
    snap["cooldown"] = block_cooldown_left() if in_block_cooldown() else 0
    return snap


def ensure_worker(state):
    """启动唯一的采集 worker（重复调用安全）。"""
    with _RQ_LOCK:
        if _RQ_WORKER["started"]:
            return
        _RQ_WORKER["started"] = True
    threading.Thread(target=_worker_loop, args=(state,), daemon=True,
                     name="RankWorker").start()
    _log("[rank] 采集队列 worker 已启动（定时与手动采集串行执行）")


# ---------------------------------------------------------------------------
# 风控熔断
#
# 2026-11-10 实测：所有指纹（连普通 Chrome UA 都试了）拿到的都是 Amazon 的
# bm-verify 挑战页 —— 这是**出口 IP 被风控**，换指纹没用。
# 这时候继续按「15 分钟重试 + 每次 3 轮」硬撞，只会让风控更久不放。
# 所以连续 N 个任务全被拦就进入冷却期，期间定时与自动重试一律跳过
# （手动点击仍允许 —— 用户可能刚换了网络，不该拦着）。
# ---------------------------------------------------------------------------
BLOCK_STREAK_LIMIT = 3          # 连续几个任务全被拦就熔断
BLOCK_COOLDOWN_SEC = 30 * 60    # 冷却 30 分钟

_BLOCK_GUARD = {"streak": 0, "until": 0.0}


def in_block_cooldown():
    return time.time() < _BLOCK_GUARD["until"]


def block_cooldown_left():
    return max(0, int(_BLOCK_GUARD["until"] - time.time()))


def _note_result(results):
    """记录本批结果，维护「连续被拦」计数与冷却期。"""
    if not results:
        return
    if any(r.get("status") in ("ok", "not_ranked") for r in results):
        _BLOCK_GUARD["streak"] = 0
        _BLOCK_GUARD["until"] = 0.0
        return
    all_blocked = all(str(r.get("error") or "").startswith("blocked") for r in results)
    if not all_blocked:
        return
    _BLOCK_GUARD["streak"] += 1
    if _BLOCK_GUARD["streak"] >= BLOCK_STREAK_LIMIT and not in_block_cooldown():
        _BLOCK_GUARD["until"] = time.time() + BLOCK_COOLDOWN_SEC
        _log(f"[rank] ⚠️ 连续 {_BLOCK_GUARD['streak']} 个任务被 Amazon 风控拦截，"
             f"暂停自动采集 {BLOCK_COOLDOWN_SEC // 60} 分钟（换网络或等解封；"
             f"手动点击不受限制）")


def submit(state, task, keyword=None, source="manual", delay=0, retry=0):
    """把一次采集排进队列；同一任务同一词已在队列里就不重复排。

    delay>0 表示延迟入队（失败自动重试用），单位秒。
    返回 {queued, duplicate, waiting, running, items, cooldown}。
    """
    if keyword:
        if keyword not in (task.get("keywords") or []):
            raise ValueError(f"任务里没有这个词：{keyword}")
        task = dict(task, keywords=[keyword])
    # 风控冷却期内：定时与自动重试直接跳过（手动保留，用户可能换了网络）
    if source in ("schedule", "retry") and in_block_cooldown():
        left = block_cooldown_left()
        _log(f"[rank] 风控冷却中（剩 {left // 60} 分钟），跳过「{task.get('name') or task.get('asin')}」")
        return {"queued": False, "cooldown": True, "cooldownLeft": left,
                **_queue_snapshot()}
    key = f"{task['id']}:{(keyword or '*').lower()}"
    with _RQ_LOCK:
        if key in _RQ_PENDING:
            return {"queued": False, "duplicate": True, **_queue_snapshot()}
        job = {
            "key": key, "task": task, "taskId": task["id"],
            "name": task.get("name") or task.get("asin"),
            "keyword": keyword, "words": len(task.get("keywords") or []),
            "source": source, "submittedAt": _now_iso(), "retry": retry,
        }
        _RQ_PENDING[key] = job
    if delay > 0:
        # 延迟入队：失败后等风控/网络恢复再试，不能立刻重撞
        t = threading.Timer(delay, lambda: _RQ.put(job))
        t.daemon = True
        t.start()
    else:
        _RQ.put(job)
    ensure_worker(state)
    with _RQ_LOCK:
        snap = _queue_snapshot()
    return {"queued": True, "duplicate": False, **snap}


# 一整批全失败时自动重试。等待时间**按错误类型区分**，不能一刀切：
#   · 网络抖动（neterr:URLError / SSLEOFError / TimeoutError）：几十秒就该重试，
#     定 15 分钟等于把「一秒的网络闪断」拖成一刻钟，用户体感很差；
#   · 风控（blocked）：挑战通常要几分钟才解除，太快只会加重；
#   · 其它（no_results 等）：取中间值。
# 每类按重试次数递增，最多 MAX_AUTO_RETRY 次。
MAX_AUTO_RETRY = 2
_RETRY_PLAN = {
    "neterr": (30, 120),      # 30 秒 → 2 分钟
    "blocked": (300, 900),    # 5 分钟 → 15 分钟
    "other": (90, 300),       # 90 秒 → 5 分钟
}


def _retry_delay(results, retry):
    """按本批的错误类型和已重试次数，算出这次该等多久（秒）。"""
    err = str((results[0] if results else {}).get("error") or "")
    if err.startswith("neterr"):
        plan = _RETRY_PLAN["neterr"]
    elif err.startswith("blocked"):
        plan = _RETRY_PLAN["blocked"]
    else:
        plan = _RETRY_PLAN["other"]
    return plan[min(max(retry, 0), len(plan) - 1)]


def _fmt_wait(sec):
    return f"{sec} 秒" if sec < 120 else f"{sec // 60} 分钟"


def _maybe_retry(state, job, results):
    retry = int(job.get("retry") or 0)
    if retry >= MAX_AUTO_RETRY or not results:
        return
    # 只要有任何一个词拿到「有效结论」（有排名 / 页面正常但未排名），就不算整体失败
    if any(r.get("status") in ("ok", "not_ranked") for r in results):
        return
    if in_block_cooldown():
        _log(f"[rank] 「{job['name']}」失败但不重试：风控冷却中（剩 {block_cooldown_left() // 60} 分钟）")
        return
    wait = _retry_delay(results, retry)
    _log(f"[rank] 「{job['name']}」本次全部失败（{results[0].get('error')}），"
         f"{_fmt_wait(wait)}后自动重试（第 {retry + 1}/{MAX_AUTO_RETRY} 次）")
    try:
        submit(state, job["task"], keyword=job.get("keyword"), source="retry",
               delay=wait, retry=retry + 1)
    except Exception as e:
        _log(f"[rank] 安排重试失败：{type(e).__name__}: {e}")


def _worker_loop(state):
    while True:
        job = _RQ.get()
        with _RQ_LOCK:
            _RQ_RUNNING["job"] = job
        t0 = time.time()
        results = []
        _log(f"[rank] 开始采集「{job['name']}」（{job['words']} 词 · {job['source']}）")
        try:
            results = run_rank_task(state, job["task"])
        except Exception as e:
            _log(f"[rank] 采集异常「{job['name']}」: {type(e).__name__}: {e}")
        finally:
            with _RQ_LOCK:
                _RQ_RUNNING["job"] = None
                _RQ_PENDING.pop(job["key"], None)
                left = len(_RQ_PENDING)
            ok_n = sum(1 for r in results if r.get("status") in ("ok", "not_ranked"))
            _log(f"[rank] 完成「{job['name']}」（{time.time() - t0:.0f}s，"
                 f"有效 {ok_n}/{len(results)}，队列剩 {left}）")
            _note_result(results)        # 维护风控熔断计数（要在 _maybe_retry 之前）
            _maybe_retry(state, job, results)
            _RQ.task_done()


def start_scheduler(state):
    """后台守护线程：每分钟检查定时档位，命中就**入队**（不在这里直接跑）。
    为什么改入队：9 个任务都定在 12:00 时，原来调度线程按顺序同步跑，
    一个任务 5 个词要 40 秒，9 个任务就把调度线程卡 6 分钟（期间新一轮检查被推迟）；
    更麻烦的是「手动立即采集」跑在 HTTP 线程里，会和定时任务**同时抓 Amazon**，
    撞反爬、还互相拖慢。现在所有采集都进同一个队列，由唯一的 worker 串行执行。
    """
    def loop():
        done = set()  # (task_id, 'YYYY-MM-DD-HH:MM')，同一档位只排一次
        while True:
            try:
                today = datetime.datetime.now().strftime("%Y-%m-%d")
                for task in state.list_rank_tasks():
                    if not task["enabled"] or not task["keywords"]:
                        continue
                    # 命中的档位按**任务自己的时区**算：中国任务 06:00 = 北京 06:00，
                    # 美东任务 06:00 = 纽约 06:00（= 北京 18:00/19:00，随夏令时变）。
                    target = _due_slot(task)
                    if not target:
                        continue
                    key = (task["id"], target.strftime("%Y-%m-%d-%H:%M"))
                    if key in done:
                        continue
                    done.add(key)
                    tz_short = TIMEZONES.get(task.get("timezone") or DEFAULT_TZ, {}).get("short", "")
                    st = submit(state, task, source="schedule")
                    _log(f"[rank] 定时入队 {task['name'] or task['asin']}/{task['marketplace']} "
                         f"({len(task['keywords'])} 词) @ {tz_short} {target.strftime('%m-%d %H:%M')}"
                         + (f"（队列中还有 {st['waiting']} 个）" if st.get("queued") else "（已在队列，跳过）"))
                if len(done) > 800:
                    done = {k for k in done if k[1][:10] >= today}
            except Exception as e:
                _log(f"[rank] 调度异常: {e}")
            time.sleep(60)

    ensure_worker(state)      # 队列消费者：定时任务入队后要有人跑
    th = threading.Thread(target=loop, daemon=True)
    th.start()
    _log("[rank] 排名调度线程已启动（每分钟按任务时区检查自定义档位）")


_SLOT_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
MAX_SLOTS = 8


def _norm_slots(raw):
    """批量接口的档位校验：只收 HH:MM，去重排序，1~8 个。"""
    if not isinstance(raw, list):
        raise ValueError("slots 必须是数组")
    out = []
    for x in raw:
        s = str(x or "").strip()
        if not _SLOT_RE.match(s):
            raise ValueError(f"非法时间 {s!r}（应为 HH:MM）")
        out.append(s)
    out = sorted(set(out))
    if not out:
        raise ValueError("至少保留一个时间点")
    if len(out) > MAX_SLOTS:
        raise ValueError(f"最多 {MAX_SLOTS} 个时间点")
    return out


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_tasks(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, {
            "tasks": state.list_rank_tasks(),
            # 可选的定时时区（前端下拉直接用，避免两边各写一份对不上）
            "timezones": [{"id": k, **v} for k, v in TIMEZONES.items()],
        })
    GET["/api/rank/tasks"] = get_tasks

    def get_history(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        keyword = (q.get("keyword") or [None])[0]
        if not task_id:
            self._send_json(400, {"error": "taskId required"})
            return
        self._send_json(200, {
            "taskId": task_id,
            "snapshots": state.get_rank_history(task_id, keyword),
        })
    GET["/api/rank/history"] = get_history

    def post_tasks(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        if not (payload.get("asin") or "").strip():
            self._send_json(400, {"error": "asin required"})
            return
        self._send_json(200, {"task": state.upsert_rank_task(payload)})
    POST["/api/rank/tasks"] = post_tasks

    def post_batch(self):
        """任务批量操作：schedule(替换/追加档位) / enabled(启停) / run(立即采集)。

        单任务下勾词也走这里 —— 档位属于任务，勾任意词等于该任务全部词。
        """
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        ids = payload.get("taskIds")
        action = str(payload.get("action") or "").strip()
        if not isinstance(ids, list) or not ids:
            self._send_json(400, {"error": "taskIds required"})
            return
        if len(ids) > 50:
            self._send_json(400, {"error": "一次最多 50 个任务"})
            return
        tasks = [state.get_rank_task(tid) for tid in ids]
        tasks = [t for t in tasks if t]
        if not tasks:
            self._send_json(404, {"error": "任务不存在"})
            return

        if action == "schedule":
            try:
                slots = _norm_slots(payload.get("slots"))
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
                return
            mode = str(payload.get("mode") or "replace")
            if mode not in ("replace", "add"):
                self._send_json(400, {"error": "mode 只能是 replace 或 add"})
                return
            for t in tasks:
                merged = slots if mode == "replace" else sorted(set((t.get("schedule") or []) + slots))
                state.update_rank_task_fields(t["id"], {"schedule": merged})
            _log(f"[rank] 批量设置采集时间：{len(tasks)} 个任务 · {mode} · {slots}")
            self._send_json(200, {"updated": len(tasks), "slots": slots, "mode": mode})
            return

        if action == "enabled":
            val = bool(payload.get("enabled"))
            for t in tasks:
                state.update_rank_task_fields(t["id"], {"enabled": val})
            _log(f"[rank] 批量{'启用' if val else '停用'}：{len(tasks)} 个任务")
            self._send_json(200, {"updated": len(tasks), "enabled": val})
            return

        if action == "run":
            results = []
            for t in tasks:
                try:
                    res = submit(state, t, source="manual")
                except ValueError as e:
                    res = {"queued": False, "duplicate": True, "error": str(e)}
                results.append({"taskId": t["id"], "name": t.get("name") or t.get("asin"),
                                **{k: res.get(k) for k in ("queued", "duplicate")}})
            n = sum(1 for r in results if r.get("queued"))
            _log(f"[rank] 批量立即采集：{len(tasks)} 个任务，入队 {n} 个")
            self._send_json(200, {"queued": n, "results": results, **queue_status()})
            return

        self._send_json(400, {"error": "unknown action"})
    POST["/api/rank/tasks/batch"] = post_batch

    def post_run(self):
        """立即采集：入队（不在这里同步抓），返回排队情况。

        前端拿到 `queued` 后轮询 /api/rank/queue 与任务历史即可；
        这样点 3 个任务的采集也不会同时抓 Amazon（全局只有一个 worker）。
        传 keyword 就只采那一个词（表格每行的「采集」按钮）。
        """
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        task_id = payload.get("taskId")
        keyword = (payload.get("keyword") or "").strip()
        task = state.get_rank_task(task_id) if task_id else payload
        if not task or not (task.get("asin") or "").strip():
            self._send_json(400, {"error": "task not found / asin required"})
            return
        if not task.get("id"):
            task = state.upsert_rank_task(task)
        try:
            res = submit(state, task, keyword=keyword or None, source="manual")
        except ValueError as e:
            self._send_json(404, {"error": str(e)})
            return
        _log(f"[rank] 手动入队 {task['asin']}/{task['marketplace']}"
             + (f" · 单词 {keyword}" if keyword else f"（{len(task.get('keywords') or [])} 词）")
             + ("" if res.get("queued") else "（已在队列，跳过）"))
        self._send_json(200, {"taskId": task["id"], **res})
    # ⚠️ 路径不能用 /api/rank/run：那个已被 rank_monitor_routes（排名监测）
    # 注册过，且它在本模块之后注册 → 会静默覆盖这里的 handler，
    # 表现就是点「采集」报「id 或 value 至少填一个」。
    POST["/api/rank/task-run"] = post_run

    def get_queue(self):
        """当前采集队列：正在跑什么、还排了几个。"""
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, queue_status())
    GET["/api/rank/queue"] = get_queue

    def delete_task(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("id") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "id required"})
            return
        state.delete_rank_task(task_id)
        self._send_json(200, {"ok": True})
    DELETE["/api/rank/tasks"] = delete_task

    def delete_keyword(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        keyword = (q.get("keyword") or [""])[0]
        if not task_id or not keyword:
            self._send_json(400, {"error": "taskId and keyword required"})
            return
        task = state.get_rank_task(task_id)
        if task:
            new_kws = [k for k in task["keywords"] if k != keyword]
            new_notes = {k: v for k, v in task["keywordNotes"].items() if k != keyword}
            state.upsert_rank_task({**task, "keywords": new_kws, "keywordNotes": new_notes})
            with state.lock:
                with state._conn() as conn:
                    conn.execute(
                        "DELETE FROM rank_snapshots WHERE task_id=? AND keyword=?",
                        [task_id, keyword]
                    )
                    conn.commit()
        self._send_json(200, {"ok": True})
    DELETE["/api/rank/keyword"] = delete_keyword
