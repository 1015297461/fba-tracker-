#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
类目榜单采集器（Best Sellers / New Releases）
================================================
给定类目 URL，抓取完整 100 条榜单；按需抓单个 ASIN 详情（品牌 / 细分类目 BSR）。

关键实测结论（2026-10-29，home-garden/3732191）：
  · 可见网格每页只渲染 30 条，但页面内嵌 `data-client-recs-list` JSON 每页 50 条
    （字段 id + metadataMap["render.zg.rank"]）。
  · 翻页必须跟随真实 Next 链接（li.a-last > a，指向 /Best-Sellers-.../zgbs/...），
    不能自己拼 ?pg=N（实测 pg=2 返回 51-80、pg=3 直接 400）。
  · 两页 JSON 合并 = rank 1-100 完整；网格只有 60 条有完整字段，其余 40 条仅 rank+ASIN。
  · 详情页必须带 Cookie: i18n-prefs=USD（否则国内 IP 价格变 CNY）。

仅依赖标准库 + 复用 product_fetcher 的 bs4 解析（详情用）。
"""

import argparse
import datetime
import gzip
import html as htmllib
import io
import json
import random
import re
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse

from .rank_fetcher import MARKETPLACES
from . import browser_fetch
from . import product_fetcher
from .utils import _log

# 浏览器指纹（与 rank_fetcher 保持一致风格）
_UAS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
]

_BLOCK_HINTS = [
    "Enter the characters you see below",
    "Type the characters you see in this image",
    "api-services-support@amazon.com",
    "To discuss automated access to Amazon data",
    "Robot Check",
    "/errors/validateCaptcha",
    "Sorry, we just need to make sure",
]

_ITEM_RE = re.compile(r'<div id="([A-Z0-9]{10})" class="p13n-sc-uncoverable-faceout">')
_RECS_RE = re.compile(r'data-client-recs-list="([^"]*)"')
_NEXT_RE = re.compile(r'<li class="a-last"><a href="([^"]+)"')
_CANON_RE = re.compile(r"/gp/(bestsellers|new-releases)/([^/]+)/(\d+)")
_ZGBS_RE = re.compile(r"/(zgbs|zgbsnr)/([^/]+)/(\d+)")

# 详情缓存：进程内存，TTL 10 分钟；重试传 refresh=True 覆盖
_DETAIL_CACHE = {}
_DETAIL_TTL = 600
_DETAIL_LOCK = threading.Lock()
# 单条详情串行闸门：点击是"随时突发"的（连点几个商品、多个弹窗同时开），
# 而批量采集是排队 + 错开发车的。若不串行，N 个并发 /dp/ 请求是触发更严封禁的
# 直接诱因——这正是「详情比批量更容易挂」的非代码差异之一。
_DETAIL_FETCH_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _decode(resp):
    raw = resp.read()
    enc = (resp.headers.get("Content-Encoding") or "").lower()
    if "gzip" in enc:
        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    elif "deflate" in enc:
        try:
            raw = zlib_decompress(raw)
        except Exception:
            pass
    return raw.decode("utf-8", "replace")


def zlib_decompress(raw):
    import zlib
    return zlib.decompress(raw)


def _http_get(url, marketplace, cookie=None, timeout=25, headers=None):
    """返回 (status, html)。网络错误先按系统代理，失败再直连重试一次。

    headers 非空时直接用（典型场景：透传 product_fetcher 的会话浏览器头 + Cookie），
    否则用内置的基础头并补 cookie。
    """
    if headers:
        h = dict(headers)
    else:
        mk = MARKETPLACES.get((marketplace or "US").upper(), {})
        h = {
            "User-Agent": random.choice(_UAS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": mk.get("lang", "en-US,en;q=0.9"),
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
        }
        if cookie:
            h["Cookie"] = cookie
    req = urllib.request.Request(url, headers=h)

    last_err = None
    for use_proxy in (True, False):
        try:
            if use_proxy:
                resp = urllib.request.urlopen(req, timeout=timeout)
            else:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                resp = opener.open(req, timeout=timeout)
            try:
                return resp.status, _decode(resp)
            finally:
                resp.close()
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception as e:
            last_err = e
            continue
    raise last_err


def _is_blocked(html_text):
    if not html_text:
        return True
    # 复用 product_fetcher 的大小写不敏感 CAPTCHA/拦截检测（比本地 _BLOCK_HINTS 更稳，
    # 能命中 404 状态但实为机器人验证页的情况）
    try:
        return product_fetcher.is_captcha_page(html_text)
    except Exception:
        low = (html_text or "").lower()
        return any(h.lower() in low for h in _BLOCK_HINTS)


# ---------------------------------------------------------------------------
# URL 解析
# ---------------------------------------------------------------------------

def parse_category_url(url):
    """从榜单 URL 解析 {marketplace, listType, nodePath, nodeId}。"""
    u = urlparse((url or "").strip())
    host = (u.hostname or "").lower()
    mk = None
    for k, v in MARKETPLACES.items():
        if v["domain"] == host:
            mk = k
            break
    if not mk:
        raise ValueError(f"不支持的站点域名: {host or '(空)'}")

    m = _CANON_RE.search(u.path)
    if m:
        list_type, node_path, node_id = m.group(1), m.group(2), m.group(3)
    else:
        m2 = _ZGBS_RE.search(u.path)
        if not m2:
            raise ValueError("无法从 URL 解析类目节点（需 /gp/bestsellers|new-releases/{路径}/{节点ID}）")
        list_type = "new-releases" if m2.group(1) == "zgbsnr" else "bestsellers"
        node_path, node_id = m2.group(2), m2.group(3)

    return {"marketplace": mk, "listType": list_type,
            "nodePath": node_path, "nodeId": node_id}


# ---------------------------------------------------------------------------
# 页面解析
# ---------------------------------------------------------------------------

def _recs_from_html(html_text):
    """data-client-recs-list → [{rank, asin}]（每页 50 条）。"""
    m = _RECS_RE.search(html_text)
    if not m:
        return []
    try:
        data = json.loads(htmllib.unescape(m.group(1)))
    except Exception:
        return []
    out = []
    for d in data:
        md = d.get("metadataMap") or {}
        r = md.get("render.zg.rank", "")
        if str(r).isdigit():
            # raw 保留原始 dict（id + metadataMap + linkParameters），补全 31-50 时原样回传给 ACP
            out.append({"rank": int(r), "asin": d.get("id"), "raw": d})
    return out


def _acp_config(html_text):
    """提取列表网格的 ACP 懒加载配置（path/params/stamp，用于补全未渲染的 20 条）。"""
    m = re.search(r'data-acp-path="(/acp/p13n-zg-list-grid-desktop/[^"]+)"', html_text)
    if not m:
        return None
    win = html_text[max(0, m.start() - 600):m.start() + 600]
    pm = re.search(r'data-acp-params="([^"]+)"', win)
    if not pm:
        return None
    sm = re.search(r'data-acp-stamp="([^"]+)"', win)
    return {"path": m.group(1), "params": pm.group(1),
            "stamp": sm.group(1) if sm else ""}


def _http_post(url, marketplace, headers, data, timeout=30):
    mk = MARKETPLACES.get((marketplace or "US").upper(), {})
    hd = {
        "User-Agent": random.choice(_UAS),
        "Accept": "text/html,application/json",
        "Accept-Language": mk.get("lang", "en-US,en;q=0.9"),
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
    }
    hd.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hd, method="POST")
    last = None
    for use_proxy in (True, False):
        try:
            if use_proxy:
                resp = urllib.request.urlopen(req, timeout=timeout)
            else:
                resp = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout)
            try:
                return resp.status, _decode(resp)
            finally:
                resp.close()
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception as e:
            last = e
            continue
    raise last


def _fetch_acp_chunk(acp, raw_recs, marketplace, domain):
    """POST ACP nextPage，让 Amazon 渲染这批 ASIN 的卡片，返回 {asin: fields}。"""
    url = f"https://{domain}{acp['path']}nextPage?page-type=zeitgeist&stamp={acp['stamp']}"
    ids = [json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in raw_recs]
    body = json.dumps({"faceoutkataname": "GeneralFaceout", "ids": ids},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "text/html, application/json",
        "Content-Type": "application/json",
        "x-amz-amabot-click-attributes": "disable",
        "x-amz-acp-params": acp["params"],
        "Referer": f"https://{domain}/",
        "Origin": f"https://{domain}",
    }
    if marketplace == "US":
        # ACP 也要强制美元，否则补全的 20 条会按 IP 返回 CNY
        headers["Cookie"] = "i18n-prefs=USD; lc-main=en_US"
    status, frag = _http_post(url, marketplace, headers, body)
    if not frag:
        raise RuntimeError(f"acp_http_{status}")
    return _grid_from_html(frag)


def _grid_from_html(html_text):
    """可见网格条目 → {asin: {title, price, rating, reviews, image}}。"""
    starts = [(m.start(), m.group(1)) for m in _ITEM_RE.finditer(html_text)]
    out = {}
    for i, (pos, asin) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(html_text)
        b = html_text[pos:end]
        t = re.search(r'_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">(.*?)</div>', b, re.S) \
            or re.search(r'<img alt="([^"]*)"', b)
        img = re.search(r'<img[^>]+src="(https://images-na\.ssl-images-amazon\.com/images/I/[^"]+)"', b)
        rating = re.search(r'a-icon-alt">([\d.]+) out of 5 stars', b)
        reviews = re.search(r'a-size-small">([\d,]+)<', b)
        # 价格优先整数+小数，off-screen 可能缺小数点（$4749）
        whole = re.search(r'a-price-whole">([\d,]+)', b)
        frac = re.search(r'a-price-fraction">(\d+)', b)
        if whole:
            ps = whole.group(1).replace(",", "") + "." + (frac.group(1) if frac else "00")
        else:
            raw = re.search(r'_cDEzb_p13n-sc-price_3mJ9Z">([^<]+)<', b) \
                or re.search(r'a-offscreen">([^<]+)<', b)
            ps = raw.group(1).strip() if raw else None
            ps = _norm_price(ps)
        out[asin] = {
            "title": htmllib.unescape(_strip_tags(t.group(1))).strip() if t else None,
            "image": img.group(1) if img else None,
            "rating": float(rating.group(1)) if rating else None,
            "reviews": int(reviews.group(1).replace(",", "")) if reviews else None,
            "price": ps,
        }
    return out


def _strip_tags(s):
    return re.sub(r"<[^>]+>", "", s or "")


def _next_link(html_text, current_url):
    m = _NEXT_RE.search(html_text)
    if not m:
        return None
    href = htmllib.unescape(m.group(1))
    nxt = urljoin(current_url, href)
    # 已是最后一页时 a-last 可能指回自身/第 1 页
    if nxt.rstrip("/") == current_url.rstrip("/"):
        return None
    return nxt


def _label_from_html(html_text, list_type):
    m = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.S)
    t = htmllib.unescape(m.group(1)).strip() if m else ""
    if list_type == "bestsellers":
        t = re.sub(r"^Amazon Best Sellers:\s*Best\s*", "", t, flags=re.I)
    else:
        t = re.sub(r"^Amazon\.com New Releases:\s*The best-selling new & future releases in\s*", "", t, flags=re.I)
    return t.strip() or None


def _norm_price(p):
    """统一成不带货币符号的十进制字符串（如 '47.49'），前端再加符号。"""
    if p is None:
        return None
    s = str(p).strip().replace(",", "")
    s = re.sub(r"^[^\d]+", "", s)          # 去掉 $ ¥ 等前缀
    if not s:
        return None
    m = re.match(r"^(\d+)$", s)
    if m and len(m.group(1)) >= 3 and int(m.group(1)) >= 1000:
        s = f"{int(m.group(1)) / 100:.2f}"  # $4749 -> 47.49
    if re.match(r"^\d+(\.\d+)?$", s):
        return s
    m3 = re.search(r"(\d+(?:\.\d+)?)", s)
    return m3.group(1) if m3 else None


# ---------------------------------------------------------------------------
# 榜单抓取
# ---------------------------------------------------------------------------

def fetch_listing(marketplace, node_path, node_id, list_type, max_pages=3, retries=2):
    """抓一个榜单，返回 {status, items, pages, requests, label, runDate, error}。

    list_type: 'bestsellers' | 'new-releases'
    items: [{rank, asin, title, price, rating, reviewCount, image, productUrl}]
    """
    marketplace = (marketplace or "US").upper()
    mk = MARKETPLACES.get(marketplace)
    if not mk:
        return {"status": "error", "items": [], "pages": 0, "requests": 0,
                "label": None, "runDate": datetime.date.today().isoformat(),
                "error": "unknown_marketplace"}

    list_type = "new-releases" if list_type in ("new-releases", "newReleases", "nr") else "bestsellers"
    domain = mk["domain"]
    url = f"https://{domain}/gp/{list_type}/{node_path}/{node_id}/"
    cookie = "i18n-prefs=USD; lc-main=en_US" if marketplace == "US" else None

    recs = {}       # rank -> asin
    grid = {}       # asin -> fields
    pages = 0
    requests = 0
    label = None
    last_err = None
    acp_failures = 0   # 两次重试都没补齐的批次数量（只用于错误说明，状态看实际字段完整性）

    for _ in range(max_pages):
        html_text = None
        status = None
        for attempt in range(retries + 1):
            requests += 1
            try:
                status, html_text = _http_get(url, marketplace, cookie=cookie)
            except Exception as e:
                last_err = f"{type(e).__name__}: {e}"
                html_text = None
            if html_text and not _is_blocked(html_text):
                break
            if html_text is None and status in (429, 503):
                last_err = "blocked"
                break
            time.sleep(1.5 + attempt)

        if not html_text:
            last_err = last_err or "no_html"
            break
        if _is_blocked(html_text):
            last_err = "blocked"
            break

        page_recs = _recs_from_html(html_text)
        if not page_recs:
            last_err = last_err or "no_recs"
            break

        pages += 1
        if not label:
            label = _label_from_html(html_text, list_type)
        grid.update(_grid_from_html(html_text))
        for r in page_recs:
            recs[r["rank"]] = r["asin"]

        # 补全当前页未渲染的 20 条（31-50 / 81-100）：走 ACP nextPage，每批 8 条
        acp = _acp_config(html_text)
        if acp:
            missing = [r for r in page_recs if not (grid.get(r["asin"]) or {}).get("title")]
            for i in range(0, len(missing), 8):
                chunk = missing[i:i + 8]
                requests += 1
                chunk_err = None
                for attempt in range(2):
                    try:
                        grid.update(_fetch_acp_chunk(acp, [r["raw"] for r in chunk], marketplace, domain))
                        chunk_err = None
                        break
                    except Exception as e:
                        chunk_err = f"acp:{type(e).__name__}"
                        if attempt == 0:
                            time.sleep(1.0)
                # ⚠️ 只有「两次都没补上」才算这批失败。此前是无条件写 last_err 且成功后不清，
                # 于是第一次失败、第二次重试成功后仍带着错误串 → 状态被判 partial，
                # 明明 100 条字段齐全却显示「部分成功」（2026-10-30 实测踩到）。
                if chunk_err:
                    acp_failures += 1
                    last_err = chunk_err

        if len(recs) >= 100:
            break
        nxt = _next_link(html_text, url)
        if not nxt:
            break
        url = nxt
        time.sleep(random.uniform(1.2, 2.4))

    items = []
    for rank in sorted(recs):
        asin = recs[rank]
        f = grid.get(asin, {})
        items.append({
            "rank": rank,
            "asin": asin,
            "title": f.get("title"),
            "price": f.get("price"),
            "rating": f.get("rating"),
            "reviewCount": f.get("reviews"),
            "image": f.get("image"),
            "productUrl": f"https://{domain}/dp/{asin}",
        })

    # 状态以**实际数据完整性**为准，而不是"过程中有没有报过错"：
    # 只要 100 条都拿到了标题和主图，就是 ok（中途某批 ACP 失败但重试成功，不该算部分成功）。
    incomplete = [it["asin"] for it in items
                  if not (it.get("title") or "").strip() or not it.get("image")]
    if items and not incomplete:
        status = "ok"
        if acp_failures:
            _log(f"[catmon] {node_id}/{list_type} 有 {acp_failures} 批 ACP 补全失败但字段已补齐，判为 ok")
    elif items:
        status = "partial"
        last_err = last_err or f"incomplete:{len(incomplete)}"
    else:
        status = "error"
    return {"status": status, "items": items, "pages": pages, "requests": requests,
            "label": label, "runDate": datetime.date.today().isoformat(),
            "error": last_err}


# ---------------------------------------------------------------------------
# 详情抓取（点击才采集；进程内存缓存 TTL 10 分钟）
# ---------------------------------------------------------------------------

def _clean_brand(s):
    if not s:
        return None
    s = re.sub(r"^(Brand:\s*|Visit the\s+)", "", str(s).strip(), flags=re.I)
    s = re.sub(r"\s+Store$", "", s, flags=re.I).strip()
    return s or None


def fetch_detail(asin, marketplace="US", refresh=False):
    """抓单个 ASIN 详情。带进程内存缓存；refresh=True 强制重抓。"""
    asin = (asin or "").strip().upper()
    marketplace = (marketplace or "US").upper()
    if not re.match(r"^[A-Z0-9]{10}$", asin):
        return {"error": "invalid_asin", "asin": asin}

    key = marketplace + ":" + asin
    now = time.time()
    if not refresh:
        with _DETAIL_LOCK:
            rec = _DETAIL_CACHE.get(key)
            if rec and now - rec["ts"] < _DETAIL_TTL:
                return dict(rec["data"], cached=True, cachedAt=rec["ts"])

    mk = MARKETPLACES.get(marketplace)
    if not mk:
        return {"error": "unknown_marketplace", "asin": asin}

    # 串行化 + 双检缓存：同一时刻只允许一个详情在抓。
    # ① 并发点击不会再打成"突发流量"（批量是排队错开发车的，点击不是）；
    # ② 排队期间别人抓成功后，这里直接命中缓存，不重复请求 Amazon。
    with _DETAIL_FETCH_LOCK:
        if not refresh:
            with _DETAIL_LOCK:
                rec = _DETAIL_CACHE.get(key)
                if rec and time.time() - rec["ts"] < _DETAIL_TTL:
                    return dict(rec["data"], cached=True, cachedAt=rec["ts"])

        data = None

        # ① 浏览器优先（默认走**服务端专用无头 Chrome**：profile 独立在 data/chrome-profile/，
        #    与任何人日常用的浏览器完全隔离，同事们点详情不会打扰到机主）。
        #    实测：urllib 连续 7 次全是 CAPTCHA，同一 URL 交给浏览器一次就拿到 3.9MB 完整页
        #    —— 被拦的是 urllib 的客户端指纹，不是这台机器的 IP。
        if browser_fetch.available():
            html_text, berr = browser_fetch.fetch_html(
                f"https://{mk['domain']}/dp/{asin}?language=en_US")
            if html_text:
                try:
                    bp = product_fetcher.parse_product_page(
                        html_text, asin, marketplace, with_customers_say=True)
                except Exception as e:
                    bp = None
                    _log(f"[catmon] 浏览器解析失败 {asin}: {e}")
                if bp:
                    now = time.time()
                    bdata = _build_detail_data(bp, asin, marketplace, mk, now)
                    if bdata["title"]:
                        bdata["fetchedBy"] = "browser"
                        data = bdata
                        _log(f"[catmon] {asin} 由服务端无头浏览器取到"
                             f"（{browser_fetch.mode()} 通道；urllib 已被反爬拦截）")
            elif berr != "page_not_ready":
                _log(f"[catmon] {asin} 浏览器通道不可用: {berr}")

        # ② 浏览器不可用/没取到 → 走与批量完全一致的 HTTP 链路（含第二轮补采）。
        if not data or not data["title"]:
            _log(f"[catmon] {asin} 回退 HTTP 抓取（含完整重试预算）")
            p = product_fetcher.scrape_product_robust(
                asin, marketplace, with_customers_say=True)
            now = time.time()
            data = _build_detail_data(p, asin, marketplace, mk, now)

        # 解析成功（有标题）才缓存，失败不污染缓存
        if data["title"]:
            with _DETAIL_LOCK:
                _DETAIL_CACHE[key] = {"data": data, "ts": now}
    return dict(data, cached=False, cachedAt=now)


def _build_detail_data(p, asin, marketplace, mk, now):
    rc = p.get("review_count")
    if isinstance(rc, str):
        digits = re.sub(r"[^\d]", "", rc)
        rc = int(digits) if digits else None

    aspects = p.get("customers_say_aspects")
    if isinstance(aspects, str):
        try:
            aspects = json.loads(aspects)
        except Exception:
            aspects = []
    if not isinstance(aspects, list):
        aspects = []

    bsr = []
    if p.get("bsr_main_rank"):
        bsr.append({"rank": str(p["bsr_main_rank"]).lstrip("#"),
                    "category": p.get("bsr_main_category")})
    if p.get("bsr_sub_rank"):
        bsr.append({"rank": str(p["bsr_sub_rank"]).lstrip("#"),
                    "category": p.get("bsr_sub_category")})

    return {
        "asin": asin,
        "marketplace": marketplace,
        "title": p.get("title"),
        "brand": _clean_brand(p.get("brand")),
        "price": _norm_price(p.get("price")),
        "rating": p.get("rating"),
        "reviewCount": rc,
        "image": p.get("main_image"),
        "url": p.get("url") or f"https://{mk['domain']}/dp/{asin}",
        "bsr": bsr,
        "images": [x for x in (p.get("images") or []) if x and x != p.get("main_image")][:12],
        "aplusImages": (p.get("aplus_images") or [])[:24],
        "bulletPoints": p.get("bullet_points") or [],
        "description": p.get("description"),
        "specifications": p.get("specifications") or {},
        "productDetails": p.get("product_details") or {},
        "categories": p.get("categories"),
        "seller": p.get("seller"),
        "availability": p.get("availability"),
        "customerReviews": {
            "customersSay": p.get("customers_say"),
            "customersSayTags": p.get("customers_say_tags"),
            "customersSayAspects": aspects,
            "reviewImages": p.get("review_images") or [],
            "selectToLearnMore": p.get("select_to_learn_more") or [],
        },
        "error": p.get("error_message"),
    }


def detail_cache_size():
    with _DETAIL_LOCK:
        return len(_DETAIL_CACHE)


def clear_detail_cache():
    with _DETAIL_LOCK:
        _DETAIL_CACHE.clear()


# ---------------------------------------------------------------------------
# CLI 自测
# ---------------------------------------------------------------------------

def _selftest(url):
    info = parse_category_url(url)
    print("parsed:", json.dumps(info, ensure_ascii=False))
    res = fetch_listing(info["marketplace"], info["nodePath"], info["nodeId"], info["listType"])
    print(f"listing: status={res['status']} pages={res['pages']} requests={res['requests']} "
          f"label={res['label']} items={len(res['items'])} err={res['error']}")
    if res["items"]:
        print("first:", json.dumps(res["items"][0], ensure_ascii=False))
        print("last :", json.dumps(res["items"][-1], ensure_ascii=False))
        full = sum(1 for i in res["items"] if i["title"])
        print(f"full={full} rankonly={len(res['items']) - full}")
        d = fetch_detail(res["items"][0]["asin"], info["marketplace"])
        print("detail:", json.dumps({k: d.get(k) for k in
              ("title", "brand", "price", "rating", "reviewCount", "bsr", "cached")},
              ensure_ascii=False))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://www.amazon.com/gp/bestsellers/home-garden/3732191/")
    a = ap.parse_args()
    _selftest(a.url)
