"""产品采集路由与后台执行器。

执行权在服务端，不在浏览器：POST /api/scrape/start 只负责建任务、起线程并立刻返回
taskId，前端改为轮询 /api/scrape/progress。这样刷新页面、关标签页，甚至换一台电脑
打开，任务都还在跑、进度也不会丢——早期版本由前端 for 循环逐批 await，刷新即中断。

暂停/取消采用「停在断点、可从断点重起」的模型：请求到达后给执行线程一个停止信号，
线程在检查点退出并把状态落成 paused / cancelled，已抓到的结果一条不丢；「继续」再按
同一个 task_id 起一个新线程，待跑列表由「全部 ASIN − 已成功 ASIN」算出，天然跳过
跑过的。这样暂停不需要把线程挂在那儿阻塞，服务重启后照样能继续。
"""
import random
import threading
import time
from urllib.parse import urlparse, parse_qs

from .. import product_fetcher, review_media
from ..utils import _extract_token, _now_iso, _log

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

# 每完成这么多条 ASIN 打一行进度日志：既能实时看到推进，又不会刷屏。
PROGRESS_LOG_EVERY = 25


# ---------------------------------------------------------------------------
# 评论媒体（Customer photos and videos）—— 按需抓取 + 批量预热
#
# 这批数据只能经「本机浏览器的 CDP」拿到（端点要求有效会话，详见 review_media 模块）。
# 因此权限与限速比采集更严：
#   - 详情页 tab：优先读缓存；无缓存时**仅 root** 可触发抓取，其他人看到明确提示
#   - 批量预热：**仅 root**，且带随机间隔 / 单批上限 / 当日上限 / 异常即停
#     （抓 1 个产品只有 1 次 AJAX 请求，远小于正常打开一个详情页的 100+ 请求）
# ---------------------------------------------------------------------------

_media_batch = {
    "running": False, "stopped": False,
    "total": 0, "done": 0, "ok": 0, "fail": 0,
    "current": "", "log": [],
    "startedAt": None, "finishedAt": None,
}
# 用 RLock：_media_log() 内部也要拿这把锁，而调用点往往已持有它
_media_batch_lock = threading.RLock()

MEDIA_DELAY_RANGE = (20, 60)   # 每个 ASIN 之间的随机间隔（秒）——随机更像真人
MEDIA_BATCH_MAX = 25           # 单批上限
MEDIA_DAILY_MAX = 50           # 当日上限（内存计数，进程重启即重置）
MEDIA_LOG_KEEP = 200           # 批量日志最多保留条数

_media_daily = {"date": "", "count": 0}

_MEDIA_HINTS = {
    "cdp_unavailable": "评论媒体服务未就绪：请确认本机浏览器已打开、并已允许远程调试",
    "page_not_ready": "详情页加载超时，请稍后重试",
    "open_tab_failed": "无法打开后台标签页，请确认浏览器远程调试可用",
    "bad_asin": "ASIN 格式不正确",
    "daily_limit": f"今日抓取已达上限（{MEDIA_DAILY_MAX} 个）",
}


def _media_hint(code):
    return _MEDIA_HINTS.get(code or "", "抓取失败，请稍后重试")


def _media_daily_guard():
    """当日配额检查。返回 (是否允许, 今日已用)。"""
    today = _now_iso()[:10]
    if _media_daily["date"] != today:
        _media_daily["date"] = today
        _media_daily["count"] = 0
    return _media_daily["count"] < MEDIA_DAILY_MAX, _media_daily["count"]


def _media_log(msg):
    with _media_batch_lock:
        _media_batch["log"].append(f"{_now_iso()[11:19]}  {msg}")
        if len(_media_batch["log"]) > MEDIA_LOG_KEEP:
            _media_batch["log"] = _media_batch["log"][-MEDIA_LOG_KEEP:]


