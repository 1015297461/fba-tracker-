"""产品采集路由与后台执行器。

执行权在服务端，不在浏览器：POST /api/scrape/start 只负责建任务、起线程并立刻返回
taskId，前端改为轮询 /api/scrape/progress。这样刷新页面、关标签页，甚至换一台电脑
打开，任务都还在跑、进度也不会丢——早期版本由前端 for 循环逐批 await，刷新即中断。

暂停/取消采用「停在断点、可从断点重起」的模型：请求到达后给执行线程一个停止信号，
线程在检查点退出并把状态落成 paused / cancelled，已抓到的结果一条不丢；「继续」再按
同一个 task_id 起一个新线程，待跑列表由「全部 ASIN − 已成功 ASIN」算出，天然跳过
跑过的。这样暂停不需要把线程挂在那儿阻塞，服务重启后照样能继续。
"""
import threading
from urllib.parse import urlparse, parse_qs

from .. import product_fetcher
from ..utils import _extract_token, _now_iso

# 正在执行的采集任务：task_id -> _TaskCtl。
# 同一时间只允许一个采集任务，避免多个任务争抢同一站点的令牌桶。
_running = {}
_running_lock = threading.Lock()

# 外层分块大小。注意：结果**不再**按块落库（那样整块没跑完时进度会一直停在 0/500），
# 而是交给 on_progress 逐条写库；块只用来兜底收尾（把失败重试轮的结果补写一次）。
CHUNK_SIZE = 50

# 每落库这么多条才重算一次 success/failed 计数：重算是全表 COUNT，
# 逐条都算的话 500 个 ASIN 就是 500 次统计，没必要。
COUNT_REFRESH_EVERY = 5


class _TaskCtl:
    """一次执行的停止信号。reason 区分「暂停」与「取消」，决定线程退出时落哪个状态。"""

    def __init__(self):
        self.stop = threading.Event()
        self.reason = "cancelled"


def _active_task_id():
    with _running_lock:
        return next(iter(_running), None)


def _ctl(task_id):
    with _running_lock:
        return _running.get(task_id)


def _run_scrape(state, task_id, marketplace, with_reviews, ctl):
    """后台线程：按断点续跑，逐条落库，支持暂停/取消。"""
    try:
        state.set_scrape_task_status(task_id, "running", started_at=_now_iso())
        task = state.get_scrape_task(task_id) or {}
        asins = task.get("asins") or []
        # 待跑 = 全部 ASIN − 已成功的。这就是断点续跑：跳过跑过的，只补没跑的和失败的。
        done = state.get_scrape_done_asins(task_id)
        pending = [a for a in asins if a not in done]
        print(f"  [scrape] 任务 {task_id} 开始：待采集 {len(pending)} 个"
              f"（总 {len(asins)}，已成功 {len(done)}）")

        since_refresh = 0

        def on_progress(_completed, _total, product):
            """每抓完一个 ASIN 就落库，进度条才不会长时间停在 0/500。"""
            nonlocal since_refresh
            state.save_scrape_products(task_id, [product])
            since_refresh += 1
            if since_refresh >= COUNT_REFRESH_EVERY:
                since_refresh = 0
                state.refresh_scrape_task_counts(task_id)

        for start in range(0, len(pending), CHUNK_SIZE):
            chunk = pending[start:start + CHUNK_SIZE]
            try:
                results = product_fetcher.scrape_products(
                    chunk, marketplace, with_reviews,
                    on_progress=on_progress, should_stop=ctl.stop.is_set)
            except product_fetcher.ScrapeInterrupted:
                raise
            except Exception as e:
                # 单块异常不该让整个任务停摆：标记这一块失败后继续跑下一块
                print(f"  [scrape] 任务 {task_id} 第 {start // CHUNK_SIZE + 1} 块异常: {e}")
                results = [{**product_fetcher._empty_product(
                    a, marketplace, f"fetch_exc:{type(e).__name__}")} for a in chunk]
            # 兜底再写一次：失败重试轮的结果不走 on_progress，靠这里落库（UPSERT 幂等）
            state.save_scrape_products(task_id, results)
            state.refresh_scrape_task_counts(task_id)

        state.refresh_scrape_task_counts(task_id)
        t = state.get_scrape_task(task_id) or {}
        failed = t.get("failed") or 0
        state.set_scrape_task_status(
            task_id, "partial" if failed else "completed",
            error=f"{failed} 个 ASIN 采集失败，可点「重试失败项」" if failed else None,
            ended_at=_now_iso())
        print(f"  [scrape] 任务 {task_id} 结束：成功 {t.get('success')}，失败 {failed}")

    except product_fetcher.ScrapeInterrupted:
        state.refresh_scrape_task_counts(task_id)
        if ctl.reason == "paused":
            # 暂停不算结束，不写 ended_at；续跑时 started_at 也用 COALESCE 保留首次时间
            state.set_scrape_task_status(task_id, "paused", error="已暂停，可点「继续」")
            print(f"  [scrape] 任务 {task_id} 已暂停（已采集的部分保留，点「继续」接着跑）")
        else:
            state.set_scrape_task_status(task_id, "cancelled", error="已取消",
                                         ended_at=_now_iso())
            print(f"  [scrape] 任务 {task_id} 已取消（已采集的部分保留，可点「继续」续跑）")
    except Exception as e:
        print(f"  [scrape] 任务 {task_id} 异常: {e}")
        try:
            state.set_scrape_task_status(task_id, "error", error=str(e)[:500],
                                         ended_at=_now_iso())
        except Exception:
            pass
    finally:
        with _running_lock:
            _running.pop(task_id, None)


