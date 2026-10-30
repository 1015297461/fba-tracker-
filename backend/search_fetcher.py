#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
搜索结果页榜单抓取器（关键词 → 该词下全部 ASIN 的自然位）
==========================================================
输入一个关键词 + 站点 + 页数，抓取亚马逊搜索结果页，输出整页榜单：

    [
      {"pos": 1, "asin": "B0HG9ZV6NX", "ad": false, "org": 1,
       "title": "...", "price": 69.0, "symbol": "$", "rating": 4.5,
       "reviews": 1234, "img": "https://m.media-amazon.com/..."},
      {"pos": 3, "asin": "B0HGLM6Y1Z", "ad": true,  "org": null, ...},
      ...
    ]

其中 pos 是页面视觉坑位（含广告），org 是剔除广告后的自然位序号（跨页累加）。
「该词下所有 ASIN 的自然位」= 一次抓取即可得到，不需要逐个 ASIN 去搜。

与 rank_fetcher.py 的区别（那个是老的「逐个 ASIN 定位」版）：
  * 复用 product_fetcher 的 SessionState —— 预置 i18n-prefs 货币 cookie + 首页预热，
    否则本机出口 IP 会被地理定位成日本用户，amazon.com 也返回 JPY 价格。
  * 有令牌桶限流与 Cookie 池，不是裸 urllib 请求，被封概率低得多。
  * 返回整页所有卡片，不只是目标 ASIN 的位置。

CLI 自测：
  python3 search_fetcher.py --keyword "office chair heating pad" --pages 3
