import datetime
import json
import os
import re
import secrets
import sqlite3
import threading
import uuid

from .utils import _now_iso, PROJECT_ROOT, _log

# SIF 任务失败退避策略：第 n 次失败后等待对应分钟数再重试；当天失败次数达到
# 上限即熔断（次日计划时刻自动重置）。目的是让「每天最多浪费 3 次配额」，
# 而不是像早期版本那样每分钟重试一整天（单次 daily 层约 25 次 SIF 调用）。
SIF_RETRY_BACKOFF_MIN = (5, 30, 120)
SIF_MAX_RETRIES_PER_DAY = len(SIF_RETRY_BACKOFF_MIN) + 1


# ---------------------------------------------------------------------------
# 货件跟踪：camelCase(接口/原项目) <-> snake_case(SQLite) 机械互转
#
# 原 shipment-tracker 用 JSON 文件存，字段是 camelCase（shipmentId / etaDate / qtyPerBox…）。
# 迁到 SQLite 后列名用 snake_case，接口仍返回 camelCase——这样前端逻辑可以原样搬，
# 也避免 42 个字段手写映射表出错。
# ---------------------------------------------------------------------------

def _snake_key(k):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', str(k)).lower()


def _camel_key(k):
    parts = str(k).split('_')
    return parts[0] + ''.join(p.title() for p in parts[1:])


def _row_to_camel(row):
    """SQLite 行 → camelCase dict；cancelled 还原成 bool，history 还原成数组。"""
    d = {k: row[k] for k in row.keys()}
    d["cancelled"] = bool(d.get("cancelled"))
    hist = d.get("history")
    if hist:
        try:
            d["history"] = json.loads(hist)
        except Exception:
            d["history"] = []
    else:
        d["history"] = []
    return {_camel_key(k): v for k, v in d.items()}


def _dedupe_scrape_products(conn):
    """清理 scrape_products 中重复的 (task_id, asin)，并建立唯一索引。

    重复来源：早期「重试失败项」走 INSERT 而非 UPSERT，同一 ASIN 会被反复写入，
    库里曾出现同一任务同一 ASIN 最多 3 条。清理前先把要删的行导出到 data/ 备查，
    每对 (task_id, asin) 只保留 id 最大的一条（即最近一次采集结果）。
    已有唯一索引时直接跳过，因此本函数是幂等的。
    注意：新索引名也要认（见下方「seq」迁移）——否则本函数会在每次启动时把已被
    替换掉的旧索引重建回来，把「重采 · 新增一条记录」重新拦死。
    """
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='index' "
                    "AND name IN ('idx_scrape_prod_task_asin', "
                    "'idx_scrape_prod_task_asin_seq')").fetchone():
        return

    dups = conn.execute(
        """SELECT * FROM scrape_products
           WHERE id NOT IN (SELECT MAX(id) FROM scrape_products GROUP BY task_id, asin)
           ORDER BY task_id, asin, id"""
    ).fetchall()

    if dups:
        cols = [d[0] for d in conn.execute("SELECT * FROM scrape_products LIMIT 0").description]
        rows = [dict(zip(cols, r)) for r in dups]
        stamp = _now_iso().replace("-", "").replace(":", "")
        backup = os.path.join(PROJECT_ROOT, "data", f"scrape_products_dups_{stamp}.json")
        try:
            with open(backup, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, indent=2)
        except Exception as e:
            # 备份失败就不动数据：宁可保留重复，也不要丢掉可追溯性
            _log(f"[warn] 采集结果去重已跳过：备份写入失败（{e}）")
            return
        conn.execute(
            "DELETE FROM scrape_products WHERE id NOT IN "
            "(SELECT MAX(id) FROM scrape_products GROUP BY task_id, asin)"
        )
        _log(f"[info] 采集结果去重：删除 {len(rows)} 条重复行，原数据已备份到 "
             f"data/{os.path.basename(backup)}")

    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_scrape_prod_task_asin "
                 "ON scrape_products(task_id, asin)")


