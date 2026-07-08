from urllib.parse import urlparse, parse_qs

from .. import product_fetcher
from ..utils import _extract_token


def run_scrape_task(state, asins, marketplace, with_reviews, task_id=None, total=None):
    """批量采集产品详情，落库并返回 (task_id, results)。
    传入已有 task_id 时，结果累加到该任务，使同一次提交的多个批次合并为一条历史记录。"""
    asins = [a.strip().upper() for a in asins if a and a.strip()]
    if task_id is None:
        task_id = state.create_scrape_task(marketplace, total if total is not None else len(asins), with_reviews)
    try:
        results = product_fetcher.scrape_products(asins, marketplace, with_reviews=with_reviews)
    except Exception as e:
        results = [
            {**product_fetcher._empty_product(a, marketplace, f"fetch_exc:{type(e).__name__}")}
            for a in asins
        ]
    state.save_scrape_products(task_id, results)
    success = sum(1 for r in results if r.get("status") == "success")
    failed = len(results) - success
    state.accumulate_scrape_task(task_id, success, failed)
    return task_id, results


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_tasks(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, {"tasks": state.list_scrape_tasks()})
    GET["/api/scrape/tasks"] = get_tasks

    def get_products(self):
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
            "products": state.get_scrape_products(task_id),
        })
    GET["/api/scrape/products"] = get_products

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
        with_reviews = bool(payload.get("withReviews", False))
        task_id_in = payload.get("taskId")
        if not isinstance(task_id_in, str) or not task_id_in:
            task_id_in = None
        total = payload.get("total")
        if not isinstance(total, int):
            total = None
        print(f"  [scrape] 采集 {len(asins)} 个 ASIN @ {marketplace}"
              f"{' (含评论)' if with_reviews else ''}")
        task_id, results = run_scrape_task(state, asins, marketplace, with_reviews, task_id=task_id_in, total=total)
        self._send_json(200, {"taskId": task_id, "results": results})
    POST["/api/scrape/run"] = post_run

    def delete_task(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("id") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "id required"})
            return
        state.delete_scrape_task(task_id)
        self._send_json(200, {"ok": True})
    DELETE["/api/scrape/tasks"] = delete_task

    def delete_reset_session(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        marketplace = (payload.get("marketplace") or "").upper()
        product_fetcher.reset_session(marketplace if marketplace else None)
        self._send_json(200, {"ok": True})
    DELETE["/api/scrape/reset-session"] = delete_reset_session
