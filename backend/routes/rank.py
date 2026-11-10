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


def run_rank_task(state, task, delay_between_kw=(3.0, 7.0)):
    """串行采集任务下所有关键词，写入快照，返回结果列表。

    task["keywords"] 只留一个词时，就是「只采这个词」（立即采集按钮用）。
    """
    results = []
    kws = task.get("keywords", [])
    for i, kw in enumerate(kws):
        kw = (kw or "").strip()
        if not kw:
            continue
        try:
            res = rank_fetcher.locate_rank(task["asin"], task["marketplace"], kw, max_pages=3)
        except Exception as e:
            res = {
                "asin": task["asin"], "keyword": kw,
                "marketplace": task["marketplace"], "status": "error",
                "organic_rank": None, "organic_page": None, "sponsored": [],
                "error": f"fetch_exc:{type(e).__name__}", "captured_at": _now_iso(),
            }
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
        return _queue_snapshot()


def ensure_worker(state):
    """启动唯一的采集 worker（重复调用安全）。"""
    with _RQ_LOCK:
        if _RQ_WORKER["started"]:
            return
        _RQ_WORKER["started"] = True
    threading.Thread(target=_worker_loop, args=(state,), daemon=True,
                     name="RankWorker").start()
    _log("[rank] 采集队列 worker 已启动（定时与手动采集串行执行）")


def submit(state, task, keyword=None, source="manual", delay=0, retry=0):
    """把一次采集排进队列；同一任务同一词已在队列里就不重复排。

    delay>0 表示延迟入队（失败自动重试用），单位秒。
    返回 {queued, duplicate, waiting, running, items}。
    """
    if keyword:
        if keyword not in (task.get("keywords") or []):
            raise ValueError(f"任务里没有这个词：{keyword}")
        task = dict(task, keywords=[keyword])
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


# 一整批全失败（网络断/被风控）时自动重试：等一会儿再来，最多几次。
# 为什么需要：实测 2026-11-10 00:00 与 06:00 两批都因 neterr 全失败，
# 若没人手动点，当天等于一条数据都没采到。
MAX_AUTO_RETRY = 2
RETRY_DELAY_SEC = 15 * 60


def _maybe_retry(state, job, results):
    retry = int(job.get("retry") or 0)
    if retry >= MAX_AUTO_RETRY or not results:
        return
    # 只要有任何一个词拿到「有效结论」（有排名 / 页面正常但未排名），就不算整体失败
    if any(r.get("status") in ("ok", "not_ranked") for r in results):
        return
    _log(f"[rank] 「{job['name']}」本次全部失败（{results[0].get('error')}），"
         f"{RETRY_DELAY_SEC // 60} 分钟后自动重试（第 {retry + 1}/{MAX_AUTO_RETRY} 次）")
    try:
        submit(state, job["task"], keyword=job.get("keyword"), source="retry",
               delay=RETRY_DELAY_SEC, retry=retry + 1)
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