def _run_media_batch(state, targets, marketplace):
    """批量抓取线程：串行 + 随机间隔 + 异常即停。

    注意：日志与计数都在**锁外**更新（_media_log 内部自己加锁），
    且「成功」分支**不能**提前 continue —— 否则会跳过限速等待，
    批量就变成连续快抓，违背风控设计。
    """
    total = len(targets)
    try:
        for i, p in enumerate(targets):
            asin = p.get("asin") or ""
            with _media_batch_lock:
                if _media_batch["stopped"]:
                    _media_log("已停止")
                    break
                _media_batch["current"] = asin

            _media_log(f"[{i + 1}/{total}] {asin} 抓取中…")
            try:
                res = review_media.fetch_review_media(asin, marketplace)
            except Exception as e:
                res = {"ok": False, "error": f"exc:{type(e).__name__}"}

            ok = bool(res.get("ok"))
            err = res.get("error")
            with _media_batch_lock:
                _media_batch["done"] += 1
                _media_batch["ok" if ok else "fail"] += 1

            if ok:
                state.save_review_media(asin, res.get("items") or [])
                _media_daily["count"] += 1
                n = len(res.get("items") or [])
                _media_log(f"  ✓ {asin} 抓到 {n} 项"
                           f"{'（该产品无评论媒体）' if res.get('note') == 'no_media' else ''}")
            else:
                _media_log(f"  ✗ {asin} 失败：{err}")
                # 服务不可用类错误 → 立即中止，不硬撑（保护账号，也别空转）
                if err in ("cdp_unavailable", "open_tab_failed"):
                    _media_log("服务不可用，已自动中止")
                    break

            if i < total - 1:
                delay = random.uniform(*MEDIA_DELAY_RANGE)
                _media_log(f"  限速等待 {delay:.0f}s")
                stopped = False
                for _ in range(int(delay)):
                    with _media_batch_lock:
                        if _media_batch["stopped"]:
                            stopped = True
                            break
                    time.sleep(1)
                if stopped:
                    _media_log("已停止")
                    break
    finally:
        with _media_batch_lock:
            _media_batch["running"] = False
            _media_batch["current"] = ""
            _media_batch["finishedAt"] = _now_iso()
        _media_log("批量抓取结束")


class _TaskCtl:
    """一次执行的停止信号 + 本轮进度基线。reason 区分「暂停」与「取消」。"""

    def __init__(self):
        self.stop = threading.Event()
        self.reason = "cancelled"
        # 本轮进度基线（提交时同步算好，供 /progress 返回「本轮」口径）：
        #   base_success 本轮开跑前已成功的 ASIN 数
        #   run_total    本轮待跑的 ASIN 数（= 全部 − 已成功）
        #   first_run    是否该任务的首次执行（库里还没有任何结果行）
        self.base_success = 0
        self.run_total = 0
        self.first_run = True
        #   force_total  本轮「强制重采」的 ASIN 数（>0 表示按重采口径报进度）
        #   force_done   本轮已处理的重采 ASIN 数，由 _run_scrape 逐块递增
        self.force_total = 0
        self.force_done = 0


def _active_task_id():
    with _running_lock:
        return next(iter(_running), None)


def _ctl(task_id):
    with _running_lock:
        return _running.get(task_id)


def _run_progress(ctl, task):
    """按「本轮」口径算进度；无活跃执行时返回 None。

    分母 = 本轮工作集（全量 ASIN − 本轮开跑前已成功的）；分子分两种：
      - 首次执行：已处理数（成功 + 失败）
      - 重试 / 续跑：本轮重新成功的数量（success − base_success）

    为什么重试不能用「成功 + 失败」：失败项早已在结果表里（有行=已处理），
    重试时它们正被重新抓，若仍算作「已完成」→ success + failed 恒等于 total，
    进度条会一开跑就 100% 且全程不动。

    强制重采（重采按钮）另走一条口径：任务累计的 success 在「替换」模式下不会增长
    （同一行被覆盖），在「新增」模式下增长数也不等于本轮处理数 —— 所以用量
    _run_scrape 自己维护的 force_done / force_total，与任务计数脱钩。
    """
    if ctl is None:
        return None
    if ctl.force_total > 0:
        return {"done": min(ctl.force_done, ctl.force_total), "total": ctl.force_total}
    success = task.get("success") or 0
    failed = task.get("failed") or 0
    done = (success + failed) if ctl.first_run else (success - ctl.base_success)
    return {"done": max(0, done), "total": ctl.run_total}


