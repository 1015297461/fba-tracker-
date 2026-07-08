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
  6. 首次启动自动从 data/fba-data.json 迁移数据
  7. 首次启动自动创建 data/fba-users.json（默认账号 admin / fba2025）

用法（必须从仓库根目录以 -m 方式执行，backend/ 内部用了包相对导入，
直接 `python3 backend/app.py` 会因为没有包上下文而报 ImportError）：
  python3 -m backend.app                       # 默认 0.0.0.0:8002
  python3 -m backend.app --port 9000
  python3 -m backend.app --db /path/fba.db     # 自定义数据库路径
  python3 -m backend.app --users /path/u.json  # 自定义用户配置

按 Ctrl+C 停止。
"""

import http.server
import json
import os
import socket
import argparse
import socketserver
from urllib.parse import urlparse

from .utils import PROJECT_ROOT
from .db import DbState
from .auth import AuthManager
from .workers.export_worker import ExportWorker
from .workers.ai_analysis_worker import AiAnalysisWorker
from . import pdf_splitter
from .routes import auth_routes, products, rank, scrape, review, exports, pdf, ai_analysis


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


ROUTE_MODULES = (
    auth_routes, products, rank, scrape, review, exports, pdf, ai_analysis,
)


def make_handler(state, auth, ai_worker):
    GET, POST, PUT, DELETE = {}, {}, {}, {}
    for mod in ROUTE_MODULES:
        mod.register(GET, POST, PUT, DELETE, state, auth, ai_worker)

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
            route = GET.get(path)
            if route:
                return route(self)
            return super().do_GET()

        # ---- POST ----

        def do_POST(self):
            path = urlparse(self.path).path
            route = POST.get(path)
            if route:
                return route(self)
            self.send_error(404)

        # ---- DELETE ----

        def do_DELETE(self):
            path = urlparse(self.path).path
            route = DELETE.get(path)
            if route:
                return route(self)
            self.send_error(404)

        # ---- PUT ----

        def do_PUT(self):
            path = urlparse(self.path).path
            route = PUT.get(path)
            if route:
                return route(self)
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

        def _send_file(self, path, download_name=None, inline=False):
            import mimetypes
            from urllib.parse import quote
            try:
                size = os.path.getsize(path)
                ctype, _ = mimetypes.guess_type(path)
                ctype = ctype or "application/octet-stream"
                fname = download_name or os.path.basename(path)
                # RFC 5987：非 ASCII 文件名用 UTF-8 percent-encoding
                ascii_fname = fname.encode("ascii", "replace").decode("ascii")
                encoded_fname = quote(fname, safe="")
                disposition = "inline" if inline else "attachment"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(size))
                self.send_header(
                    "Content-Disposition",
                    f'{disposition}; filename="{ascii_fname}"; filename*=UTF-8\'\'{encoded_fname}',
                )
                self.end_headers()
                with open(path, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except OSError:
                self.send_error(500)

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
    p.add_argument("--db",      default=os.path.join(PROJECT_ROOT, "data", "fba-data.db"),
                   help="SQLite 数据库 (默认 <仓库根>/data/fba-data.db)")
    p.add_argument("--users",   default=os.path.join(PROJECT_ROOT, "data", "fba-users.json"),
                   help="用户配置文件 (默认 <仓库根>/data/fba-users.json)")
    p.add_argument("--migrate", default=os.path.join(PROJECT_ROOT, "data", "fba-data.json"),
                   help="首次启动时从旧 JSON 文件迁移 (默认 <仓库根>/data/fba-data.json)")
    args = p.parse_args()

    db_path    = os.path.abspath(args.db)
    users_path = os.path.abspath(args.users)

    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    os.makedirs(os.path.dirname(users_path), exist_ok=True)

    db_state = DbState(db_path)
    db_state.import_from_json(os.path.abspath(args.migrate))
    pdf_splitter.cleanup_old_tmp()

    auth_mgr = AuthManager(users_path)

    export_worker = ExportWorker(db_state)
    export_worker.start()

    ai_worker = AiAnalysisWorker(db_state)
    ai_worker.start()

    handler  = make_handler(db_state, auth_mgr, ai_worker)
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
    rank.start_scheduler(db_state)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
