import json
import os
import secrets
import threading
import time

from .utils import _log

# 登录态有效期：过了就要求重新登录。30 天足够日常使用，
# 又不至于让一个 token 永久有效。
TOKEN_TTL_DAYS = 30


class AuthManager:
    """
    基于随机 Token 的轻量认证。
    - 用户名/密码存储在 fba-users.json，明文（局域网内可接受）
    - Token 落盘到 fba-tokens.json（与 users 同目录），**服务重启后登录态不丢**
      早期只在内存里，重启等于全员被登出：前端拿到 401 后各列表变成空，
      看起来像「数据被清了」——实际是读不到，不是没数据。
    - 首次启动自动创建默认账号 admin / fba2025
    """

    def __init__(self, users_path):
        self.users_path  = users_path
        self.tokens_path = os.path.join(os.path.dirname(users_path) or ".", "fba-tokens.json")
        self.tokens = {}        # token -> {username, name, role, created_at}
        self.lock   = threading.Lock()
        self._ensure_default_users()
        self._load_tokens()

    def _ensure_default_users(self):
        if not os.path.exists(self.users_path):
            default = {
                "users": [
                    {"username": "admin",  "password": "fba2025",     "name": "管理员", "role": "admin"},
                    {"username": "editor", "password": "fba2025",     "name": "编辑员", "role": "editor"},
                    {"username": "root",   "password": "fba2026root", "name": "Root",  "role": "root"},
                ]
            }
            with open(self.users_path, "w", encoding="utf-8") as f:
                json.dump(default, f, ensure_ascii=False, indent=2)
            _log(f"[info] 已创建用户配置: {self.users_path}")
            _log("  默认账号: admin / fba2025  ← 请尽快修改密码")
            return
        # 幂等补充 root 账号：AI分析模块暂时只对 root 开放，不动已有的 admin/editor
        users = self._load_users()
        if not any(u.get("username") == "root" for u in users):
            users.append({"username": "root", "password": "fba2026root", "name": "Root", "role": "root"})
            with open(self.users_path, "w", encoding="utf-8") as f:
                json.dump({"users": users}, f, ensure_ascii=False, indent=2)
            _log(f"[info] 已补充 root 账号到 {self.users_path}")

    def _load_users(self):
        try:
            with open(self.users_path, "r", encoding="utf-8") as f:
                return json.load(f).get("users", [])
        except Exception:
            return []

    def login(self, username, password):
        """验证成功返回 (token, user_info)，失败返回 (None, None)"""
        for u in self._load_users():
            if u["username"] == username and u["password"] == password:
                token = secrets.token_hex(32)
                info  = {
                    "username": username,
                    "name":     u.get("name", username),
                    "role":     u.get("role", "editor"),
                }
                with self.lock:
                    self.tokens[token] = dict(info, created_at=time.time())
                self._save_tokens()
                return token, info
        return None, None

    def verify(self, token):
        """返回 user_info 或 None（不含 created_at 这类内部字段）"""
        if not token:
            return None
        with self.lock:
            rec = self.tokens.get(token)
            if not rec:
                return None
            ts = rec.get("created_at") or 0
            if ts and time.time() - ts > TOKEN_TTL_DAYS * 86400:
                self.tokens.pop(token, None)     # 过期的顺手清掉
                return None
            return {k: v for k, v in rec.items() if k != "created_at"}

    def logout(self, token):
        with self.lock:
            self.tokens.pop(token, None)
        self._save_tokens()

    # ---- 登录态持久化 ----

    def _load_tokens(self):
        """启动时恢复未过期的 token。文件不存在 / 损坏都不影响启动。"""
        try:
            with open(self.tokens_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except FileNotFoundError:
            return
        except Exception as e:
            _log(f"[warn] 读取登录态失败（忽略）: {e}")
            return

        now = time.time()
        keep = {}
        for tk, info in (raw.get("tokens") or {}).items():
            if not isinstance(info, dict):
                continue
            ts = info.get("created_at") or 0
            if ts and now - ts > TOKEN_TTL_DAYS * 86400:
                continue
            keep[tk] = info
        with self.lock:
            self.tokens = keep
        if keep:
            _log(f"[info] 已恢复 {len(keep)} 个登录态（重启后无需重新登录）")

    def _save_tokens(self):
        """原子写入：先写 .tmp 再 replace，避免写一半断电留下坏文件。"""
        with self.lock:
            snapshot = dict(self.tokens)
        try:
            os.makedirs(os.path.dirname(self.tokens_path) or ".", exist_ok=True)
            tmp = self.tokens_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"tokens": snapshot}, f, ensure_ascii=False)
            os.replace(tmp, self.tokens_path)
        except Exception as e:
            _log(f"[warn] 保存登录态失败: {e}")
