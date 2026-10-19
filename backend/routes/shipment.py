"""货件跟踪路由（由独立项目 shipment-tracker 迁移而来）。

原项目是 Node + JSON 文件；迁到 fba2 后：
- 数据落 SQLite（db.py 的 shipments / shipment_products 两张表）
- 接口统一加 `/api/shipment` 前缀
- **出入参仍是 camelCase**（与原项目一致，前端逻辑可原样移植；DB 层负责换名）
- Excel 导入只做「工作簿 → sheet 名 + TSV 文本」的桥，列映射解析留在前端
  （与原项目一致；上传用 base64 放在 JSON 里，避免引入 multipart 解析）
- 权限：admin / root

业务规则（从 server.js 原样搬，勿擅自"优化"）：
- 货件导入去重键 = `shipmentId|product|shipDate|warehouse`
  （同一个 FBA 号可能含多个厂家的多个产品、多个提货时间，不能只按 FBA 号去重）
- 产品库导入去重键 = `fnsku || product`；已存在则**只补空字段**，不覆盖已有值
- 自动算 ETA：普船 45 / 加班 38 / 正班 36 / 空派 14 天；
  `etaDate = 发货日 + N`，`etaEndDate = 发货日 + N + 6`；
  跳过：已取消、非 FBA 开头、已有 etaDate、缺 channel 或 shipDate
"""

import base64
import datetime
import io
from urllib.parse import urlparse, parse_qs

from ..utils import _extract_token, _log

# 海运/空运时效（天）——与原项目 server.js 的 TRANSIT 完全一致
TRANSIT_DAYS = {"普船": 45, "加班": 38, "正班": 36, "空派": 14}

# 产品库"补空字段"时允许被填充的字段（原 PRODUCT_FIELDS）
PRODUCT_PATCH_FIELDS = (
    "product", "msku", "categoryEn", "categoryCn", "qtyPerBox", "singleBoxWeight",
    "length", "width", "height", "volume", "supplier", "fnsku",
)


def _now():
    return datetime.datetime.now().replace(microsecond=0).isoformat(sep=" ")


def _add_days(date_str, n):
    """日期加天数，返回 YYYY-MM-DD；无法解析时返回空串（与原 addDaysLocal 行为一致）。"""
    try:
        d = datetime.date.fromisoformat(str(date_str)[:10])
    except Exception:
        return ""
    return (d + datetime.timedelta(days=n)).isoformat()


def _ship_key(x):
    return "|".join(str(x.get(k) or "").strip()
                    for k in ("shipmentId", "product", "shipDate", "warehouse"))