"""

import re
import time
import random
import datetime
import urllib.parse

try:
    from .utils import _log
except ImportError:  # CLI 直接运行
    import datetime as _dt

    def _log(msg):
        print(f"[{_dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

try:
    from . import product_fetcher as pf
except ImportError:
    import product_fetcher as pf


# ============================================================
# 参数
# ============================================================
PAGE_SIZE = 48                 # 实测 amazon.com 搜索页每页 48 个卡片（自然 + 广告）
MIN_PAGES = 1
MAX_PAGES = 5                  # 上限：5 页 = 5 次请求，已是单 IP 安全边界
DEFAULT_PAGES = 3
DEFAULT_PAGES_DESC = "1~5 页，默认 3 页（144 位）"

# 页间等待：实测 25 秒以上连发 3 次是安全的；低于 10 秒连发 3~4 次即 503
PAGE_DELAY_RANGE = (14.0, 24.0)
# 被封后的退避（秒）。首次只等 25s（实测这个间隔能过），之后才拉长
BLOCK_BACKOFF = [25, 60, 120]
# 真的没有结果 vs 被限流返回降级页，靠这两个特征区分：
#   无结果页有明确文案；限流降级页只有空壳，没有 s-search-result
_NO_RESULT_HINTS = (
    "No results for",
    "did not match any products",
    "Try checking your spelling or use more general terms",
)

_CARD_RE = re.compile(
    r'<div[^>]*?data-asin="([A-Z0-9]{10})"[^>]*?data-component-type="s-search-result"',
    re.IGNORECASE,
)
# 兜底：少数布局把两个属性顺序颠倒，或只带 s-result-item class
_CARD_RE_ALT = re.compile(
    r'<div[^>]*?data-asin="([A-Z0-9]{10})"[^>]*?class="[^"]*s-result-item[^"]*"',
    re.IGNORECASE,
)
# 各站点「赞助」文案（广告判定辅助信号，HTML 标记为主、文案为辅）
SP_WORDS = {
    "US": ("Sponsored",), "UK": ("Sponsored",), "CA": ("Sponsored",), "AU": ("Sponsored",),
    "DE": ("Gesponsert", "Sponsored"), "FR": ("Sponsorisé", "Sponsored"),
    "IT": ("Sponsorizzato", "Sponsored"), "ES": ("Patrocinado", "Sponsored"),
    "JP": ("スポンサー", "Sponsored"), "MX": ("Patrocinado", "Sponsored"),
    "NL": ("Gesponsord", "Sponsored"), "SE": ("Sponsrad", "Sponsored"),
    "PL": ("Sponsorowane", "Sponsored"), "BE": ("Gesponsord", "Sponsorisé", "Sponsored"),
    "TR": ("Sponsorlu", "Sponsored"), "IN": ("Sponsored",), "SG": ("Sponsored",),
    "AE": ("Sponsored",), "SA": ("Sponsored",), "BR": ("Patrocinado", "Sponsored"),
}
_TAG_RE = re.compile(r"<[^>]+>")
_AD_HINTS = ("s-sponsored-label", "AdHolder", "puis-sponsored", 'data-component-type="sp-sponsored-result"')
_BLOCK_HINTS = (
    "Enter the characters you see below",
    "Type the characters you see in this image",
    "api-services-support@amazon.com",
    "To discuss automated access to Amazon data please contact",
    "Robot Check",
    "/errors/validateCaptcha",
    "Sorry! Something went wrong",
)
_PRICE_WHOLE_RE = re.compile(r'a-price-whole">([\d.,]+)')
_PRICE_FRAC_RE = re.compile(r'a-price-fraction">(\d+)')
_PRICE_SYM_RE = re.compile(r'a-price-symbol">([^<]{1,4})<')
_RATING_RE = re.compile(r"([\d.]+)\s+out of 5 stars")
_REVIEWS_RE = re.compile(r'aria-label="([\d,]+)\s+ratings?"')
_IMG_RE = re.compile(r'<img[^>]+src="(https://m\.media-amazon\.com/images/I/[^"]+)"')
_TITLE_RE = re.compile(r"<h2[^>]*>(.*?)</h2>", re.S)
# 「500+ bought in past month」—— 只有部分商品会展示（亚马逊按类目/库存/数据量决定），
# 抓不到就是 "—"，不代表销量为 0
_SALES_RE = re.compile(
    r">\s*([\d.]+\s*[KM]?)\+?\s*bought in (?:the )?past month\s*<", re.I)


def clamp_pages(n, default=DEFAULT_PAGES):
    """把前端传来的页数收进 1~5。非法值退回默认。"""
    try:
        v = int(n)
    except (TypeError, ValueError):
        return default
    return max(MIN_PAGES, min(MAX_PAGES, v))


def _clean(text):
    """去标签 + 压空白 + 去 HTML 实体。"""
    if not text:
        return None
    s = _TAG_RE.sub(" ", text)
    s = (s.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')
          .replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">"))
    s = re.sub(r"\s+", " ", s).strip()
    return s or None


def _num(v):
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


# ============================================================
# 解析
# ============================================================
def parse_srp(html_text, sp_words=("Sponsored",)):
    """解析一页搜索结果，返回按视觉顺序排列的卡片列表。

    广告判定用多重信号：本地化「赞助」词、s-sponsored-label、AdHolder、
    puis-sponsored。任一命中即视为广告 —— 单靠文案在部分站点会漏判。
    """
    matches = list(_CARD_RE.finditer(html_text))
    if not matches:
        matches = list(_CARD_RE_ALT.finditer(html_text))
    items = []
    for i, m in enumerate(matches):
        asin = m.group(1).upper()
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else min(len(html_text), start + 60000)
        body = html_text[start:end]

        sponsored = any(h in body for h in _AD_HINTS) or any(w in body for w in sp_words)

        whole = _PRICE_WHOLE_RE.search(body)
        frac = _PRICE_FRAC_RE.search(body)
        price = None
        if whole:
            w = whole.group(1).replace(",", "")
            price = _num(f"{w}.{frac.group(1)}" if frac else w)

        sym = _PRICE_SYM_RE.search(body)
        rating = _RATING_RE.search(body)
        reviews = _REVIEWS_RE.search(body)
        img = _IMG_RE.search(body)
        title = _TITLE_RE.search(body)
        sales = _SALES_RE.search(body)

        items.append({
            "pos": i + 1,
            "asin": asin,
            "ad": sponsored,
            "org": None,                      # 由上层跨页累加填
            "title": _clean(title.group(1)) if title else None,
            "price": price,
            "symbol": (sym.group(1).strip() if sym else None),
            "rating": _num(rating.group(1)) if rating else None,
            "reviews": int(reviews.group(1).replace(",", "")) if reviews else None,
            "img": img.group(1) if img else None,
            # 形如 "500+"：原页面上是「500+ bought in past month」，这里只留量级部分。
            # None = 该商品没展示销量，不是 0
            "sales": (sales.group(1).replace(" ", "").upper() + "+") if sales else None,
        })
    return items


def _looks_blocked(html_text):
    return any(h in html_text for h in _BLOCK_HINTS)


def _retryable(err):
    """这个错误值不值得再试一次。

    值得：被限流（blocked）、软限流降级页（no_cards）、网络抖动（neterr）。
    不值得：真没结果（empty）、404/400 这类（http_4xx）—— 重试只是白等。
    """
    if not err:
        return False
    if err in ("blocked", "no_cards"):
        return True
    if err.startswith("neterr"):
        return True
    return False


# ============================================================
# 抓取
# ============================================================
def fetch_page(keyword, marketplace="US", page=1, referer=None, timeout=30):
    """抓一页搜索结果，返回 (html, error)。

    error 取值：blocked / no_cards / http_xxx / neterr:xxx / unknown_marketplace
    """
    mp = pf.MARKETPLACES.get((marketplace or "US").upper())
    if not mp:
        return None, "unknown_marketplace"

    sess = pf.get_session(marketplace.upper())
    pf.warm_up_session(marketplace.upper())

    qs = urllib.parse.urlencode({"k": keyword, "page": page, "ref": "nb_sb_noss"})
    # language=en_US 是必须的：缺了会按 IP 地理定位变成当地语言/货币
    url = f"https://{mp['domain']}/s?{qs}&language=en_US"

    sess.acquire_rate_limit()
    # 只有翻页（page>1）才带 Referer（指向上一页结果）。第 1 页**不带**：
    # 2026-10-29 实测，warm-up 现在返回的是 202 挑战页（拿不到 session-id），
    # 此时再带 `Referer: https://www.amazon.com/` + `Sec-Fetch-Site: same-origin`，
    # 等于「声称从首页点进来、却没有首页给的 cookie」→ 被判机器人，
    # 返回 503「Sorry! Something went wrong!」或 200 空壳（表现为 no_cards）。
    # 去掉首页 Referer 后实测第 1 页恢复 200（48 卡、拿到 session-id），
    # 第 2 页再用「上一页 Referer + 第 1 页的 cookie」也正常。
    headers = pf.build_headers(sess, marketplace.upper(),
                              referer=(referer if page > 1 else None))
    status, text, resp_headers, err = pf._http_get(url, headers, timeout=timeout)

    if resp_headers is not None:
        sess.merge_cookies(resp_headers.get_all("Set-Cookie"))
    # 亚马逊会改写 i18n-prefs，每次请求后都覆写回去
    if mp.get("currency"):
        sess.cookies["i18n-prefs"] = mp["currency"]

    if err:
        return None, err
    if status in (503, 429, 202):
        # 202 = 亚马逊的 JS 挑战页（空壳、无 cookie），同样视为「被拦」，不要当正常页面
        return None, "blocked"
    if status != 200:
        return None, f"http_{status}"
    if _looks_blocked(text):
        return None, "blocked"
    if any(h in text for h in _NO_RESULT_HINTS):
        return None, "empty"
    if "s-search-result" not in text:
        # 200 但没有结果卡片：多半是被软限流后返回了降级页，不能当成「这个词没结果」。
        # 打一行诊断（标题 + 长度 + 是否命中拦截特征），否则下次又只能看到光秃秃的 no_cards。
        _m = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
        _title = _m.group(1).strip()[:60] if _m else ""
        _log(f"[srp] no_cards 诊断：status={status} len={len(text)} "
             f"title={_title!r} block_hint={_looks_blocked(text)}")
        return None, "no_cards"
    return text, None


def fetch_srp(keyword, marketplace="US", pages=DEFAULT_PAGES, on_progress=None, should_stop=None):
    """抓取 N 页搜索结果，返回整份榜单。

    返回结构：
      {
        "keyword": "...", "marketplace": "US", "pages_requested": 3, "pages_ok": 3,
        "captured_at": "2026-10-28T10:12:33", "elapsed": 47.2,
        "items": [...],                       # 跨页合并，org 已累加
        "org_total": 138, "ad_total": 6,
        "errors": [{"page": 3, "error": "blocked"}],
        "ok": True, "warn": None
      }
    """
    keyword = (keyword or "").strip()
    marketplace = (marketplace or "US").upper()
    pages = clamp_pages(pages)
    t0 = time.time()

    items = []
    errors = []
    org_seen = 0
    pages_ok = 0
    referer = None

    for page in range(1, pages + 1):
        if should_stop and should_stop():
            errors.append({"page": page, "error": "stopped"})
            break

        if on_progress:
            on_progress(f"正在抓第 {page}/{pages} 页", page - 1, pages)

        html, err = fetch_page(keyword, marketplace, page, referer=referer)

        # 被限流或网络抖动：退避重试，最多三次
        tries = 0
        while _retryable(err) and tries < len(BLOCK_BACKOFF):
            wait = BLOCK_BACKOFF[tries]
            tries += 1
            if on_progress:
                on_progress(f"第 {page} 页被限流，{wait}s 后第 {tries} 次重试", page - 1, pages)
            _log(f"[srp] {keyword} p{page} {err}，退避 {wait}s 重试（{tries}/{len(BLOCK_BACKOFF)}）")
            if tries >= 2:
                # 连续两次被拦才换会话（清 cookie + 换指纹）。首次只等待 ——
                # 过早重建会话会把已预热的 cookie 丢掉，反而更容易再被拦。
                pf.reset_session(marketplace)
            time.sleep(wait)
            if on_progress:
                on_progress(f"正在抓第 {page}/{pages} 页", page - 1, pages)
            html, err = fetch_page(keyword, marketplace, page, referer=referer)

        if err:
            errors.append({"page": page, "error": err})
            _log(f"[srp] {keyword} p{page} 失败：{err}")
            # 首页就失败，后面翻页没意义
            if page == 1:
                break
            continue

        page_items = parse_srp(html, SP_WORDS.get(marketplace) or ("Sponsored",))
        if len(page_items) < 10:
            # 卡片数异常少，说明页面结构变了或只渲染了一部分，丢掉不写脏数据
            errors.append({"page": page, "error": f"only_{len(page_items)}_cards"})
            _log(f"[srp] {keyword} p{page} 只解析到 {len(page_items)} 个卡片，丢弃")
            continue

        for it in page_items:
            if not it["ad"]:
                org_seen += 1
                it["org"] = org_seen
            it["page"] = page
        items.extend(page_items)
        pages_ok += 1
        referer = f"https://{pf.MARKETPLACES[marketplace]['domain']}/s?k={urllib.parse.quote(keyword)}&page={page}"

        if page < pages:
            delay = random.uniform(*PAGE_DELAY_RANGE)
            if on_progress:
                on_progress(f"第 {page} 页完成，等 {delay:.0f}s 再翻页（防限流）", page, pages)
            time.sleep(delay)

    if on_progress:
        on_progress("整理榜单", pages, pages)

    org_total = sum(1 for i in items if not i["ad"])
    ad_total = sum(1 for i in items if i["ad"])
    ok = pages_ok > 0 and org_total > 0

    warn = None
    if not ok:
        first = errors[0]["error"] if errors else "unknown"
        warn = {
            "blocked": "被亚马逊限流了，等 2~3 分钟再试",
            "no_cards": "页面没有解析到结果卡片，可能是限流降级页或页面结构变了",
            "empty": "这个词在亚马逊没有搜索结果，检查关键词拼写",
            "neterr": "网络请求失败，检查本机网络",
        }.get(first.split(":")[0], f"抓取失败：{first}")
    elif pages_ok < pages:
        warn = f"只成功抓到 {pages_ok}/{pages} 页，后面的位次可能缺失"

    return {
        "keyword": keyword,
        "marketplace": marketplace,
        "pages_requested": pages,
        "pages_ok": pages_ok,
        "captured_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "elapsed": round(time.time() - t0, 1),
        "items": items,
        "org_total": org_total,
        "ad_total": ad_total,
        "errors": errors,
        "ok": ok,
        "warn": warn,
    }


# ============================================================
# CLI 自测
# ============================================================
def _selftest(keyword, marketplace, pages):
    def prog(stage, done, total):
        print(f"  [{done}/{total}] {stage}")

    res = fetch_srp(keyword, marketplace, pages, on_progress=prog)
    print()
    print(f"{'坑位':>6} {'类型':<4} {'自然位':>5}  {'价格':>8}  {'评分':>4}  ASIN / 标题")
    for it in res["items"][:15]:
        kind = "广告" if it["ad"] else "自然"
        price = f"{it['symbol'] or ''}{it['price']:g}" if it["price"] else "-"
        print(f"{it['page']}-{it['pos']:<3} {kind:<4} {str(it['org'] or '-'):>5}  "
              f"{price:>8}  {str(it['rating'] or '-'):>4}  {it['asin']} {(it['title'] or '')[:40]}")
    print()
    print(f"关键词：{res['keyword']}  站点：{res['marketplace']}")
    print(f"成功 {res['pages_ok']}/{res['pages_requested']} 页 · "
          f"{len(res['items'])} 条（自然 {res['org_total']} / 广告 {res['ad_total']}）· "
          f"耗时 {res['elapsed']}s")
    if res["warn"]:
        print(f"警告：{res['warn']}")
    if res["errors"]:
        print(f"错误：{res['errors']}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--keyword", required=True)
    ap.add_argument("--marketplace", default="US")
    ap.add_argument("--pages", type=int, default=DEFAULT_PAGES)
    a = ap.parse_args()
    _selftest(a.keyword, a.marketplace, a.pages)
