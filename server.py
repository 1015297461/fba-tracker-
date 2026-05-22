#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FBA Tracker — 局域网协作服务器
============================================
功能：
  1. 提供静态文件服务（替代 python3 -m http.server）
  2. 提供 /api/products GET/PUT 接口，把所有产品状态写入本地 JSON 文件
  3. 前端会自动检测此接口，启用云端同步模式（4 秒轮询 + 600ms 防抖写入）
  4. 多人同时编辑：基于版本号的乐观锁，冲突时以服务器端为准（自动合并）

用法：
  python3 server.py                     # 默认 0.0.0.0:8000
  python3 server.py --port 9000         # 自定义端口
  python3 server.py --data /path/data.json   # 自定义数据文件

启动后会打印局域网 IP，同事在浏览器访问 http://<你的IP>:8000 即可。
按 Ctrl+C 停止。
"""

import http.server
import json
import os
import socket
import argparse
import threading
import socketserver
from urllib.parse import urlparse


def get_lan_ip():
    """探测本机的局域网 IP（用于打印访问地址）"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class SyncState:
    """单文件 JSON 状态 + 版本号 + 读写锁"""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.version = 0
        self.products = []
        self._load()

    def _load(self):
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                obj = json.load(f)
            if isinstance(obj, dict):
                self.version = int(obj.get("version", 0))
                self.products = obj.get("products", [])
            elif isinstance(obj, list):
                self.products = obj
        except Exception as e:
            print(f"[warn] 读取 {self.path} 失败: {e}")

    def _persist(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(
                {"version": self.version, "products": self.products, "updatedAt": _now_iso()},
                f,
                ensure_ascii=False,
                indent=2,
            )
        os.replace(tmp, self.path)

    def snapshot(self):
        with self.lock:
            return {"version": self.version, "products": self.products}

    def write(self, new_products, base_version):
        """
        Optimistic concurrency: 只有当 base_version 等于当前 version 时才接受写入。
        否则返回 (None, current_snapshot) 表示冲突。
        """
        with self.lock:
            if base_version is not None and int(base_version) != self.version:
                return None, {"version": self.version, "products": self.products}
            self.version += 1
            self.products = new_products
            try:
                self._persist()
            except Exception as e:
                print(f"[error] 写入 {self.path} 失败: {e}")
            return self.version, None


def _now_iso():
    import datetime
    return datetime.datetime.now().isoformat(timespec="seconds")


def make_handler(state):
    class Handler(http.server.SimpleHTTPRequestHandler):
        # ---- 静态文件：禁用缓存，让 .jsx 改动立刻生效 ----
        def end_headers(self):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            super().end_headers()

        def log_message(self, fmt, *args):
            # 简化日志
            if "/api/products" in args[0] if args else False:
                return
            print(f"  {self.address_string()} - {args[0] if args else ''}")

        # ---- API: GET /api/products ----
        def do_GET(self):
            if urlparse(self.path).path == "/api/products":
                body = json.dumps(state.snapshot(), ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()

        # ---- API: PUT /api/products  body: {products, baseVersion} ----
        def do_PUT(self):
            if urlparse(self.path).path == "/api/products":
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length).decode("utf-8")
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError as e:
                    self._send_json(400, {"error": "invalid JSON: " + str(e)})
                    return
                new_products = payload.get("products")
                base_version = payload.get("baseVersion")
                if not isinstance(new_products, list):
                    self._send_json(400, {"error": "products must be an array"})
                    return
                new_version, conflict = state.write(new_products, base_version)
                if conflict is not None:
                    self._send_json(409, conflict)
                else:
                    self._send_json(200, {"version": new_version})
                return
            self.send_error(405, "PUT not allowed here")

        def _send_json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    p = argparse.ArgumentParser(description="FBA Tracker 局域网协作服务器")
    p.add_argument("--port", type=int, default=8000, help="监听端口 (默认 8000)")
    p.add_argument("--host", default="0.0.0.0", help="监听地址 (默认 0.0.0.0 = 所有网卡)")
    p.add_argument("--data", default="fba-data.json", help="数据文件路径 (默认 ./fba-data.json)")
    args = p.parse_args()

    state = SyncState(os.path.abspath(args.data))
    handler = make_handler(state)
    server = ThreadingServer((args.host, args.port), handler)

    ip = get_lan_ip()
    bar = "─" * 56
    print(bar)
    print("  FBA Tracker 协作服务器已启动")
    print(bar)
    print(f"  本机访问：  http://localhost:{args.port}")
    print(f"  局域网访问：http://{ip}:{args.port}")
    print(f"  数据文件：  {state.path}")
    print(f"  当前版本：  v{state.version}  ({len(state.products)} 个产品)")
    print(bar)
    print("  把上面的局域网地址发给同事即可共同编辑")
    print("  Ctrl+C 停止服务")
    print(bar)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
