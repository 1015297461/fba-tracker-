from urllib.parse import urlparse, parse_qs

from ..utils import _extract_token


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_products(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, state.snapshot())
    GET["/api/products"] = get_products

    def put_products(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        new_products = payload.get("products")
        base_version = payload.get("baseVersion")
        if not isinstance(new_products, list):
            self._send_json(400, {"error": "products must be an array"})
            return
        new_version, conflict = state.write(
            new_products, base_version, user=user.get("username")
        )
        if conflict is not None:
            self._send_json(409, conflict)
        else:
            self._send_json(200, {"version": new_version})
    PUT["/api/products"] = put_products

    def post_trash_restore(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = str(payload.get("id") or "").strip()
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        new_version = state.restore_from_trash(tid, user=user.get("username"))
        if new_version is None:
            self._send_json(404, {"error": "回收站中未找到该产品"})
        else:
            self._send_json(200, {"version": new_version})
    POST["/api/trash/restore"] = post_trash_restore

    def delete_trash_empty(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        new_version = state.empty_trash(user=user.get("username"))
        self._send_json(200, {"version": new_version})
    DELETE["/api/trash/empty"] = delete_trash_empty

    def delete_trash_purge(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id") or [""])[0]
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        new_version = state.purge_from_trash(tid, user=user.get("username"))
        self._send_json(200, {"version": new_version})
    DELETE["/api/trash"] = delete_trash_purge