def start_scrape_task(state, asins, marketplace, with_reviews, task_id=None):
    """建/复用任务并起后台线程，立即返回 task_id。

    传 task_id 时把新 ASIN 合并进已有任务（「重试失败项」「继续」走这条路）。
    待跑列表由「任务里的全部 ASIN − 已成功的 ASIN」算出，所以重跑会天然跳过
    已成功项、只补失败项与未跑项。
    """
    asins = [a.strip().upper() for a in asins if a and a.strip()]
    ctl = _TaskCtl()
    with _running_lock:
        if _running:
            raise RuntimeError(f"已有采集任务正在运行（{next(iter(_running))}），请先暂停或取消")
        if task_id:
            t = state.get_scrape_task(task_id)
            if not t:
                raise ValueError(f"任务不存在: {task_id}")
            merged = list(dict.fromkeys((t.get("asins") or []) + asins))
            state.update_scrape_task_asins(task_id, merged)
        else:
            task_id = state.create_scrape_task(marketplace, asins, with_reviews)
        _running[task_id] = ctl
        # 同步落状态再返回：否则 start 一返回、后台线程还没调度起来时，任务状态仍是
        # 上一轮的终态（partial/completed），前端轮询会误判成「已结束」。
        state.set_scrape_task_status(task_id, "running", error=None)

    threading.Thread(target=_run_scrape,
                     args=(state, task_id, marketplace, with_reviews, ctl),
                     daemon=True, name=f"ScrapeTask-{task_id[:8]}").start()
    return task_id