def _run_scrape(state, task_id, marketplace, with_reviews, with_customers_say, ctl,
                force_asins=None, append=False):
    """后台线程：按断点续跑，逐条落库，支持暂停/取消。

    force_asins：「强制重采」的 ASIN 集合。它们**即使已成功也不跳过**——这正是重采
      的前提（断点续跑默认会把已成功项跳过，直接重采会「什么都没发生」）。
      给了这一项时，待跑列表就**恰好是这批 ASIN**，不会顺带把任务里其他失败项也跑一遍。
    append：True 时落库写 seq=max+1（「新增一条记录」，保留旧版本）；
      默认 False 写 seq=0，即覆盖（「替换当前记录」）。
    """
    try:
        state.set_scrape_task_status(task_id, "running", started_at=_now_iso())
        task = state.get_scrape_task(task_id) or {}
        asins = task.get("asins") or []
        force_set = set(force_asins or [])
        if force_set:
            pending = [a for a in asins if a in force_set]
        else:
            # 待跑 = 全部 ASIN − 已成功的。这就是断点续跑：跳过跑过的，只补没跑的和失败的。
            done = state.get_scrape_done_asins(task_id)
            pending = [a for a in asins if a not in done]
        _log(f"[scrape] 任务 {task_id} 开始：待采集 {len(pending)} 个"
             f"（总 {len(asins)}）"
             + (f"，本次为强制重采（{'新增' if append else '替换'}）" if force_set else ""))

        since_refresh = 0
        scraped = 0
        # append 模式下每条 ASIN 的 seq 只算一次并缓存 —— 否则 on_progress 与
        # 块末兜底写会各取一次 max+1，同一 ASIN 被写成两行。
        _seq_cache = {}

        def _persist(products):
            if append:
                for p in products:
                    a = p.get("asin")
                    if a not in _seq_cache:
                        _seq_cache[a] = state.next_scrape_product_seq(task_id, a)
                products = [{**p, "seq": _seq_cache.get(p.get("asin"), 0)} for p in products]
            state.save_scrape_products(task_id, products)

        def on_progress(_completed, _total, product):
            """每抓完一个 ASIN 就落库，进度条才不会长时间停在 0/500。"""
            nonlocal since_refresh, scraped
            _persist([product])
            since_refresh += 1
            scraped += 1
            if scraped % PROGRESS_LOG_EVERY == 0:
                _log(f"[scrape] 进度 {scraped}/{len(asins)}（已落库，成功/失败见任务计数）")
            if since_refresh >= COUNT_REFRESH_EVERY:
                since_refresh = 0
                state.refresh_scrape_task_counts(task_id)

        for start in range(0, len(pending), CHUNK_SIZE):
            chunk = pending[start:start + CHUNK_SIZE]
            _log(f"[scrape] 第 {start // CHUNK_SIZE + 1} 块：提交 {len(chunk)} 个 ASIN"
                 f"（待跑还剩 {len(pending) - start - len(chunk)}）")
            try:
                results = product_fetcher.scrape_products(
                    chunk, marketplace, with_reviews,
                    on_progress=on_progress, should_stop=ctl.stop.is_set,
                    with_customers_say=with_customers_say)
            except product_fetcher.ScrapeInterrupted:
                raise
            except Exception as e:
                # 单块异常不该让整个任务停摆：标记这一块失败后继续跑下一块
                _log(f"[scrape] 任务 {task_id} 第 {start // CHUNK_SIZE + 1} 块异常: {e}")
                results = [{**product_fetcher._empty_product(
                    a, marketplace, f"fetch_exc:{type(e).__name__}")} for a in chunk]
            # 兜底再写一次：失败重试轮的结果不走 on_progress，靠这里落库（UPSERT 幂等）
            _persist(results)
            state.refresh_scrape_task_counts(task_id)
            # 重采进度与任务计数脱钩，由这里按块推进（见 _run_progress 的说明）
            if force_set:
                ctl.force_done = min(start + len(chunk), len(pending))

        state.refresh_scrape_task_counts(task_id)
        t = state.get_scrape_task(task_id) or {}
        failed = t.get("failed") or 0
        state.set_scrape_task_status(
            task_id, "partial" if failed else "completed",
            error=f"{failed} 个 ASIN 采集失败，可点「重试失败项」" if failed else None,
            ended_at=_now_iso())
        _log(f"[scrape] 任务 {task_id} 结束：成功 {t.get('success')}，失败 {failed}")

    except product_fetcher.ScrapeInterrupted:
        state.refresh_scrape_task_counts(task_id)
        if ctl.reason == "paused":
            # 暂停不算结束，不写 ended_at；续跑时 started_at 也用 COALESCE 保留首次时间
            state.set_scrape_task_status(task_id, "paused", error="已暂停，可点「继续」")
            _log(f"[scrape] 任务 {task_id} 已暂停（已采集的部分保留，点「继续」接着跑）")
        else:
            state.set_scrape_task_status(task_id, "cancelled", error="已取消",
                                         ended_at=_now_iso())
            _log(f"[scrape] 任务 {task_id} 已取消（已采集的部分保留，可点「继续」续跑）")
    except Exception as e:
        _log(f"[scrape] 任务 {task_id} 异常: {e}")
        try:
            state.set_scrape_task_status(task_id, "error", error=str(e)[:500],
                                         ended_at=_now_iso())
        except Exception:
            pass
    finally:
        with _running_lock:
            _running.pop(task_id, None)


