from ..utils import _extract_token


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def post_login(self):
        payload = self._read_json()
        if payload is None:
            return
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        token, user_info = auth.login(username, password)
        if token:
            print(f"  [auth] {username} 登录成功")
            self._send_json(200, {"token": token, "user": user_info})
        else:
            self._send_json(401, {"error": "用户名或密码错误"})
    POST["/api/login"] = post_login

    def post_logout(self):
        token = _extract_token(self)
        if token:
            auth.logout(token)
        self._send_json(200, {"ok": True})
    POST["/api/logout"] = post_logout

    def get_me(self):
        user = auth.verify(_extract_token(self))
        if not user:
            self._send_json(401, {"error": "未登录"})
            return
        self._send_json(200, user)
    GET["/api/me"] = get_me
