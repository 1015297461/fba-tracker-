"""
ASIN 属性补齐（上架时间）的运维接口 —— 两个模块共用。

为什么单独一个路由模块：取数通道（卖家精灵）是「类目榜单监控」和「排名监测」
共用的，把「状态 / 重新登录」挂在任一业务模块下都别扭，所以独立出来。

路由：
    GET  /api/asin-meta/status   浏览器状态 + 登录态 + 凭据是否配置 + 最近一次取数结果
    POST /api/asin-meta/login    打开可见登录窗口（登录成功后自动关闭）
"""

from .. import asin_meta, sprite_fetch
from ..utils import _extract_token


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def _ok(handler):
        user = auth.verify(_extract_token(handler))
        if not user:
            handler._send_json(401, {"error": "请先登录"})
            return False
        return True

    def get_status(self):
        if not _ok(self):
            return
        try:
            st = sprite_fetch.status()
        except Exception as e:
            st = {"running": False, "logged_in": False, "last": {},
                  "error": f"{type(e).__name__}: {e}"}
        st["sources"] = asin_meta.enabled_sources()
        self._send_json(200, st)
    GET["/api/asin-meta/status"] = get_status

    def post_login(self):
        if not _ok(self):
            return
        try:
            res = sprite_fetch.open_login_window()
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        self._send_json(200, res)
    POST["/api/asin-meta/login"] = post_login