def start_scrape_task(state, asins, marketplace, with_reviews, task_id=None,
                      with_customers_say=True, force_asins=None, append=False):
    """建/复用任务并起后台线程，立即返回 task_id。

    传 task_id 时把新 ASIN 合并进已有任务（「重试失败项」「继续」走这条路）。
    待跑列表由「任务里的全部 ASIN − 已成功的 ASIN」算出，所以重跑会天然跳过
    已成功项、只补失败项与未跑项。

    with_customers_say：是否解析 Customers say。新建任务用传入值；
    复用已有任务时改用任务里记录的开关（与上次采集保持一致）。

    force_asins + append：重采通道。给了 force_asins 时，待跑列表恰好是这批 ASIN
    （不再按「已成功就跳过」过滤，否则重采已成功的项会什么都不发生）；
    append=True 落库写新 seq（保留旧版本），默认 False 覆盖。
    """
    asins = [a.strip().upper() for a in asins if a and a.strip()]
    force_set = {a.strip().upper() for a in (force_asins or []) if a and a.strip()}
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
            # 续跑/重试沿用原任务的开关，避免同一任务两次采集字段不一致
            with_customers_say = bool(t.get("withCustomersSay", True))
        else:
            task_id = state.create_scrape_task(marketplace, asins, with_reviews,
                                               with_customers_say=with_customers_say)
            merged = asins
        _running[task_id] = ctl
        # 同步落状态再返回：否则 start 一返回、后台线程还没调度起来时，任务状态仍是
        # 上一轮的终态（partial/completed），前端轮询会误判成「已结束」。
        state.set_scrape_task_status(task_id, "running", error=None)
        # 同步算「本轮」进度基线：start 返回后前端第一次轮询就能读到正确基数，
        # 不会先闪现一次按任务累计口径算的 100%（重试场景尤其明显）。
        done = state.get_scrape_done_asins(task_id)
        snapshot = state.get_scrape_task(task_id) or {}
        ctl.base_success = len(done)
        if force_set:
            # 重采：分母就是这批 ASIN，且走 force_done/force_total 口径
            ctl.force_total = sum(1 for a in merged if a in force_set)
            ctl.run_total = ctl.force_total
        else:
            ctl.run_total = sum(1 for a in merged if a not in done)
        ctl.first_run = ((snapshot.get("success") or 0)
                         + (snapshot.get("failed") or 0)) == 0

    threading.Thread(target=_run_scrape,
                     args=(state, task_id, marketplace, with_reviews, with_customers_say, ctl),
                     kwargs={"force_asins": sorted(force_set), "append": append},
                     daemon=True, name=f"ScrapeTask-{task_id[:8]}").start()
    return task_id


