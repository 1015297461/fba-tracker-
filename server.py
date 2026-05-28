#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FBA Tracker — 局域网协作服务器 v2
============================================
功能：
  1. 提供静态文件服务
  2. /api/products GET/PUT — SQLite 存储，乐观锁，增量写入
  3. /api/login POST — 用户名/密码换 Token
  4. /api/logout POST — 撤销 Token
  5. /api/me GET — 查询当前用户
  6. 首次启动自动从 fba-data.json 迁移数据
  7. 首次启动自动创建 fba-users.json（默认账号 admin / fba2025）

用法：
  python3 server.py                       # 默认 0.0.0.0:8000
  python3 server.py --port 9000
  python3 server.py --db /path/fba.db     # 自定义数据库路径
  python3 server.py --users /path/u.json  # 自定义用户配置

按 Ctrl+C 停止。
"""

import http.server
import json
import os
import socket
import argparse
import threading
import socketserver
import sqlite3
import secrets
import datetime
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def get_lan_ip():
    """探测本机局域网 IP，优先返回 192.168/10/172.16-31 段"""
    import subprocess
    candidates = []
    try:
        result = subprocess.run(
            ["ifconfig"], capture_output=True, text=True, timeout=3
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("inet ") and "127.0.0.1" not in line:
                ip = line.split()[1]
                if ip.startswith("192.168.") or ip.startswith("10.") or \
                   any(ip.startswith(f"172.{i}.") for i in range(16, 32)):
                    candidates.append(ip)
    except Exception:
        pass
    if candidates:
        return candidates[0]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 数据层：SQLite
# ---------------------------------------------------------------------------

class DbState:
    """SQLite 存储，WAL 模式支持并发读，行级写入替代全量 JSON 重写"""

    def __init__(self, db_path):
        self.db_path = db_path
        self.lock = threading.Lock()
        self._init_db()

    def _conn(self):
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _init_db(self):
        with self._conn() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT OR IGNORE INTO meta VALUES ('version', '0');

                CREATE TABLE IF NOT EXISTS products (
                    id            TEXT PRIMARY KEY,
                    name          TEXT,
                    sku           TEXT,
                    category      TEXT,
                    status        TEXT,
                    lead          TEXT,
                    created_at    TEXT,
                    current_stage TEXT,
                    progress      INTEGER DEFAULT 0,
                    fx_rate       REAL    DEFAULT 7.2,
                    stages        TEXT    DEFAULT '{}',
                    logs          TEXT    DEFAULT '[]',
                    variants      TEXT    DEFAULT '[]',
                    updated_at    TEXT
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id TEXT,
                    user_name  TEXT,
                    action     TEXT,
                    changed_at TEXT DEFAULT (datetime('now'))
                );
            """)
            # 兼容旧版数据库：若 variants 列不存在则追加（幂等）
            existing = {row[1] for row in conn.execute("PRAGMA table_info(products)")}
            if "variants" not in existing:
                conn.execute("ALTER TABLE products ADD COLUMN variants TEXT DEFAULT '[]'")

    # ---- 内部辅助 ----

    def _get_version(self, conn):
        row = conn.execute("SELECT value FROM meta WHERE key='version'").fetchone()
        return int(row[0]) if row else 0

    def _row_to_product(self, row):
        return {
            "id":           row["id"],
            "name":         row["name"],
            "sku":          row["sku"],
            "category":     row["category"],
            "status":       row["status"],
            "lead":         row["lead"],
            "createdAt":    row["created_at"],
            "currentStage": row["current_stage"],
            "progress":     row["progress"] or 0,
            "fxRate":       row["fx_rate"] or 7.20,
            "stages":       json.loads(row["stages"]   or "{}"),
            "logs":         json.loads(row["logs"]     or "[]"),
            "variants":     json.loads(row["variants"] or "[]"),
        }

    # ---- 公开接口 ----

    def snapshot(self):
        with self._conn() as conn:
            version  = self._get_version(conn)
            rows     = conn.execute(
                "SELECT * FROM products ORDER BY created_at DESC"
            ).fetchall()
            return {
                "version":  version,
                "products": [self._row_to_product(r) for r in rows],
            }

    def write(self, new_products, base_version, user=None):
        """
        乐观锁写入：base_version 与当前版本不符则返回 (None, conflict_snapshot)。
        成功返回 (new_version, None)。
        """
        with self.lock:
            with self._conn() as conn:
                current = self._get_version(conn)
                if base_version is not None and int(base_version) != current:
                    return None, self.snapshot()

                new_version = current + 1
                conn.execute(
                    "INSERT OR REPLACE INTO meta VALUES ('version', ?)",
                    [str(new_version)],
                )
                now = _now_iso()

                for p in new_products:
                    conn.execute(
                        """INSERT OR REPLACE INTO products
                           (id, name, sku, category, status, lead, created_at,
                            current_stage, progress, fx_rate, stages, logs, variants, updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        [
                            p.get("id"),
                            p.get("name"),
                            p.get("sku"),
                            p.get("category"),
                            p.get("status"),
                            p.get("lead"),
                            p.get("createdAt"),
                            p.get("currentStage"),
                            p.get("progress", 0),
                            p.get("fxRate", 7.20),
                            json.dumps(p.get("stages",   {}), ensure_ascii=False),
                            json.dumps(p.get("logs",     []), ensure_ascii=False),
                            json.dumps(p.get("variants", []), ensure_ascii=False),
                            now,
                        ],
                    )

                # 删除已不在列表中的产品
                if new_products:
                    ids = [p.get("id") for p in new_products if p.get("id")]
                    placeholders = ",".join("?" for _ in ids)
                    conn.execute(
                        f"DELETE FROM products WHERE id NOT IN ({placeholders})", ids
                    )
                else:
                    conn.execute("DELETE FROM products")

                conn.execute(
                    "INSERT INTO audit_log (product_id, user_name, action, changed_at)"
                    " VALUES (?,?,?,?)",
                    ["__batch__", user or "anonymous", f"write v{new_version}", now],
                )
                conn.commit()
                return new_version, None

    def import_from_json(self, json_path):
        """首次启动时从旧版 fba-data.json 一键迁移"""
        if not os.path.exists(json_path):
            return False
        with self._conn() as conn:
            count = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
            if count > 0:
                return False  # DB 已有数据，跳过

        try:
            with open(json_path, "r", encoding="utf-8") as f:
                obj = json.load(f)
            if isinstance(obj, dict):
                products = obj.get("products", [])
                orig_version = int(obj.get("version", 0))
            elif isinstance(obj, list):
                products = obj
                orig_version = 0
            else:
                return False

            if not products:
                return False

            # 写入后将版本号还原为原始值（避免版本跳变）
            self.write(products, None, user="__migration__")
            with self._conn() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO meta VALUES ('version', ?)",
                    [str(orig_version)],
                )
                conn.commit()
            print(f"[info] 已从 {json_path} 迁移 {len(products)} 条产品 (v{orig_version})")
            return True
        except Exception as e:
            print(f"[warn] JSON 迁移失败: {e}")
            return False

    @property
    def version(self):
        with self._conn() as conn:
            return self._get_version(conn)

    @property
    def product_count(self):
        with self._conn() as conn:
            return conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]


# ---------------------------------------------------------------------------
# 认证层：简单 Token（局域网场景）
# ---------------------------------------------------------------------------

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
        if os.path.exists(self.users_path):
            return
        default = {
            "users": [
                {"username": "admin",  "password": "fba2025", "name": "管理员", "role": "admin"},
                {"username": "editor", "password": "fba2025", "name": "编辑员", "role": "editor"},
            ]
        }
        with open(self.users_path, "w", encoding="utf-8") as f:
            json.dump(default, f, ensure_ascii=False, indent=2)
        print(f"[info] 已创建用户配置: {self.users_path}")
        print("  默认账号: admin / fba2025  ← 请尽快修改密码")

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


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

def _extract_token(handler):
    auth = handler.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def make_handler(state, auth):
    class Handler(http.server.SimpleHTTPRequestHandler):

        def end_headers(self):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            super().end_headers()

        def log_message(self, fmt, *args):
            path = args[0] if args else ""
            if "/api/" in str(path):
                return
            print(f"  {self.address_string()} — {path}")

        # ---- GET ----

        def do_GET(self):
            path = urlparse(self.path).path

            if path == "/api/products":
                user = auth.verify(_extract_token(self))
                if not user:
                    self._send_json(401, {"error": "请先登录"})
                    return
                self._send_json(200, state.snapshot())
                return

            if path == "/api/me":
                user = auth.verify(_extract_token(self))
                if not user:
                    self._send_json(401, {"error": "未登录"})
                    return
                self._send_json(200, user)
                return

            return super().do_GET()

        # ---- POST ----

        def do_POST(self):
            path = urlparse(self.path).path

            if path == "/api/login":
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
                return

            if path == "/api/logout":
                token = _extract_token(self)
                if token:
                    auth.logout(token)
                self._send_json(200, {"ok": True})
                return

            self.send_error(404)

        # ---- PUT ----

        def do_PUT(self):
            path = urlparse(self.path).path

            if path == "/api/products":
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
                return

            self.send_error(405, "PUT not allowed here")

        # ---- 工具方法 ----

        def _read_json(self):
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                return json.loads(raw)
            except json.JSONDecodeError as e:
                self._send_json(400, {"error": "invalid JSON: " + str(e)})
                return None

        def _send_json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads      = True
    allow_reuse_address = True


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="FBA Tracker 局域网协作服务器 v2")
    p.add_argument("--port",    type=int, default=8002,           help="监听端口 (默认 8002)")
    p.add_argument("--host",    default="0.0.0.0",                help="监听地址 (默认 0.0.0.0)")
    p.add_argument("--db",      default="fba-data.db",            help="SQLite 数据库 (默认 ./fba-data.db)")
    p.add_argument("--users",   default="fba-users.json",         help="用户配置文件 (默认 ./fba-users.json)")
    p.add_argument("--migrate", default="fba-data.json",          help="首次启动时从旧 JSON 文件迁移 (默认 ./fba-data.json)")
    args = p.parse_args()

    db_path    = os.path.abspath(args.db)
    users_path = os.path.abspath(args.users)

    db_state = DbState(db_path)
    db_state.import_from_json(os.path.abspath(args.migrate))

    auth_mgr = AuthManager(users_path)
    handler  = make_handler(db_state, auth_mgr)
    server   = ThreadingServer((args.host, args.port), handler)

    ip        = get_lan_ip()
    local_hn  = socket.gethostname()  # e.g. Mac-miniY.local
    if not local_hn.endswith('.local'):
        local_hn = local_hn + '.local'
    bar = "─" * 58
    print(bar)
    print("  FBA Tracker 协作服务器 v2 已启动")
    print(bar)
    print(f"  本机访问：  http://localhost:{args.port}")
    print(f"  固定地址：  http://{local_hn}:{args.port}  ← 换 WiFi 也不变")
    print(f"  当前 IP：   http://{ip}:{args.port}")
    print(f"  数据库：    {db_path}")
    print(f"  用户配置：  {users_path}")
    print(f"  当前版本：  v{db_state.version}  ({db_state.product_count} 个产品)")
    print(bar)
    print("  固定地址（.local）在公司任意 WiFi 下均可访问")
    print("  Ctrl+C 停止服务")
    print(bar)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
