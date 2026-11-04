"""详情结果池：产品采集 / 类目榜单 / 排名监测共用的「同一份 ASIN 详情」。

背景
----
三个入口抓的都是同一个东西（Amazon /dp/ 页面的完整详情）。此前各存各的：
产品采集写 `scrape_products`，类目榜单/排名监测写 `asin_detail_snapshots`。
结果是同一个 ASIN 被反复抓——库里 5422 个唯一 ASIN 里有 571 个被多个任务采过，
冗余约 650 次请求（折合 3~7 小时的抓取时间，还要吃反爬风险）。

做法
----
以 `asin_detail_snapshots`（按天快照，一天一条）为**唯一结果池**，业务表各留各的：
- 抓之前：先在池里找该 ASIN 最近 `ASIN_DETAIL_REUSE_DAYS` 天内的成功快照，
  命中就直接拿来用，不再打 Amazon；抓完之后：把结果写回池子。
- 池里存的格式统一是「类目榜单详情」的驼峰结构（`catmon_fetcher._build_detail_data`
  的产物），产品采集的蛇形 product dict 与它在这里互转。

为什么复用窗口能放到一个月
--------------------------
快照自带 `fetched_at`（真实抓取时刻），界面上会显示「抓取于 11-03 12:04」，
所以「一个月前的数据」不会被误当成刚抓的；用户想要最新的，点「重新获取」即可
（重采通道绕过池子，见 `routes/scrape.py` 的 force）。
"""

import datetime
import json
import time

from . import catmon_fetcher, product_fetcher
from .db import ASIN_DETAIL_REUSE_DAYS
from .utils import _log


def _mk(marketplace):
    """市场代码 → product_fetcher 的市场配置（未知代码兜底成美国域名）。"""
    code = str(marketplace or "US").strip().upper() or "US"
    return code, (product_fetcher.MARKETPLACES.get(code)
                  or {"domain": "www.amazon.com", "name": code})


def _num(v):
    """'#1,234' / '1234' / 1234 → 1234；取不到数字返回 None。"""
    if v is None:
        return None
    if isinstance(v, int):
        return v
    digits = "".join(ch for ch in str(v) if ch.isdigit())
    return int(digits) if digits else None


# ---------------------------------------------------------------------------
# 产品采集 dict（蛇形） → 池 detail（驼峰）
# ---------------------------------------------------------------------------
def product_to_detail(p, asin=None, marketplace=None):
    """把产品采集的一条结果转成池里统一的驼峰 detail 结构。

    直接复用 `catmon_fetcher._build_detail_data`——它就是「抓取结果 → 详情接口
    返回体」的唯一口径，两边各写一套转换迟早会跑偏。
    """
    if not isinstance(p, dict):
        return None
    a = str(asin or p.get("asin") or "").strip().upper()
    mk_code, mk = _mk(marketplace or p.get("marketplace"))
    if not a:
        return None
    return catmon_fetcher._build_detail_data(p, a, mk_code, mk, time.time())


# ---------------------------------------------------------------------------
# 池 detail（驼峰） → 产品采集 dict（蛇形）
# ---------------------------------------------------------------------------
def detail_to_product(detail, marketplace=None):
    """把池里的驼峰 detail 转成 `scrape_products` 需要的蛇形结构。

    字段与 product_fetcher 的产出对齐（含 customers_say_aspects 用 JSON 串，
    因为那一列是直接按文本写入的，见 db.save_scrape_products）。
    """
    if not isinstance(detail, dict):
        return None
    a = str(detail.get("asin") or "").strip().upper()
    if not a:
        return None
    mk_code, _mk_conf = _mk(marketplace or detail.get("marketplace"))

    bsr = detail.get("bsr") or []
    main = bsr[0] if len(bsr) > 0 and isinstance(bsr[0], dict) else {}
    sub = bsr[1] if len(bsr) > 1 and isinstance(bsr[1], dict) else {}

    cr = detail.get("customerReviews") or {}
    aspects = cr.get("customersSayAspects")
    if aspects is not None and not isinstance(aspects, str):
        aspects = json.dumps(aspects, ensure_ascii=False)
    if aspects in ("[]", ""):
        aspects = None

    images = [x for x in (detail.get("images") or []) if x]
    main_image = detail.get("image")

    return {
        "asin": a,
        "marketplace": mk_code,
        "title": detail.get("title"),
        "brand": detail.get("brand"),
        "price": detail.get("price"),
        "rating": detail.get("rating"),
        "review_count": detail.get("reviewCount"),
        "availability": detail.get("availability"),
        "bullet_points": detail.get("bulletPoints") or [],
        "description": detail.get("description"),
        "main_image": main_image,
        "images": images,
        "aplus_images": detail.get("aplusImages") or [],
        "specifications": detail.get("specifications") or {},
        "product_details": detail.get("productDetails") or {},
        "categories": detail.get("categories"),
        "seller": detail.get("seller"),
        "bsr_main_category": main.get("category"),
        "bsr_main_rank": _num(main.get("rank")),
        "bsr_sub_category": sub.get("category"),
        "bsr_sub_rank": _num(sub.get("rank")),
        "bsr_raw_text": None,
        "customers_say": cr.get("customersSay"),
        "customers_say_tags": cr.get("customersSayTags"),
        "customers_say_aspects": aspects,
        "review_images": cr.get("reviewImages") or [],
        "select_to_learn_more": cr.get("selectToLearnMore") or [],
        "status": "success",
        "error_message": None,
    }