def _prod_key(x):
    return str(x.get("fnsku") or x.get("product") or "").strip()


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def _user(self):
        u = auth.verify(_extract_token(self))
        if not u:
            self._send_json(401, {"error": "请先登录"})
            return None
        if u.get("role") not in ("admin", "root"):
            self._send_json(403, {"error": "仅管理员可用"})
            return None
        return u

    # ---------------- 货件 ----------------

    def get_shipments(self):
        if not _user(self):
            return
        self._send_json(200, {"shipments": state.list_shipments()})
    GET["/api/shipment/shipments"] = get_shipments

    def post_shipment(self):
        if not _user(self):
            return
        p = self._read_json()
        if p is None:
            return
        if not str(p.get("shipmentId") or "").strip():
            self._send_json(400, {"error": "货件号(FBA) 为必填"})
            return
        p.setdefault("createdAt", _now())
        sid = state.upsert_shipment(p)
        self._send_json(201, {"ok": True, "id": sid})
    POST["/api/shipment/shipments"] = post_shipment

    def put_shipment(self):
        if not _user(self):
            return
        p = self._read_json()
        if p is None:
            return
        if not p.get("id"):
            self._send_json(400, {"error": "id required"})
            return
        sid = state.upsert_shipment(p)
        self._send_json(200, {"ok": True, "id": sid})
    PUT["/api/shipment/shipments"] = put_shipment

    def delete_shipment(self):
        if not _user(self):
            return
        qs = parse_qs(urlparse(self.path).query)
        sid = (qs.get("id") or [""])[0]
        if not sid:
            self._send_json(400, {"error": "id required"})
            return
        n = state.delete_shipment(sid)
        self._send_json(200, {"ok": True, "deleted": n})
    DELETE["/api/shipment/shipments"] = delete_shipment

    def post_import_shipments(self):
        """批量导入货件：按 shipmentId|product|shipDate|warehouse 去重。"""
        if not _user(self):
            return
        p = self._read_json()
        if p is None:
            return
        items = p.get("items") or []
        existing = {_ship_key(s) for s in state.list_shipments()}
        added = duplicated = skipped = 0
        errors = []
        rows = []
        for it in items:
            if not str(it.get("shipmentId") or "").strip():
                skipped += 1
                errors.append({"shipmentId": it.get("shipmentId"), "reason": "缺少货件号(FBA)"})
                continue
            k = _ship_key(it)
            if k in existing:
                duplicated += 1
                continue
            existing.add(k)
            it.setdefault("createdAt", _now())
            rows.append(it)
            added += 1
        if rows:
            state.bulk_upsert_shipments(rows, table="shipments")
        _log(f"[shipment] 导入货件 +{added} 重复{duplicated} 跳过{skipped}")
        self._send_json(200, {"added": added, "skipped": skipped,
                              "duplicated": duplicated, "errors": errors})
    POST["/api/shipment/shipments/import"] = post_import_shipments

    def post_batch_update(self):
        """批量改预计到货 / 到货区间。"""
        if not _user(self):
            return
        p = self._read_json()
        if p is None:
            return
        ids = set(p.get("ids") or [])
        eta = str(p.get("etaDate") or "").strip()
        eta_end = str(p.get("etaEndDate") or "").strip()
        updated = 0
        for s in state.list_shipments():
            if s.get("id") in ids:
                s["etaDate"] = eta
                s["etaEndDate"] = eta_end
                state.upsert_shipment(s)
                updated += 1
        self._send_json(200, {"updated": updated})
    POST["/api/shipment/shipments/batch-update"] = post_batch_update

    def post_auto_calc_eta(self):
        """按渠道时效自动推算 ETA（只填空缺，不覆盖已有值）。"""
        if not _user(self):
            return
        updated = skipped = 0
        for s in state.list_shipments():
            ship_no = str(s.get("shipmentId") or "")
            if s.get("cancelled") or not ship_no.upper().startswith("FBA"):
                skipped += 1
                continue
            if s.get("etaDate"):
                skipped += 1
                continue
            days = TRANSIT_DAYS.get(s.get("channel"))
            if not days or not s.get("shipDate"):
                skipped += 1
                continue
            s["etaDate"] = _add_days(s["shipDate"], days)
            s["etaEndDate"] = _add_days(s["shipDate"], days + 6)
            state.upsert_shipment(s)
            updated += 1
        _log(f"[shipment] 自动算 ETA：更新 {updated} 条，跳过 {skipped} 条")
        self._send_json(200, {"updated": updated, "skipped": skipped})
    POST["/api/shipment/shipments/auto-calc-eta"] = post_auto_calc_eta

    # ---------------- 产品库 ----------------

    def get_products(self):
        if not _user(self):
            return
        self._send_json(200, {"products": state.list_shipment_products()})
    GET["/api/shipment/products"] = get_products

    def post_product(self):
        if not _user(self):
            return
        p = self._read_json()
        if p is None:
            return
        if not str(p.get("product") or "").strip():
            self._send_json(400, {"error": "产品名称为必填"})
            return
        p.setdefault("createdAt", _now())
        pid = state.upsert_shipment_product(p)
        self._send_json(201, {"ok": True, "id": pid})
    POST["/api/shipment/products"] = post_product

    def put_product(self):
        if not _user(self):
            return
        p = self._read_json()
        if p is None:
            return
        if not p.get("id"):
            self._send_json(400, {"error": "id required"})
            return
        pid = state.upsert_shipment_product(p)
        self._send_json(200, {"ok": True, "id": pid})
    PUT["/api/shipment/products"] = put_product

    def delete_product(self):
        if not _user(self):
            return
        qs = parse_qs(urlparse(self.path).query)
        pid = (qs.get("id") or [""])[0]
        if not pid:
            self._send_json(400, {"error": "id required"})
            return
        n = state.delete_shipment_product(pid)
        self._send_json(200, {"ok": True, "deleted": n})
    DELETE["/api/shipment/products"] = delete_product

    def post_import_products(self):
        """产品库导入：按 fnsku||product 去重，已存在则只补空字段。"""
        if not _user(self):
            return
        p = self._read_json()
        if p is None:
            return
        items = p.get("items") or []
        current = state.list_shipment_products()
        index = {}
        for i, x in enumerate(current):
            k = _prod_key(x)
            if k and k not in index:
                index[k] = i
        added = updated = skipped = 0
        for it in items:
            if not str(it.get("product") or "").strip():
                skipped += 1
                continue
            k = _prod_key(it)
            if k and k in index:
                cur = current[index[k]]
                changed = False
                for f in PRODUCT_PATCH_FIELDS:
                    if not cur.get(f) and it.get(f):
                        cur[f] = it[f]
                        changed = True
                if changed:
                    state.upsert_shipment_product(cur)
                    updated += 1
                else:
                    skipped += 1
            else:
                it.setdefault("createdAt", _now())
                state.upsert_shipment_product(it)
                if k:
                    index[k] = len(current)
                    current.append(it)
                added += 1
        _log(f"[shipment] 导入产品 +{added} 补全{updated} 跳过{skipped}")
        self._send_json(200, {"added": added, "updated": updated, "skipped": skipped})
    POST["/api/shipment/products/import"] = post_import_products

    # ---------------- Excel ----------------

    def post_import_xlsx(self):
        """把上传的 xlsx 转成 [{name, text}]（TSV），列映射交给前端（与原项目一致）。"""
        if not _user(self):
            return
        p = self._read_json()
        if p is None:
            return
        b64 = str(p.get("data") or "").strip()
        if not b64:
            self._send_json(400, {"error": "未收到文件"})
            return
        if b64.startswith("data:") and "," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            import openpyxl
        except ImportError:
            self._send_json(500, {"error": "服务端缺少 openpyxl，请先 pip install openpyxl"})
            return
        try:
            raw = base64.b64decode(b64)
            wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
            sheets = []
            for ws in wb.worksheets:
                lines = []
                for row in ws.iter_rows(values_only=True):
                    lines.append("\t".join("" if c is None else str(c) for c in row))
                sheets.append({"name": ws.title, "text": "\n".join(lines)})
            wb.close()
            self._send_json(200, {"sheets": sheets})
        except Exception as e:
            self._send_json(400, {"error": "解析 Excel 失败：" + str(e)[:120]})
    POST["/api/shipment/import/xlsx"] = post_import_xlsx
