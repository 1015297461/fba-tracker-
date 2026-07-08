import json
import os
import secrets
import threading


class AuthManager:
    """
    基于随机 Token 的轻量认证。
    - 用户名/密码存储在 fba-users.json，明文（局域网内可接受）
    - Token 仅在内存中，服务器重启后需重新登录
    - 首次启动自动创建默认账号 admin / fba2025
    """

    def __init__(self, users_path):
        self.users_path = users_path
        self.tokens = {}        # token -> {username, name, role}
        self.lock   = threading.Lock()
        self._ensure_default_users()

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
            print(f"[info] 已创建用户配置: {self.users_path}")
            print("  默认账号: admin / fba2025  ← 请尽快修改密码")
            return
        # 幂等补充 root 账号：AI分析模块暂时只对 root 开放，不动已有的 admin/editor
        users = self._load_users()
        if not any(u.get("username") == "root" for u in users):
            users.append({"username": "root", "password": "fba2026root", "name": "Root", "role": "root"})
            with open(self.users_path, "w", encoding="utf-8") as f:
                json.dump({"users": users}, f, ensure_ascii=False, indent=2)
            print(f"[info] 已补充 root 账号到 {self.users_path}")

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
                    self.tokens[token] = info
                return token, info
        return None, None

    def verify(self, token):
        """返回 user_info 或 None"""
        if not token:
            return None
        with self.lock:
            return self.tokens.get(token)

    def logout(self, token):
        with self.lock:
            self.tokens.pop(token, None)