def recover_stale_tasks(state):
    """服务启动时把残留的 running 任务标为 paused，让它可以从断点继续。"""
    n = state.mark_running_scrape_tasks_paused()
    if n:
        print(f"  [scrape] {n} 个采集任务因服务重启被标记为已暂停，可在界面点「继续」")


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def _authed(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return False
        return True

    def get_tasks(self):
        if not _authed(self):
            return
        self._send_json(200, {"tasks": state.list_scrape_tasks(),
                              "activeTaskId": _active_task_id()})
    GET["/api/scrape/tasks"] = get_tasks

    def get_products(self):
        if not _authed(self):
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "taskId required"})
            return
        self._send_json(200, {
            "taskId": task_id,
            "products": state.get_scrape_products(task_id),
        })
    GET["/api/scrape/products"] = get_products

    def get_progress(self):
        if not _authed(self):
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "taskId required"})
            return
        task = state.get_scrape_task(task_id)
        if not task:
            self._send_json(404, {"error": "任务不存在"})
            return
        ctl = _ctl(task_id)
        self._send_json(200, {
            "task": task,
            "live": ctl is not None,
            # 停止信号已发出但线程还没退出：前端可显示「正在暂停…」
            "stopping": bool(ctl and ctl.stop.is_set()),
        })
    GET["/api/scrape/progress"] = get_progress

    def post_start(self):
        """提交采集：立即返回 taskId，真正的抓取在后台线程里跑。"""
        if not _authed(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        asins = payload.get("asins")
        if not isinstance(asins, list) or not asins:
            self._send_json(400, {"error": "asins must be a non-empty array"})
            return
        marketplace = (payload.get("marketplace") or "US").upper()
        if marketplace not in product_fetcher.MARKETPLACES:
            self._send_json(400, {"error": f"unsupported marketplace: {marketplace}"})
            return
        with_reviews = bool(payload.get("withReviews", False))
        task_id_in = payload.get("taskId")
        if not isinstance(task_id_in, str) or not task_id_in:
            task_id_in = None
        try:
            task_id = start_scrape_task(state, asins, marketplace, with_reviews,
                                        task_id=task_id_in)
        except RuntimeError as e:
            self._send_json(409, {"error": str(e)})
            return
        except ValueError as e:
            self._send_json(404, {"error": str(e)})
            return
        print(f"  [scrape] 已提交 {len(asins)} 个 ASIN @ {marketplace}"
              f"{' (含评论)' if with_reviews else ''} -> {task_id}")
        self._send_json(200, {"taskId": task_id})
    POST["/api/scrape/start"] = post_start

    def post_pause(self):
        """暂停：给线程一个停止信号，它在检查点退出并落成 paused，已抓到的结果不丢。"""
        if not _authed(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        task_id = payload.get("taskId")
        ctl = _ctl(task_id) if task_id else None
        if ctl:
            ctl.reason = "paused"
            ctl.stop.set()
            print(f"  [scrape] 收到暂停请求: {task_id}")
        self._send_json(200, {"ok": True, "pausing": bool(ctl)})
    POST["/api/scrape/pause"] = post_pause

    def post_resume(self):
        """继续：按同一个 task_id 起重线程，已成功的 ASIN 会被自动跳过。"""
        if not _authed(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        task_id = payload.get("taskId")
        task = state.get_scrape_task(task_id) if task_id else None
        if not task:
            self._send_json(404, {"error": "任务不存在"})
            return
        try:
            start_scrape_task(state, [], task["marketplace"], task["withReviews"],
                              task_id=task_id)
        except RuntimeError as e:
            self._send_json(409, {"error": str(e)})
            return
        print(f"  [scrape] 继续任务 {task_id}")
        self._send_json(200, {"ok": True, "taskId": task_id})
    POST["/api/scrape/resume"] = post_resume

    def post_cancel(self):
        if not _authed(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        task_id = payload.get("taskId")
        ctl = _ctl(task_id) if task_id else None
        if ctl:
            ctl.reason = "cancelled"
            ctl.stop.set()
            print(f"  [scrape] 收到取消请求: {task_id}")
            self._send_json(200, {"ok": True, "cancelled": True})
            return
        # 线程已经不在了（例如任务处于「已暂停」）→ 直接落终态，不必再起线程
        task = state.get_scrape_task(task_id) if task_id else None
        if task and task["status"] in ("paused", "running"):
            state.set_scrape_task_status(task_id, "cancelled", error="已取消",
                                         ended_at=_now_iso())
            print(f"  [scrape] 已取消暂停中的任务: {task_id}")
            self._send_json(200, {"ok": True, "cancelled": True})
            return
        self._send_json(200, {"ok": True, "cancelled": False})
    POST["/api/scrape/cancel"] = post_cancel

    def delete_task(self):
        if not _authed(self):
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("id") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "id required"})
            return
        if _active_task_id() == task_id:
            self._send_json(409, {"error": "任务正在运行，请先暂停或取消再删除"})
            return
        state.delete_scrape_task(task_id)
        self._send_json(200, {"ok": True})
    DELETE["/api/scrape/tasks"] = delete_task

    def put_task_name(self):
        if not _authed(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        task_id = payload.get("id")
        name = payload.get("name")
        if not task_id:
            self._send_json(400, {"error": "id required"})
            return
        state.update_scrape_task_name(task_id, name or "")
        self._send_json(200, {"ok": True})
    PUT["/api/scrape/tasks"] = put_task_name

    def post_reset_session(self):
        if not _authed(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        marketplace = (payload.get("marketplace") or "").upper()
        product_fetcher.reset_session(marketplace if marketplace else None)
        self._send_json(200, {"ok": True})
    POST["/api/scrape/reset-session"] = post_reset_session
