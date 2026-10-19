#!/usr/bin/env python3
"""把 shipment-tracker（独立 Node 项目）的 JSON 数据导入 fba2 的 SQLite。

一次性迁移脚本；按 id 做 upsert，重复执行不会产生重复行。

用法：
    python3 scripts/import_shipment_tracker.py
    python3 scripts/import_shipment_tracker.py --src /path/to/shipment-tracker --db data/fba-data.db

导入后会自动做一次**逐条逐字段比对**（含空字符串），确保一条不丢、一字不差。
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend.db import DbState  # noqa: E402

DEFAULT_SRC = os.path.join(os.path.dirname(ROOT), "shipment-tracker")
DEFAULT_DB = os.path.join(ROOT, "data", "fba-data.db")

# JSON 文件 -> 目标表
SOURCES = [
    ("shipments.json", "shipments", "list_shipments"),
    ("products.json", "shipment_products", "list_shipment_products"),
]


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def normalize(v):
    """比对用归一：None 与 '' 视为同值（原数据里空字段都写 ''）。

    另：空数组/空对象也归到 ''——原数据用 '' 表示「无 history」，
    而库里读回时统一还原成 []（前端可直接 .length / .forEach）。
    """
    if v is None:
        return ""
    if isinstance(v, bool):
        return v
    if isinstance(v, (list, dict)):
        if not v:
            return ""
        return json.dumps(v, ensure_ascii=False, sort_keys=True)
    if isinstance(v, (int, float)):
        return str(v)
    return str(v)


def compare(state, src_rows, getter_name, label):
    """逐条逐字段比对，返回 (缺失id列表, 不一致明细)。"""
    stored = {r["id"]: r for r in getattr(state, getter_name)()}
    missing, diffs = [], []
    for row in src_rows:
        rid = row.get("id")
        got = stored.get(rid)
        if not got:
            missing.append(rid)
            continue
        for k, sv in row.items():
            if k in ("id", "updatedAt", "updated_at"):
                continue
            gv = got.get(k)
            # cancelled: JSON bool vs DB int(0/1) -> 读回时已转 bool
            if k == "cancelled":
                if bool(sv) != bool(gv):
                    diffs.append((rid, k, sv, gv))
                continue
            if normalize(sv) != normalize(gv):
                diffs.append((rid, k, sv, gv))
    return missing, diffs, len(stored)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC, help="shipment-tracker 目录")
    ap.add_argument("--db", default=DEFAULT_DB, help="目标 SQLite 路径")
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(args.src, "data")):
        print(f"✗ 找不到数据目录: {args.src}/data")
        return 2

    state = DbState(args.db)
    print(f"目标库: {args.db}\n")
    ok = True

    for filename, table, getter in SOURCES:
        path = os.path.join(args.src, "data", filename)
        if not os.path.exists(path):
            print(f"✗ 跳过（文件不存在）: {path}")
            ok = False
            continue
        rows = load_json(path)
        print(f"=== {filename} → {table}：{len(rows)} 条 ===")
        n = state.bulk_upsert_shipments(rows, table=table)
        print(f"  写入/更新 {n} 条")

        missing, diffs, stored = compare(state, rows, getter, table)
        print(f"  库中现有 {stored} 条")
        if missing:
            ok = False
            print(f"  ✗ 缺失 {len(missing)} 条：{missing[:5]}")
        if diffs:
            ok = False
            print(f"  ✗ 字段不一致 {len(diffs)} 处（显示前 8）:")
            for rid, k, sv, gv in diffs[:8]:
                print(f"      {str(rid)[:8]} {k}: 源={sv!r} 库={gv!r}")
        if not missing and not diffs:
            print(f"  ✓ 逐字段比对通过（{len(rows)} 条 × {len(rows[0]) if rows else 0} 字段）")
        print()

    print("RESULT:", "ALL PASS ✓" if ok else "有差异 ✗")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
