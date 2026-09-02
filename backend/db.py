import datetime
import json
import os
import sqlite3
import secrets
import threading

from .utils import _now_iso

# SIF 任务失败退避策略：第 n 次失败后等待对应分钟数再重试；当天失败次数达到
# 上限即熔断（次日计划时刻自动重置）。目的是让「每天最多浪费 3 次配额」，
# 而不是像早期版本那样每分钟重试一整天（单次 daily 层约 25 次 SIF 调用）。
SIF_RETRY_BACKOFF_MIN = (5, 30, 120)
SIF_MAX_RETRIES_PER_DAY = len(SIF_RETRY_BACKOFF_MIN) + 1


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

                -- ===== SIF 爆品关键词监控 v2 =====

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
                    asin_limit     INTEGER DEFAULT 20,
                    backfill_days  INTEGER DEFAULT 90,
                    auto_asin      INTEGER DEFAULT 1,
                    freq_type      TEXT DEFAULT 'daily',
                    every_n_days   INTEGER DEFAULT 2,
                    schedule_weekday INTEGER DEFAULT 1,
                    schedule_time  TEXT,
                    enabled        INTEGER DEFAULT 1,
                    last_run_at    TEXT,
                    last_daily_at  TEXT,
                    last_weekly_at TEXT,
                    last_status    TEXT DEFAULT 'idle',
                    last_error     TEXT,
                    fail_count     INTEGER DEFAULT 0,
                    fail_date      TEXT,
                    next_retry_at  TEXT,
                    created_at     TEXT
                );

                -- 关键词每日快照：只存当日数据点（不冗余历史），逐日累积出日粒度序列
                CREATE TABLE IF NOT EXISTS sif_kw_snapshots (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id        TEXT NOT NULL,
                    run_date       TEXT NOT NULL,
                    captured_at    TEXT NOT NULL,
                    keyword        TEXT NOT NULL,
                    search_volume  REAL,
                    rank           INTEGER,
                    cpc            REAL,
                    cvr            REAL,
                    click_share    REAL,
                    traffic_cost   REAL,
                    entry_signal   TEXT,
                    top_asins      TEXT DEFAULT '[]',
                    root           TEXT,
                    data_period    TEXT,
                    is_new_entry   INTEGER DEFAULT 0,
                    UNIQUE(task_id, run_date, keyword)
                );
                CREATE INDEX IF NOT EXISTS idx_sif_kw_snap ON sif_kw_snapshots(task_id, run_date);
                CREATE INDEX IF NOT EXISTS idx_sif_kw_word ON sif_kw_snapshots(task_id, keyword, run_date);

                -- ASIN 监控池（机会词 Top3 点击 ASIN + 词根头部竞品 + 手动添加）
                CREATE TABLE IF NOT EXISTS sif_asins (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id        TEXT NOT NULL,
                    asin           TEXT NOT NULL,
                    title          TEXT,
                    brand          TEXT,
                    img            TEXT,
                    url            TEXT,
                    price          REAL,
                    star           REAL,
                    rating_num     INTEGER,
                    category       TEXT,
                    weight_oz      REAL,
                    dims_in        TEXT DEFAULT '{}',
                    first_available_day TEXT,
                    variation_num  INTEGER,
                    source         TEXT DEFAULT 'manual',
                    source_ref     TEXT,
                    added_at       TEXT,
                    last_stat_date TEXT,
                    active         INTEGER DEFAULT 1,
                    UNIQUE(task_id, asin)
                );

                -- ASIN 真日粒度数据（ops_get_asin_traffic_trend granularity=day）
                CREATE TABLE IF NOT EXISTS sif_asin_snapshots (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id        TEXT NOT NULL,
                    asin           TEXT NOT NULL,
                    stat_date      TEXT NOT NULL,
                    price          REAL,
                    bsr            INTEGER,
                    bought_month   INTEGER,
                    review_num     INTEGER,
                    star           REAL,
                    seller_num     INTEGER,
                    total_score    REAL,
                    nf_score       REAL,
                    ad_score       REAL,
                    sp_score       REAL,
                    sb_score       REAL,
                    sbv_score      REAL,
                    promotion      TEXT,
                    coupon         TEXT,
                    captured_at    TEXT,
                    UNIQUE(task_id, asin, stat_date)
                );
                CREATE INDEX IF NOT EXISTS idx_sif_asin_stat ON sif_asin_snapshots(task_id, asin, stat_date);

                -- 关键词需求画像（每周层，按 ISO 周覆盖）
                CREATE TABLE IF NOT EXISTS sif_kw_profiles (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id        TEXT NOT NULL,
                    keyword        TEXT NOT NULL,
                    iso_week       TEXT NOT NULL,
                    profile        TEXT DEFAULT '{}',
                    captured_at    TEXT,
                    UNIQUE(task_id, keyword, iso_week)
                );

                -- 词根头部竞品概览（每周层）
                CREATE TABLE IF NOT EXISTS sif_asin_weekly (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id        TEXT NOT NULL,
                    root           TEXT NOT NULL,
                    iso_week       TEXT NOT NULL,
                    competitors    TEXT DEFAULT '[]',
                    captured_at    TEXT,
                    UNIQUE(task_id, root, iso_week)
                );

                -- 信号引擎产出（阈值在设置页可配）
                CREATE TABLE IF NOT EXISTS sif_signals (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    date           TEXT NOT NULL,
                    created_at     TEXT,
                    task_id        TEXT,
                    direction      TEXT,
                    kind           TEXT NOT NULL,
                    severity       TEXT DEFAULT 'info',
                    ref_type       TEXT NOT NULL,
                    ref_id         TEXT NOT NULL,
                    title          TEXT,
                    detail         TEXT DEFAULT '{}',
                    ack            INTEGER DEFAULT 0,
                    UNIQUE(date, task_id, kind, ref_type, ref_id)
                );
                CREATE INDEX IF NOT EXISTS idx_sif_sig_date ON sif_signals(date DESC);

                -- 运行日志（记录每次运行的调用数与统计，成本透明）
                CREATE TABLE IF NOT EXISTS sif_runs (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id        TEXT NOT NULL,
                    run_date       TEXT NOT NULL,
                    tier           TEXT NOT NULL,
                    started_at     TEXT,
                    finished_at    TEXT,
                    status         TEXT DEFAULT 'done',
                    stats          TEXT DEFAULT '{}',
                    error          TEXT
                );

                -- 全局设置（信号阈值 + 默认配额）
                CREATE TABLE IF NOT EXISTS sif_settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
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

            # SIF v1 → v2：旧版结构（单表快照 + detail 冗余存 60 周历史）与新「爆品关键词
            # 监控」不兼容，按确认「旧架构与历史数据全部丢弃」直接重建为 v2。
            existing_sif = {row[1] for row in conn.execute("PRAGMA table_info(sif_tasks)")}
            if existing_sif and "freq_type" not in existing_sif:
                conn.execute("DROP TABLE IF EXISTS sif_snapshots")
                conn.execute("DROP INDEX IF EXISTS idx_sif_snap_task")
                conn.execute("DROP TABLE IF EXISTS sif_tasks")
                conn.execute("""
                    CREATE TABLE sif_tasks (
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
                        asin_limit     INTEGER DEFAULT 20,
                        backfill_days  INTEGER DEFAULT 90,
                        auto_asin      INTEGER DEFAULT 1,
                        freq_type      TEXT DEFAULT 'daily',
                        every_n_days   INTEGER DEFAULT 2,
                        schedule_weekday INTEGER DEFAULT 1,
                        schedule_time  TEXT,
                        enabled        INTEGER DEFAULT 1,
                        last_run_at    TEXT,
                        last_daily_at  TEXT,
                        last_weekly_at TEXT,
                        last_status    TEXT DEFAULT 'idle',
                        last_error     TEXT,
                        created_at     TEXT
                    )
                """)
                conn.commit()
                print("[info] SIF 模块已迁移到 v2（爆品关键词监控），旧任务与快照数据已清空")

            # SIF v2.1：失败退避 / 熔断字段。新表已含这三列，这里只为老库补列，
            # 所以重建之后重新读一次列信息，避免重复 ADD COLUMN。
            _sif_cols = {r[1] for r in conn.execute("PRAGMA table_info(sif_tasks)")}
            for col, ddl in (("fail_count", "INTEGER DEFAULT 0"),
                             ("fail_date", "TEXT"),
                             ("next_retry_at", "TEXT")):
                if col not in _sif_cols:
                    conn.execute(f"ALTER TABLE sif_tasks ADD COLUMN {col} {ddl}")

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

    # ---- SIF 爆品关键词监控 v2：设置 ----

    SIF_DEFAULT_SETTINGS = {
        # 信号阈值（前端设置页可改，单位：%）
        "thresholds": {
            "kw_dod_pct":        20,   # 关键词搜索量日环比 ±%
            "kw_wow_pct":        30,   # 关键词搜索量 7 日环比 ±%
            "kw_rank_jump_pct":  20,   # ABA 排名改善幅度阈值（数值变小 = 变好）
            "kw_new_entry":       1,   # 1=提示新入榜机会词，0=关闭
            "asin_bsr_jump_pct": 30,   # BSR 单日跃升（排名数值变小 = 变好）
            "asin_price_drop_pct": 10, # 价格降幅（内卷/清仓预警）
            "asin_sales_wow_pct": 50,  # 近30天销量 7 日增速
            "asin_review_wow_pct": 25,  # 评论数 7 日增速（起量佐证）
            "new_product_days":  180,   # 新品黑马：上架天数上限
            "new_product_sales": 500,   # 新品黑马：近30天销量下限
            "nf_share_drop_pct": 20,   # 自然流量占比骤降（转广告依赖）
            "min_search_volume": 500,   # 关键词最小搜索量过滤（降噪）
        },
        # 新建任务的默认配额
        "defaults": {
            "topN":        8,
            "quotaLimit":  30,
            "asinLimit":   20,
            "backfillDays": 90,
            "keepDays":    365,
            "country":     "US",
        },
    }

    def get_sif_settings(self) -> dict:
        """读取全局设置（信号阈值 + 默认配额），缺失项用内置默认补齐。"""
        import copy
        out = copy.deepcopy(self.SIF_DEFAULT_SETTINGS)
        with self._conn() as conn:
            rows = conn.execute("SELECT key, value FROM sif_settings").fetchall()
        stored = {r["key"]: r["value"] for r in rows}
        for section in ("thresholds", "defaults"):
            raw = stored.get(section)
            if not raw:
                continue
            try:
                val = json.loads(raw)
            except Exception:
                continue
            if isinstance(val, dict):
                for k, v in val.items():
                    if k in out[section]:
                        out[section][k] = v
        return out

    def save_sif_settings(self, section: str, values: dict) -> dict:
        """保存某一节设置（thresholds / defaults），未知键忽略。"""
        if section not in ("thresholds", "defaults"):
            return self.get_sif_settings()
        cur = self.get_sif_settings()
        allowed = cur.get(section, {})
        merged = dict(allowed)
        for k, v in (values or {}).items():
            if k not in allowed:
                continue
            try:
                merged[k] = float(v) if isinstance(v, str) and "." in v else (
                    int(v) if isinstance(allowed[k], int) and not isinstance(allowed[k], bool)
                    else float(v))
            except Exception:
                continue
        cur[section] = merged
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO sif_settings(key, value) VALUES (?,?)",
                    [section, json.dumps(merged, ensure_ascii=False)])
                conn.commit()
        return self.get_sif_settings()

    # ---- SIF v2：任务 CRUD ----

    def create_sif_task(self, t: dict) -> str:
        import secrets
        tid = "sif" + secrets.token_hex(6)
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO sif_tasks
                       (id, name, direction, mode, roots, keywords, asins, country,
                        top_n, quota_limit, asin_limit, backfill_days, auto_asin,
                        freq_type, every_n_days, schedule_weekday, schedule_time,
                        enabled, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                     int(t.get("asinLimit") or 20),
                     int(t.get("backfillDays") or 90),
                     1 if t.get("autoAsin", True) else 0,
                     t.get("freqType") or "daily",
                     int(t.get("everyNDays") or 2),
                     int(t.get("scheduleWeekday") or 1),
                     t.get("scheduleTime") or None,
                     1 if t.get("enabled", True) else 0,
                     now])
                conn.commit()
        return tid

    def _row_to_sif_task(self, row):
        fail_count = int(row["fail_count"] or 0)
        fail_date = (row["fail_date"] or "")[:10]
        return {
            "id":              row["id"],
            "name":            row["name"],
            "direction":       row["direction"] or "",
            "mode":            row["mode"] or "root",
            "roots":           json.loads(row["roots"] or "[]"),
            "keywords":        json.loads(row["keywords"] or "[]"),
            "asins":           json.loads(row["asins"] or "[]"),
            "country":         row["country"] or "US",
            "topN":            row["top_n"] or 8,
            "quotaLimit":      row["quota_limit"] or 30,
            "asinLimit":       row["asin_limit"] or 20,
            "backfillDays":    row["backfill_days"] or 90,
            "autoAsin":        bool(row["auto_asin"]),
            "freqType":        row["freq_type"] or "daily",
            "everyNDays":      row["every_n_days"] or 2,
            "scheduleWeekday": row["schedule_weekday"] or 1,
            "scheduleTime":    row["schedule_time"],
            "enabled":         bool(row["enabled"]),
            "lastRunAt":       row["last_run_at"],
            "lastDailyAt":     row["last_daily_at"],
            "lastWeeklyAt":    row["last_weekly_at"],
            "lastStatus":      row["last_status"] or "idle",
            "lastError":       row["last_error"],
            "createdAt":       row["created_at"],
            "failCount":       fail_count,
            "failDate":        row["fail_date"],
            "nextRetryAt":     row["next_retry_at"],
            # 当天失败次数已达上限即熔断：调度器当天不再触发，次日计划时刻自动恢复
            "tripped":         bool(fail_date) and fail_date == _now_iso()[:10]
                               and fail_count >= SIF_MAX_RETRIES_PER_DAY,
        }

    def list_sif_tasks(self):
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM sif_tasks ORDER BY created_at DESC").fetchall()
        return [self._row_to_sif_task(r) for r in rows]

    def get_sif_task(self, tid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM sif_tasks WHERE id=?", [tid]).fetchone()
        return self._row_to_sif_task(row) if row else None

    def update_sif_task(self, tid: str, t: dict):
        allowed = {
            "name": "name", "direction": "direction", "mode": "mode",
            "country": "country", "schedule_time": "scheduleTime",
            "schedule_weekday": "scheduleWeekday", "freq_type": "freqType",
            "enabled": "enabled", "top_n": "topN", "quota_limit": "quotaLimit",
            "asin_limit": "asinLimit", "backfill_days": "backfillDays",
            "auto_asin": "autoAsin", "every_n_days": "everyNDays",
            "roots": "roots", "keywords": "keywords", "asins": "asins",
        }
        json_cols = ("roots", "keywords", "asins")
        int_cols = ("top_n", "quota_limit", "schedule_weekday", "asin_limit",
                    "backfill_days", "every_n_days")
        sets, vals = [], []
        for col, key in allowed.items():
            if key not in t:
                continue
            v = t[key]
            if col in json_cols:
                v = json.dumps(v or [], ensure_ascii=False)
            elif col in ("enabled", "auto_asin"):
                v = 1 if v else 0
            elif col in int_cols:
                v = int(v or 0)
            elif col == "country":
                v = (v or "US").upper()
            elif col == "schedule_time":
                v = v or None
            elif col == "freq_type" and v not in ("daily", "every_n", "weekly"):
                continue
            sets.append(f"{col}=?")
            vals.append(v)
        if t.get("enabled"):
            # 手动重新启用视为人工确认问题已解决：清掉退避与熔断状态，立刻恢复调度
            sets.extend(["fail_count=0", "fail_date=NULL", "next_retry_at=NULL"])
        if not sets:
            return
        vals.append(tid)
        with self.lock:
            with self._conn() as conn:
                conn.execute(f"UPDATE sif_tasks SET {', '.join(sets)} WHERE id=?", vals)
                conn.commit()

    def set_sif_task_status(self, tid: str, status: str, error: str = None,
                            run_at: str = None, daily_at: str = None, weekly_at: str = None):
        """更新任务运行状态。

        done / partial 视为本轮跑完，同时清零失败退避计数（计数只在
        mark_sif_task_failed 里累加）——成功一次即复位，退避不会跨天残留。
        """
        ok = 1 if status in ("done", "partial") else 0
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE sif_tasks SET last_status=?, last_error=?, last_run_at=?, "
                    "last_daily_at=COALESCE(?, last_daily_at), "
                    "last_weekly_at=COALESCE(?, last_weekly_at), "
                    "fail_count=CASE WHEN ? THEN 0 ELSE fail_count END, "
                    "fail_date=CASE WHEN ? THEN NULL ELSE fail_date END, "
                    "next_retry_at=CASE WHEN ? THEN NULL ELSE next_retry_at END "
                    "WHERE id=?",
                    [status, error, run_at, daily_at, weekly_at, ok, ok, ok, tid])
                conn.commit()

    def mark_sif_task_failed(self, tid: str, error: str, now: str = None,
                             max_retries: int = SIF_MAX_RETRIES_PER_DAY) -> dict:
        """记录一次硬失败：累计当日失败次数，按指数退避排下一次重试。

        返回 {"failCount": n, "nextRetryAt": iso 或 None, "tripped": bool}。
        · 未到上限 → next_retry_at = 现在 + 退避分钟，当天稍后重试一次；
        · 达到上限 → tripped=True 且 next_retry_at=NULL，调度器当天不再触发，
          次日计划时刻到来时因 fail_date != today 自动重置。

        这里刻意不推进 last_daily_at：失败的运行不该消耗掉当天唯一的跑位。
        「今天已跑过」的判定改由 next_retry_at 闸门承担，否则下一分钟仍会被
        判定命中，形成每分钟重试一整天的死循环。
        """
        now = now or _now_iso()
        today = now[:10]
        with self.lock:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT fail_count, fail_date FROM sif_tasks WHERE id=?", [tid]).fetchone()
                prev_n = int(row["fail_count"] or 0) if row else 0
                prev_d = (row["fail_date"] or "")[:10] if row else ""
                # 封顶到上限：熔断后即使再有失败也停在 max_retries，计数不无限膨胀
                n = min(prev_n + 1 if prev_d == today else 1, max_retries)
                tripped = n >= max_retries
                nxt = None
                if not tripped:
                    mins = SIF_RETRY_BACKOFF_MIN[min(n, len(SIF_RETRY_BACKOFF_MIN)) - 1]
                    try:
                        base = datetime.datetime.fromisoformat(now[:19])
                    except Exception:
                        base = datetime.datetime.now()
                    nxt = (base + datetime.timedelta(minutes=mins)).strftime("%Y-%m-%dT%H:%M")
                conn.execute(
                    "UPDATE sif_tasks SET last_status=?, last_error=?, last_run_at=?, "
                    "fail_count=?, fail_date=?, next_retry_at=? WHERE id=?",
                    ["error", (error or "")[:500], now, n, today, nxt, tid])
                conn.commit()
        return {"failCount": n, "nextRetryAt": nxt, "tripped": tripped}

    def delete_sif_task(self, tid: str):
        """删除任务并连带清理其全部监控数据。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM sif_tasks WHERE id=?", [tid])
                for table in ("sif_kw_snapshots", "sif_asins", "sif_asin_snapshots",
                              "sif_kw_profiles", "sif_asin_weekly", "sif_signals", "sif_runs"):
                    conn.execute(f"DELETE FROM {table} WHERE task_id=?", [tid])
                conn.commit()

    # ---- SIF v2：关键词每日快照 ----

    def save_kw_snapshots(self, task_id: str, run_date: str, captured_at: str, items: list) -> int:
        """写入当日快照（同日重跑按词覆盖更新，但做 carry-forward）。

        screen 接口不返回 ABA 排名 —— 排名由每周层的 keyword_history 回填。
        INSERT OR REPLACE 会整行覆盖，所以这里先把已有行的 rank/click_share 等
        回填字段与首次入库时间、入榜标记带过来，避免同日第二次运行把它们冲成 NULL。
        is_new_entry：该词在库里（含本日之前的运行）从未出现过才标 1。
        """
        if not items:
            return 0
        with self.lock:
            with self._conn() as conn:
                known = {r["keyword"] for r in conn.execute(
                    "SELECT DISTINCT keyword FROM sif_kw_snapshots WHERE task_id=?", [task_id])}
                today = {r["keyword"]: r for r in conn.execute(
                    "SELECT * FROM sif_kw_snapshots WHERE task_id=? AND run_date=?",
                    [task_id, run_date]).fetchall()}
                rows = []
                for it in items:
                    kw = it.get("keyword") or ""
                    if not kw:
                        continue
                    # 逐词合并：新值优先，缺失字段沿用当日已有行
                    old = today.get(kw)
                    rank = _as_int(it.get("rank"))
                    if rank is None and old is not None:
                        rank = old["rank"]
                    click_share = it.get("click_share")
                    if click_share is None and old is not None:
                        click_share = old["click_share"]
                    traffic_cost = it.get("traffic_cost")
                    if traffic_cost is None and old is not None:
                        traffic_cost = old["traffic_cost"]
                    cvr = it.get("cvr")
                    if cvr is None and old is not None:
                        cvr = old["cvr"]
                    cpc = it.get("cpc")
                    if cpc is None and old is not None:
                        cpc = old["cpc"]
                    entry_signal = it.get("entry_signal") or (old["entry_signal"] if old is not None else "")
                    top_asins = it.get("top_asins")
                    if not top_asins and old is not None:
                        top_asins = json.loads(old["top_asins"] or "[]")
                    # 同日重跑不改变当天的"新入榜"判定：known 里含今天早前那次运行插入的行，
                    # 若直接用它会把标记冲成 0，导致新入榜信号只在第一次运行那天出现。
                    if old is not None:
                        new_entry = old["is_new_entry"]
                    else:
                        new_entry = 0 if kw in known else 1
                    rows.append((
                        task_id, run_date,
                        old["captured_at"] if old is not None else captured_at,
                        kw, it.get("search_volume"), rank, cpc, cvr, click_share, traffic_cost,
                        entry_signal or "", json.dumps(top_asins or [], ensure_ascii=False),
                        it.get("root") or (old["root"] if old is not None else None),
                        it.get("data_period") or (old["data_period"] if old is not None else None),
                        new_entry,
                    ))
                if not rows:
                    return 0
                conn.executemany(
                    """INSERT OR REPLACE INTO sif_kw_snapshots
                       (task_id, run_date, captured_at, keyword, search_volume, rank, cpc, cvr,
                        click_share, traffic_cost, entry_signal, top_asins, root, data_period, is_new_entry)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
                conn.commit()
        return len(rows)

    def list_kw_snapshots(self, task_id: str, run_date: str = None) -> list:
        with self._conn() as conn:
            if run_date:
                rows = conn.execute(
                    "SELECT * FROM sif_kw_snapshots WHERE task_id=? AND run_date=? "
                    "ORDER BY search_volume DESC", [task_id, run_date]).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM sif_kw_snapshots WHERE task_id=? "
                    "ORDER BY run_date DESC, search_volume DESC", [task_id]).fetchall()
        return [self._row_to_kw_snapshot(r) for r in rows]

    def _row_to_kw_snapshot(self, row):
        return {
            "id":           row["id"],
            "runDate":      row["run_date"],
            "capturedAt":   row["captured_at"],
            "keyword":      row["keyword"],
            "searchVolume": row["search_volume"],
            "rank":         row["rank"],
            "cpc":          row["cpc"],
            "cvr":          row["cvr"],
            "clickShare":   row["click_share"],
            "trafficCost":  row["traffic_cost"],
            "entrySignal":  row["entry_signal"] or "",
            "topAsins":     json.loads(row["top_asins"] or "[]"),
            "root":         row["root"],
            "dataPeriod":   row["data_period"],
            "isNewEntry":   bool(row["is_new_entry"]),
        }

    def kw_dates(self, task_id: str, limit: int = 400) -> list:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT DISTINCT run_date FROM sif_kw_snapshots WHERE task_id=? "
                "ORDER BY run_date DESC LIMIT ?", [task_id, int(limit)]).fetchall()
        return [r["run_date"] for r in rows]

    def kw_series(self, task_id: str, keyword: str, days: int = 90) -> list:
        """某关键词的自建日序列（按日期升序）。"""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM (SELECT * FROM sif_kw_snapshots WHERE task_id=? AND keyword=? "
                "ORDER BY run_date DESC LIMIT ?) ORDER BY run_date ASC",
                [task_id, keyword, int(days)]).fetchall()
        return [self._row_to_kw_snapshot(r) for r in rows]

    def kw_universe(self, task_id: str) -> list:
        """任务监控过的全部关键词（按最新搜索量降序）。"""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT keyword, MAX(run_date) AS last_date, MAX(COALESCE(search_volume,0)) AS sv "
                "FROM sif_kw_snapshots WHERE task_id=? GROUP BY keyword ORDER BY sv DESC",
                [task_id]).fetchall()
        return [{"keyword": r["keyword"], "lastDate": r["last_date"], "peakVolume": r["sv"]}
                for r in rows]

    def update_kw_rank(self, task_id: str, run_date: str, keyword: str,
                       rank: int = None, click_share: float = None):
        """回填 ABA 排名 / Top3 点击集中度到当日快照行。

        screen_opportunities 不返回排名，排名来自每周层的 keyword_history 最新一期，
        因此该字段是周级刷新（每日快照沿用当周最新值）。"""
        if rank is None and click_share is None:
            return
        sets, vals = [], []
        if rank is not None:
            sets.append('"rank"=?')
            vals.append(int(rank))
        if click_share is not None:
            sets.append("click_share=?")
            vals.append(float(click_share))
        vals += [task_id, run_date, keyword]
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    f"UPDATE sif_kw_snapshots SET {', '.join(sets)} "
                    "WHERE task_id=? AND run_date=? AND keyword=?", vals)
                conn.commit()

    def prune_kw_snapshots(self, task_id: str, before_date: str) -> int:
        """按保留期清理过期快照（数据清理走 DELETE，仅作用于本模块自有 SQLite 表）。"""
        with self.lock:
            with self._conn() as conn:
                n = conn.execute(
                    "DELETE FROM sif_kw_snapshots WHERE task_id=? AND run_date<?",
                    [task_id, before_date]).rowcount
                conn.execute(
                    "DELETE FROM sif_asin_snapshots WHERE task_id=? AND stat_date<?",
                    [task_id, before_date]).rowcount
                conn.commit()
        return n

    # ---- SIF v2：ASIN 监控池 ----

    def add_asins(self, task_id: str, rows: list) -> int:
        """入池（已存在则只补 source_ref，不覆盖已有画像）。返回新增数。"""
        if not rows:
            return 0
        now = _now_iso()
        added = 0
        with self.lock:
            with self._conn() as conn:
                for r in rows:
                    asin = (r.get("asin") or "").strip()
                    if not asin:
                        continue
                    cur = conn.execute(
                        "SELECT id FROM sif_asins WHERE task_id=? AND asin=?",
                        [task_id, asin]).fetchone()
                    if cur:
                        if not r.get("force_reactivate"):
                            continue
                        conn.execute("UPDATE sif_asins SET active=1 WHERE id=?", [cur["id"]])
                        continue
                    conn.execute(
                        """INSERT INTO sif_asins
                           (task_id, asin, title, brand, img, url, price, star, rating_num,
                            category, weight_oz, dims_in, first_available_day, variation_num,
                            source, source_ref, added_at, active)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        [task_id, asin, r.get("title"), r.get("brand"), r.get("img"), r.get("url"),
                         r.get("price"), r.get("star"), _as_int(r.get("rating_num")),
                         r.get("category"), r.get("weight_oz"),
                         json.dumps(r.get("dims_in") or {}, ensure_ascii=False),
                         r.get("first_available_day"), r.get("variation_num"),
                         r.get("source") or "manual",
                         json.dumps({k: v for k, v in r.items()
                                     if k in ("keyword", "root", "covered_volume",
                                              "keyword_count", "rank1_count", "monthly_orders",
                                              "posture", "serp_share", "first_available_day")},
                                    ensure_ascii=False),
                         now, 1])
                    added += 1
                conn.commit()
        return added

    def update_asin_profile(self, task_id: str, asin: str, p: dict):
        """用 market_get_asin_profile 结果刷新静态属性。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """UPDATE sif_asins SET title=COALESCE(?,title), brand=COALESCE(?,brand),
                       img=COALESCE(?,img), url=COALESCE(?,url), price=COALESCE(?,price),
                       star=COALESCE(?,star), rating_num=COALESCE(?,rating_num),
                       category=COALESCE(?,category), weight_oz=COALESCE(?,weight_oz),
                       first_available_day=COALESCE(?,first_available_day),
                       variation_num=COALESCE(?,variation_num),
                       dims_in=CASE WHEN ?='{}' THEN dims_in ELSE ? END
                       WHERE task_id=? AND asin=?""",
                    [p.get("title"), p.get("brand"), p.get("img"), p.get("url"), p.get("price"),
                     p.get("star"), _as_int(p.get("rating_num")), p.get("category"),
                     p.get("weight_oz"), p.get("first_available_day"), p.get("variation_num"),
                     json.dumps(p.get("dims_in") or {}, ensure_ascii=False),
                     json.dumps(p.get("dims_in") or {}, ensure_ascii=False),
                     task_id, asin])
                conn.commit()

    def list_asins(self, task_id: str, active_only: bool = True) -> list:
        with self._conn() as conn:
            sql = "SELECT * FROM sif_asins WHERE task_id=?"
            if active_only:
                sql += " AND active=1"
            rows = conn.execute(sql + " ORDER BY added_at ASC", [task_id]).fetchall()
        return [self._row_to_asin(r) for r in rows]

    def count_asins(self, task_id: str) -> int:
        with self._conn() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM sif_asins WHERE task_id=? AND active=1", [task_id]).fetchone()[0]

    def _row_to_asin(self, row):
        return {
            "id": row["id"], "asin": row["asin"], "title": row["title"] or "",
            "brand": row["brand"] or "", "img": row["img"], "url": row["url"],
            "price": row["price"], "star": row["star"], "ratingNum": row["rating_num"],
            "category": row["category"], "weightOz": row["weight_oz"],
            "dimsIn": json.loads(row["dims_in"] or "{}"),
            "firstAvailableDay": row["first_available_day"],
            "variationNum": row["variation_num"],
            "source": row["source"] or "manual",
            "sourceRef": json.loads(row["source_ref"] or "{}"),
            "addedAt": row["added_at"], "lastStatDate": row["last_stat_date"],
            "active": bool(row["active"]),
        }

    def set_asin_active(self, task_id: str, asin: str, active: bool):
        with self.lock:
            with self._conn() as conn:
                conn.execute("UPDATE sif_asins SET active=? WHERE task_id=? AND asin=?",
                             [1 if active else 0, task_id, asin])
                conn.commit()

    def delete_asin(self, task_id: str, asin: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM sif_asins WHERE task_id=? AND asin=?", [task_id, asin])
                conn.execute("DELETE FROM sif_asin_snapshots WHERE task_id=? AND asin=?",
                             [task_id, asin])
                conn.commit()

    # ---- SIF v2：ASIN 日粒度数据 ----

    def save_asin_snapshots(self, task_id: str, asin: str, points: list) -> int:
        if not points:
            return 0
        now = _now_iso()
        rows = []
        for p in points:
            d = p.get("date")
            if not d:
                continue
            rows.append((
                task_id, asin, d, p.get("price"), _as_int(p.get("bsr")),
                _as_int(p.get("bought_month")), _as_int(p.get("review")),
                p.get("star"), _as_int(p.get("seller")),
                p.get("total_score"), p.get("nf_score"), p.get("ad_score"),
                p.get("sp_score"), p.get("sb_score"), p.get("sbv_score"),
                _short(p.get("promotion")), _short(p.get("coupon")), now))
        with self.lock:
            with self._conn() as conn:
                conn.executemany(
                    """INSERT OR REPLACE INTO sif_asin_snapshots
                       (task_id, asin, stat_date, price, bsr, bought_month, review_num, star,
                        seller_num, total_score, nf_score, ad_score, sp_score, sb_score,
                        sbv_score, promotion, coupon, captured_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
                latest = max(r[2] for r in rows)
                conn.execute(
                    "UPDATE sif_asins SET last_stat_date=? WHERE task_id=? AND asin=?",
                    [latest, task_id, asin])
                conn.commit()
        return len(rows)

    def asin_series(self, task_id: str, asin: str, days: int = 90) -> list:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM (SELECT * FROM sif_asin_snapshots WHERE task_id=? AND asin=? "
                "ORDER BY stat_date DESC LIMIT ?) ORDER BY stat_date ASC",
                [task_id, asin, int(days)]).fetchall()
        return [self._row_to_asin_snapshot(r) for r in rows]

    def _row_to_asin_snapshot(self, row):
        return {
            "date": row["stat_date"], "price": row["price"], "bsr": row["bsr"],
            "boughtMonth": row["bought_month"], "reviewNum": row["review_num"],
            "star": row["star"], "sellerNum": row["seller_num"],
            "totalScore": row["total_score"], "nfScore": row["nf_score"],
            "adScore": row["ad_score"], "spScore": row["sp_score"],
            "sbScore": row["sb_score"], "sbvScore": row["sbv_score"],
            "promotion": row["promotion"], "coupon": row["coupon"],
        }

    def asin_latest_map(self, task_id: str) -> dict:
        """每个 ASIN 的最新日数据点（用于爆品榜排序与环比）。"""
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT s.* FROM sif_asin_snapshots s
                   JOIN (SELECT asin, MAX(stat_date) AS d FROM sif_asin_snapshots
                         WHERE task_id=? GROUP BY asin) m
                     ON s.asin=m.asin AND s.stat_date=m.d WHERE s.task_id=?""",
                [task_id, task_id]).fetchall()
        out = {}
        for r in rows:
            out[r["asin"]] = self._row_to_asin_snapshot(r)
        return out

    def asin_prev_map(self, task_id: str, days_back: int = 7) -> dict:
        """每个 ASIN 约 N 天前的数据点（做周环比基线）。"""
        import datetime
        cutoff = (datetime.date.today() - datetime.timedelta(days=int(days_back))).isoformat()
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT s.* FROM sif_asin_snapshots s
                   JOIN (SELECT asin, MAX(stat_date) AS d FROM sif_asin_snapshots
                         WHERE task_id=? AND stat_date<=? GROUP BY asin) m
                     ON s.asin=m.asin AND s.stat_date=m.d WHERE s.task_id=?""",
                [task_id, cutoff, task_id]).fetchall()
        out = {}
        for r in rows:
            out[r["asin"]] = self._row_to_asin_snapshot(r)
        return out

    def asin_kw_dates(self, task_id: str, asin: str) -> list:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT DISTINCT stat_date FROM sif_asin_snapshots WHERE task_id=? AND asin=? "
                "ORDER BY stat_date DESC", [task_id, asin]).fetchall()
        return [r["stat_date"] for r in rows]

    # ---- SIF v2：需求画像 / 竞品概览 ----

    def save_kw_profiles(self, task_id: str, iso_week: str, profiles: list) -> int:
        if not profiles:
            return 0
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                conn.executemany(
                    """INSERT OR REPLACE INTO sif_kw_profiles
                       (task_id, keyword, iso_week, profile, captured_at) VALUES (?,?,?,?,?)""",
                    [(task_id, p.get("keyword", ""), iso_week,
                      json.dumps(p, ensure_ascii=False), now) for p in profiles if p.get("keyword")])
                conn.commit()
        return len(profiles)

    def latest_kw_profiles(self, task_id: str) -> dict:
        """{keyword: profile dict}，取该任务最新 iso_week 的画像。"""
        with self._conn() as conn:
            wk = conn.execute(
                "SELECT MAX(iso_week) AS w FROM sif_kw_profiles WHERE task_id=?",
                [task_id]).fetchone()
            if not wk or not wk["w"]:
                return {}
            rows = conn.execute(
                "SELECT keyword, profile FROM sif_kw_profiles WHERE task_id=? AND iso_week=?",
                [task_id, wk["w"]]).fetchall()
        return {r["keyword"]: json.loads(r["profile"] or "{}") for r in rows}

    def kw_profile(self, task_id: str, keyword: str):
        with self._conn() as conn:
            row = conn.execute(
                "SELECT profile, iso_week FROM sif_kw_profiles WHERE task_id=? AND keyword=? "
                "ORDER BY iso_week DESC LIMIT 1", [task_id, keyword]).fetchone()
        if not row:
            return None
        return {"week": row["iso_week"], "profile": json.loads(row["profile"] or "{}")}

    def save_asin_weekly(self, task_id: str, root: str, iso_week: str, competitors: list):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT OR REPLACE INTO sif_asin_weekly
                       (task_id, root, iso_week, competitors, captured_at) VALUES (?,?,?,?,?)""",
                    [task_id, root, iso_week,
                     json.dumps(competitors or [], ensure_ascii=False), _now_iso()])
                conn.commit()

    def list_asin_weekly(self, task_id: str) -> list:
        with self._conn() as conn:
            wk = conn.execute(
                "SELECT MAX(iso_week) AS w FROM sif_asin_weekly WHERE task_id=?",
                [task_id]).fetchone()
            if not wk or not wk["w"]:
                return []
            rows = conn.execute(
                "SELECT root, competitors, iso_week FROM sif_asin_weekly WHERE task_id=? AND iso_week=?",
                [task_id, wk["w"]]).fetchall()
        return [{"root": r["root"], "week": r["iso_week"],
                 "competitors": json.loads(r["competitors"] or "[]")} for r in rows]

    # ---- SIF v2：信号 ----

    def save_signals(self, rows: list) -> int:
        """写信号（同一天同任务同类型同对象幂等去重）。"""
        if not rows:
            return 0
        with self.lock:
            with self._conn() as conn:
                for r in rows:
                    conn.execute(
                        """INSERT OR IGNORE INTO sif_signals
                           (date, created_at, task_id, direction, kind, severity,
                            ref_type, ref_id, title, detail)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        [r.get("date"), _now_iso(), r.get("task_id"), r.get("direction"),
                         r.get("kind"), r.get("severity") or "info", r.get("ref_type"),
                         r.get("ref_id"), r.get("title"),
                         json.dumps(r.get("detail") or {}, ensure_ascii=False)])
                conn.commit()
        return len(rows)

    def list_signals(self, days: int = 14, task_id: str = None, limit: int = 400) -> list:
        import datetime
        since = (datetime.date.today() - datetime.timedelta(days=int(days))).isoformat()
        sql = "SELECT * FROM sif_signals WHERE date>=?"
        args = [since]
        if task_id:
            sql += " AND task_id=?"
            args.append(task_id)
        sql += " ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, date DESC LIMIT ?"
        args.append(int(limit))
        with self._conn() as conn:
            rows = conn.execute(sql, args).fetchall()
        out = []
        for r in rows:
            out.append({
                "id": r["id"], "date": r["date"], "createdAt": r["created_at"],
                "taskId": r["task_id"], "direction": r["direction"] or "", "kind": r["kind"],
                "severity": r["severity"] or "info", "refType": r["ref_type"],
                "refId": r["ref_id"], "title": r["title"] or "",
                "detail": json.loads(r["detail"] or "{}"), "ack": bool(r["ack"]),
            })
        return out

    def ack_signal(self, sid, ack: bool = True):
        with self.lock:
            with self._conn() as conn:
                conn.execute("UPDATE sif_signals SET ack=? WHERE id=?", [1 if ack else 0, int(sid)])
                conn.commit()

    def delete_signals(self, days: int, task_id: str = None):
        import datetime
        cutoff = (datetime.date.today() - datetime.timedelta(days=int(days))).isoformat()
        sql, args = "DELETE FROM sif_signals WHERE date<?", [cutoff]
        if task_id:
            sql += " AND task_id=?"
            args.append(task_id)
        with self.lock:
            with self._conn() as conn:
                conn.execute(sql, args)
                conn.commit()

    def signal_counts(self, days: int = 14) -> dict:
        import datetime
        since = (datetime.date.today() - datetime.timedelta(days=int(days))).isoformat()
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT severity, COUNT(*) AS n FROM sif_signals WHERE date>=? GROUP BY severity",
                [since]).fetchall()
        out = {"high": 0, "warn": 0, "info": 0, "total": 0}
        for r in rows:
            out[r["severity"]] = r["n"]
            out["total"] += r["n"]
        return out

    # ---- SIF v2：运行日志 ----

    def log_sif_run(self, task_id: str, run_date: str, tier: str, started_at: str,
                    finished_at: str, status: str, stats: dict, error: str = None):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO sif_runs
                       (task_id, run_date, tier, started_at, finished_at, status, stats, error)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    [task_id, run_date, tier, started_at, finished_at, status,
                     json.dumps(stats or {}, ensure_ascii=False), error])
                conn.commit()

    def patch_sif_run_stats(self, task_id: str, run_date: str, tier: str, patch: dict):
        """把运行日志写完之后才产生的统计（如信号条数）并回最近一条对应记录。"""
        with self.lock:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT id, stats FROM sif_runs WHERE task_id=? AND run_date=? AND tier=? "
                    "ORDER BY id DESC LIMIT 1", [task_id, run_date, tier]).fetchone()
                if not row:
                    return
                merged = {}
                try:
                    merged = json.loads(row["stats"] or "{}")
                except Exception:
                    merged = {}
                merged.update(patch or {})
                conn.execute("UPDATE sif_runs SET stats=? WHERE id=?",
                             [json.dumps(merged, ensure_ascii=False), row["id"]])
                conn.commit()

    def list_sif_runs(self, task_id: str = None, limit: int = 60) -> list:
        sql = ("SELECT r.*, t.name AS task_name FROM sif_runs r "
               "LEFT JOIN sif_tasks t ON t.id=r.task_id ")
        args = []
        if task_id:
            sql += "WHERE r.task_id=? "
            args.append(task_id)
        sql += "ORDER BY r.id DESC LIMIT ?"
        args.append(int(limit))
        with self._conn() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [{
            "id": r["id"], "taskId": r["task_id"], "taskName": r["task_name"] or "",
            "runDate": r["run_date"], "tier": r["tier"], "startedAt": r["started_at"],
            "finishedAt": r["finished_at"], "status": r["status"],
            "stats": json.loads(r["stats"] or "{}"), "error": r["error"],
        } for r in rows]

    def sif_overview(self) -> dict:
        """全局概览：任务数 / 监控词数 / 监控 ASIN 数 / 最新数据日期。"""
        with self._conn() as conn:
            tasks = conn.execute("SELECT COUNT(*) FROM sif_tasks").fetchone()[0]
            kws = conn.execute("SELECT COUNT(DISTINCT keyword) FROM sif_kw_snapshots").fetchone()[0]
            asins = conn.execute(
                "SELECT COUNT(DISTINCT asin) FROM sif_asins WHERE active=1").fetchone()[0]
            kw_date = conn.execute(
                "SELECT MAX(run_date) FROM sif_kw_snapshots").fetchone()[0]
            asin_date = conn.execute(
                "SELECT MAX(stat_date) FROM sif_asin_snapshots").fetchone()[0]
            calls = conn.execute(
                "SELECT COALESCE(SUM(json_extract(stats,'$.calls')),0) FROM sif_runs").fetchone()[0]
        return {"tasks": tasks, "keywords": kws, "asins": asins,
                "latestKwDate": kw_date, "latestAsinDate": asin_date, "totalCalls": calls}

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


def _as_int(v):
    if v is None:
        return None
    try:
        return int(float(v))
    except Exception:
        return None


def _short(v, n=200):
    """促销/优惠券字段可能是 dict 或长字符串，统一压成短文本入库。"""
    if v is None:
        return None
    if isinstance(v, (dict, list)):
        s = json.dumps(v, ensure_ascii=False)
    else:
        s = str(v)
    return s[:n] or None
