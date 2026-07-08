import os
from urllib.parse import urlparse, parse_qs

from .. import pdf_splitter
from ..utils import _extract_token, _now_iso


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_list(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, {"jobs": state.list_export_jobs()})
    GET["/api/exports/list"] = get_list

    def post_create(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        job_type = (payload.get("type") or "").strip()
        if job_type not in ("scrape_xlsx",):
            self._send_json(400, {"error": f"unsupported type: {job_type}"})
            return
        params  = payload.get("params") or {}
        label   = (payload.get("label") or "导出任务").strip()
        fname   = (payload.get("fileName") or f"export_{_now_iso()[:10]}.xlsx").strip()
        # 预估 progress_total（按产品数）
        task_id = params.get("taskId", "")
        asins   = params.get("asins")
        products = state.get_scrape_products(task_id) if task_id else []
        if asins:
            products = [p for p in products if p.get("asin") in set(asins)]
        total = len(products)
        jid = state.create_export_job(job_type, label, {**params, "asins": asins}, total)
        state.update_export_job(jid, file_name=fname)
        self._send_json(200, {"jobId": jid})
    POST["/api/exports/create"] = post_create

    def delete_job(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        jid = (q.get("id") or [""])[0]
        if not jid:
            self._send_json(400, {"error": "id required"})
            return
        jobs = state.list_export_jobs()
        for j in jobs:
            if j["id"] == jid and j.get("download_id"):
                fpath = pdf_splitter._download_registry.pop(j["download_id"], None)
                if fpath:
                    try:
                        os.remove(fpath)
                    except OSError:
                        pass
                break
        state.delete_export_job(jid)
        self._send_json(200, {"ok": True})
    DELETE["/api/exports"] = delete_job
