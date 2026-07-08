from urllib.parse import urlparse, parse_qs

from .. import product_fetcher
from ..utils import _extract_token


def run_review_task(state, asins, marketplace, sort_by, filter_star, verified_only, max_pages, task_id=None):
    """批量采集评论，去重落入评论池并返回 (task_id, results)。
    传入已有 task_id 时，结果累加到该任务，使同一次提交的多个批次合并为一条历史记录。"""
    asins = [a.strip().upper() for a in asins if a and a.strip()]
    if task_id is None:
        task_id = state.create_review_task(marketplace, asins, sort_by, filter_star, verified_only, max_pages)

    try:
        fetch_results = product_fetcher.fetch_reviews_for_asins(
            asins, marketplace, max_pages=max_pages, sort_by=sort_by,
            filter_by_star=filter_star, verified_only=verified_only,
        )
    except Exception as e:
        fetch_results = [
            {"asin": a, "marketplace": marketplace, "reviews": [],
             "status": "failed", "error_message": f"fetch_exc:{type(e).__name__}"}
            for a in asins
        ]

    new_count = 0
    summaries = []
    for r in fetch_results:
        inserted = state.save_review_results(task_id, r["asin"], marketplace, r["reviews"])
        new_count += inserted
        summaries.append({
            "asin": r["asin"],
            "marketplace": marketplace,
            "totalFetched": len(r["reviews"]),
            "newCount": inserted,
            "status": r["status"],
            "errorMessage": r["error_message"],
        })

    state.accumulate_review_task(task_id, asins, new_count)
    return task_id, summaries


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_tasks(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, {"tasks": state.list_review_tasks()})
    GET["/api/review/tasks"] = get_tasks

    def get_results(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "taskId required"})
            return
        self._send_json(200, {
            "taskId": task_id,
            "results": state.get_review_results(task_id),
        })
    GET["/api/review/results"] = get_results

    def post_run(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
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
        sort_by = payload.get("sortBy") or "recent"
        if sort_by not in ("recent", "helpful"):
            sort_by = "recent"
        filter_star = payload.get("filterStar")
        if filter_star is not None:
            try:
                filter_star = int(filter_star)
            except (TypeError, ValueError):
                filter_star = None
            if filter_star not in (1, 2, 3, 4, 5):
                filter_star = None
        verified_only = bool(payload.get("verifiedOnly", False))
        try:
            max_pages = int(payload.get("maxPages", 3))
        except (TypeError, ValueError):
            max_pages = 3
        max_pages = max(1, min(max_pages, 10))
        task_id_in = payload.get("taskId")
        if not isinstance(task_id_in, str) or not task_id_in:
            task_id_in = None
        print(f"  [review] 采集 {len(asins)} 个 ASIN 评论 @ {marketplace}"
              f" (sortBy={sort_by}, maxPages={max_pages})")
        task_id, results = run_review_task(
            state, asins, marketplace, sort_by, filter_star, verified_only, max_pages,
            task_id=task_id_in,
        )
        self._send_json(200, {"taskId": task_id, "results": results})
    POST["/api/review/run"] = post_run

    def delete_task(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("id") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "id required"})
            return
        state.delete_review_task(task_id)
        self._send_json(200, {"ok": True})
    DELETE["/api/review/tasks"] = delete_task
