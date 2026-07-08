from urllib.parse import urlparse, parse_qs, unquote, quote

from .. import pdf_splitter
from ..utils import _extract_token


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_download(self):
        q = parse_qs(urlparse(self.path).query)
        dl_id = (q.get("id") or [""])[0]
        if not dl_id:
            self._send_json(400, {"error": "id required"})
            return
        fpath = pdf_splitter.get_download_path(dl_id)
        if not fpath:
            self._send_json(404, {"error": "文件不存在或已过期，请重新拆分"})
            return
        self._send_file(fpath)
    GET["/api/pdf/download"] = get_download

    def post_upload(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        if not pdf_splitter.check_pypdf():
            self._send_json(503, {"error": "后端未安装 pypdf，请运行: pip3 install pypdf"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            self._send_json(400, {"error": "empty body"})
            return
        filename = unquote(self.headers.get("X-Filename", "upload.pdf"))
        data = self.rfile.read(length)
        try:
            info = pdf_splitter.save_upload(filename, data)
            self._send_json(200, info)
        except Exception as e:
            self._send_json(500, {"error": str(e)})
    POST["/api/pdf/upload"] = post_upload

    def post_split(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        jobs = payload.get("jobs")
        if not isinstance(jobs, list) or not jobs:
            self._send_json(400, {"error": "jobs must be a non-empty array"})
            return
        results = [pdf_splitter.run_split_job(job) for job in jobs]
        self._send_json(200, {"results": results})
    POST["/api/pdf/split"] = post_split

    def post_zip(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        ids = payload.get("ids")
        if not isinstance(ids, list) or not ids:
            self._send_json(400, {"error": "ids must be a non-empty array"})
            return
        zip_name = str(payload.get("name", "split_results.zip"))
        try:
            data = pdf_splitter.create_zip(ids)
        except Exception as e:
            self._send_json(500, {"error": str(e)})
            return
        encoded_name = quote(zip_name, safe="")
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(data)))
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{zip_name.encode("ascii","replace").decode("ascii")}"; filename*=UTF-8\'\'{encoded_name}',
        )
        self.end_headers()
        self.wfile.write(data)
    POST["/api/pdf/zip"] = post_zip