def recover_stale_tasks(state):
    """服务启动时把残留的 running 任务标为 paused，让它可以从断点继续。"""
    n = state.mark_running_scrape_tasks_paused()
    if n:
        _log(f"[scrape] {n} 个采集任务因服务重启被标记为已暂停，可在界面点「继续」")


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
            # 「本轮」进度：分母是本轮工作集（首次=全部 ASIN；重试/续跑=未成功的那些）
            "run": _run_progress(ctl, task),
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
        # Customers say 默认开启：成本极低（净增约 44ms，无额外请求）
        with_customers_say = bool(payload.get("withCustomersSay", True))
        # 重采通道：force=True 时这批 ASIN 强制重跑（不按「已成功就跳过」过滤）；
        # append=True 落库追加新版本（「新增一条记录」），否则覆盖（「替换」）。
        force = bool(payload.get("force", False))
        append = bool(payload.get("append", False))
        task_id_in = payload.get("taskId")
        if not isinstance(task_id_in, str) or not task_id_in:
            task_id_in = None
        if force and not task_id_in:
            self._send_json(400, {"error": "重采必须带 taskId（重采的是已有任务里的记录）"})
            return
        try:
            task_id = start_scrape_task(state, asins, marketplace, with_reviews,
                                        task_id=task_id_in,
                                        with_customers_say=with_customers_say,
                                        force_asins=asins if force else None,
                                        append=append)
        except RuntimeError as e:
            self._send_json(409, {"error": str(e)})
            return
        except ValueError as e:
            self._send_json(404, {"error": str(e)})
            return
        if force:
            _log(f"[scrape] 重采 {len(asins)} 个 ASIN @ {marketplace}"
                 f"（{'新增一条记录' if append else '替换当前记录'}）-> {task_id}")
        else:
            _extras = []
            if with_reviews:
                _extras.append("含评论")
            if with_customers_say:
                _extras.append("含 Customers say")
            _log(f"[scrape] 已提交 {len(asins)} 个 ASIN @ {marketplace}"
                 f"{(' (' + ' + '.join(_extras) + ')') if _extras else ''} -> {task_id}")
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
            _log(f"[scrape] 收到暂停请求: {task_id}")
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
                              task_id=task_id,
                              with_customers_say=bool(task.get("withCustomersSay", True)))
        except RuntimeError as e:
            self._send_json(409, {"error": str(e)})
            return
        _log(f"[scrape] 继续任务 {task_id}")
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
            _log(f"[scrape] 收到取消请求: {task_id}")
            self._send_json(200, {"ok": True, "cancelled": True})
            return
        # 线程已经不在了（例如任务处于「已暂停」）→ 直接落终态，不必再起线程
        task = state.get_scrape_task(task_id) if task_id else None
        if task and task["status"] in ("paused", "running"):
            state.set_scrape_task_status(task_id, "cancelled", error="已取消",
                                         ended_at=_now_iso())
            _log(f"[scrape] 已取消暂停中的任务: {task_id}")
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

    # ---- 评论媒体（Customer photos and videos）----
    #
    # 抓取会经「管理员本机浏览器」发出（端点要求有效会话），所以这两个写接口
    # 都限制 root：员工点详情页 tab 只能读已落库的缓存。

    def _is_root(self):
        user = auth.verify(_extract_token(self))
        return bool(user and user.get("role") == "root")

    def get_review_media(self):
        """详情页 tab：读缓存；无缓存时仅 root 可触发抓取。"""
        if not _authed(self):
            return
        qs = parse_qs(urlparse(self.path).query)
        task_id = (qs.get("taskId") or [""])[0]
        asin = (qs.get("asin") or [""])[0].strip().upper()
        if not asin:
            self._send_json(400, {"error": "asin required"})
            return

        # 三态：None=从未抓过（要抓）；[]=抓过但无媒体；[...]=有媒体
        cached = state.get_review_media(task_id, asin) if task_id else None
        if cached is not None:
            self._send_json(200, {"items": cached, "cached": True,
                                  "note": "no_media" if not cached else "ok"})
            return

        if not _is_root(self):
            self._send_json(200, {"items": [], "cached": False, "needsFetch": True,
                                  "hint": "该产品的评论媒体尚未采集，请联系管理员"})
            return

        allowed, _used = _media_daily_guard()
        if not allowed:
            self._send_json(200, {"items": [], "cached": False, "fetchError": "daily_limit",
                                  "hint": _media_hint("daily_limit")})
            return

        task = state.get_scrape_task(task_id) if task_id else None
        marketplace = (task or {}).get("marketplace") or "US"
        res = review_media.fetch_review_media(asin, marketplace)
        if not res.get("ok"):
            self._send_json(200, {"items": [], "cached": False,
                                  "fetchError": res.get("error"),
                                  "detail": res.get("detail"),
                                  "hint": _media_hint(res.get("error"))})
            return
        items = res.get("items") or []
        state.save_review_media(asin, items)
        _media_daily["count"] += 1
        self._send_json(200, {"items": items, "cached": False, "fetched": True,
                              "note": res.get("note")})
    GET["/api/scrape/review-media"] = get_review_media

    def post_review_media_batch(self):
        """批量预热（仅 root）：把选中/全部产品的评论媒体一次抓好，之后全员可读。"""
        if not _authed(self):
            return
        if not _is_root(self):
            self._send_json(403, {"error": "仅 root 账号可执行批量抓取"})
            return
        payload = self._read_json()
        if payload is None:
            return
        task_id = payload.get("taskId")
        scope = payload.get("asins")
        if not task_id:
            self._send_json(400, {"error": "taskId required"})
            return
        with _media_batch_lock:
            if _media_batch["running"]:
                self._send_json(409, {"error": "已有批量抓取在进行中"})
                return

        products = state.get_scrape_products(task_id)
        if scope:
            want = {str(a).strip().upper() for a in scope}
            targets = [p for p in products if p.get("asin") in want]
        else:
            targets = [p for p in products if p.get("status") == "success"]
        # 跳过「已经抓过」的（含抓过但无媒体的），避免每批都重试同一批空产品
        todo = [p for p in targets
                if not ((p.get("customerReviews") or {}).get("reviewMediaFetched"))]
        if not todo:
            self._send_json(200, {"started": False, "hint": "所选范围都已有媒体缓存，无需抓取"})
            return

        allowed, used = _media_daily_guard()
        if not allowed:
            self._send_json(200, {"started": False, "hint": _media_hint("daily_limit")})
            return
        budget = min(MEDIA_BATCH_MAX, MEDIA_DAILY_MAX - used)
        todo = todo[:budget]

        task = state.get_scrape_task(task_id) or {}
        marketplace = task.get("marketplace") or "US"
        with _media_batch_lock:
            _media_batch.update({"running": True, "stopped": False, "total": len(todo),
                                 "done": 0, "ok": 0, "fail": 0, "current": "", "log": [],
                                 "startedAt": _now_iso(), "finishedAt": None})
        threading.Thread(target=_run_media_batch, args=(state, todo, marketplace),
                         daemon=True, name="ReviewMediaBatch").start()
        _log(f"[review-media] 批量开始：{len(todo)} 个 ASIN @ {marketplace}"
             f"（今日剩余额度 {MEDIA_DAILY_MAX - used}）")
        self._send_json(200, {"started": True, "total": len(todo),
                              "hint": f"已开始，每个之间随机等待 "
                                      f"{MEDIA_DELAY_RANGE[0]}–{MEDIA_DELAY_RANGE[1]} 秒"})
    POST["/api/scrape/review-media/batch"] = post_review_media_batch

    def get_review_media_batch(self):
        if not _authed(self):
            return
        with _media_batch_lock:
            snap = dict(_media_batch)
        snap["log"] = snap["log"][-80:]
        _allowed, used = _media_daily_guard()
        snap.update({"dailyUsed": used, "dailyMax": MEDIA_DAILY_MAX,
                     "batchMax": MEDIA_BATCH_MAX, "delayRange": list(MEDIA_DELAY_RANGE)})
        self._send_json(200, snap)
    GET["/api/scrape/review-media/batch"] = get_review_media_batch

    def post_review_media_batch_cancel(self):
        if not _authed(self):
            return
        if not _is_root(self):
            self._send_json(403, {"error": "仅 root 账号可操作"})
            return
        with _media_batch_lock:
            _media_batch["stopped"] = True
        _log("[review-media] 收到停止请求")
        self._send_json(200, {"ok": True})
    POST["/api/scrape/review-media/batch/cancel"] = post_review_media_batch_cancel
