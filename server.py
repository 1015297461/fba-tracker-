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
  python3 server.py                       # 默认 0.0.0.0:8002
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
import time
import random
from urllib.parse import urlparse, parse_qs

import rank_fetcher
import product_fetcher


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

                CREATE TABLE IF NOT EXISTS keyword_tasks (
                    id             TEXT PRIMARY KEY,
                    asin           TEXT NOT NULL,
                    marketplace    TEXT NOT NULL,
                    name           TEXT,
                    keywords       TEXT DEFAULT '[]',
                    keyword_notes  TEXT DEFAULT '{}',
                    schedule       TEXT DEFAULT '[0,6,12,18]',
                    enabled        INTEGER DEFAULT 1,
                    created_at     TEXT,
                    last_run_at    TEXT
                );

                CREATE TABLE IF NOT EXISTS rank_snapshots (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id      TEXT,
                    asin         TEXT,
                    marketplace  TEXT,
                    keyword      TEXT,
                    captured_at  TEXT,
                    organic_rank INTEGER,
                    organic_page INTEGER,
                    sponsored    TEXT,
                    status       TEXT,
                    error        TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_snap_task_kw
                    ON rank_snapshots(task_id, keyword, captured_at);

                CREATE TABLE IF NOT EXISTS scrape_tasks (
                    id           TEXT PRIMARY KEY,
                    marketplace  TEXT NOT NULL,
                    total        INTEGER DEFAULT 0,
                    success      INTEGER DEFAULT 0,
                    failed       INTEGER DEFAULT 0,
                    with_reviews INTEGER DEFAULT 0,
                    status       TEXT DEFAULT 'completed',
                    created_at   TEXT
                );

                CREATE TABLE IF NOT EXISTS scrape_products (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id       TEXT NOT NULL,
                    asin          TEXT NOT NULL,
                    marketplace   TEXT,
                    title         TEXT,
                    brand         TEXT,
                    price         TEXT,
                    rating        TEXT,
                    review_count  TEXT,
                    availability  TEXT,
                    bullet_points TEXT,
                    description   TEXT,
                    main_image    TEXT,
                    images        TEXT,
                    aplus_images  TEXT,
                    specifications TEXT,
                    product_details TEXT,
                    categories    TEXT,
                    seller        TEXT,
                    bsr_main_category TEXT,
                    bsr_main_rank     INTEGER,
                    bsr_sub_category  TEXT,
                    bsr_sub_rank      INTEGER,
                    bsr_raw_text      TEXT,
                    customers_say     TEXT,
                    review_images     TEXT,
                    select_to_learn_more TEXT,
                    status        TEXT,
                    error_message TEXT,
                    scraped_at    TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_scrape_prod_task ON scrape_products(task_id);
            """)
            # 兼容旧版数据库：幂等追加缺失列
            existing_products = {row[1] for row in conn.execute("PRAGMA table_info(products)")}
            if "variants" not in existing_products:
                conn.execute("ALTER TABLE products ADD COLUMN variants TEXT DEFAULT '[]'")
            existing_tasks = {row[1] for row in conn.execute("PRAGMA table_info(keyword_tasks)")}
            if "keyword_notes" not in existing_tasks:
                conn.execute("ALTER TABLE keyword_tasks ADD COLUMN keyword_notes TEXT DEFAULT '{}'")

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

    # ---- 关键词排名：任务与快照 ----

    def _row_to_task(self, row):
        return {
            "id":           row["id"],
            "asin":         row["asin"],
            "marketplace":  row["marketplace"],
            "name":         row["name"],
            "keywords":     json.loads(row["keywords"]      or "[]"),
            "keywordNotes": json.loads(row["keyword_notes"] or "{}"),
            "schedule":     json.loads(row["schedule"]      or "[]"),
            "enabled":      bool(row["enabled"]),
            "createdAt":    row["created_at"],
            "lastRunAt":    row["last_run_at"],
        }

    def list_rank_tasks(self):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM keyword_tasks ORDER BY created_at DESC"
            ).fetchall()
            return [self._row_to_task(r) for r in rows]

    def get_rank_task(self, task_id):
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM keyword_tasks WHERE id=?", [task_id]
            ).fetchone()
            return self._row_to_task(row) if row else None

    def upsert_rank_task(self, t):
        tid = t.get("id") or ("kt" + secrets.token_hex(6))
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT created_at, last_run_at FROM keyword_tasks WHERE id=?", [tid]
                ).fetchone()
                created  = row["created_at"]  if row else now
                last_run = row["last_run_at"] if row else None
                conn.execute(
                    """INSERT OR REPLACE INTO keyword_tasks
                       (id, asin, marketplace, name, keywords, keyword_notes,
                        schedule, enabled, created_at, last_run_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    [
                        tid,
                        (t.get("asin") or "").upper().strip(),
                        (t.get("marketplace") or "US").upper(),
                        t.get("name", ""),
                        json.dumps(t.get("keywords", []), ensure_ascii=False),
                        json.dumps(t.get("keywordNotes", {}), ensure_ascii=False),
                        json.dumps(t.get("schedule", [0, 6, 12, 18])),
                        1 if t.get("enabled", True) else 0,
                        created,
                        last_run,
                    ],
                )
                conn.commit()
        return self.get_rank_task(tid)

    def delete_rank_task(self, task_id):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM keyword_tasks WHERE id=?", [task_id])
                conn.execute("DELETE FROM rank_snapshots WHERE task_id=?", [task_id])
                conn.commit()

    def mark_task_run(self, task_id, ts=None):
        with self._conn() as conn:
            conn.execute(
                "UPDATE keyword_tasks SET last_run_at=? WHERE id=?",
                [ts or _now_iso(), task_id],
            )
            conn.commit()

    def add_snapshot(self, task_id, res):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO rank_snapshots
                       (task_id, asin, marketplace, keyword, captured_at,
                        organic_rank, organic_page, sponsored, status, error)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    [
                        task_id, res.get("asin"), res.get("marketplace"),
                        res.get("keyword"), res.get("captured_at"),
                        res.get("organic_rank"), res.get("organic_page"),
                        json.dumps(res.get("sponsored", []), ensure_ascii=False),
                        res.get("status"), res.get("error"),
                    ],
                )
                conn.commit()

    def get_rank_history(self, task_id, keyword=None, limit=3000):
        with self._conn() as conn:
            if keyword:
                rows = conn.execute(
                    """SELECT * FROM rank_snapshots WHERE task_id=? AND keyword=?
                       ORDER BY captured_at ASC LIMIT ?""",
                    [task_id, keyword, limit],
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM rank_snapshots WHERE task_id=?
                       ORDER BY captured_at ASC LIMIT ?""",
                    [task_id, limit],
                ).fetchall()
            return [{
                "id":          r["id"],
                "keyword":     r["keyword"],
                "capturedAt":  r["captured_at"],
                "organicRank": r["organic_rank"],
                "organicPage": r["organic_page"],
                "sponsored":   json.loads(r["sponsored"] or "[]"),
                "status":      r["status"],
                "error":       r["error"],
            } for r in rows]

    # ---- 产品采集：任务与明细 ----

    def _row_to_scrape_task(self, row):
        return {
            "id":          row["id"],
            "marketplace": row["marketplace"],
            "total":       row["total"],
            "success":     row["success"],
            "failed":      row["failed"],
            "withReviews": bool(row["with_reviews"]),
            "status":      row["status"],
            "createdAt":   row["created_at"],
        }

    def create_scrape_task(self, marketplace, total, with_reviews):
        tid = "st" + secrets.token_hex(6)
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO scrape_tasks
                       (id, marketplace, total, success, failed, with_reviews, status, created_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    [tid, marketplace, total, 0, 0, 1 if with_reviews else 0, "running", _now_iso()],
                )
                conn.commit()
        return tid

    def finish_scrape_task(self, task_id, success, failed):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE scrape_tasks SET success=?, failed=?, status='completed' WHERE id=?",
                    [success, failed, task_id],
                )
                conn.commit()

    def list_scrape_tasks(self, limit=100):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM scrape_tasks ORDER BY created_at DESC LIMIT ?", [limit]
            ).fetchall()
            return [self._row_to_scrape_task(r) for r in rows]

    def save_scrape_products(self, task_id, products):
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                for p in products:
                    conn.execute(
                        """INSERT INTO scrape_products
                           (task_id, asin, marketplace, title, brand, price, rating,
                            review_count, availability, bullet_points, description,
                            main_image, images, aplus_images, specifications, product_details,
                            categories, seller, bsr_main_category, bsr_main_rank,
                            bsr_sub_category, bsr_sub_rank, bsr_raw_text, customers_say,
                            review_images, select_to_learn_more, status, error_message, scraped_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        [
                            task_id, p.get("asin"), p.get("marketplace"),
                            p.get("title"), p.get("brand"), p.get("price"), p.get("rating"),
                            p.get("review_count"), p.get("availability"),
                            json.dumps(p.get("bullet_points", []), ensure_ascii=False),
                            p.get("description"),
                            p.get("main_image"),
                            json.dumps(p.get("images", []), ensure_ascii=False),
                            json.dumps(p.get("aplus_images", []), ensure_ascii=False),
                            json.dumps(p.get("specifications", {}), ensure_ascii=False),
                            json.dumps(p.get("product_details", {}), ensure_ascii=False),
                            p.get("categories"), p.get("seller"),
                            p.get("bsr_main_category"), p.get("bsr_main_rank"),
                            p.get("bsr_sub_category"), p.get("bsr_sub_rank"), p.get("bsr_raw_text"),
                            p.get("customers_say"),
                            json.dumps(p.get("review_images", []), ensure_ascii=False),
                            json.dumps(p.get("select_to_learn_more", []), ensure_ascii=False),
                            p.get("status"), p.get("error_message"), now,
                        ],
                    )
                conn.commit()

    def _row_to_scrape_product(self, row):
        return {
            "id":            row["id"],
            "asin":          row["asin"],
            "marketplace":   row["marketplace"],
            "title":         row["title"],
            "brand":         row["brand"],
            "price":         row["price"],
            "rating":        row["rating"],
            "reviewCount":   row["review_count"],
            "availability":  row["availability"],
            "bulletPoints":  json.loads(row["bullet_points"] or "[]"),
            "description":   row["description"],
            "mainImage":     row["main_image"],
            "images":        json.loads(row["images"] or "[]"),
            "aplusImages":   json.loads(row["aplus_images"] or "[]"),
            "specifications": json.loads(row["specifications"] or "{}"),
            "productDetails": json.loads(row["product_details"] or "{}"),
            "categories":    row["categories"],
            "seller":        row["seller"],
            "bestSellerRank": {
                "mainCategory": row["bsr_main_category"],
                "mainRank":     row["bsr_main_rank"],
                "subCategory":  row["bsr_sub_category"],
                "subRank":      row["bsr_sub_rank"],
                "rawText":      row["bsr_raw_text"],
            },
            "customerReviews": {
                "customersSay":     row["customers_say"],
                "reviewImages":     json.loads(row["review_images"] or "[]"),
                "selectToLearnMore": json.loads(row["select_to_learn_more"] or "[]"),
            },
            "status":       row["status"],
            "errorMessage": row["error_message"],
            "scrapedAt":    row["scraped_at"],
        }

    def get_scrape_products(self, task_id):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM scrape_products WHERE task_id=? ORDER BY id ASC", [task_id]
            ).fetchall()
            return [self._row_to_scrape_product(r) for r in rows]

    def delete_scrape_task(self, task_id):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM scrape_tasks WHERE id=?", [task_id])
                conn.execute("DELETE FROM scrape_products WHERE task_id=?", [task_id])
                conn.commit()

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

def run_rank_task(state, task, delay_between_kw=(3.0, 7.0)):
    """串行采集任务下所有关键词，写入快照，返回结果列表。"""
    results = []
    kws = task.get("keywords", [])
    for i, kw in enumerate(kws):
        kw = (kw or "").strip()
        if not kw:
            continue
        try:
            res = rank_fetcher.locate_rank(task["asin"], task["marketplace"], kw, max_pages=3)
        except Exception as e:
            res = {
                "asin": task["asin"], "keyword": kw,
                "marketplace": task["marketplace"], "status": "error",
                "organic_rank": None, "organic_page": None, "sponsored": [],
                "error": f"fetch_exc:{type(e).__name__}", "captured_at": _now_iso(),
            }
        state.add_snapshot(task["id"], res)
        results.append(res)
        if i < len(kws) - 1:
            time.sleep(random.uniform(*delay_between_kw))
    state.mark_task_run(task["id"])
    return results


def run_scrape_task(state, asins, marketplace, with_reviews):
    """批量采集产品详情，落库并返回 (task_id, results)。"""
    asins = [a.strip().upper() for a in asins if a and a.strip()]
    task_id = state.create_scrape_task(marketplace, len(asins), with_reviews)
    try:
        results = product_fetcher.scrape_products(asins, marketplace, with_reviews=with_reviews)
    except Exception as e:
        results = [
            {**product_fetcher._empty_product(a, marketplace, f"fetch_exc:{type(e).__name__}")}
            for a in asins
        ]
    state.save_scrape_products(task_id, results)
    success = sum(1 for r in results if r.get("status") == "success")
    failed = len(results) - success
    state.finish_scrape_task(task_id, success, failed)
    return task_id, results


def start_scheduler(state):
    """后台守护线程：每分钟检查定时档位，命中即采集（同一小时不重复）。"""
    def loop():
        done = set()  # (task_id, 'YYYY-MM-DD-HH')，避免同一小时重复触发
        while True:
            try:
                now  = datetime.datetime.now()
                slot = now.strftime("%Y-%m-%d-%H")
                today = now.strftime("%Y-%m-%d")
                for task in state.list_rank_tasks():
                    if not task["enabled"] or not task["keywords"]:
                        continue
                    hours = {h % 24 for h in task["schedule"]}  # 24:00 视作 0:00
                    if now.hour not in hours:
                        continue
                    key = (task["id"], slot)
                    if key in done:
                        continue
                    done.add(key)
                    print(f"[rank] 定时执行 {task['asin']}/{task['marketplace']} "
                          f"({len(task['keywords'])} 词) @ {slot}")
                    try:
                        run_rank_task(state, task)
                    except Exception as e:
                        print(f"[rank] 任务异常: {e}")
                if len(done) > 800:
                    done = {k for k in done if k[1] >= today}
            except Exception as e:
                print(f"[rank] 调度异常: {e}")
            time.sleep(60)

    th = threading.Thread(target=loop, daemon=True)
    th.start()
    print("[rank] 排名调度线程已启动（每分钟检查 0/6/12/18 档位）")


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

            if path == "/api/rank/tasks":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                self._send_json(200, {"tasks": state.list_rank_tasks()})
                return

            if path == "/api/rank/history":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                q = parse_qs(urlparse(self.path).query)
                task_id = (q.get("taskId") or [""])[0]
                keyword = (q.get("keyword") or [None])[0]
                if not task_id:
                    self._send_json(400, {"error": "taskId required"})
                    return
                self._send_json(200, {
                    "taskId": task_id,
                    "snapshots": state.get_rank_history(task_id, keyword),
                })
                return

            if path == "/api/scrape/tasks":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                self._send_json(200, {"tasks": state.list_scrape_tasks()})
                return

            if path == "/api/scrape/products":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                q = parse_qs(urlparse(self.path).query)
                task_id = (q.get("taskId") or [""])[0]
                if not task_id:
                    self._send_json(400, {"error": "taskId required"})
                    return
                self._send_json(200, {
                    "taskId": task_id,
                    "products": state.get_scrape_products(task_id),
                })
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

            if path == "/api/rank/tasks":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                payload = self._read_json()
                if payload is None:
                    return
                if not (payload.get("asin") or "").strip():
                    self._send_json(400, {"error": "asin required"})
                    return
                self._send_json(200, {"task": state.upsert_rank_task(payload)})
                return

            if path == "/api/rank/run":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                payload = self._read_json()
                if payload is None:
                    return
                task_id = payload.get("taskId")
                task = state.get_rank_task(task_id) if task_id else payload
                if not task or not (task.get("asin") or "").strip():
                    self._send_json(400, {"error": "task not found / asin required"})
                    return
                if not task.get("id"):
                    task = state.upsert_rank_task(task)
                print(f"  [rank] 手动执行 {task['asin']}/{task['marketplace']}")
                results = run_rank_task(state, task)
                self._send_json(200, {"taskId": task["id"], "results": results})
                return

            if path == "/api/scrape/run":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                payload = self._read_json()
                if payload is None:
                    return
                asins = payload.get("asins")
                if not isinstance(asins, list) or not asins:
                    self._send_json(400, {"error": "asins must be a non-empty array"})
                    return
                marketplace = (payload.get("marketplace") or "US").upper()
                if marketplace not in product_fetcher.MARKETPLACES:
                    self._send_json(400, {"error": f"unsupported marketplace: {marketplace}"})
                    return
                with_reviews = bool(payload.get("withReviews", False))
                print(f"  [scrape] 采集 {len(asins)} 个 ASIN @ {marketplace}"
                      f"{' (含评论)' if with_reviews else ''}")
                task_id, results = run_scrape_task(state, asins, marketplace, with_reviews)
                self._send_json(200, {"taskId": task_id, "results": results})
                return

            self.send_error(404)

        # ---- DELETE ----

        def do_DELETE(self):
            path = urlparse(self.path).path
            if path == "/api/rank/tasks":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                q = parse_qs(urlparse(self.path).query)
                task_id = (q.get("id") or [""])[0]
                if not task_id:
                    self._send_json(400, {"error": "id required"})
                    return
                state.delete_rank_task(task_id)
                self._send_json(200, {"ok": True})
                return

            if path == "/api/rank/keyword":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                q = parse_qs(urlparse(self.path).query)
                task_id = (q.get("taskId") or [""])[0]
                keyword = (q.get("keyword") or [""])[0]
                if not task_id or not keyword:
                    self._send_json(400, {"error": "taskId and keyword required"})
                    return
                task = state.get_rank_task(task_id)
                if task:
                    new_kws = [k for k in task["keywords"] if k != keyword]
                    new_notes = {k: v for k, v in task["keywordNotes"].items() if k != keyword}
                    state.upsert_rank_task({**task, "keywords": new_kws, "keywordNotes": new_notes})
                    with state.lock:
                        with state._conn() as conn:
                            conn.execute(
                                "DELETE FROM rank_snapshots WHERE task_id=? AND keyword=?",
                                [task_id, keyword]
                            )
                            conn.commit()
                self._send_json(200, {"ok": True})
                return

            if path == "/api/scrape/tasks":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                q = parse_qs(urlparse(self.path).query)
                task_id = (q.get("id") or [""])[0]
                if not task_id:
                    self._send_json(400, {"error": "id required"})
                    return
                state.delete_scrape_task(task_id)
                self._send_json(200, {"ok": True})
                return

            if path == "/api/scrape/reset-session":
                if not auth.verify(_extract_token(self)):
                    self._send_json(401, {"error": "请先登录"})
                    return
                payload = self._read_json()
                if payload is None:
                    return
                marketplace = (payload.get("marketplace") or "").upper()
                product_fetcher.reset_session(marketplace if marketplace else None)
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
    start_scheduler(db_state)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