# ---------------------------------------------------------------------------
# 可用性判定 + 取/存
# ---------------------------------------------------------------------------
def is_usable(detail, need_customers_say=False):
    """池里这条快照够不够当「本次抓取的结果」用。

    判定刻意宽松（有标题 + 有至少一项核心内容），因为 Amazon 页面本身就不保证
    每个 ASIN 都有 A+ 图或规格表。但**本次要求 Customers say 而池里没有**时必须
    判为不可用——否则用户勾了「抓 Customers say」却拿到一条没有的旧数据。
    """
    if not isinstance(detail, dict) or not detail.get("title"):
        return False
    if need_customers_say:
        cr = detail.get("customerReviews") or {}
        if not cr.get("customersSay"):
            return False
    has_body = bool(detail.get("images") or detail.get("aplusImages")
                    or detail.get("productDetails") or detail.get("bulletPoints"))
    return has_body


def take(state, asins, marketplace, need_customers_say=False, days=None):
    """批量取可复用的快照。返回 {ASIN: {data, snap_date, fetched_at, snapDay}}。

    `snapDay` 是给界面直接用的日期串（YYYY-MM-DD）。
    """
    try:
        found = state.get_reusable_asin_details(asins, marketplace, days=days)
    except Exception as e:
        _log(f"[detail-pool] 查询失败，本次全部按需抓取：{type(e).__name__}: {e}")
        return {}
    out = {}
    for a, rec in (found or {}).items():
        if is_usable(rec.get("data"), need_customers_say=need_customers_say):
            out[a] = {**rec, "snapDay": rec.get("snap_date")}
    return out


def put(state, product, marketplace=None):
    """把一条抓取结果写回池子（一天一条，同日覆盖）。失败只记日志，不影响主流程。"""
    if not isinstance(product, dict):
        return False
    if product.get("status") != "success" or not product.get("title"):
        return False
    detail = product_to_detail(product, marketplace=marketplace)
    if not detail or not detail.get("title"):
        return False
    try:
        state.save_asin_detail_snapshot(detail["asin"], detail["marketplace"], detail)
        return True
    except Exception as e:
        _log(f"[detail-pool] 写池失败 {product.get('asin')}: {type(e).__name__}: {e}")
        return False


def take_products(state, asins, marketplace, need_customers_say=False, days=None):
    """便捷入口：直接返回「已转成产品采集结构」的复用结果。

    返回 {ASIN: product_dict}，其中带 `scraped_at`（池里的真实抓取时间）与
    `reused_from`（同一个时间，供界面标注「复用」）。
    """
    hit = take(state, asins, marketplace, need_customers_say=need_customers_say, days=days)
    out = {}
    for a, rec in hit.items():
        p = detail_to_product(rec.get("data"), marketplace=marketplace)
        if not p:
            continue
        ts = rec.get("fetched_at") or f"{rec.get('snap_date')} 00:00:00"
        p["scraped_at"] = ts
        p["reused_from"] = ts
        out[a] = p
    return out


def reuse_window_days():
    return ASIN_DETAIL_REUSE_DAYS


def today_str():
    return datetime.date.today().isoformat()