class DbState:
    """SQLite 存储，WAL 模式支持并发读，行级写入替代全量 JSON 重写"""

    def __init__(self, db_path):
        self.db_path = db_path
        self.lock = threading.Lock()
        self._init_db()
        self._init_catmon()

    def _conn(self):
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    # =====================================================================
    # catmon：Amazon 类目榜单监控（Best Sellers / New Releases）
    # =====================================================================

    def _init_catmon(self):
        with self._conn() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS catmon_targets (
                    id               TEXT PRIMARY KEY,
                    marketplace      TEXT NOT NULL,
                    node_id          TEXT NOT NULL,
                    node_path        TEXT,
                    label            TEXT,
                    list_types       TEXT DEFAULT '["bestsellers","new-releases"]',
                    enabled          INTEGER DEFAULT 1,
                    freq_type        TEXT DEFAULT 'daily',
                    every_n_days     INTEGER DEFAULT 1,
                    schedule_weekday INTEGER DEFAULT 1,
                    schedule_time    TEXT,
                    last_run_at      TEXT,
                    last_status      TEXT DEFAULT 'idle',
                    last_error       TEXT,
                    created_at       TEXT,
                    UNIQUE(marketplace, node_id)
                );
                CREATE TABLE IF NOT EXISTS catmon_snapshots (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_id   TEXT NOT NULL,
                    list_type   TEXT NOT NULL,
                    run_date    TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    status      TEXT DEFAULT 'ok',
                    item_count  INTEGER DEFAULT 0,
                    UNIQUE(target_id, list_type, run_date)
                );
                CREATE INDEX IF NOT EXISTS idx_catmon_snap
                    ON catmon_snapshots(target_id, list_type, run_date);
                CREATE TABLE IF NOT EXISTS catmon_items (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    snapshot_id  INTEGER NOT NULL,
                    target_id    TEXT NOT NULL,
                    list_type    TEXT NOT NULL,
                    run_date     TEXT NOT NULL,
                    rank         INTEGER,
                    asin         TEXT NOT NULL,
                    title        TEXT,
                    price        TEXT,
                    rating       REAL,
                    review_count INTEGER,
                    image_url    TEXT,
                    product_url  TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_catmon_items
                    ON catmon_items(target_id, list_type, run_date, rank);
                CREATE TABLE IF NOT EXISTS catmon_runs (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_id   TEXT NOT NULL,
                    started_at  TEXT,
                    finished_at TEXT,
                    pages       INTEGER DEFAULT 0,
                    requests    INTEGER DEFAULT 0,
                    items       INTEGER DEFAULT 0,
                    status      TEXT DEFAULT 'running',
                    error       TEXT
                );
                CREATE TABLE IF NOT EXISTS catmon_events (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_id  TEXT NOT NULL,
                    list_type  TEXT NOT NULL,
                    run_date   TEXT NOT NULL,
                    asin       TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    old_rank   INTEGER,
                    new_rank   INTEGER,
                    delta      INTEGER,
                    title      TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_catmon_events
                    ON catmon_events(target_id, run_date);
            """)
            cols = {r[1] for r in conn.execute("PRAGMA table_info(catmon_targets)").fetchall()}
            if "last_progress" not in cols:
                conn.execute("ALTER TABLE catmon_targets ADD COLUMN last_progress TEXT")
            # 查询记录支持手动拖拽排序：sort_order 小的在上；老数据按原来的展示顺序
            # （created_at DESC，新加的在上）回填一次，界面看起来不变。
            if "sort_order" not in cols:
                conn.execute("ALTER TABLE catmon_targets ADD COLUMN sort_order INTEGER")
                rows = conn.execute(
                    "SELECT id FROM catmon_targets ORDER BY created_at DESC").fetchall()
                for i, r in enumerate(rows):
                    conn.execute("UPDATE catmon_targets SET sort_order=? WHERE id=?", [i, r[0]])

    def _row_to_catmon_target(self, row):
        try:
            list_types = json.loads(row["list_types"] or "[]")
        except Exception:
            list_types = []
        return {
            "id": row["id"],
            "marketplace": row["marketplace"],
            "nodeId": row["node_id"],
            "nodePath": row["node_path"],
            "label": row["label"],
            "listTypes": list_types,
            "enabled": bool(row["enabled"]),
            "freqType": row["freq_type"],
            "everyNDays": row["every_n_days"],
            "scheduleWeekday": row["schedule_weekday"],
            "scheduleTime": row["schedule_time"],
            "lastRunAt": row["last_run_at"],
            "lastStatus": row["last_status"],
            "lastError": row["last_error"],
            "lastProgress": row["last_progress"],
            "sortOrder": row["sort_order"],
            "createdAt": row["created_at"],
        }

    def create_catmon_target(self, t: dict) -> str:
        marketplace = (t.get("marketplace") or "US").upper()
        node_id = str(t.get("nodeId") or t.get("node_id") or "").strip()
        if not node_id:
            raise ValueError("nodeId required")
        list_types = t.get("listTypes") or t.get("list_types") or ["bestsellers", "new-releases"]
        with self.lock:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT id FROM catmon_targets WHERE marketplace=? AND node_id=?",
                    [marketplace, node_id]).fetchone()
                if row:
                    return row["id"]
                tid = "cat" + secrets.token_hex(6)
                # 新加的排最前（与原 created_at DESC 的观感一致）
                nxt = conn.execute(
                    "SELECT COALESCE(MIN(sort_order), 0) - 1 FROM catmon_targets").fetchone()[0]
                conn.execute(
                    """INSERT INTO catmon_targets
                       (id, marketplace, node_id, node_path, label, list_types,
                        enabled, freq_type, every_n_days, schedule_weekday,
                        schedule_time, created_at, sort_order)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    [tid, marketplace, node_id,
                     t.get("nodePath") or t.get("node_path"),
                     t.get("label"),
                     json.dumps(list_types, ensure_ascii=False),
                     1 if t.get("enabled", True) else 0,
                     t.get("freqType") or "daily",
                     int(t.get("everyNDays") or 1),
                     int(t.get("scheduleWeekday") or 1),
                     t.get("scheduleTime") or "09:00",
                     _now_iso(), nxt])
                conn.commit()
        return tid

    def list_catmon_targets(self):
        with self._conn() as conn:
            # NULL 的（迁移前插入/老版本后端插入的）当作 -1 → 排最前，符合「新加的在上」的旧观感
            rows = conn.execute(
                "SELECT * FROM catmon_targets "
                "ORDER BY COALESCE(sort_order, -1) ASC, created_at DESC").fetchall()
        return [self._row_to_catmon_target(r) for r in rows]

    def reorder_catmon_targets(self, ids):
        """按给定顺序重排查询记录（拖动排序后调用）。"""
        with self.lock:
            with self._conn() as conn:
                for i, tid in enumerate(ids):
                    conn.execute("UPDATE catmon_targets SET sort_order=? WHERE id=?", [i, tid])
                conn.commit()

    def get_catmon_target(self, tid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM catmon_targets WHERE id=?", [tid]).fetchone()
        return self._row_to_catmon_target(row) if row else None

    def update_catmon_target(self, tid: str, t: dict):
        allowed = {
            "label": "label", "enabled": "enabled", "freq_type": "freqType",
            "every_n_days": "everyNDays", "schedule_weekday": "scheduleWeekday",
            "schedule_time": "scheduleTime", "list_types": "listTypes",
        }
        sets, vals = [], []
        for col, key in allowed.items():
            if key not in t:
                continue
            v = t[key]
            if col == "list_types":
                v = json.dumps(v or [], ensure_ascii=False)
            elif col == "enabled":
                v = 1 if v else 0
            elif col in ("every_n_days", "schedule_weekday"):
                v = int(v or 0)
            elif col == "schedule_time":
                v = v or None
            sets.append(f"{col}=?")
            vals.append(v)
        if not sets:
            return
        vals.append(tid)
        with self.lock:
            with self._conn() as conn:
                conn.execute(f"UPDATE catmon_targets SET {', '.join(sets)} WHERE id=?", vals)
                conn.commit()

    def delete_catmon_target(self, tid: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM catmon_items WHERE target_id=?", [tid])
                conn.execute("DELETE FROM catmon_snapshots WHERE target_id=?", [tid])
                conn.execute("DELETE FROM catmon_runs WHERE target_id=?", [tid])
                conn.execute("DELETE FROM catmon_events WHERE target_id=?", [tid])
                conn.execute("DELETE FROM catmon_targets WHERE id=?", [tid])
                conn.commit()

    def set_catmon_target_status(self, tid, status, error=None, last_run_at=None, progress=None):
        with self.lock:
            with self._conn() as conn:
                if last_run_at is not None:
                    conn.execute(
                        "UPDATE catmon_targets SET last_status=?, last_error=?, last_run_at=? WHERE id=?",
                        [status, error, last_run_at, tid])
                else:
                    conn.execute(
                        "UPDATE catmon_targets SET last_status=?, last_error=? WHERE id=?",
                        [status, error, tid])
                if progress is not None:
                    conn.execute("UPDATE catmon_targets SET last_progress=? WHERE id=?", [progress, tid])
                conn.commit()

    def save_catmon_snapshot(self, target_id, list_type, run_date, items, status="ok", captured_at=None):
        """写入某天某榜的快照（同日覆盖），并与上一快照对比生成事件。"""
        captured_at = captured_at or _now_iso()
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "DELETE FROM catmon_items WHERE target_id=? AND list_type=? AND run_date=?",
                    [target_id, list_type, run_date])
                conn.execute(
                    "DELETE FROM catmon_snapshots WHERE target_id=? AND list_type=? AND run_date=?",
                    [target_id, list_type, run_date])
                cur = conn.execute(
                    "INSERT INTO catmon_snapshots "
                    "(target_id, list_type, run_date, captured_at, status, item_count) VALUES (?,?,?,?,?,?)",
                    [target_id, list_type, run_date, captured_at, status, len(items)])
                snap_id = cur.lastrowid
                if items:
                    conn.executemany(
                        """INSERT INTO catmon_items
                           (snapshot_id, target_id, list_type, run_date, rank, asin, title,
                            price, rating, review_count, image_url, product_url)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        [[snap_id, target_id, list_type, run_date, it.get("rank"), it.get("asin"),
                          it.get("title"), it.get("price"), it.get("rating"),
                          it.get("reviewCount"), it.get("image"), it.get("productUrl")]
                         for it in items])
                prev = conn.execute(
                    "SELECT run_date FROM catmon_snapshots WHERE target_id=? AND list_type=? "
                    "AND run_date<? ORDER BY run_date DESC LIMIT 1",
                    [target_id, list_type, run_date]).fetchone()
                events = []
                if prev:
                    prev_rows = conn.execute(
                        "SELECT asin, rank, title FROM catmon_items "
                        "WHERE target_id=? AND list_type=? AND run_date=?",
                        [target_id, list_type, prev["run_date"]]).fetchall()
                    prev_map = {r["asin"]: r for r in prev_rows}
                    new_map = {it["asin"]: it for it in items}
                    for asin, it in new_map.items():
                        old = prev_map.get(asin)
                        if not old:
                            events.append([target_id, list_type, run_date, asin, "new",
                                           None, it.get("rank"), None, it.get("title")])
                        else:
                            delta = (it.get("rank") or 0) - (old["rank"] or 0)
                            if delta <= -20:
                                events.append([target_id, list_type, run_date, asin, "up",
                                               old["rank"], it.get("rank"), delta, it.get("title")])
                            elif delta >= 20:
                                events.append([target_id, list_type, run_date, asin, "down",
                                               old["rank"], it.get("rank"), delta, it.get("title")])
                    for asin, old in prev_map.items():
                        if asin not in new_map:
                            events.append([target_id, list_type, run_date, asin, "out",
                                           old["rank"], None, None, old["title"]])
                    if events:
                        conn.executemany(
                            """INSERT INTO catmon_events
                               (target_id, list_type, run_date, asin, event_type,
                                old_rank, new_rank, delta, title)
                               VALUES (?,?,?,?,?,?,?,?,?)""", events)
                conn.commit()
        return {"snapshotId": snap_id, "events": len(events)}

    def list_catmon_snapshot(self, target_id, list_type, run_date=None):
        with self._conn() as conn:
            if not run_date:
                row = conn.execute(
                    "SELECT run_date FROM catmon_snapshots WHERE target_id=? AND list_type=? "
                    "ORDER BY run_date DESC LIMIT 1", [target_id, list_type]).fetchone()
                if not row:
                    return None
                run_date = row["run_date"]
            snap = conn.execute(
                "SELECT * FROM catmon_snapshots WHERE target_id=? AND list_type=? AND run_date=?",
                [target_id, list_type, run_date]).fetchone()
            if not snap:
                return None
            rows = conn.execute(
                "SELECT rank, asin, title, price, rating, review_count, image_url, product_url "
                "FROM catmon_items WHERE target_id=? AND list_type=? AND run_date=? ORDER BY rank",
                [target_id, list_type, run_date]).fetchall()
            # 上一次快照（用于表格里的「较上次」位次变化；小幅度变动也算，不只 ±20 的事件）
            prev = conn.execute(
                "SELECT run_date FROM catmon_snapshots WHERE target_id=? AND list_type=? "
                "AND run_date<? ORDER BY run_date DESC LIMIT 1",
                [target_id, list_type, run_date]).fetchone()
            prev_map = {}
            if prev:
                prev_map = {r["asin"]: r["rank"] for r in conn.execute(
                    "SELECT asin, rank FROM catmon_items "
                    "WHERE target_id=? AND list_type=? AND run_date=?",
                    [target_id, list_type, prev["run_date"]]).fetchall()}
        def _delta(r):
            old = prev_map.get(r["asin"])
            if old is None or r["rank"] is None:
                return None
            return r["rank"] - old
        return {
            "targetId": target_id,
            "listType": list_type,
            "date": run_date,
            "prevDate": prev["run_date"] if prev else None,
            "capturedAt": snap["captured_at"],
            "status": snap["status"],
            "items": [{
                "rank": r["rank"], "asin": r["asin"], "title": r["title"], "price": r["price"],
                "rating": r["rating"], "reviewCount": r["review_count"],
                "image": r["image_url"], "productUrl": r["product_url"],
                "prevRank": prev_map.get(r["asin"]), "delta": _delta(r),
            } for r in rows],
        }

    def list_catmon_snapshot_dates(self, target_id, list_type):
        """该 target+listType 的历史快照日期（新→旧），供前端选择历史快照。"""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT run_date, captured_at, status, item_count FROM catmon_snapshots "
                "WHERE target_id=? AND list_type=? ORDER BY run_date DESC",
                [target_id, list_type]).fetchall()
        return [{"date": r["run_date"], "capturedAt": r["captured_at"],
                 "status": r["status"], "count": r["item_count"]} for r in rows]

    def get_catmon_trend(self, target_id, list_type, asin, limit=60):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT run_date, rank FROM catmon_items "
                "WHERE target_id=? AND list_type=? AND asin=? ORDER BY run_date DESC LIMIT ?",
                [target_id, list_type, asin, limit]).fetchall()
        return [{"date": r["run_date"], "rank": r["rank"]} for r in reversed(rows)]

    def list_catmon_trend_range(self, target_id, list_type, asins=None,
                                start=None, end=None, top_n=5):
        """多 ASIN 区间趋势。asins 为空时取最新快照前 top_n 名。

        返回 {dates: [...], series: [{asin, title, points:[{date, rank}]}]}
        """
        with self._conn() as conn:
            q = "SELECT DISTINCT run_date FROM catmon_items WHERE target_id=? AND list_type=?"
            params = [target_id, list_type]
            if start:
                q += " AND run_date>=?"; params.append(start)
            if end:
                q += " AND run_date<=?"; params.append(end)
            dates = [r["run_date"] for r in conn.execute(q + " ORDER BY run_date", params).fetchall()]
            if not dates:
                return {"dates": [], "series": []}

            asins = [a.strip().upper() for a in (asins or []) if a and a.strip()]
            if not asins:
                rows = conn.execute(
                    "SELECT asin FROM catmon_items WHERE target_id=? AND list_type=? "
                    "AND run_date=? ORDER BY rank LIMIT ?",
                    [target_id, list_type, dates[-1], int(top_n or 5)]).fetchall()
                asins = [r["asin"] for r in rows]
            if not asins:
                return {"dates": dates, "series": []}

            ph = ",".join("?" for _ in asins)
            rows = conn.execute(
                f"SELECT asin, run_date, rank, title FROM catmon_items "
                f"WHERE target_id=? AND list_type=? AND asin IN ({ph}) "
                f"AND run_date>=? AND run_date<=?",
                [target_id, list_type, *asins, dates[0], dates[-1]]).fetchall()

        rank_map = {a: {} for a in asins}
        titles = {}
        for r in rows:
            rank_map.setdefault(r["asin"], {})[r["run_date"]] = r["rank"]
            if r["title"]:
                titles[r["asin"]] = r["title"]
        series = [{
            "asin": a,
            "title": titles.get(a),
            "points": [{"date": d, "rank": rank_map.get(a, {}).get(d)} for d in dates],
        } for a in asins]
        return {"dates": dates, "series": series}

    def list_catmon_matrix(self, target_id, list_type, start=None, end=None):
        """区间内「出现过的全部 ASIN」的每日位次矩阵（类目榜单 · 全部 ASIN 位次）。

        返回 {dates:[...], rows:[{asin,title,image,ranks:[rank|null],present,best,last}]}
        空白（None）= 当天该 ASIN 不在抓取范围内。
        """
        with self._conn() as conn:
            q = "SELECT DISTINCT run_date FROM catmon_items WHERE target_id=? AND list_type=?"
            params = [target_id, list_type]
            if start:
                q += " AND run_date>=?"; params.append(start)
            if end:
                q += " AND run_date<=?"; params.append(end)
            dates = [r["run_date"] for r in conn.execute(q + " ORDER BY run_date", params).fetchall()]
            if not dates:
                return {"dates": [], "rows": []}
            rows = conn.execute(
                "SELECT asin, run_date, rank, title, image_url, price FROM catmon_items "
                "WHERE target_id=? AND list_type=? AND run_date>=? AND run_date<=? "
                "ORDER BY run_date",
                [target_id, list_type, dates[0], dates[-1]]).fetchall()

        meta, rank_map = {}, {}
        for r in rows:
            a = r["asin"]
            if not a:
                continue
            m = meta.setdefault(a, {"title": None, "image": None, "price": None})
            if r["title"] and not m["title"]:
                m["title"] = r["title"]
            if r["image_url"] and not m["image"]:
                m["image"] = r["image_url"]
            if r["price"] is not None:               # 取最近一天的价格（rows 未排序，取到即覆盖）
                m["price"] = r["price"]
            if r["rank"] is not None:
                rank_map.setdefault(a, {})[r["run_date"]] = r["rank"]

        out = []
        for a, m in meta.items():
            rm = rank_map.get(a, {})
            ranks = [rm.get(d) for d in dates]
            vals = [x for x in ranks if x is not None]
            last = next((ranks[i] for i in range(len(ranks) - 1, -1, -1) if ranks[i] is not None), None)
            out.append({
                "asin": a, "title": m["title"], "image": m["image"], "price": m.get("price"),
                "ranks": ranks, "present": len(vals),
                "best": min(vals) if vals else None, "last": last,
            })
        # 最新在榜优先，其次最好名次
        out.sort(key=lambda r: (r["last"] is None, r["last"] or 9999, r["best"] or 9999))
        return {"dates": dates, "rows": out}

    def list_catmon_events(self, target_id=None, days=7, limit=200, start=None, end=None):
        q = "SELECT * FROM catmon_events WHERE 1=1"
        params = []
        if target_id:
            q += " AND target_id=?"; params.append(target_id)
        if start:
            q += " AND run_date>=?"; params.append(start)
        elif not end:
            since = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
            q += " AND run_date>=?"; params.append(since)
        if end:
            q += " AND run_date<=?"; params.append(end)
        q += " ORDER BY id DESC LIMIT ?"; params.append(limit)
        with self._conn() as conn:
            rows = conn.execute(q, params).fetchall()
        return [{
            "targetId": r["target_id"], "listType": r["list_type"], "date": r["run_date"],
            "asin": r["asin"], "eventType": r["event_type"], "oldRank": r["old_rank"],
            "newRank": r["new_rank"], "delta": r["delta"], "title": r["title"],
        } for r in rows]

    def add_catmon_run(self, target_id):
        with self.lock:
            with self._conn() as conn:
                cur = conn.execute(
                    "INSERT INTO catmon_runs (target_id, started_at, status) VALUES (?,?,?)",
                    [target_id, _now_iso(), "running"])
                conn.commit()
                return cur.lastrowid

    def finish_catmon_run(self, run_id, status, pages=0, requests=0, items=0, error=None):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE catmon_runs SET finished_at=?, status=?, pages=?, requests=?, items=?, error=? "
                    "WHERE id=?", [_now_iso(), status, pages, requests, items, error, run_id])
                conn.commit()

    def list_catmon_runs(self, target_id, limit=20):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM catmon_runs WHERE target_id=? ORDER BY id DESC LIMIT ?",
                [target_id, limit]).fetchall()
        return [dict(r) for r in rows]

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
                    with_customers_say INTEGER DEFAULT 1,
                    status       TEXT DEFAULT 'completed',
                    created_at   TEXT,
                    asins        TEXT DEFAULT '[]',
                    started_at   TEXT,
                    ended_at     TEXT,
                    error        TEXT
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
                    customers_say_tags    TEXT,
                    customers_say_aspects TEXT,
                    review_images     TEXT,
                    select_to_learn_more TEXT,
                    status        TEXT,
                    error_message TEXT,
                    scraped_at    TEXT,
                    seq           INTEGER DEFAULT 0,
                    review_media  TEXT
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

                -- 流量分析报告历史（traffic-compare）：不走 AI 任务队列（报告是一次模型调用，
                -- 不是后台跑几分钟的子进程），所以单独建表。id 就是 datasetId，和
                -- data/traffic-reports/<id>.md 一一对应，便于删记录时连文件一起删。
                CREATE TABLE IF NOT EXISTS traffic_reports (
                    id           TEXT PRIMARY KEY,
                    asin         TEXT NOT NULL,
                    period_label TEXT,
                    period_value TEXT,
                    username     TEXT,
                    model        TEXT,
                    report_chars INTEGER DEFAULT 0,
                    alert_count  INTEGER DEFAULT 0,
                    md_path      TEXT,
                    created_at   TEXT
                );

                -- 排名监测：监测目标（一个关键词 或 一个 ASIN）
                CREATE TABLE IF NOT EXISTS rmon_targets (
                    id          TEXT PRIMARY KEY,
                    kind        TEXT NOT NULL,          -- keyword | asin
                    value       TEXT NOT NULL,          -- 关键词 或 ASIN
                    label       TEXT,
                    country     TEXT DEFAULT 'US',
                    own_asin    TEXT,                   -- 查词时可指定「我的 ASIN」以算卡位
                    freq        TEXT DEFAULT 'daily',   -- daily | weekly
                    enabled     INTEGER DEFAULT 1,
                    username    TEXT,
                    created_at  TEXT,
                    last_run_at TEXT,
                    last_status TEXT,
                    last_error  TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS ux_rmon_targets
                    ON rmon_targets(kind, value, country);

                -- 排名监测：每日快照（同一目标同一天只保留一条，重跑覆盖）
                CREATE TABLE IF NOT EXISTS rmon_snapshots (
                    id         TEXT PRIMARY KEY,
                    target_id  TEXT NOT NULL,
                    snap_date  TEXT NOT NULL,
                    data       TEXT,
                    created_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS ux_rmon_snap
                    ON rmon_snapshots(target_id, snap_date);

                -- 排名监测：变动事件（规则判定，供页面高亮与提醒）
                CREATE TABLE IF NOT EXISTS rmon_events (
                    id          TEXT PRIMARY KEY,
                    target_id   TEXT NOT NULL,
                    detected_at TEXT,
                    level       TEXT,                   -- high | mid | low
                    kind        TEXT,                   -- rank_drop/rank_rise/new_entrant/drop_out/tier_change/share_shift
                    subject     TEXT,
                    detail      TEXT,
                    prev_value  TEXT,
                    curr_value  TEXT,
                    acked       INTEGER DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS ix_rmon_events_target
                    ON rmon_events(target_id, detected_at DESC);

                -- 排名监测：全局设置（采集时刻、默认竞品数）
                CREATE TABLE IF NOT EXISTS rmon_settings (
                    k TEXT PRIMARY KEY,
                    v TEXT
                );

                -- 排名监测：即时查询历史（查询也留痕，可删可导出）
                CREATE TABLE IF NOT EXISTS rmon_queries (
                    id         TEXT PRIMARY KEY,
                    kind       TEXT NOT NULL,          -- keyword | asin
                    value      TEXT NOT NULL,
                    country    TEXT DEFAULT 'US',
                    own_asin   TEXT,
                    summary    TEXT,                   -- 列表页一句话摘要
                    data       TEXT,                   -- 完整结果 JSON
                    username   TEXT,
                    created_at TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_rmon_queries_time
                    ON rmon_queries(created_at DESC);

                -- 关键词搜索页快照（爬虫实测榜单，与 SIF 链路完全独立）
                -- 一个词一次抓取 = 一行，data 里是整页 144 条（含广告标记与自然位）
                -- 同词同日只留最新一条：趋势按天取点，同日多条没有意义
                CREATE TABLE IF NOT EXISTS rmon_srps (
                    id          TEXT PRIMARY KEY,
                    keyword     TEXT NOT NULL,
                    country     TEXT DEFAULT 'US',
                    snap_date   TEXT NOT NULL,          -- YYYY-MM-DD
                    pages       INTEGER,                -- 成功抓取页数
                    org_total   INTEGER,                -- 自然位条数
                    ad_total    INTEGER,                -- 广告位条数
                    elapsed     REAL,                   -- 耗时（秒）
                    warn        TEXT,
                    data        TEXT,                   -- 完整榜单 JSON
                    username    TEXT,
                    created_at  TEXT
                );
                -- 注意：**不要**再给 (keyword, country, snap_date) 建唯一索引。
                -- 现在允许同一天多条（内容有变化才追加），唯一约束会让第二条直接报
                -- UNIQUE constraint failed。老库里的 ux_rmon_srps 由迁移代码 DROP 掉。
                CREATE INDEX IF NOT EXISTS ix_rmon_srps_kw
                    ON rmon_srps(keyword, country, created_at DESC);
                CREATE INDEX IF NOT EXISTS ix_rmon_srps_time
                    ON rmon_srps(created_at DESC);

                -- 每个关键词自己的抓取页数（配置下沉到词一级，不是全局一个值）
                -- 不同词的榜单深度需求不一样：头部词看前 2 页就够，长尾词要多翻几页
                CREATE TABLE IF NOT EXISTS rmon_srp_cfg (
                    keyword    TEXT NOT NULL,
                    country    TEXT DEFAULT 'US',
                    pages      INTEGER,
                    updated_at TEXT,
                    PRIMARY KEY (keyword, country)
                );

                -- 前台实测的定时监测目标（每个词一条：抓几页、每天几点、是否启用）
                -- 与 SIF 的 rmon_targets 分开：那条链路是周数据 + SIF 配额，
                -- 这条是每天爬亚马逊搜索页，节奏和限流约束完全不同
                CREATE TABLE IF NOT EXISTS rmon_srp_targets (
                    id          TEXT PRIMARY KEY,
                    keyword     TEXT NOT NULL,
                    country     TEXT DEFAULT 'US',
                    pages       INTEGER DEFAULT 3,
                    daily_at    TEXT,                   -- HH:MM，空 = 当天首次检查即抓
                    enabled     INTEGER DEFAULT 1,
                    last_run_at TEXT,
                    last_status TEXT,
                    last_error  TEXT,
                    username    TEXT,
                    created_at  TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS ux_rmon_srp_targets
                    ON rmon_srp_targets(keyword, country);

                -- ASIN 静态属性缓存（上架日期/品牌）。**只在缓存缺失时才问 SIF**：
                -- 上架日期一旦确定就不会变，所以每个 ASIN 一辈子只查一次，
                -- 榜单每天换的那点新面孔才是真正的开销（20 个/次调用）。
                -- first_available_day 为空串 = 查过但 SIF 没有这个字段（负缓存，避免反复查）。
                CREATE TABLE IF NOT EXISTS rmon_asin_meta (
                    asin                TEXT PRIMARY KEY,
                    first_available_day TEXT,
                    brand               TEXT,
                    fetched_at          TEXT,
                    src                 TEXT            -- age = 上架天数换算 / asin = SIF 档案原始日期
                );

                -- 关键词搜索趋势缓存（SIF ABA 周数据）。周数据每天只会微调，
                -- 所以缓存 12 小时：同一天反复打开同一个词不再打 SIF。
                CREATE TABLE IF NOT EXISTS rmon_kw_trend (
                    keyword     TEXT NOT NULL,
                    country     TEXT DEFAULT 'US',
                    granularity TEXT DEFAULT 'week',
                    payload     TEXT,
                    fetched_at  TEXT,
                    PRIMARY KEY (keyword, country, granularity)
                );

                -- 「检查过但没变化」的留痕。不存快照（省空间），只记时间与一句话，
                -- 让用户点完「获取最新数据」能看到自己确实点过、且知道结果一致。
                CREATE TABLE IF NOT EXISTS rmon_checks (
                    id         TEXT PRIMARY KEY,
                    source     TEXT NOT NULL,          -- scrape | sif
                    keyword    TEXT NOT NULL,
                    country    TEXT DEFAULT 'US',
                    checked_at TEXT,
                    note       TEXT,
                    username   TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_rmon_checks_kw
                    ON rmon_checks(source, keyword, checked_at DESC);

                -- ===== 货件跟踪（由独立项目 shipment-tracker 迁移而来）=====
                -- 字段名与原 JSON 一一对应（camelCase -> snake_case 机械转换），
                -- 全部 TEXT：原数据本身就是字符串（含 "1500"/"9.83" 这类），不做类型转换以免丢精度。
                -- history 存 JSON 数组（变更轨迹）。

                CREATE TABLE IF NOT EXISTS shipment_products (
                    id                 TEXT PRIMARY KEY,
                    created_at         TEXT,
                    product            TEXT,
                    msku               TEXT,
                    msku_full          TEXT,
                    fnsku              TEXT,
                    category_en        TEXT,
                    category_cn        TEXT,
                    qty_per_box        TEXT,
                    box_count          TEXT,
                    total_qty          TEXT,
                    length             TEXT,
                    width              TEXT,
                    height             TEXT,
                    volume             TEXT,
                    single_box_weight  TEXT,
                    total_weight       TEXT,
                    total_volume       TEXT,
                    supplier           TEXT,
                    declaration_name   TEXT,
                    updated_at         TEXT
                );

                CREATE TABLE IF NOT EXISTS shipments (
                    id                 TEXT PRIMARY KEY,
                    created_at         TEXT,
                    cancelled          INTEGER DEFAULT 0,
                    shipment_id        TEXT,
                    tracking_no        TEXT,
                    channel            TEXT,
                    site               TEXT,
                    warehouse          TEXT,
                    order_no           TEXT,
                    sail_date          TEXT,
                    eta_date           TEXT,
                    eta_end_date       TEXT,
                    actual_date        TEXT,
                    ship_date          TEXT,
                    forwarder_eta      TEXT,
                    product            TEXT,
                    declaration_name   TEXT,
                    msku               TEXT,
                    fnsku              TEXT,
                    category_en        TEXT,
                    category_cn        TEXT,
                    material           TEXT,
                    invoice_unit       TEXT,
                    invoice_name       TEXT,
                    length             TEXT,
                    width              TEXT,
                    height             TEXT,
                    volume             TEXT,
                    single_box_weight  TEXT,
                    total_weight       TEXT,
                    total_volume       TEXT,
                    qty_per_box        TEXT,
                    box_count          TEXT,
                    total_qty          TEXT,
                    box_no             TEXT,
                    supplier           TEXT,
                    tax_company        TEXT,
                    tax_type           TEXT,
                    tax_rate           TEXT,
                    special_invoice    TEXT,
                    note               TEXT,
                    store              TEXT,
                    progress           TEXT,
                    history            TEXT,
                    updated_at         TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_shipment_eta ON shipments(eta_date);
                CREATE INDEX IF NOT EXISTS idx_shipment_cancelled ON shipments(cancelled);

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
            if "with_customers_say" not in existing_scrape:
                # 老库没有该开关，按「默认开启」补列并回填 1，行为与新版一致
                conn.execute("ALTER TABLE scrape_tasks ADD COLUMN with_customers_say INTEGER DEFAULT 1")
                conn.execute("UPDATE scrape_tasks SET with_customers_say=1 WHERE with_customers_say IS NULL")

            # 排名监测目标：竞品数可配（默认 10）+ 暂停开关
            _rmon_cols = {r[1] for r in conn.execute("PRAGMA table_info(rmon_targets)")}
            if "competitor_n" not in _rmon_cols:
                conn.execute("ALTER TABLE rmon_targets ADD COLUMN competitor_n INTEGER DEFAULT 10")
            if "paused" not in _rmon_cols:
                conn.execute("ALTER TABLE rmon_targets ADD COLUMN paused INTEGER DEFAULT 0")
            if "run_at" not in _rmon_cols:
                # 每个关键词自己的采集时刻（HH:MM）；空 = 当天首次检查就跑
                conn.execute("ALTER TABLE rmon_targets ADD COLUMN run_at TEXT")
            if "extra_asins" not in _rmon_cols:
                # 用户额外指定要跟踪自然位的 ASIN（JSON 数组字符串，如 ["B0...","B0..."]）
                conn.execute("ALTER TABLE rmon_targets ADD COLUMN extra_asins TEXT")

            # Customers say 落库：summary 复用既有 customers_say 列，另补 tags / aspects 两列
            _scrape_prod_cols = {r[1] for r in conn.execute("PRAGMA table_info(scrape_products)")}
            for col in ("customers_say_tags", "customers_say_aspects"):
                if col not in _scrape_prod_cols:
                    conn.execute(f"ALTER TABLE scrape_products ADD COLUMN {col} TEXT")

            # 采集任务改为服务端后台执行后，任务需要自己记住「原始 ASIN 列表」才能断点续跑，
            # 并记录运行窗口与失败原因。新表已含这四列，这里只为老库补列。
            _scrape_cols = {r[1] for r in conn.execute("PRAGMA table_info(scrape_tasks)")}
            for col, ddl in (("asins", "TEXT DEFAULT '[]'"),
                             ("started_at", "TEXT"),
                             ("ended_at", "TEXT"),
                             ("error", "TEXT")):
                if col not in _scrape_cols:
                    conn.execute(f"ALTER TABLE scrape_tasks ADD COLUMN {col} {ddl}")

            # 「获取最新数据」去重：同一词同一天允许多条，但内容没变就不新增。
            # fingerprint 存榜单/份额的结构摘要，比对时不用解析 1~2MB 的 JSON；
            # checked_at 是「最后一次确认过内容相同」的时间（无变化时只更新它）。
            # 老库里的唯一索引 ux_rmon_srps 必须拆掉，否则同日第二条插入直接报错。
            conn.execute("DROP INDEX IF EXISTS ux_rmon_srps")
            _meta_cols = {r[1] for r in conn.execute("PRAGMA table_info(rmon_asin_meta)")}
            if _meta_cols and "src" not in _meta_cols:
                # 来源标记：age = 由 SIF 上架天数换算（可能差 1 天）/ asin = 档案原始日期
                conn.execute("ALTER TABLE rmon_asin_meta ADD COLUMN src TEXT")
            for _tbl in ("rmon_srps", "rmon_queries"):
                _cols = {r[1] for r in conn.execute(f"PRAGMA table_info({_tbl})")}
                if _cols:
                    if "fingerprint" not in _cols:
                        conn.execute(f"ALTER TABLE {_tbl} ADD COLUMN fingerprint TEXT")
                    if "changed" not in _cols:
                        conn.execute(f"ALTER TABLE {_tbl} ADD COLUMN changed INTEGER DEFAULT 1")
                    if "checked_at" not in _cols:
                        conn.execute(f"ALTER TABLE {_tbl} ADD COLUMN checked_at TEXT")

            # 采集结果去重：早期「重试失败项」走 INSERT 而非 UPSERT，同一 (task_id, asin)
            # 会累积多行。先导出备份再清理（每对只保留最新一次），随后建唯一索引，
            # 之后 save_scrape_products 用 ON CONFLICT DO UPDATE 收敛到一行。
            _dedupe_scrape_products(conn)

            # 「重采 · 新增一条记录」支持：唯一约束从 (task_id, asin) 放宽到
            # (task_id, asin, seq)。seq=0 是被「替换」覆盖的那条；「新增」写 seq=max+1。
            # 正常采集路径一律写 seq=0，行为与以前完全一致（同 ASIN 仍是覆盖，不产生重复）。
            _scraped_cols = {r[1] for r in conn.execute("PRAGMA table_info(scrape_products)")}
            if "seq" not in _scraped_cols:
                conn.execute("ALTER TABLE scrape_products ADD COLUMN seq INTEGER DEFAULT 0")
                conn.execute("UPDATE scrape_products SET seq=0 WHERE seq IS NULL")
            # 旧索引（更严格）必须**无条件**确保不存在：_dedupe_scrape_products 在老库上
            # 可能把它重建出来，留着会拦死「新增一条记录」。
            conn.execute("DROP INDEX IF EXISTS idx_scrape_prod_task_asin")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_scrape_prod_task_asin_seq "
                         "ON scrape_products(task_id, asin, seq)")
            # 评论媒体（图片/视频）：按需经 CDP 抓取后缓存为 JSON 数组；未抓过为 NULL。
            # 与采集主链路解耦——采集阶段不写它，只在详情页 tab / 批量预热时写入。
            if "review_media" not in _scraped_cols:
                conn.execute("ALTER TABLE scrape_products ADD COLUMN review_media TEXT")

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
                _log("[info] SIF 模块已迁移到 v2（爆品关键词监控），旧任务与快照数据已清空")

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

    # 采集任务状态（服务端后台执行，见 routes/scrape.py）：
    #   running   后台线程正在跑
    #   paused    服务重启中断，可从断点继续
    #   completed 全部 ASIN 成功
    #   partial   跑完了但有失败项（可重试失败项）
    #   cancelled 用户主动取消
    #   error     执行过程抛异常
    def _row_to_scrape_task(self, row):
        return {
            "id":          row["id"],
            "marketplace": row["marketplace"],
            "name":        row["name"],
            "total":       row["total"],
            "success":     row["success"],
            "failed":      row["failed"],
            "withReviews": bool(row["with_reviews"]),
            "withCustomersSay": bool(row["with_customers_say"]),
            "status":      row["status"],
            "createdAt":   row["created_at"],
            "asins":       json.loads(row["asins"] or "[]"),
            "startedAt":   row["started_at"],
            "endedAt":     row["ended_at"],
            "error":       row["error"],
        }

    def create_scrape_task(self, marketplace, asins, with_reviews, name=None,
                           with_customers_say=True):
        """建任务并把完整 ASIN 列表落库——这是断点续跑的唯一依据。"""
        tid = "st" + secrets.token_hex(6)
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO scrape_tasks
                       (id, marketplace, name, total, success, failed, with_reviews,
                        with_customers_say, status, created_at, asins, started_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    [tid, marketplace, name, len(asins), 0, 0, 1 if with_reviews else 0,
                     1 if with_customers_say else 0,
                     "running", now, json.dumps(list(asins), ensure_ascii=False), now],
                )
                conn.commit()
        return tid

    def get_scrape_task(self, task_id):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM scrape_tasks WHERE id=?", [task_id]).fetchone()
            return self._row_to_scrape_task(row) if row else None

    def set_scrape_task_status(self, task_id, status, error=None,
                               started_at=None, ended_at=None):
        """显式设置任务状态与运行窗口。

        刻意与进度计数分开：早期版本每次写结果都顺手把 status 改成 completed，
        结果任务刚跑完第一批就显示「已完成」，完全看不出只跑了不到三成。
        error 每次都写（允许清空），时间戳只在传入时更新。
        """
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE scrape_tasks SET status=?, error=?, "
                    "started_at=COALESCE(?, started_at), ended_at=COALESCE(?, ended_at) "
                    "WHERE id=?",
                    [status, error, started_at, ended_at, task_id],
                )
                conn.commit()

    def refresh_scrape_task_counts(self, task_id):
        """按已落库结果重算 success / failed，而不是累加。

        累加会把「失败后重试成功」的 ASIN 同时计进两边，导致 success + failed > total；
        重算则始终等于结果表里的真实分布。

        注意按 **asin 去重**统计：同一 ASIN 可能因「重采 · 新增一条记录」存在多行
        （seq=0/1/…），直接 COUNT(*) 会让 success 超过任务的 ASIN 总数。
        判定口径与 get_scrape_done_asins 一致 —— 任意一行成功即算该 ASIN 成功。
        """
        with self.lock:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT COUNT(DISTINCT asin) n, "
                    "COUNT(DISTINCT CASE WHEN status='success' THEN asin END) s "
                    "FROM scrape_products WHERE task_id=?", [task_id]
                ).fetchone()
                done = row[0] or 0
                ok = row[1] or 0
                conn.execute("UPDATE scrape_tasks SET success=?, failed=? WHERE id=?",
                             [ok, done - ok, task_id])
                conn.commit()

    def update_scrape_task_asins(self, task_id, asins):
        """合并 ASIN 列表（重试失败项时复用同一任务），total 随之对齐。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE scrape_tasks SET asins=?, total=? WHERE id=?",
                    [json.dumps(list(asins), ensure_ascii=False), len(asins), task_id],
                )
                conn.commit()

    def get_scrape_done_asins(self, task_id):
        """已成功采集的 ASIN 集合——续跑时与原始列表做差集，跳过跑过的。"""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT asin FROM scrape_products WHERE task_id=? AND status='success'",
                [task_id]
            ).fetchall()
            return {r[0] for r in rows}

    def mark_running_scrape_tasks_paused(self):
        """服务启动时把残留的 running 标记为 paused（可续跑），返回受影响条数。"""
        with self.lock:
            with self._conn() as conn:
                cur = conn.execute(
                    "UPDATE scrape_tasks SET status='paused', "
                    "error='服务重启导致中断，可点击继续' WHERE status='running'"
                )
                conn.commit()
                return cur.rowcount

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

    def next_scrape_product_seq(self, task_id, asin):
        """该 (task_id, asin) 下一个可用的 seq —— 「重采 · 新增一条记录」用。

        库中不存在该 ASIN 时返回 0（等价于首次落库）；否则返回 max(seq)+1，
        即在同任务同 ASIN 下追加一个新版本行（旧版本保留，不覆盖）。
        """
        with self._conn() as conn:
            row = conn.execute(
                "SELECT MAX(seq) AS m FROM scrape_products WHERE task_id=? AND asin=?",
                [task_id, asin]).fetchone()
        m = row["m"] if row else None
        return 0 if m is None else int(m) + 1

    def save_scrape_products(self, task_id, products):
        """写入采集结果，按 (task_id, asin, seq) 收敛为一行。

        默认 seq=0：重试/重采（替换）某个 ASIN 时直接覆盖旧结果，不会累积重复行
        （早期版本同一任务同一 ASIN 最多出现 3 条，列表里也是重复展示，已修）。
        「重采 · 新增一条记录」由调用方在 product 里带 seq=max+1 —— 这是**用户显式
        选择**才产生的多行，用于对比新旧数据，与上面那个 bug 不是一回事。
        """
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
                            customers_say_tags, customers_say_aspects,
                            review_images, select_to_learn_more, status, error_message, scraped_at,
                            seq)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                           ON CONFLICT(task_id, asin, seq) DO UPDATE SET
                               marketplace=excluded.marketplace, title=excluded.title,
                               brand=excluded.brand, price=excluded.price,
                               rating=excluded.rating, review_count=excluded.review_count,
                               availability=excluded.availability,
                               bullet_points=excluded.bullet_points,
                               description=excluded.description,
                               main_image=excluded.main_image, images=excluded.images,
                               aplus_images=excluded.aplus_images,
                               specifications=excluded.specifications,
                               product_details=excluded.product_details,
                               categories=excluded.categories, seller=excluded.seller,
                               bsr_main_category=excluded.bsr_main_category,
                               bsr_main_rank=excluded.bsr_main_rank,
                               bsr_sub_category=excluded.bsr_sub_category,
                               bsr_sub_rank=excluded.bsr_sub_rank,
                               bsr_raw_text=excluded.bsr_raw_text,
                               customers_say=excluded.customers_say,
                               customers_say_tags=excluded.customers_say_tags,
                               customers_say_aspects=excluded.customers_say_aspects,
                               review_images=excluded.review_images,
                               select_to_learn_more=excluded.select_to_learn_more,
                               status=excluded.status, error_message=excluded.error_message,
                               scraped_at=excluded.scraped_at""",
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
                            p.get("customers_say_tags"),
                            p.get("customers_say_aspects"),
                            json.dumps(p.get("review_images", []), ensure_ascii=False),
                            json.dumps(p.get("select_to_learn_more", []), ensure_ascii=False),
                            p.get("status"), p.get("error_message"), now,
                            int(p.get("seq") or 0),
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
                "customersSayTags": row["customers_say_tags"],
                "customersSayAspects": json.loads(row["customers_say_aspects"] or "[]"),
                "reviewImages":     json.loads(row["review_images"] or "[]"),
                "selectToLearnMore": json.loads(row["select_to_learn_more"] or "[]"),
                # 评论媒体（图片/视频）：按需抓取后缓存的 JSON；未抓过为 []（前端据此显示「尚未采集」）
                "reviewMedia":      json.loads(row["review_media"] or "[]"),
                # 区分「从未抓过」与「抓过但该产品确实没有媒体」——
                # 前者点 tab 会触发抓取，后者直接显示「无媒体」，避免反复重抓
                "reviewMediaFetched": row["review_media"] is not None,
            },
            "status":       row["status"],
            "errorMessage": row["error_message"],
            "scrapedAt":    row["scraped_at"],
            "seq":          row["seq"] if row["seq"] is not None else 0,
        }

    def save_review_media(self, asin, media):
        """缓存某 ASIN 的评论媒体（按需抓取后写入）。

        故意按 **asin** 更新（不限 task_id）：评论媒体是「产品级」属性，
        同一 ASIN 可能出现在多个任务里，抓一次应处处可见，避免重复消耗额度。
        只覆盖 review_media 一列，不动其它字段；返回受影响行数（0 = 库里还没有该 ASIN）。
        """
        payload = json.dumps(media or [], ensure_ascii=False)
        with self.lock:
            with self._conn() as conn:
                cur = conn.execute(
                    "UPDATE scrape_products SET review_media=? WHERE asin=?", [payload, asin])
                conn.commit()
                return cur.rowcount

    def cleanup_review_media(self, task_id, asin):
        """清空某 ASIN 的媒体缓存（用于「重新抓取」前先作废）。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE scrape_products SET review_media=NULL WHERE task_id=? AND asin=?",
                    [task_id, asin])
                conn.commit()

    def get_review_media(self, task_id, asin):
        """读某任务某 ASIN 的媒体缓存。

        返回语义（三态，别混）：
          None  → 从未抓过（点 tab 应触发抓取）
          []    → 抓过，但该产品确实没有评论媒体
          [...] → 抓到了媒体
        """
        with self._conn() as conn:
            row = conn.execute(
                "SELECT review_media FROM scrape_products "
                "WHERE task_id=? AND asin=? AND seq=0", [task_id, asin]).fetchone()
        if not row or row[0] is None:
            return None
        try:
            return json.loads(row[0])
        except Exception:
            return []

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

    # ---- 流量分析报告历史（traffic-compare）----
    # 不走 ai_analysis_tasks：报告是一次模型调用（十几秒），不是后台跑几分钟的
    # claude 子进程，塞进任务队列会被 AiAnalysisWorker 误当成待执行任务。

    def upsert_traffic_report(self, record: dict):
        """写入/覆盖一条报告记录（同一 datasetId 重新生成时覆盖）。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO traffic_reports
                       (id, asin, period_label, period_value, username, model,
                        report_chars, alert_count, md_path, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET
                         model=excluded.model,
                         report_chars=excluded.report_chars,
                         alert_count=excluded.alert_count,
                         md_path=excluded.md_path,
                         created_at=excluded.created_at""",
                    [record.get("id"), record.get("asin"), record.get("period_label"),
                     record.get("period_value"), record.get("username"), record.get("model"),
                     int(record.get("report_chars") or 0), int(record.get("alert_count") or 0),
                     record.get("md_path"), record.get("created_at") or _now_iso()],
                )
                conn.commit()

    def list_traffic_reports(self, asin: str = None, limit: int = 50) -> list:
        with self._conn() as conn:
            if asin:
                rows = conn.execute(
                    "SELECT * FROM traffic_reports WHERE asin=? ORDER BY created_at DESC LIMIT ?",
                    [asin, limit]).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM traffic_reports ORDER BY created_at DESC LIMIT ?",
                    [limit]).fetchall()
        return [dict(r) for r in rows]

    def get_traffic_report(self, rid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM traffic_reports WHERE id=?", [rid]).fetchone()
        return dict(row) if row else None

    def delete_traffic_report(self, rid: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM traffic_reports WHERE id=?", [rid])
                conn.commit()

    # ---- 排名监测：目标 / 快照 / 变动事件 ----

    def upsert_rank_target(self, kind: str, value: str, country: str = "US",
                           label: str = None, own_asin: str = None,
                           freq: str = "daily", username: str = None,
                           competitor_n: int = None, run_at: str = None,
                           extra_asins=None) -> str:
        """加监测目标。同一 (kind, value, country) 已存在时复用并更新配置，
        避免用户重复添加同一词导致每次抓两遍。"""
        kind = (kind or "").strip().lower()
        value = (value or "").strip()
        country = (country or "US").upper()[:4]
        with self.lock:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT id FROM rmon_targets WHERE kind=? AND value=? AND country=?",
                    [kind, value.upper() if kind == "asin" else value, country],
                ).fetchone()
                if row:
                    tid = row["id"] if isinstance(row, dict) or hasattr(row, "keys") else row[0]
                    conn.execute(
                        """UPDATE rmon_targets
                           SET label=COALESCE(?, label), own_asin=COALESCE(?, own_asin),
                               freq=?, competitor_n=COALESCE(?, competitor_n),
                               run_at=COALESCE(?, run_at),
                               extra_asins=COALESCE(?, extra_asins), enabled=1
                           WHERE id=?""",
                        [label, own_asin, freq, competitor_n, run_at,
                         json.dumps(extra_asins, ensure_ascii=False) if extra_asins is not None else None,
                         tid],
                    )
                    conn.commit()
                    return tid
                tid = "rt" + secrets.token_hex(6)
                conn.execute(
                    """INSERT INTO rmon_targets
                       (id, kind, value, label, country, own_asin, freq, competitor_n,
                        run_at, extra_asins, enabled, username, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)""",
                    [tid, kind, value.upper() if kind == "asin" else value, label, country,
                     own_asin, freq, competitor_n if competitor_n else 10, run_at or None,
                     json.dumps(extra_asins, ensure_ascii=False) if extra_asins else None,
                     username, _now_iso()],
                )
                conn.commit()
        return tid

    def list_rank_targets(self, kind: str = None, enabled_only: bool = True) -> list:
        sql = "SELECT * FROM rmon_targets"
        cond, args = [], []
        if kind:
            cond.append("kind=?")
            args.append(kind)
        if enabled_only:
            cond.append("enabled=1")
        if cond:
            sql += " WHERE " + " AND ".join(cond)
        sql += " ORDER BY created_at DESC"
        with self._conn() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]

    def get_rank_target(self, tid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM rmon_targets WHERE id=?", [tid]).fetchone()
        return dict(row) if row else None

    def update_rank_target(self, tid: str, **kwargs):
        allowed = {"label", "own_asin", "freq", "enabled", "competitor_n", "paused",
                   "run_at", "extra_asins", "last_run_at", "last_status", "last_error"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        with self.lock:
            with self._conn() as conn:
                conn.execute(f"UPDATE rmon_targets SET {sets} WHERE id=?",
                             list(fields.values()) + [tid])
                conn.commit()

    def delete_rank_target(self, tid: str):
        """删目标时连快照与事件一起删，避免孤儿数据。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM rmon_snapshots WHERE target_id=?", [tid])
                conn.execute("DELETE FROM rmon_events WHERE target_id=?", [tid])
                conn.execute("DELETE FROM rmon_targets WHERE id=?", [tid])
                conn.commit()

    def add_rank_snapshot(self, target_id: str, snap_date: str, data: dict):
        """写当日快照；同一天重跑时覆盖（不累积重复行）。"""
        sid = f"{target_id}_{snap_date}"
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO rmon_snapshots (id, target_id, snap_date, data, created_at)
                       VALUES (?,?,?,?,?)
                       ON CONFLICT(target_id, snap_date) DO UPDATE SET
                         data=excluded.data, created_at=excluded.created_at""",
                    [sid, target_id, snap_date, json.dumps(data, ensure_ascii=False), _now_iso()],
                )
                conn.commit()

    def _snap_row(self, row):
        if not row:
            return None
        d = dict(row)
        try:
            d["data"] = json.loads(d.get("data") or "{}")
        except Exception:
            d["data"] = {}
        return d

    def get_latest_snapshot(self, target_id: str):
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM rmon_snapshots WHERE target_id=? ORDER BY snap_date DESC LIMIT 1",
                [target_id],
            ).fetchone()
        return self._snap_row(row)

    def get_snapshot_before(self, target_id: str, before_date: str):
        """取 before_date 之前（不含）最近一条，用于算变动。"""
        with self._conn() as conn:
            row = conn.execute(
                """SELECT * FROM rmon_snapshots WHERE target_id=? AND snap_date<?
                   ORDER BY snap_date DESC LIMIT 1""",
                [target_id, before_date],
            ).fetchone()
        return self._snap_row(row)

    def list_rank_snapshots(self, target_id: str, limit: int = 30) -> list:
        """快照列表（新→旧）。data 不返回，列表页只要日期与摘要。"""
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT id, target_id, snap_date, created_at FROM rmon_snapshots
                   WHERE target_id=? ORDER BY snap_date DESC LIMIT ?""",
                [target_id, limit],
            ).fetchall()
        return [dict(r) for r in rows]

    def list_rank_snapshots_full(self, target_id: str, limit: int = 90) -> list:
        """快照（含 data，旧→新）。趋势图要用逐日数据，所以这里必须带 data。

        注意顺序：返回**旧→新**，方便直接喂给折线图；列表页那个 list_rank_snapshots
        是新→旧（最近的在上面）。
        """
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT * FROM rmon_snapshots WHERE target_id=?
                   ORDER BY snap_date DESC LIMIT ?""",
                [target_id, limit],
            ).fetchall()
        out = [self._snap_row(r) for r in rows]
        out.reverse()
        return [x for x in out if x]

    def add_rank_event(self, target_id: str, level: str, kind: str, subject: str,
                       detail: str, prev_value=None, curr_value=None):
        eid = "re" + secrets.token_hex(6)
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    """INSERT INTO rmon_events
                       (id, target_id, detected_at, level, kind, subject, detail,
                        prev_value, curr_value, acked)
                       VALUES (?,?,?,?,?,?,?,?,?,0)""",
                    [eid, target_id, _now_iso(), level, kind, subject, detail,
                     None if prev_value is None else str(prev_value),
                     None if curr_value is None else str(curr_value)],
                )
                conn.commit()
        return eid

    def list_rank_events(self, target_id: str = None, limit: int = 100) -> list:
        with self._conn() as conn:
            if target_id:
                rows = conn.execute(
                    "SELECT * FROM rmon_events WHERE target_id=? ORDER BY detected_at DESC LIMIT ?",
                    [target_id, limit],
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM rmon_events ORDER BY detected_at DESC LIMIT ?", [limit]
                ).fetchall()
        return [dict(r) for r in rows]

    def clear_rank_events_on(self, target_id: str, day: str):
        """清掉某一天产生的变动事件（同日重跑时先清再写，避免重复行）。"""
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "DELETE FROM rmon_events WHERE target_id=? AND substr(detected_at, 1, 10)=?",
                    [target_id, day],
                )
                conn.commit()

    def clear_rank_events(self, target_id: str = None):
        with self.lock:
            with self._conn() as conn:
                if target_id:
                    conn.execute("DELETE FROM rmon_events WHERE target_id=?", [target_id])
                else:
                    conn.execute("DELETE FROM rmon_events")
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


    # ---- 排名监测：全局设置 ----

    # 全局只保留「新目标的默认竞品数」用于预填；采集时刻已下沉到每个关键词（rmon_targets.run_at）
    RMON_DEFAULT_SETTINGS = {
        "default_competitor_n": "10",
        # 爬虫抓搜索页的默认页数（每页 48 条，5 页 = 240 位是安全上限）
        "scrape_pages": "3",
    }

    def get_rmon_settings(self) -> dict:
        """只返回白名单里的键。老库里可能残留已废弃的配置行（如 daily_at），
        不过滤的话会跟着返回，UI 上看起来像"删了还在"。"""
        out = dict(self.RMON_DEFAULT_SETTINGS)
        try:
            with self._conn() as conn:
                rows = conn.execute("SELECT k, v FROM rmon_settings").fetchall()
            for r in rows:
                k = r["k"] if hasattr(r, "keys") else r[0]
                v = r["v"] if hasattr(r, "keys") else r[1]
                if k in self.RMON_DEFAULT_SETTINGS:
                    out[k] = v
        except Exception:
            pass
        return out

    def set_rmon_settings(self, **kw):
        allowed = set(self.RMON_DEFAULT_SETTINGS)
        fields = {k: ("" if v is None else str(v)) for k, v in kw.items() if k in allowed}
        if not fields:
            return
        with self.lock:
            with self._conn() as conn:
                for k, v in fields.items():
                    conn.execute(
                        "INSERT INTO rmon_settings (k, v) VALUES (?,?) "
                        "ON CONFLICT(k) DO UPDATE SET v=excluded.v", [k, v])
                conn.commit()

    # ---- 排名监测：即时查询历史 ----

    def add_rank_query(self, kind: str, value: str, country: str, own_asin,
                       summary: str, data: dict, username: str = None,
                       fingerprint: str = None) -> dict:
        """写一条查询历史。**同一天内：内容没变就不新增，变了才追加一条。**

        早期是纯 INSERT（点一次刷新就多一条），后来改成「同词同日先删后插」（覆盖）。
        覆盖的副作用是没有旧记录可比对，于是「有没有变化」无从判断。现在按内容指纹比对：
          · 与当天最后一条指纹相同 -> 只把 checked_at 改到现在，不新增快照
          · 不同（或当天还没有记录）-> 追加一条新记录
        返回 {changed, id, checked_at}，调用方据此给「已更新 / 无变化」回执。
        """
        now = _now_iso()
        day = now[:10]
        with self.lock:
            with self._conn() as conn:
                last = conn.execute(
                    "SELECT id, fingerprint FROM rmon_queries "
                    "WHERE kind=? AND UPPER(value)=UPPER(?) AND UPPER(country)=UPPER(?) "
                    "AND substr(created_at, 1, 10)=? ORDER BY created_at DESC LIMIT 1",
                    [kind, value, country or "US", day],
                ).fetchone()
                if last and fingerprint and last["fingerprint"] == fingerprint:
                    conn.execute("UPDATE rmon_queries SET checked_at=? WHERE id=?",
                                 [now, last["id"]])
                    conn.commit()
                    return {"changed": False, "id": last["id"], "checked_at": now}

                # 老数据没有指纹（升级前写入的）：拿它自己的 data 现算一次补上，
                # 否则第一次点「获取最新数据」会误判成「有变化」而多出一条。
                if last and fingerprint and not last["fingerprint"]:
                    try:
                        from .fingerprint import sif_fingerprint
                        old = conn.execute("SELECT data FROM rmon_queries WHERE id=?",
                                           [last["id"]]).fetchone()
                        legacy = sif_fingerprint(json.loads(old["data"] or "{}"))
                    except Exception:
                        legacy = None
                    if legacy == fingerprint:
                        conn.execute(
                            "UPDATE rmon_queries SET fingerprint=?, checked_at=? WHERE id=?",
                            [fingerprint, now, last["id"]])
                        conn.commit()
                        return {"changed": False, "id": last["id"], "checked_at": now}

                qid = "rq" + secrets.token_hex(6)
                conn.execute(
                    """INSERT INTO rmon_queries
                       (id, kind, value, country, own_asin, summary, data, username,
                        created_at, fingerprint, changed, checked_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,1,?)""",
                    [qid, kind, value, country or "US", own_asin, summary,
                     json.dumps(data, ensure_ascii=False), username, now, fingerprint, now],
                )
                conn.commit()
        return {"changed": True, "id": qid, "checked_at": now}

    def list_rank_queries(self, limit: int = 100) -> list:
        """列表不返回 data（大字段），只给摘要。"""
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT id, kind, value, country, own_asin, summary, username, created_at
                   FROM rmon_queries ORDER BY created_at DESC LIMIT ?""", [limit]
            ).fetchall()
        return [dict(r) for r in rows]

    def get_rank_query(self, qid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM rmon_queries WHERE id=?", [qid]).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["data"] = json.loads(d.get("data") or "{}")
        except Exception:
            d["data"] = {}
        return d

    def list_rank_queries_by_target(self, kind: str, value: str, limit: int = 60) -> list:
        """同一目标的所有查询记录（旧→新，含 data）。

        没建监测目标时，趋势就用它算 —— 用户反复查同一个词，本身就是一条时间序列。
        """
        with self._conn() as conn:
            # 两边都 UPPER 再比：关键词有大小写混写（用户可能改动过），ASIN 本来该全大写，
            # 只对一边做 UPPER 会漏掉另一侧（曾因此查不到任何记录）。
            rows = conn.execute(
                """SELECT * FROM rmon_queries WHERE kind=? AND UPPER(value)=UPPER(?)
                   ORDER BY created_at ASC LIMIT ?""",
                [kind, value, limit],
            ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["data"] = json.loads(d.get("data") or "{}")
            except Exception:
                d["data"] = {}
            out.append(d)
        return out

    def delete_rank_query(self, qid: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM rmon_queries WHERE id=?", [qid])
                conn.commit()

    def clear_rank_queries(self):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM rmon_queries")
                conn.commit()

    # ------------------------------------------------------------------
    # 关键词搜索页快照（爬虫实测）—— 与上面 SIF 的 rmon_queries 完全隔离，
    # 两套数据各自存、各自查，页面上不交叉比较（口径与采集时刻都不同）。
    # ------------------------------------------------------------------
    def save_rmon_srp(self, keyword: str, country: str, result: dict,
                      username: str = None, fingerprint: str = None) -> dict:
        """存一次抓取结果。**同一天内：内容没变就不新增，变了才追加一条。**

        曾经的写法是「同词同日先删后插」，覆盖的副作用是没有旧记录可比对，
        根本判断不了「这次和上次一不一样」。现在按内容指纹比对：
          · 与当天最后一条指纹相同 -> 只更新 checked_at，不新增快照
          · 不同（或当天还没有记录）-> 追加一条
        跨天仍是每天至少一条，所以趋势图/热力图不会因去重而缺日。
        返回 {changed, id, checked_at}。
        """
        now = _now_iso()
        day = now[:10]
        with self.lock:
            with self._conn() as conn:
                last = conn.execute(
                    "SELECT id, fingerprint FROM rmon_srps "
                    "WHERE UPPER(keyword)=UPPER(?) AND UPPER(country)=UPPER(?) "
                    "AND snap_date=? ORDER BY created_at DESC LIMIT 1",
                    [keyword, country, day],
                ).fetchone()
                if last and fingerprint and last["fingerprint"] == fingerprint:
                    conn.execute("UPDATE rmon_srps SET checked_at=? WHERE id=?",
                                 [now, last["id"]])
                    conn.commit()
                    return {"changed": False, "id": last["id"], "checked_at": now}

                # 老数据没有指纹（升级前写入的）：现算一次补上，
                # 否则第一次点「获取最新数据」会误判成「有变化」而多出一条。
                if last and fingerprint and not last["fingerprint"]:
                    try:
                        from .fingerprint import srp_fingerprint
                        old = conn.execute("SELECT data FROM rmon_srps WHERE id=?",
                                           [last["id"]]).fetchone()
                        legacy = srp_fingerprint(json.loads(old["data"] or "{}"))
                    except Exception:
                        legacy = None
                    if legacy == fingerprint:
                        conn.execute(
                            "UPDATE rmon_srps SET fingerprint=?, checked_at=? WHERE id=?",
                            [fingerprint, now, last["id"]])
                        conn.commit()
                        return {"changed": False, "id": last["id"], "checked_at": now}

                sid = "sr" + secrets.token_hex(6)
                conn.execute(
                    """INSERT INTO rmon_srps
                       (id, keyword, country, snap_date, pages, org_total, ad_total,
                        elapsed, warn, data, username, created_at, fingerprint, changed, checked_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)""",
                    [sid, keyword, country, day, result.get("pages_ok"),
                     result.get("org_total"), result.get("ad_total"),
                     result.get("elapsed"), result.get("warn"),
                     json.dumps(result, ensure_ascii=False), username, now,
                     fingerprint, now],
                )
                conn.commit()
        return {"changed": True, "id": sid, "checked_at": now}

    def add_rmon_check(self, source: str, keyword: str, country: str = "US",
                       note: str = "", username: str = None) -> str:
        """记一条「检查过、内容没变」的留痕（不存快照，只记时间与说明）。"""
        cid = "ck" + secrets.token_hex(6)
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "INSERT INTO rmon_checks (id, source, keyword, country, checked_at, note, username) "
                    "VALUES (?,?,?,?,?,?,?)",
                    [cid, source, keyword, country or "US", _now_iso(), note, username],
                )
                conn.commit()
        return cid

    def list_rmon_checks(self, source: str, keyword: str, country: str = "US",
                         limit: int = 20) -> list:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id, checked_at, note FROM rmon_checks "
                "WHERE source=? AND UPPER(keyword)=UPPER(?) AND UPPER(country)=UPPER(?) "
                "ORDER BY checked_at DESC LIMIT ?",
                [source, keyword, country or "US", limit],
            ).fetchall()
        return [dict(r) for r in rows]

    def list_rmon_srps(self, keyword: str = None, country: str = None,
                       limit: int = 60) -> list:
        """抓取历史列表，不返回 data（大字段）。"""
        sql = ("SELECT id, keyword, country, snap_date, pages, org_total, ad_total, "
               "elapsed, warn, username, created_at FROM rmon_srps WHERE 1=1")
        args = []
        if keyword:
            sql += " AND UPPER(keyword)=UPPER(?)"
            args.append(keyword)
        if country:
            sql += " AND UPPER(country)=UPPER(?)"
            args.append(country)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        with self._conn() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]

    def get_rmon_srp(self, sid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM rmon_srps WHERE id=?", [sid]).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["data"] = json.loads(d.get("data") or "{}")
        except Exception:
            d["data"] = {}
        return d

    def get_rmon_srp_latest(self, keyword: str, country: str = "US"):
        with self._conn() as conn:
            row = conn.execute(
                """SELECT * FROM rmon_srps
                   WHERE UPPER(keyword)=UPPER(?) AND UPPER(country)=UPPER(?)
                   ORDER BY created_at DESC LIMIT 1""",
                [keyword, country],
            ).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["data"] = json.loads(d.get("data") or "{}")
        except Exception:
            d["data"] = {}
        return d

    def list_rmon_srp_series(self, keyword: str, country: str = "US",
                             limit: int = 60) -> list:
        """按时间正序返回每日榜单（含 data），供趋势与热力图聚合用。"""
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT * FROM rmon_srps
                   WHERE UPPER(keyword)=UPPER(?) AND UPPER(country)=UPPER(?)
                   ORDER BY created_at DESC LIMIT ?""",
                [keyword, country, limit],
            ).fetchall()
        out = []
        for r in reversed(rows):
            d = dict(r)
            try:
                d["data"] = json.loads(d.get("data") or "{}")
            except Exception:
                d["data"] = {}
            out.append(d)
        return out

    def delete_rmon_srp(self, sid: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM rmon_srps WHERE id=?", [sid])
                conn.commit()

    def get_srp_cfg(self, keyword: str, country: str = "US"):
        """该关键词自己保存的抓取页数；没配过返回 None（调用方回落到默认值）。"""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT pages FROM rmon_srp_cfg "
                "WHERE UPPER(keyword)=UPPER(?) AND UPPER(country)=UPPER(?)",
                [keyword, country],
            ).fetchone()
        if not row:
            return None
        try:
            return int(row[0])
        except (TypeError, ValueError):
            return None

    def set_srp_cfg(self, keyword: str, country: str, pages: int) -> None:
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "DELETE FROM rmon_srp_cfg "
                    "WHERE UPPER(keyword)=UPPER(?) AND UPPER(country)=UPPER(?)",
                    [keyword, country],
                )
                conn.execute(
                    "INSERT INTO rmon_srp_cfg (keyword, country, pages, updated_at) "
                    "VALUES (?,?,?,?)",
                    [keyword, country, pages, _now_iso()],
                )
                conn.commit()

    def list_srp_cfg(self, limit: int = 200) -> list:
        """所有已配置过的词（前端显示「这个词配了几页」用）。"""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT keyword, country, pages, updated_at FROM rmon_srp_cfg "
                "ORDER BY updated_at DESC LIMIT ?", [limit],
            ).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------
    # ASIN 静态属性缓存（上架日期/品牌）：先读缓存，缺了才问 SIF
    # ------------------------------------------------------------------
    def get_rmon_asin_meta(self, asins: list) -> dict:
        """批量读缓存，返回 {ASIN: {first_available_day, brand, fetched_at}}。

        只返回**库里已有**的（含负缓存：first_available_day == ""）。
        调用方据此判断哪些还需要去问 SIF。
        """
        keys = [str(a or "").upper() for a in (asins or []) if a]
        if not keys:
            return {}
        out = {}
        with self._conn() as conn:
            # SQLite 变量数上限 999，分批查（一次最多 60 个，够用，仍按 200 切）
            for i in range(0, len(keys), 200):
                chunk = keys[i:i + 200]
                ph = ",".join("?" * len(chunk))
                rows = conn.execute(
                    f"SELECT asin, first_available_day, brand, fetched_at, src "
                    f"FROM rmon_asin_meta WHERE UPPER(asin) IN ({ph})", chunk,
                ).fetchall()
                for r in rows:
                    out[str(r["asin"]).upper()] = {
                        "first_available_day": r["first_available_day"] or "",
                        "brand": r["brand"] or "",
                        "fetched_at": r["fetched_at"],
                        "src": r["src"] or "",
                    }
        return out

    def upsert_rmon_asin_meta(self, rows: list):
        """写缓存。rows = [{asin, first_available_day, brand}]，已存在就覆盖。"""
        if not rows:
            return
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                for r in rows:
                    asin = str(r.get("asin") or "").upper()
                    if not asin:
                        continue
                    conn.execute(
                        "INSERT INTO rmon_asin_meta (asin, first_available_day, brand, fetched_at, src) "
                        "VALUES (?,?,?,?,?) ON CONFLICT(asin) DO UPDATE SET "
                        "first_available_day=excluded.first_available_day, "
                        "brand=excluded.brand, fetched_at=excluded.fetched_at, "
                        "src=COALESCE(excluded.src, rmon_asin_meta.src)",
                        [asin, r.get("first_available_day") or "",
                         r.get("brand") or "", now, r.get("src")],
                    )
                conn.commit()

    # ------------------------------------------------------------------
    # 关键词搜索趋势缓存（SIF ABA 周数据，周维度、每天只微调）
    # ------------------------------------------------------------------
    def get_rmon_kw_trend(self, keyword: str, country: str = "US",
                          granularity: str = "week", max_age_hours: int = 12):
        """返回 (payload, fetched_at)；不存在或已过期返回 (None, None)。"""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT payload, fetched_at FROM rmon_kw_trend "
                "WHERE UPPER(keyword)=UPPER(?) AND UPPER(country)=UPPER(?) "
                "AND granularity=?",
                [keyword, country, granularity],
            ).fetchone()
        if not row:
            return None, None
        fetched = row["fetched_at"] or ""
        if max_age_hours > 0:
            try:
                t = datetime.datetime.strptime(fetched[:19], "%Y-%m-%dT%H:%M:%S")
                if (datetime.datetime.now() - t).total_seconds() > max_age_hours * 3600:
                    return None, fetched
            except ValueError:
                return None, fetched
        try:
            return json.loads(row["payload"] or "{}"), fetched
        except json.JSONDecodeError:
            return None, fetched

    def save_rmon_kw_trend(self, keyword: str, country: str, granularity: str, payload: dict):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "INSERT INTO rmon_kw_trend (keyword, country, granularity, payload, fetched_at) "
                    "VALUES (?,?,?,?,?) ON CONFLICT(keyword, country, granularity) DO UPDATE SET "
                    "payload=excluded.payload, fetched_at=excluded.fetched_at",
                    [keyword, country.upper(), granularity, json.dumps(payload, ensure_ascii=False),
                     _now_iso()],
                )
                conn.commit()

    # ------------------------------------------------------------------
    # 前台实测的定时监测目标（每天自动抓某个词的搜索页榜单）
    # ------------------------------------------------------------------
    def upsert_srp_target(self, keyword: str, country: str = "US", pages: int = 3,
                          daily_at: str = "", enabled: bool = True,
                          username: str = None) -> dict:
        tid = "st" + secrets.token_hex(6)
        now = _now_iso()
        with self.lock:
            with self._conn() as conn:
                row = conn.execute(
                    "SELECT id FROM rmon_srp_targets "
                    "WHERE UPPER(keyword)=UPPER(?) AND UPPER(country)=UPPER(?)",
                    [keyword, country],
                ).fetchone()
                if row:
                    tid = row[0]
                    conn.execute(
                        "UPDATE rmon_srp_targets SET pages=?, daily_at=?, enabled=? WHERE id=?",
                        [pages, daily_at or "", 1 if enabled else 0, tid],
                    )
                else:
                    conn.execute(
                        """INSERT INTO rmon_srp_targets
                           (id, keyword, country, pages, daily_at, enabled, username, created_at)
                           VALUES (?,?,?,?,?,?,?,?)""",
                        [tid, keyword, country, pages, daily_at or "",
                         1 if enabled else 0, username, now],
                    )
                conn.commit()
        return self.get_srp_target(tid)

    def get_srp_target(self, tid: str):
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM rmon_srp_targets WHERE id=?", [tid]).fetchone()
        return dict(row) if row else None

    def list_srp_targets(self, enabled_only: bool = False) -> list:
        sql = "SELECT * FROM rmon_srp_targets"
        if enabled_only:
            sql += " WHERE enabled=1"
        sql += " ORDER BY created_at DESC"
        with self._conn() as conn:
            rows = conn.execute(sql).fetchall()
        return [dict(r) for r in rows]

    def delete_srp_target(self, tid: str):
        with self.lock:
            with self._conn() as conn:
                conn.execute("DELETE FROM rmon_srp_targets WHERE id=?", [tid])
                conn.commit()

    def mark_srp_target_run(self, tid: str, status: str, error: str = None):
        with self.lock:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE rmon_srp_targets SET last_run_at=?, last_status=?, last_error=? WHERE id=?",
                    [_now_iso(), status, (error or "")[:200], tid],
                )
                conn.commit()

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
            _log(f"[info] 已从 {json_path} 迁移 {len(products)} 条产品 (v{orig_version})")
            return True
        except Exception as e:
            _log(f"[warn] JSON 迁移失败: {e}")
            return False

    @property
    def version(self):
        with self._conn() as conn:
            return self._get_version(conn)

    @property
    def product_count(self):
        with self._conn() as conn:
            return conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]

    # ------------------------------------------------------------------
    # 货件跟踪（由 shipment-tracker 迁移；字段名与接口都用 camelCase）
    # ------------------------------------------------------------------

    def _upsert_camel(self, table, data):
        """通用 upsert：入参 camelCase，落库 snake_case，未知列自动忽略。

        用 PRAGMA 拿真实列名做白名单，这样前端多传/少传字段都不会炸，
        也不需要维护 40+ 个字段的手写映射。
        """
        with self.lock:
            with self._conn() as conn:
                cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
                row = {}
                for k, v in (data or {}).items():
                    c = _snake_key(k)
                    if c not in cols:
                        continue
                    if c == "cancelled":
                        v = 1 if v else 0
                    elif c == "history" and isinstance(v, (list, dict)):
                        v = json.dumps(v, ensure_ascii=False)
                    row[c] = v
                if not row.get("id"):
                    row["id"] = str(uuid.uuid4())
                if "updated_at" in cols:
                    row["updated_at"] = _now_iso()
                keys = list(row.keys())
                ph = ",".join("?" * len(keys))
                sql = f"INSERT INTO {table}({','.join(keys)}) VALUES({ph})"
                sets = ",".join(f"{k}=excluded.{k}" for k in keys if k != "id")
                if sets:
                    sql += f" ON CONFLICT(id) DO UPDATE SET {sets}"
                conn.execute(sql, [row[k] for k in keys])
                conn.commit()
                return row["id"]

    def list_shipments(self):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM shipments ORDER BY ship_date DESC, created_at DESC").fetchall()
        return [_row_to_camel(r) for r in rows]

    def upsert_shipment(self, data):
        return self._upsert_camel("shipments", data)

    def delete_shipment(self, sid):
        with self.lock:
            with self._conn() as conn:
                cur = conn.execute("DELETE FROM shipments WHERE id=?", [sid])
                conn.commit()
                return cur.rowcount

    def list_shipment_products(self):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM shipment_products ORDER BY created_at DESC").fetchall()
        return [_row_to_camel(r) for r in rows]

    def upsert_shipment_product(self, data):
        return self._upsert_camel("shipment_products", data)

    def delete_shipment_product(self, pid):
        with self.lock:
            with self._conn() as conn:
                cur = conn.execute("DELETE FROM shipment_products WHERE id=?", [pid])
                conn.commit()
                return cur.rowcount

    def bulk_upsert_shipments(self, rows, table="shipments"):
        """批量导入（逐条 upsert；单条失败不阻断整批）。返回成功条数。"""
        n = 0
        for r in (rows or []):
            try:
                self._upsert_camel(table, r)
                n += 1
            except Exception as e:
                _log(f"[shipment] 导入失败 {str(r.get('id'))[:12]}: {e}")
        return n


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
