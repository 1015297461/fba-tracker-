import json
import os
import sqlite3
import secrets
import threading

from .utils import _now_iso


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
                    sort_order    INTEGER DEFAULT 0,
                    updated_at    TEXT
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id TEXT,
                    user_name  TEXT,
                    action     TEXT,
                    changed_at TEXT DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS trash (
                    id           TEXT PRIMARY KEY,
                    name         TEXT,
                    sku          TEXT,
                    product_json TEXT NOT NULL,
                    deleted_by   TEXT,
                    deleted_at   TEXT
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
                    name         TEXT,
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

                CREATE TABLE IF NOT EXISTS review_tasks (
                    id            TEXT PRIMARY KEY,
                    marketplace   TEXT NOT NULL,
                    asins         TEXT DEFAULT '[]',
                    sort_by       TEXT DEFAULT 'recent',
                    filter_star   TEXT,
                    verified_only INTEGER DEFAULT 0,
                    max_pages     INTEGER DEFAULT 3,
                    total         INTEGER DEFAULT 0,
                    new_count     INTEGER DEFAULT 0,
                    status        TEXT DEFAULT 'completed',
                    created_at    TEXT
                );

                CREATE TABLE IF NOT EXISTS review_results (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id       TEXT NOT NULL,
                    asin          TEXT NOT NULL,
                    marketplace   TEXT,
                    review_id     TEXT NOT NULL,
                    rating        REAL,
                    title         TEXT,
                    author        TEXT,
                    date_raw      TEXT,
                    verified      INTEGER DEFAULT 0,
                    body          TEXT,
                    helpful_count INTEGER,
                    images        TEXT DEFAULT '[]',
                    fetched_at    TEXT,
                    UNIQUE(asin, review_id)
                );
                CREATE INDEX IF NOT EXISTS idx_review_res_asin ON review_results(asin);
                CREATE TABLE IF NOT EXISTS export_jobs (
                    id             TEXT PRIMARY KEY,
                    type           TEXT NOT NULL,
                    label          TEXT,
                    params         TEXT DEFAULT '{}',
                    status         TEXT DEFAULT 'pending',
                    progress_cur   INTEGER DEFAULT 0,
                    progress_total INTEGER DEFAULT 0,
                    error          TEXT,
                    download_id    TEXT,
                    file_name      TEXT,
                    created_at     TEXT,
                    completed_at   TEXT
                );
                CREATE TABLE IF NOT EXISTS ai_analysis_tasks (
                    id           TEXT PRIMARY KEY,
                    skill_id     TEXT NOT NULL,
                    asin         TEXT NOT NULL,
                    username     TEXT,
                    params       TEXT DEFAULT '{}',
                    status       TEXT DEFAULT 'pending',
                    error        TEXT,
                    summary      TEXT,
                    files        TEXT DEFAULT '[]',
                    created_at   TEXT,
                    completed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS sif_tasks (
                    id             TEXT PRIMARY KEY,
                    name           TEXT NOT NULL,
                    direction      TEXT DEFAULT '',
                    mode           TEXT DEFAULT 'root',
                    roots          TEXT DEFAULT '[]',
                    keywords       TEXT DEFAULT '[]',
                    asins          TEXT DEFAULT '[]',
                    country        TEXT DEFAULT 'US',
                    top_n          INTEGER DEFAULT 8,
                    quota_limit    INTEGER DEFAULT 30,
                    schedule_time  TEXT,
                    enabled        INTEGER DEFAULT 1,
                    last_run_at    TEXT,
                    last_status    TEXT DEFAULT 'idle',
                    last_error     TEXT,
                    created_at     TEXT
                );

                CREATE TABLE IF NOT EXISTS sif_snapshots (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id        TEXT NOT NULL,
                    run_date       TEXT NOT NULL,
                    captured_at    TEXT NOT NULL,
                    keyword        TEXT NOT NULL,
                    search_volume  REAL,
                    rank           INTEGER,
                    cpc            REAL,
                    entry_signal   TEXT,
                    demand         TEXT,
                    detail         TEXT,
                    UNIQUE(task_id, run_date, keyword)
                );
                CREATE INDEX IF NOT EXISTS idx_sif_snap_task ON sif_snapshots(task_id, run_date);
            """)
            # 兼容旧版数据库：幂等追加缺失列
            existing_ai_tasks = {row[1] for row in conn.execute("PRAGMA table_info(ai_analysis_tasks)")}
            if "username" not in existing_ai_tasks:
                conn.execute("ALTER TABLE ai_analysis_tasks ADD COLUMN username TEXT")
            existing_products = {row[1] for row in conn.execute("PRAGMA table_info(products)")}
            if "variants" not in existing_products:
                conn.execute("ALTER TABLE products ADD COLUMN variants TEXT DEFAULT '[]'")
            if "sort_order" not in existing_products:
                conn.execute("ALTER TABLE products ADD COLUMN sort_order INTEGER DEFAULT 0")
                # 按旧排序（创建时间倒序）回填，避免升级后顺序突变
                rows = conn.execute("SELECT id FROM products ORDER BY created_at DESC").fetchall()
                conn.executemany(
                    "UPDATE products SET sort_order=? WHERE id=?",
                    [(i, row["id"]) for i, row in enumerate(rows)],
                )
            existing_tasks = {row[1] for row in conn.execute("PRAGMA table_info(keyword_tasks)")}
            if "keyword_notes" not in existing_tasks:
                conn.execute("ALTER TABLE keyword_tasks ADD COLUMN keyword_notes TEXT DEFAULT '{}'")

            existing_scrape = {row[1] for row in conn.execute("PRAGMA table_info(scrape_tasks)")}
            if "name" not in existing_scrape:
                conn.execute("ALTER TABLE scrape_tasks ADD COLUMN name TEXT")

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

    # ---- 回收站 ----

    def list_trash(self):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id, name, sku, product_json, deleted_by, deleted_at "
                "FROM trash ORDER BY deleted_at DESC"
            ).fetchall()
            return [{
                "id":        r["id"],
                "name":      r["name"],
                "sku":       r["sku"],
                "deletedBy": r["deleted_by"],
                "deletedAt": r["deleted_at"],
                "product":   json.loads(r["product_json"] or "{}"),
            } for r in rows]

    def restore_from_trash(self, tid, user=None):
        """把回收站里的产品移回 products；找不到返回 None，否则返回新 version。"""
        with self.lock:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT product_json FROM trash WHERE id=?", [tid]
                ).fetchone()
                if not row:
                    return None
                prod = json.loads(row["product_json"] or "{}")
                max_so = conn.execute("SELECT MAX(sort_order) FROM products").fetchone()[0] or 0
                now = _now_iso()
                conn.execute(
                    """INSERT OR REPLACE INTO products
                       (id, name, sku, category, status, lead, created_at,
                        current_stage, progress, fx_rate, stages, logs, variants, sort_order, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    [
                        prod.get("id"),
                        prod.get("name"),
                        prod.get("sku"),
                        prod.get("category"),
                        prod.get("status"),
                        prod.get("lead"),
                        prod.get("createdAt"),
                        prod.get("currentStage"),
                        prod.get("progress", 0),
                        prod.get("fxRate", 7.20),
                        json.dumps(prod.get("stages",   {}), ensure_ascii=False),
                        json.dumps(prod.get("logs",     []), ensure_ascii=False),
                        json.dumps(prod.get("variants", []), ensure_ascii=False),
                        max_so + 1,
                        now,
                    ],
                )
                conn.execute("DELETE FROM trash WHERE id=?", [tid])
                new_version = self._get_version(conn) + 1
                conn.execute("INSERT OR REPLACE INTO meta VALUES ('version', ?)", [str(new_version)])
                conn.execute(
                    "INSERT INTO audit_log (product_id, user_name, action, changed_at)"
                    " VALUES (?,?,?,?)",
                    ["__batch__", user or "anonymous", f"restore v{new_version}", now],
                )
                conn.commit()
                return new_version

    def purge_from_trash(self, tid, user=None):
        """从回收站彻底删除单个产品，返回新 version。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM trash WHERE id=?", [tid])
                new_version = self._get_version(conn) + 1
                conn.execute("INSERT OR REPLACE INTO meta VALUES ('version', ?)", [str(new_version)])
                now = _now_iso()
                conn.execute(
                    "INSERT INTO audit_log (product_id, user_name, action, changed_at)"
                    " VALUES (?,?,?,?)",
                    ["__batch__", user or "anonymous", f"purge v{new_version}", now],
                )
                conn.commit()
                return new_version

    def empty_trash(self, user=None):
        """清空回收站，返回新 version。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM trash")
                new_version = self._get_version(conn) + 1
                conn.execute("INSERT OR REPLACE INTO meta VALUES ('version', ?)", [str(new_version)])
                now = _now_iso()
                conn.execute(
                    "INSERT INTO audit_log (product_id, user_name, action, changed_at)"
                    " VALUES (?,?,?,?)",
                    ["__batch__", user or "anonymous", f"empty_trash v{new_version}", now],
                )
                conn.commit()
                return new_version

    # ---- 公开接口 ----

    def snapshot(self):
        with self._conn() as conn:
            version  = self._get_version(conn)
            rows     = conn.execute(
                "SELECT * FROM products ORDER BY sort_order ASC"
            ).fetchall()
            return {
                "version":  version,
                "products": [self._row_to_product(r) for r in rows],
                "trash":    self.list_trash(),
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

                for i, p in enumerate(new_products):
                    conn.execute(
                        """INSERT OR REPLACE INTO products
                           (id, name, sku, category, status, lead, created_at,
                            current_stage, progress, fx_rate, stages, logs, variants, sort_order, updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                            i,
                            now,
                        ],
                    )

                # 被删除的产品（不在新列表中）→ 移入回收站，而非真删
                new_ids = {p.get("id") for p in new_products if p.get("id")}
                existing_rows = conn.execute("SELECT * FROM products").fetchall()
                existing_ids = {r["id"] for r in existing_rows}
                removed_ids = existing_ids - new_ids
                for rid in removed_ids:
                    row = next((r for r in existing_rows if r["id"] == rid), None)
                    if not row:
                        continue
                    snap = self._row_to_product(row)
                    conn.execute(
                        """INSERT OR IGNORE INTO trash (id, name, sku, product_json, deleted_by, deleted_at)
                           VALUES (?,?,?,?,?,?)""",
                        [
                            snap["id"], snap["name"], snap["sku"],
                            json.dumps(snap, ensure_ascii=False),
                            user or "anonymous", now,
                        ],
                    )

                # 删除已不在列表中的产品（已从回收站保留快照）
                if new_products:
                    ids = [p.get("id") for p in new_products if p.get("id")]
                    placeholders = ",".join("?" for _ in ids)
                    conn.execute(
                        f"DELETE FROM products WHERE id NOT IN ({placeholders})", ids
                    )
                    # 若某 id 重新出现在 products（恢复走 products PUT 的场景），同步移出回收站
                    conn.execute(
                        f"DELETE FROM trash WHERE id IN ({placeholders})", ids
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
            "name":        row["name"],
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

    def accumulate_scrape_task(self, task_id, success_delta, failed_delta):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE scrape_tasks SET success=success+?, failed=failed+?, status='completed' WHERE id=?",
                    [success_delta, failed_delta, task_id],
                )
                conn.commit()

    def update_scrape_task_name(self, task_id, name):
        with self.lock:
            with self._conn() as conn:
                conn.execute("UPDATE scrape_tasks SET name=? WHERE id=?", [name, task_id])
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

    # ---- 评论采集：任务与评论池 ----

    def _row_to_review_task(self, row):
        return {
            "id":           row["id"],
            "marketplace":  row["marketplace"],
            "asins":        json.loads(row["asins"] or "[]"),
            "sortBy":       row["sort_by"],
            "filterStar":   row["filter_star"],
            "verifiedOnly": bool(row["verified_only"]),
            "maxPages":     row["max_pages"],
            "total":        row["total"],
            "newCount":     row["new_count"],
            "status":       row["status"],
            "createdAt":    row["created_at"],
        }

    def create_review_task(self, marketplace, asins, sort_by, filter_star, verified_only, max_pages):
        tid = "rt" + secrets.token_hex(6)
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO review_tasks
                       (id, marketplace, asins, sort_by, filter_star, verified_only,
                        max_pages, total, new_count, status, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    [
                        tid, marketplace, json.dumps(asins, ensure_ascii=False),
                        sort_by, filter_star, 1 if verified_only else 0,
                        max_pages, len(asins), 0, "running", _now_iso(),
                    ],
                )
                conn.commit()
        return tid

    def accumulate_review_task(self, task_id, batch_asins, new_count_delta):
        """合并本批次的 ASIN 到任务的 asins 列表，累加 new_count，并标记完成。"""
        with self.lock:
            with self._conn() as conn:
                row = conn.execute("SELECT asins FROM review_tasks WHERE id=?", [task_id]).fetchone()
                if not row:
                    return
                existing = json.loads(row["asins"] or "[]")
                merged = list(dict.fromkeys(existing + list(batch_asins)))
                conn.execute(
                    "UPDATE review_tasks SET asins=?, total=?, new_count=new_count+?, status='completed' WHERE id=?",
                    [json.dumps(merged, ensure_ascii=False), len(merged), new_count_delta, task_id],
                )
                conn.commit()

    def list_review_tasks(self, limit=100):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM review_tasks ORDER BY created_at DESC LIMIT ?", [limit]
            ).fetchall()
            return [self._row_to_review_task(r) for r in rows]

    def get_review_task(self, task_id):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM review_tasks WHERE id=?", [task_id]).fetchone()
            return self._row_to_review_task(row) if row else None

    def save_review_results(self, task_id, asin, marketplace, reviews):
        """INSERT OR IGNORE 写入评论池（按 asin+review_id 去重），返回新增条数。"""
        now = _now_iso()
        inserted = 0
        with self.lock:
            with self._conn() as conn:
                for r in reviews:
                    review_id = r.get("review_id")
                    if not review_id:
                        continue
                    cur = conn.execute(
                        """INSERT OR IGNORE INTO review_results
                           (task_id, asin, marketplace, review_id, rating, title, author,
                            date_raw, verified, body, helpful_count, images, fetched_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        [
                            task_id, asin, marketplace, review_id,
                            r.get("rating"), r.get("title"), r.get("author"), r.get("date_raw"),
                            1 if r.get("verified") else 0, r.get("body"), r.get("helpful_count"),
                            json.dumps(r.get("images", []), ensure_ascii=False), now,
                        ],
                    )
                    inserted += cur.rowcount
                conn.commit()
        return inserted

    def _row_to_review_result(self, row):
        return {
            "id":           row["id"],
            "taskId":       row["task_id"],
            "asin":         row["asin"],
            "marketplace":  row["marketplace"],
            "reviewId":     row["review_id"],
            "rating":       row["rating"],
            "title":        row["title"],
            "author":       row["author"],
            "dateRaw":      row["date_raw"],
            "verified":     bool(row["verified"]),
            "body":         row["body"],
            "helpfulCount": row["helpful_count"],
            "images":       json.loads(row["images"] or "[]"),
            "fetchedAt":    row["fetched_at"],
        }

    def get_review_results(self, task_id):
        with self._conn() as conn:
            task_row = conn.execute("SELECT asins FROM review_tasks WHERE id=?", [task_id]).fetchone()
            if not task_row:
                return []
            asins = json.loads(task_row["asins"] or "[]")
            if not asins:
                return []
            placeholders = ",".join("?" for _ in asins)
            rows = conn.execute(
                f"SELECT * FROM review_results WHERE asin IN ({placeholders}) ORDER BY asin, fetched_at DESC",
                asins,
            ).fetchall()
            return [self._row_to_review_result(r) for r in rows]

    def delete_review_task(self, task_id):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM review_tasks WHERE id=?", [task_id])
                conn.commit()

    # ---- 导出任务 ----

    def create_export_job(self, job_type: str, label: str, params: dict, progress_total: int) -> str:
        import secrets
        jid = "ej" + secrets.token_hex(8)
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO export_jobs
                       (id, type, label, params, status, progress_cur, progress_total, created_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    [jid, job_type, label, json.dumps(params, ensure_ascii=False),
                     "pending", 0, progress_total, now]
                )
                conn.commit()
        return jid

    def update_export_job(self, jid: str, **kwargs):
        allowed = {"status", "progress_cur", "progress_total", "error",
                   "download_id", "file_name", "completed_at"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        vals = list(fields.values()) + [jid]
        with self.lock:
            with self._conn() as conn:
                conn.execute(f"UPDATE export_jobs SET {sets} WHERE id=?", vals)
                conn.commit()

    def list_export_jobs(self, limit: int = 100) -> list:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM export_jobs ORDER BY created_at DESC LIMIT ?", [limit]
            ).fetchall()
        return [dict(r) for r in rows]

    def get_pending_export_job(self):
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM export_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
        return dict(row) if row else None

    def delete_export_job(self, jid: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM export_jobs WHERE id=?", [jid])
                conn.commit()

    # ---- AI分析任务 ----

    def create_ai_task(self, skill_id: str, asin: str, username: str, params: dict) -> str:
        tid = "ai" + secrets.token_hex(6)
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO ai_analysis_tasks
                       (id, skill_id, asin, username, params, status, created_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    [tid, skill_id, asin, username, json.dumps(params, ensure_ascii=False),
                     "pending", _now_iso()],
                )
                conn.commit()
        return tid

    def update_ai_task(self, tid: str, **kwargs):
        allowed = {"status", "error", "summary", "files", "completed_at"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        if "files" in fields and not isinstance(fields["files"], str):
            fields["files"] = json.dumps(fields["files"], ensure_ascii=False)
        sets = ", ".join(f"{k}=?" for k in fields)
        vals = list(fields.values()) + [tid]
        with self.lock:
            with self._conn() as conn:
                conn.execute(f"UPDATE ai_analysis_tasks SET {sets} WHERE id=?", vals)
                conn.commit()

    def _row_to_ai_task(self, row):
        d = dict(row)
        d["params"] = json.loads(d.get("params") or "{}")
        d["files"] = json.loads(d.get("files") or "[]")
        return d

    def list_ai_tasks(self, skill_id: str = None, limit: int = 100) -> list:
        with self._conn() as conn:
            if skill_id:
                rows = conn.execute(
                    "SELECT * FROM ai_analysis_tasks WHERE skill_id=? ORDER BY created_at DESC LIMIT ?",
                    [skill_id, limit],
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM ai_analysis_tasks ORDER BY created_at DESC LIMIT ?", [limit]
                ).fetchall()
        return [self._row_to_ai_task(r) for r in rows]

    def get_ai_task(self, tid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM ai_analysis_tasks WHERE id=?", [tid]).fetchone()
        return self._row_to_ai_task(row) if row else None

    def get_pending_ai_task(self):
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM ai_analysis_tasks WHERE status='pending' ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
        return self._row_to_ai_task(row) if row else None

    def delete_ai_task(self, tid: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM ai_analysis_tasks WHERE id=?", [tid])
                conn.commit()

    # ---- SIF 关键词监测：任务与快照 ----

    def create_sif_task(self, t: dict) -> str:
        import secrets
        tid = "sif" + secrets.token_hex(6)
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO sif_tasks
                       (id, name, direction, mode, roots, keywords, asins, country,
                        top_n, quota_limit, schedule_time, enabled, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    [tid,
                     (t.get("name") or "未命名任务").strip() or "未命名任务",
                     t.get("direction") or "",
                     t.get("mode") or "root",
                     json.dumps(t.get("roots") or [], ensure_ascii=False),
                     json.dumps(t.get("keywords") or [], ensure_ascii=False),
                     json.dumps(t.get("asins") or [], ensure_ascii=False),
                     (t.get("country") or "US").upper(),
                     int(t.get("topN") or 8),
                     int(t.get("quotaLimit") or 30),
                     t.get("scheduleTime") or None,
                     1 if t.get("enabled", True) else 0,
                     now])
                conn.commit()
        return tid

    def _row_to_sif_task(self, row):
        return {
            "id":            row["id"],
            "name":          row["name"],
            "direction":     row["direction"] or "",
            "mode":          row["mode"] or "root",
            "roots":         json.loads(row["roots"]     or "[]"),
            "keywords":      json.loads(row["keywords"]  or "[]"),
            "asins":         json.loads(row["asins"]     or "[]"),
            "country":       row["country"] or "US",
            "topN":          row["top_n"] or 8,
            "quotaLimit":    row["quota_limit"] or 30,
            "scheduleTime":  row["schedule_time"],
            "enabled":       bool(row["enabled"]),
            "lastRunAt":     row["last_run_at"],
            "lastStatus":    row["last_status"] or "idle",
            "lastError":     row["last_error"],
            "createdAt":     row["created_at"],
        }

    def list_sif_tasks(self):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM sif_tasks ORDER BY created_at DESC"
            ).fetchall()
        return [self._row_to_sif_task(r) for r in rows]

    def get_sif_task(self, tid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM sif_tasks WHERE id=?", [tid]).fetchone()
        return self._row_to_sif_task(row) if row else None

    def update_sif_task(self, tid: str, t: dict):
        allowed = {
            "name": "name", "direction": "direction", "mode": "mode",
            "country": "country", "schedule_time": "scheduleTime",
            "enabled": "enabled", "top_n": "topN", "quota_limit": "quotaLimit",
        }
        sets = []
        vals = []
        for col, key in allowed.items():
            if key not in t:
                continue
            v = t[key]
            if col in ("roots", "keywords", "asins"):
                v = json.dumps(v or [], ensure_ascii=False)
            elif col == "enabled":
                v = 1 if v else 0
            elif col in ("top_n", "quota_limit"):
                v = int(v or 0)
            elif col == "country":
                v = (v or "US").upper()
            elif col == "schedule_time":
                v = v or None
            sets.append(f"{col}=?")
            vals.append(v)
        if not sets:
            return
        vals.append(tid)
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    f"UPDATE sif_tasks SET {', '.join(sets)} WHERE id=?", vals
                )
                conn.commit()

    def set_sif_task_status(self, tid: str, status: str, error: str = None, run_at: str = None):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE sif_tasks SET last_status=?, last_error=?, last_run_at=? WHERE id=?",
                    [status, error, run_at, tid],
                )
                conn.commit()

    def delete_sif_task(self, tid: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM sif_tasks WHERE id=?", [tid])
                conn.execute("DELETE FROM sif_snapshots WHERE task_id=?", [tid])
                conn.commit()

    def save_sif_snapshots(self, task_id: str, run_date: str, captured_at: str, items: list):
        with self.lock:
            with self._conn() as conn:
                conn.executemany(
                    """INSERT OR REPLACE INTO sif_snapshots
                       (task_id, run_date, captured_at, keyword, search_volume, rank,
                        cpc, entry_signal, demand, detail)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    [
                        (task_id, run_date, captured_at, it.get("keyword", ""),
                         it.get("search_volume"), it.get("rank"),
                         it.get("cpc"), it.get("entry_signal"),
                         json.dumps(it.get("demand", {}), ensure_ascii=False),
                         json.dumps(it.get("detail", {}), ensure_ascii=False))
                        for it in items
                    ],
                )
                conn.commit()

    def list_sif_run_dates(self, task_id: str) -> list:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT DISTINCT run_date FROM sif_snapshots WHERE task_id=? "
                "ORDER BY run_date DESC", [task_id]
            ).fetchall()
        return [r["run_date"] for r in rows]

    def list_sif_snapshots(self, task_id: str, run_date: str = None) -> list:
        with self._conn() as conn:
            if run_date:
                rows = conn.execute(
                    "SELECT * FROM sif_snapshots WHERE task_id=? AND run_date=? "
                    "ORDER BY search_volume DESC", [task_id, run_date]
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM sif_snapshots WHERE task_id=? "
                    "ORDER BY run_date DESC, search_volume DESC", [task_id]
                ).fetchall()
        out = []
        for r in rows:
            out.append({
                "id":           r["id"],
                "runDate":      r["run_date"],
                "capturedAt":   r["captured_at"],
                "keyword":      r["keyword"],
                "searchVolume": r["search_volume"],
                "rank":         r["rank"],
                "cpc":          r["cpc"],
                "entrySignal":  r["entry_signal"],
                "demand":       json.loads(r["demand"] or "{}"),
                "detail":       json.loads(r["detail"] or "{}"),
            })
        return out

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
