"""一次性回填：把「产品采集」的历史结果灌进详情结果池。

为什么需要
----------
详情结果池（`asin_detail_snapshots`）是三个入口共用的。新代码只对**新采集**写池，
所以首次上线时池里几乎是空的——存量 4900+ 个 ASIN 明明抓过，却仍会被重新抓一遍。

本脚本把 `scrape_products` 里每个 (asin, marketplace) 的**最新一条成功记录**
转成池里的详情结构写进去（快照日期 = 那条记录的采集时间），这样产品采集/类目榜单/
排名监测马上就能命中。

幂等
----
- 同一 (asin, marketplace, snap_date) 池里已有**且不更旧** → 跳过。
- 只取 status=success 且有 title 的记录（失败/空壳不进池，否则会污染复用判定）。
- 可重复执行，重复跑不会重复写。

用法
----
    /opt/homebrew/bin/python3.13 -m scripts.backfill_detail_pool            # 真写
    /opt/homebrew/bin/python3.13 -m scripts.backfill_detail_pool --dry-run  # 只看统计
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import asin_detail_pool as pool          # noqa: E402
from backend.db import DbState                        # noqa: E402
from backend.utils import PROJECT_ROOT                # noqa: E402

JSON_COLS = ("bullet_points", "images", "aplus_images", "specifications",
             "product_details", "review_images", "select_to_learn_more",
             "customers_say_aspects")

SQL = """
SELECT asin, marketplace, title, brand, price, rating, review_count, availability,
       bullet_points, description, main_image, images, aplus_images, specifications,
       product_details, categories, seller, bsr_main_category, bsr_main_rank,
       bsr_sub_category, bsr_sub_rank, bsr_raw_text, customers_say,
       customers_say_tags, customers_say_aspects, review_images,
       select_to_learn_more, scraped_at
  FROM scrape_products sp
 WHERE status = 'success' AND title IS NOT NULL AND title <> ''
   AND id = (SELECT id FROM scrape_products
              WHERE asin = sp.asin AND marketplace = sp.marketplace
                AND status = 'success' AND title IS NOT NULL AND title <> ''
              ORDER BY COALESCE(scraped_at, '') DESC, id DESC
              LIMIT 1)
"""


def _snake_row(row):
    """SQLite 行 → 产品采集的蛇形 dict（JSON 列反序列化），供 product_to_detail 用。"""
    p = dict(row)
    for c in JSON_COLS:
        v = p.get(c)
        if isinstance(v, str) and v.strip():
            try:
                p[c] = json.loads(v)
            except Exception:
                p[c] = None if c == "customers_say_aspects" else []
        elif v is None:
            p[c] = None if c == "customers_say_aspects" else (
                {} if c in ("specifications", "product_details") else [])
    return p


def main(argv):
    dry = "--dry-run" in argv
    db_path = os.path.join(PROJECT_ROOT, "data", "fba-data.db")
    if not os.path.exists(db_path):
        print(f"找不到数据库：{db_path}")
        return 1
    state = DbState(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(SQL).fetchall()
    existing = {(r["asin"], r["marketplace"], r["snap_date"]): (r["fetched_at"] or "")
                for r in conn.execute("SELECT asin, marketplace, snap_date, fetched_at "
                                      "FROM asin_detail_snapshots")}
    print(f"候选 {len(rows)} 个 (asin, marketplace)；池内已有 {len(existing)} 条快照")

    written = skipped = bad = 0
    for r in rows:
        p = _snake_row(r)
        asin = (p.get("asin") or "").upper()
        mk = (p.get("marketplace") or "US").upper()
        day = (p.get("scraped_at") or "")[:10]
        if not asin or not day:
            bad += 1
            continue
        key = (asin, mk, day)
        if key in existing and existing[key] >= p["scraped_at"]:
            skipped += 1
            continue
        detail = pool.product_to_detail(p, asin=asin, marketplace=mk)
        if not detail or not detail.get("title"):
            bad += 1
            continue
        if not pool.is_usable(detail):
            bad += 1
            continue
        if not dry:
            # 关键：fetched_at 用原记录的采集时间，不能用「现在」——
            # 否则界面上每个 ASIN 都会显示成「今天抓的」，用户无从判断数据新旧。
            state.save_asin_detail_snapshot(asin, mk, detail, snap_date=day,
                                            fetched_at=p.get("scraped_at"))
        existing[key] = p["scraped_at"]
        written += 1

    conn.close()
    print(f"{'[dry-run] 将写入' if dry else '已写入'} {written} 条，"
          f"跳过（已有且不更旧）{skipped} 条，不可用 {bad} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
