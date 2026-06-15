#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
产品详情采集器（移植自 mine/amazon-scraper 的 server/scraper.ts）
====================================================================
输入 ASIN + 站点，抓取亚马逊产品详情页（可选评论页），解析：
  - 标题/品牌/价格/评分/评论数/库存状态/五点描述/正文描述
  - 主图/图集/A+图片
  - 规格参数 specifications / 产品信息 productDetails
  - 类目面包屑 / 卖家
  - Best Sellers Rank（主类目/子类目排名）
  - 顾客评价摘要 customers_say / 评论图 / "买家关注点" 标签

DOM 解析依赖 beautifulsoup4（可选 lxml 加速），缺失时优雅降级：
  返回 status='failed'，error_message 提示未安装依赖，不影响其余功能。

反爬策略（与 scraper.ts 对齐）：
  - 浏览器指纹池（UA + sec-ch-ua 等需保持一致）
  - 会话级 Cookie 池 + i18n-prefs 货币 cookie
  - 令牌桶限流 + 最小请求间隔（默认比关键词排名更保守）
  - 退避重试 + CAPTCHA/dog-page 检测后重置会话并轮换指纹
  - 批量抓取自动重试一轮失败项

CLI 自测：
  python3 product_fetcher.py --asin B0XXXXXXXX --marketplace US
  python3 product_fetcher.py --asin B0XXXXXXXX --marketplace US --reviews
"""

import os
import re
import io
import gzip
import zlib
import json
import time
import random
import argparse
import threading
import urllib.request
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from bs4 import BeautifulSoup, Tag
    _HAS_BS4 = True
except ImportError:
    _HAS_BS4 = False
    Tag = None


# ============================================================
# 站点配置：域名 + 中文名 + 国旗 + Accept-Language + 货币（i18n-prefs cookie）
# ============================================================
MARKETPLACES = {
    "US": {"domain": "www.amazon.com",    "name": "美国",   "flag": "🇺🇸", "lang": "en-US,en;q=0.9",            "currency": "USD"},
    "UK": {"domain": "www.amazon.co.uk",  "name": "英国",   "flag": "🇬🇧", "lang": "en-GB,en;q=0.9",            "currency": "GBP"},
    "DE": {"domain": "www.amazon.de",     "name": "德国",   "flag": "🇩🇪", "lang": "de-DE,de;q=0.9,en;q=0.8",   "currency": "EUR"},
    "FR": {"domain": "www.amazon.fr",     "name": "法国",   "flag": "🇫🇷", "lang": "fr-FR,fr;q=0.9,en;q=0.8",   "currency": "EUR"},
    "IT": {"domain": "www.amazon.it",     "name": "意大利", "flag": "🇮🇹", "lang": "it-IT,it;q=0.9,en;q=0.8",   "currency": "EUR"},
    "ES": {"domain": "www.amazon.es",     "name": "西班牙", "flag": "🇪🇸", "lang": "es-ES,es;q=0.9,en;q=0.8",   "currency": "EUR"},
    "JP": {"domain": "www.amazon.co.jp",  "name": "日本",   "flag": "🇯🇵", "lang": "ja-JP,ja;q=0.9,en;q=0.8",   "currency": "JPY"},
    "CA": {"domain": "www.amazon.ca",     "name": "加拿大", "flag": "🇨🇦", "lang": "en-CA,en;q=0.9",            "currency": "CAD"},
    "AU": {"domain": "www.amazon.com.au", "name": "澳大利亚", "flag": "🇦🇺", "lang": "en-AU,en;q=0.9",          "currency": "AUD"},
    "IN": {"domain": "www.amazon.in",     "name": "印度",   "flag": "🇮🇳", "lang": "en-IN,en;q=0.9,hi;q=0.8",   "currency": "INR"},
    "MX": {"domain": "www.amazon.com.mx", "name": "墨西哥", "flag": "🇲🇽", "lang": "es-MX,es;q=0.9,en;q=0.8",   "currency": "MXN"},
    "BR": {"domain": "www.amazon.com.br", "name": "巴西",   "flag": "🇧🇷", "lang": "pt-BR,pt;q=0.9,en;q=0.8",   "currency": "BRL"},
    "SG": {"domain": "www.amazon.sg",     "name": "新加坡", "flag": "🇸🇬", "lang": "en-SG,en;q=0.9",            "currency": "SGD"},
    "AE": {"domain": "www.amazon.ae",     "name": "阿联酋", "flag": "🇦🇪", "lang": "en-AE,en;q=0.9,ar;q=0.8",   "currency": "AED"},
    "SA": {"domain": "www.amazon.sa",     "name": "沙特阿拉伯", "flag": "🇸🇦", "lang": "ar-SA,ar;q=0.9,en;q=0.8", "currency": "SAR"},
    "NL": {"domain": "www.amazon.nl",     "name": "荷兰",   "flag": "🇳🇱", "lang": "nl-NL,nl;q=0.9,en;q=0.8",   "currency": "EUR"},
    "SE": {"domain": "www.amazon.se",     "name": "瑞典",   "flag": "🇸🇪", "lang": "sv-SE,sv;q=0.9,en;q=0.8",   "currency": "SEK"},
    "PL": {"domain": "www.amazon.pl",     "name": "波兰",   "flag": "🇵🇱", "lang": "pl-PL,pl;q=0.9,en;q=0.8",   "currency": "PLN"},
    "BE": {"domain": "www.amazon.com.be", "name": "比利时", "flag": "🇧🇪", "lang": "nl-BE,nl;q=0.9,fr;q=0.8,en;q=0.7", "currency": "EUR"},
    "TR": {"domain": "www.amazon.com.tr", "name": "土耳其", "flag": "🇹🇷", "lang": "tr-TR,tr;q=0.9,en;q=0.8",   "currency": "TRY"},
}


# ============================================================
# 浏览器指纹池：UA + platform + sec-ch-ua* （Firefox/Safari 不发 sec-ch-ua 组头）
# ============================================================
BROWSER_PROFILES = [
    {
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"Windows"', "sec_ch_ua_mobile": "?0",
    },
    {
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Google Chrome";v="133", "Chromium";v="133", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"Windows"', "sec_ch_ua_mobile": "?0",
    },
    {
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"macOS"', "sec_ch_ua_mobile": "?0",
    },
    {
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Google Chrome";v="133", "Chromium";v="133", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"macOS"', "sec_ch_ua_mobile": "?0",
    },
    {
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
        "sec_ch_ua": '"Microsoft Edge";v="134", "Chromium";v="134", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"Windows"', "sec_ch_ua_mobile": "?0",
    },
    {
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
        "sec_ch_ua": '"Microsoft Edge";v="133", "Chromium";v="133", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"Windows"', "sec_ch_ua_mobile": "?0",
    },
    {
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"Linux"', "sec_ch_ua_mobile": "?0",
    },
    {
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
        "sec_ch_ua": "", "sec_ch_ua_platform": "", "sec_ch_ua_mobile": "",
    },
    {
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0",
        "sec_ch_ua": "", "sec_ch_ua_platform": "", "sec_ch_ua_mobile": "",
    },
    {
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
        "sec_ch_ua": "", "sec_ch_ua_platform": "", "sec_ch_ua_mobile": "",
    },
    {
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Google Chrome";v="132", "Chromium";v="132", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"Windows"', "sec_ch_ua_mobile": "?0",
    },
    {
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="99"',
        "sec_ch_ua_platform": '"Windows"', "sec_ch_ua_mobile": "?0",
    },
]


# ============================================================
# 限流参数（无代理走本机住宅 IP，比关键词排名更保守，均可用环境变量覆盖）
# ============================================================
TOKEN_BUCKET_CAPACITY = int(os.environ.get("SCRAPER_BUCKET_CAPACITY", "6"))
TOKEN_REFILL_RATE_MS = int(os.environ.get("SCRAPER_REFILL_MS", "2500"))
MIN_REQUEST_INTERVAL_MS = int(os.environ.get("SCRAPER_MIN_INTERVAL_MS", "1200"))

MAX_RETRIES = 3
RETRY_DELAYS = [3.0, 6.0, 12.0]


class ProductNotFoundError(Exception):
    pass


# ============================================================
# 会话状态：每个站点一个 Cookie 池 + 浏览器指纹 + 令牌桶
# ============================================================
class SessionState:
    def __init__(self, marketplace):
        self.lock = threading.Lock()
        currency = MARKETPLACES.get(marketplace, {}).get("currency")
        self.cookies = {"i18n-prefs": currency} if currency else {}
        self.profile = random.choice(BROWSER_PROFILES)
        self.last_request_time = 0.0
        self.request_count = 0
        self.initialized = False
        self.token_bucket = TOKEN_BUCKET_CAPACITY
        self.last_token_refill = time.monotonic()

    def merge_cookies(self, set_cookie_headers):
        if not set_cookie_headers:
            return
        for h in set_cookie_headers:
            name_value = h.split(";")[0]
            if "=" not in name_value:
                continue
            name, _, value = name_value.partition("=")
            name = name.strip()
            value = value.strip()
            if name:
                self.cookies[name] = value

    def cookie_string(self):
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items())

    def acquire_rate_limit(self):
        """令牌桶限流：阻塞直到可以发起下一次请求。"""
        refill_sec = TOKEN_REFILL_RATE_MS / 1000.0
        min_interval_sec = MIN_REQUEST_INTERVAL_MS / 1000.0
        with self.lock:
            now = time.monotonic()
            elapsed = now - self.last_token_refill
            tokens_to_add = int(elapsed // refill_sec)
            if tokens_to_add > 0:
                self.token_bucket = min(TOKEN_BUCKET_CAPACITY, self.token_bucket + tokens_to_add)
                self.last_token_refill = now - (elapsed % refill_sec)

            since_last = time.monotonic() - self.last_request_time
            if since_last < min_interval_sec:
                time.sleep(min_interval_sec - since_last + random.random() * 0.5)

            while self.token_bucket < 1:
                time.sleep(refill_sec / 2)
                now2 = time.monotonic()
                elapsed2 = now2 - self.last_token_refill
                add = int(elapsed2 // refill_sec)
                if add > 0:
                    self.token_bucket = min(TOKEN_BUCKET_CAPACITY, self.token_bucket + add)
                    self.last_token_refill = now2 - (elapsed2 % refill_sec)

            self.token_bucket -= 1


_sessions = {}
_sessions_lock = threading.Lock()


def get_session(marketplace):
    with _sessions_lock:
        if marketplace not in _sessions:
            _sessions[marketplace] = SessionState(marketplace)
        return _sessions[marketplace]


def reset_session(marketplace=None):
    """重置会话（清空 Cookie、轮换指纹），用于"刷新会话"按钮。"""
    with _sessions_lock:
        if marketplace:
            _sessions.pop(marketplace, None)
        else:
            _sessions.clear()


def human_delay(base_sec, jitter_sec):
    """模拟人类操作的随机延迟：5% 概率追加 1~3 秒的"思考"停顿。"""
    extra = (1.0 + random.random() * 2.0) if random.random() < 0.05 else 0.0
    secs = base_sec + (random.random() * 2 - 1) * jitter_sec + extra
    time.sleep(max(0.3, secs))


# ============================================================
# HTTP 请求
# ============================================================
def _decompress(raw, encoding):
    enc = (encoding or "").lower()
    if "gzip" in enc:
        try:
            return gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
        except Exception:
            return raw
    if "deflate" in enc:
        try:
            return zlib.decompress(raw)
        except Exception:
            try:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
            except Exception:
                return raw
    return raw


def _http_get(url, headers, timeout=30):
    """返回 (status, html_text, resp_headers, err)。err 仅在网络层异常时非空。"""
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        status = resp.status
        raw = resp.read()
        resp_headers = resp.headers
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read()
        except Exception:
            raw = b""
        resp_headers = e.headers
    except Exception as e:
        return None, None, None, f"neterr:{type(e).__name__}"

    body = _decompress(raw, resp_headers.get("Content-Encoding") if resp_headers else None)
    text = body.decode("utf-8", "replace")
    return status, text, resp_headers, None


def build_headers(session, marketplace, referer=None):
    mp = MARKETPLACES[marketplace]
    profile = session.profile
    is_chromium = bool(profile.get("sec_ch_ua"))

    headers = {
        "User-Agent": profile["user_agent"],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": mp["lang"],
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "max-age=0",
    }

    if is_chromium:
        headers["sec-ch-ua"] = profile["sec_ch_ua"]
        headers["sec-ch-ua-mobile"] = profile["sec_ch_ua_mobile"]
        headers["sec-ch-ua-platform"] = profile["sec_ch_ua_platform"]
        headers["Sec-Fetch-Dest"] = "document"
        headers["Sec-Fetch-Mode"] = "navigate"
        headers["Sec-Fetch-Site"] = "same-origin" if referer else "none"
        headers["Sec-Fetch-User"] = "?1"

    if referer:
        headers["Referer"] = referer

    ck = session.cookie_string()
    if ck:
        headers["Cookie"] = ck

    return headers


# ============================================================
# CAPTCHA / 拦截页检测
# ============================================================
def is_captcha_page(html_text):
    lower = html_text.lower()
    return (
        "captcha" in lower
        or "robot check" in lower
        or "type the characters you see" in lower
        or "sorry, we just need to make sure" in lower
        or "enter the characters you see below" in lower
        or "api-services-support@amazon.com" in lower
    )


def is_dog_page(html_text):
    lower = html_text.lower()
    return ("sorry" in lower and "dogs of amazon" in lower) or "ref=cs_503_link" in lower


# ============================================================
# 会话预热：先访问首页收集 Cookie（session-id / i18n-prefs 等）
# ============================================================
def warm_up_session(marketplace):
    session = get_session(marketplace)
    if session.initialized:
        return

    mp = MARKETPLACES.get(marketplace)
    if not mp:
        return

    url = f"https://{mp['domain']}/"
    headers = build_headers(session, marketplace)

    status, _text, resp_headers, err = _http_get(url, headers, timeout=20)
    if err is None and resp_headers is not None:
        session.merge_cookies(resp_headers.get_all("Set-Cookie"))
        if mp.get("currency"):
            session.cookies["i18n-prefs"] = mp["currency"]
        session.initialized = True
        session.last_request_time = time.monotonic()
        human_delay(0.8, 0.4)


# ============================================================
# 抓取产品页（带退避重试 + CAPTCHA 检测）
# ============================================================
def fetch_product_page(asin, marketplace):
    mp = MARKETPLACES.get(marketplace)
    if not mp:
        raise ValueError(f"Unknown marketplace: {marketplace}")

    session = get_session(marketplace)
    warm_up_session(marketplace)

    if marketplace == "US":
        product_url = f"https://{mp['domain']}/dp/{asin}?language=en_US"
    else:
        product_url = f"https://{mp['domain']}/dp/{asin}"

    referers = [
        f"https://{mp['domain']}/s?k={asin}",
        f"https://{mp['domain']}/",
        f"https://{mp['domain']}/s?k={asin}&ref=nb_sb_noss",
        f"https://{mp['domain']}/gp/bestsellers/",
    ]

    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        if attempt > 0:
            session.profile = random.choice(BROWSER_PROFILES)
            time.sleep(RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)] + random.random() * 2)

        session.acquire_rate_limit()

        referer = random.choice(referers)
        headers = build_headers(session, marketplace, referer)

        status, html_text, resp_headers, err = _http_get(product_url, headers, timeout=30)

        if err:
            last_error = err
            continue

        session.last_request_time = time.monotonic()
        session.request_count += 1
        if resp_headers is not None:
            session.merge_cookies(resp_headers.get_all("Set-Cookie"))
        if mp.get("currency"):
            session.cookies["i18n-prefs"] = mp["currency"]

        if status == 404:
            raise ProductNotFoundError(f"产品不存在或ASIN无效 ({asin})，请检查ASIN是否正确")

        if status == 503 or is_dog_page(html_text):
            last_error = "Amazon服务暂时不可用(503)，正在重试..."
            continue

        if status != 200:
            last_error = f"http_{status}"
            continue

        if is_captcha_page(html_text):
            last_error = "检测到CAPTCHA验证页面"
            session.cookies = {}
            session.initialized = False
            continue

        return html_text

    raise RuntimeError(last_error or f"Failed to fetch product page after {MAX_RETRIES + 1} attempts")


# ============================================================
# 文本清洗：去除页面中泄漏的 JS 代码片段，规整空白
# ============================================================
def clean_text(raw):
    if not raw:
        return None
    cleaned = raw
    cleaned = re.sub(r'P\.when\([^)]*\)[^;]*;?', '', cleaned)
    cleaned = re.sub(r'function\s*\([^)]*\)\s*\{[^}]*\}', '', cleaned)
    cleaned = re.sub(r'(?:var|let|const)\s+\w+\s*=[^;]+;', '', cleaned)
    cleaned = re.sub(r'A\.declarative\([\s\S]*?\);', '', cleaned)
    cleaned = re.sub(r'if\s*\(window\.ue\)[\s\S]*?\}', '', cleaned)
    cleaned = re.sub(r'ue\.count\([^)]*\)', '', cleaned)
    cleaned = re.sub(r'(?:window|document)\.\w+(?:\.\w+)*', '', cleaned)
    cleaned = re.sub(r'dpAcr\w+', '', cleaned)
    cleaned = re.sub(r'\b[a-z][a-zA-Z]{4,}(?:Has|Is|Should|Can|Will)[A-Z]\w*', '', cleaned)
    cleaned = re.sub(r'[\r\n\t]+', ' ', cleaned)
    cleaned = re.sub(r'\s{2,}', ' ', cleaned)
    cleaned = cleaned.strip()
    return cleaned if len(cleaned) >= 2 else None


def clean_record(record):
    result = {}
    for k, v in record.items():
        ck = clean_text(k)
        cv = clean_text(v)
        if ck and cv:
            result[ck] = cv
    return result


# ============================================================
# BeautifulSoup 辅助函数
# ============================================================
def _make_soup(html_text):
    if not _HAS_BS4:
        return None
    try:
        return BeautifulSoup(html_text, "lxml")
    except Exception:
        return BeautifulSoup(html_text, "html.parser")


def _text1(soup, selector):
    el = soup.select_one(selector)
    return el.get_text().strip() if el else ""


def _text_all(soup, selector):
    return "".join(e.get_text() for e in soup.select(selector))


def _prev_element_sibling(el, names=None):
    sib = el.previous_sibling
    while sib is not None:
        if isinstance(sib, Tag):
            if names is None or sib.name in names:
                return sib
            if names is not None:
                sib = sib.previous_sibling
                continue
        sib = sib.previous_sibling
    return None


def _next_element_sibling(el, names=None):
    sib = el.next_sibling
    while sib is not None:
        if isinstance(sib, Tag):
            if names is None or sib.name in names:
                return sib
        sib = sib.next_sibling
    return None


def _closest_with_attr(el, attr):
    cur = el
    while cur is not None and isinstance(cur, Tag):
        if cur.has_attr(attr):
            return cur
        cur = cur.parent
    return None


def _brand_from(soup, selector):
    text = _text1(soup, selector)
    if not text:
        return ""
    text = re.sub(r'^(Visit the |Brand: |Store: )', '', text)
    text = re.sub(r' Store$', '', text)
    return text


# ============================================================
# 解析产品页
# ============================================================
def parse_product_page(html_text, asin, marketplace):
    soup = _make_soup(html_text)
    if soup is None:
        raise RuntimeError("缺少 beautifulsoup4，无法解析产品页面")

    mp = MARKETPLACES.get(marketplace, {})
    url = f"https://{mp.get('domain', 'www.amazon.com')}/dp/{asin}"

    # 移除 <script>/<style> 前先抓取脚本文本（图片 hiRes / A+ JSON 用得上）
    script_content = "".join(s.get_text() for s in soup.find_all("script"))
    for tag in soup(["script", "style"]):
        tag.decompose()

    # 标题
    title = clean_text(_text1(soup, "#productTitle")) or clean_text(_text1(soup, "h1#title span")) or None

    # 品牌
    raw_brand = _brand_from(soup, "#bylineInfo") or _brand_from(soup, "a#bylineInfo") or ""
    brand = clean_text(raw_brand)

    # 价格
    price = (
        _text1(soup, ".a-price .a-offscreen")
        or _text1(soup, "#priceblock_ourprice")
        or _text1(soup, "#priceblock_dealprice")
        or None
    )
    if not price:
        whole = soup.select_one("span.a-price-whole")
        if whole and whole.parent:
            off = whole.parent.select_one(".a-offscreen")
            if off:
                price = off.get_text().strip()

    # 评分（提取数字部分，如 "4.7 out of 5 stars" -> "4.7"）
    raw_rating = (
        _text1(soup, "span.a-icon-alt")
        or _text1(soup, "#acrPopover .a-icon-alt")
        or _text1(soup, "[data-hook='average-star-rating'] .a-icon-alt")
        or None
    )
    rating = None
    if raw_rating:
        m = re.search(r'([\d.]+)\s*out of', raw_rating, re.I) or re.search(r'^([\d.]+)', raw_rating)
        rating = m.group(1) if m else clean_text(raw_rating)

    # 评论数
    raw_review_count = (
        _text1(soup, "#acrCustomerReviewText")
        or _text1(soup, "span[data-hook='total-review-count']")
        or None
    )
    review_count = clean_text(raw_review_count)

    # 库存状态
    raw_availability = _text1(soup, "#availability span") or _text1(soup, "#availability") or None
    availability = clean_text(raw_availability)

    # 五点描述
    bullet_points = []
    for el in soup.select("#feature-bullets ul li span.a-list-item"):
        text = clean_text(el.get_text())
        if text and "›" not in text and len(text) > 2:
            bullet_points.append(text)
    if not bullet_points:
        for el in soup.select("#feature-bullets .a-unordered-list .a-list-item"):
            text = clean_text(el.get_text())
            if text and "›" not in text and len(text) > 2:
                bullet_points.append(text)

    # 正文描述
    description = (
        clean_text(_text_all(soup, "#productDescription p"))
        or clean_text(_text1(soup, "#productDescription"))
        or clean_text(_text1(soup, "#productDescription_feature_div"))
        or None
    )
    if description and len(description) < 10:
        description = None

    # 主图
    main_image = None
    landing = soup.select_one("#landingImage, #imgBlkFront")
    if landing:
        main_image = landing.get("data-old-hires") or None
        if not main_image:
            dyn = landing.get("data-a-dynamic-image")
            if dyn:
                try:
                    img_obj = json.loads(dyn)
                    best, best_area = None, -1
                    for img_url, dims in img_obj.items():
                        area = dims[0] * dims[1]
                        if area > best_area:
                            best_area, best = area, img_url
                    main_image = best
                except Exception:
                    main_image = None
        if not main_image:
            main_image = landing.get("src") or None

    # 全部图片：优先从脚本里的 hiRes JSON 提取
    images = []
    for m in re.finditer(r'"hiRes"\s*:\s*"(https://[^"]+)"', script_content):
        if m.group(1) not in images:
            images.append(m.group(1))
    if not images:
        for el in soup.select("#altImages .a-spacing-small img, #imageBlock img"):
            src = el.get("src") or ""
            src = re.sub(r'\._[A-Z0-9_]+_\.', '.', src)
            if src and src.startswith("http") and src not in images and "sprite" not in src:
                images.append(src)

    # 规格参数
    raw_specs = {}
    for el in soup.select("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr"):
        th, td = el.find("th"), el.find("td")
        key = th.get_text().strip() if th else ""
        value = td.get_text().strip() if td else ""
        if key and value:
            raw_specs[key] = value
    for el in soup.select("table.a-keyvalue tr, #prodDetails table tr"):
        key_el = el.select_one("th, td:first-child")
        tds = el.find_all("td")
        key = key_el.get_text().strip() if key_el else ""
        value = tds[-1].get_text().strip() if tds else ""
        if key and value and key != value:
            raw_specs[key] = value
    specifications = clean_record(raw_specs)

    # 产品信息
    raw_pd = {}
    for el in soup.select("#detailBullets_feature_div li, #productDetails_db_sections .a-section"):
        text = el.get_text().strip()
        parts = re.split(r'\s*[:：]\s*', text)
        if len(parts) >= 2:
            key = re.sub(r'[^\w\s一-鿿]', '', parts[0]).strip()
            value = ":".join(parts[1:]).strip()
            if key and value:
                raw_pd[key] = value
    for el in soup.select("#detailBulletsWrapper_feature_div li"):
        spans = el.select("span span")
        if len(spans) >= 2:
            key = re.sub(r'[：:\s]+$', '', spans[0].get_text()).strip()
            value = spans[1].get_text().strip()
            if key and value:
                raw_pd[key] = value
    product_details = clean_record(raw_pd)

    # 类目面包屑
    cats = [a.get_text().strip() for a in soup.select("#wayfinding-breadcrumbs_container a")]
    cats = [c for c in cats if c]
    raw_categories = " > ".join(cats) if cats else None
    if not raw_categories:
        cats2 = [a.get_text().strip() for a in soup.select("ul.a-unordered-list.a-horizontal.a-size-small a")]
        cats2 = [c for c in cats2 if c]
        raw_categories = " > ".join(cats2) if cats2 else None
    categories = clean_text(raw_categories)

    # 卖家
    raw_seller = _text1(soup, "#sellerProfileTriggerId") or _text1(soup, "#merchant-info a") or None
    seller = clean_text(raw_seller)

    # ============================================================
    # Best Sellers Rank：格式如 "#72,186 in Kitchen & Dining ... #146 in Compact Refrigerators"
    # ============================================================
    bsr_main_category = bsr_main_rank = bsr_sub_category = bsr_sub_rank = bsr_raw_text = None

    bsr_text = (
        product_details.get("Best Sellers Rank")
        or product_details.get("Best-sellers rank")
        or product_details.get("Amazon Best Sellers Rank")
        or specifications.get("Best Sellers Rank")
        or specifications.get("Best-sellers rank")
        or specifications.get("Amazon Best Sellers Rank")
        or None
    )

    if not bsr_text:
        for el in soup.select(
            "#detailBulletsWrapper_feature_div li, #productDetails_db_sections li, #productDetails_detailBullets_sections1 tr"
        ):
            t = el.get_text()
            if "Best Sellers Rank" in t or "Best-sellers rank" in t:
                bsr_text = re.sub(r'\s+', ' ', t).strip()
                break

    if not bsr_text:
        for el in soup.select("table tr, #productDetails_techSpec_section_1 tr"):
            th = el.find("th")
            th_text = th.get_text() if th else ""
            if "Best Sellers Rank" in th_text or "Best-sellers rank" in th_text:
                td = el.find("td")
                bsr_text = re.sub(r'\s+', ' ', td.get_text()).strip() if td else None
                break

    if bsr_text:
        bsr_raw_text = bsr_text
        bsr_regex = re.compile(r'#(\d[\d,]*)\s+in\s+([^#(\n]+?)(?:\s*\(See Top 100 in [^)]+\)|\s*#|$)')
        entries = []
        for m in bsr_regex.finditer(bsr_text):
            try:
                rank_num = int(m.group(1).replace(",", ""))
            except ValueError:
                continue
            cat_name = re.sub(r'\s+', ' ', m.group(2).strip())
            cat_name = re.sub(r'\s*\([^)]*\)\s*$', '', cat_name).strip()
            if cat_name:
                entries.append((rank_num, cat_name))
        if len(entries) == 1:
            bsr_main_rank, bsr_main_category = entries[0][0], entries[0][1]
        elif len(entries) >= 2:
            bsr_main_rank, bsr_main_category = entries[0][0], entries[0][1]
            bsr_sub_rank, bsr_sub_category = entries[-1][0], entries[-1][1]

    # ============================================================
    # 顾客评价：customers_say 摘要 / 评论图 / "买家关注点" 标签
    # 注意：大量评论数据走 AJAX，初始 HTML 仅含部分数据，原项目固有限制
    # ============================================================
    say_candidates = []

    el = soup.select_one("[data-hook='cr-insights-widget-aspects-summary']")
    say_candidates.append(el.get_text().strip() if el else "")

    el = soup.select_one("[data-hook='cr-summarization-header']")
    nxt = _next_element_sibling(el, ("p", "div")) if el else None
    say_candidates.append(nxt.get_text().strip() if nxt else "")

    say_candidates.append(_text1(soup, "[data-hook='cr-lighthouse-summary']"))

    el = soup.select_one(".cr-lighthouse-term-list-header")
    nxt = _next_element_sibling(el) if el else None
    say_candidates.append(nxt.get_text().strip() if nxt else "")

    el = soup.select_one("#cr-summarization-attributes-list")
    closest = _closest_with_attr(el, "data-hook") if el else None
    prv = _prev_element_sibling(closest) if closest else None
    say_candidates.append(prv.get_text().strip() if prv else "")

    for sel in ("[data-hook='cr-insights-widget']", "#cr-insights-widget"):
        el = soup.select_one(sel)
        inner = el.find("p") if el else None
        say_candidates.append(inner.get_text().strip() if inner else "")

    say_candidates.append(_text1(soup, ".cr-insights-widget-aspects-summary"))

    el = soup.select_one("[data-hook='cr-lighthouse-term-list']")
    prv = _prev_element_sibling(el, ("p", "div")) if el else None
    say_candidates.append(prv.get_text().strip() if prv else "")

    say_candidates = [s for s in say_candidates if len(s) > 20]
    customers_say = clean_text(say_candidates[0]) if say_candidates else None

    # 评论图（最多 10 张）：脚本 JSON + DOM 选择器
    review_images = []

    def _add_review_img(src):
        if src and src.startswith("http") and "sprite" not in src and len(review_images) < 10 and src not in review_images:
            review_images.append(src)

    for m in re.finditer(r'"thumbnailImage"\s*:\s*"(https:[^"]+)"', html_text):
        _add_review_img(re.sub(r'\._[A-Z0-9_,]+_\.', '._SL500_.', m.group(1), flags=re.I))
    for m in re.finditer(r'"mediumImage"\s*:\s*"(https:[^"]+)"|"fullImage"\s*:\s*"(https:[^"]+)"', html_text):
        src = m.group(1) or m.group(2) or ""
        _add_review_img(re.sub(r'\._[A-Z0-9_,]+_\.', '._SL500_.', src, flags=re.I))
    for el in soup.select(
        "[data-hook='cr-media-gallery-thumbnail'] img, [data-hook='review-image-tile'] img, .cr-lighthouse-image img, .review-image-tile img"
    ):
        src = el.get("src") or el.get("data-src") or ""
        _add_review_img(re.sub(r'\._[A-Z0-9_,]+_\.', '._SL500_.', src, flags=re.I))
    for el in soup.select("#cr-mediacustomer-review-images img"):
        src = el.get("src") or ""
        _add_review_img(re.sub(r'\._[A-Z0-9_,]+_\.', '._SL500_.', src, flags=re.I))

    # "买家关注点"标签
    select_to_learn_more = []
    for sel in (
        ".cr-lighthouse-term",
        "[data-hook='cr-summarization-attribute'] span",
        "#cr-summarization-attributes-list .a-list-item",
        "[data-hook='cr-lighthouse-term-list'] li",
        "[data-hook='cr-insights-widget'] .a-list-item",
        ".cr-insights-widget-aspects-list li",
    ):
        for el in soup.select(sel):
            text = clean_text(el.get_text())
            if text and 1 < len(text) < 100 and text not in select_to_learn_more:
                select_to_learn_more.append(text)

    # ============================================================
    # A+ 内容图片
    # ============================================================
    aplus_images = []

    def _add_aplus(src):
        if (
            src and src.startswith("http")
            and "transparent" not in src and "sprite" not in src
            and "amazon-logo" not in src and "amazon" in src
        ):
            hi_res = re.sub(r'\._[A-Z0-9_,]+_\.', '._SL1500_.', src, flags=re.I)
            if hi_res not in aplus_images:
                aplus_images.append(hi_res)

    for sel in (
        "#aplus img", "#aplus3p_feature_div img", "#aplusProductDescription_feature_div img",
        "#dpx-aplus-product-description_feature_div img", ".aplus-v2 img",
    ):
        for el in soup.select(sel):
            _add_aplus(el.get("src") or el.get("data-src") or el.get("data-old-hires") or "")

    for el in soup.select("#aplus noscript, #aplus3p_feature_div noscript"):
        noscript_html = el.decode_contents()
        for m in re.finditer(r'src="(https://[^"]+)"', noscript_html):
            src = m.group(1)
            if src and "transparent" not in src and "sprite" not in src and "amazon" in src:
                hi_res = re.sub(r'\._[A-Z0-9_,]+_\.', '._SL1500_.', src, flags=re.I)
                if hi_res not in aplus_images:
                    aplus_images.append(hi_res)

    for m in re.finditer(r'"aplus[^"]*"\s*:\s*\{[^}]*"src"\s*:\s*"(https://[^"]+)"', script_content):
        src = m.group(1)
        if src and "amazon" in src and "sprite" not in src:
            hi_res = re.sub(r'\._[A-Z0-9_,]+_\.', '._SL1500_.', src, flags=re.I)
            if hi_res not in aplus_images:
                aplus_images.append(hi_res)

    main_image_urls = set(images)
    if main_image:
        main_image_urls.add(main_image)
    aplus_images = [img for img in aplus_images if img not in main_image_urls]

    return {
        "asin": asin,
        "marketplace": marketplace,
        "url": url,
        "title": title,
        "brand": brand,
        "price": price,
        "rating": rating,
        "review_count": review_count,
        "availability": availability,
        "bullet_points": bullet_points,
        "description": description,
        "main_image": main_image,
        "images": images,
        "aplus_images": aplus_images,
        "specifications": specifications,
        "product_details": product_details,
        "categories": categories,
        "seller": seller,
        "bsr_main_category": bsr_main_category,
        "bsr_main_rank": bsr_main_rank,
        "bsr_sub_category": bsr_sub_category,
        "bsr_sub_rank": bsr_sub_rank,
        "bsr_raw_text": bsr_raw_text,
        "customers_say": customers_say,
        "review_images": review_images,
        "select_to_learn_more": select_to_learn_more,
        "status": "success",
        "error_message": None,
    }


# ============================================================
# 评论页抓取与解析（/product-reviews/{asin} 是静态 HTML，比详情页含更多评论数据）
# ============================================================
def fetch_reviews_page(asin, marketplace, product_url):
    mp = MARKETPLACES.get(marketplace)
    if not mp:
        return None

    session = get_session(marketplace)
    reviews_url = f"https://{mp['domain']}/product-reviews/{asin}?reviewerType=all_reviews&sortBy=recent&pageNumber=1"

    try:
        session.acquire_rate_limit()
        headers = build_headers(session, marketplace, product_url)
        status, html_text, resp_headers, err = _http_get(reviews_url, headers, timeout=30)
        if err:
            return None

        session.last_request_time = time.monotonic()
        if resp_headers is not None:
            session.merge_cookies(resp_headers.get_all("Set-Cookie"))
        if mp.get("currency"):
            session.cookies["i18n-prefs"] = mp["currency"]

        if status != 200:
            return None
        if is_captcha_page(html_text) or is_dog_page(html_text):
            return None
        return html_text
    except Exception:
        return None


def parse_reviews_page(html_text):
    soup = _make_soup(html_text)
    if soup is None:
        return {}

    say_candidates = []
    for sel in (
        "[data-hook='cr-insights-widget-aspects-summary']",
        "[data-hook='cr-lighthouse-summary']",
        ".cr-lighthouse-summary",
        "[data-hook='cr-summarization-description']",
        ".a-section.cr-lighthouse-summary-widget p",
    ):
        say_candidates.append(_text1(soup, sel))
    for sel in ("[data-hook='cr-insights-widget']", "#cr-insights-widget"):
        el = soup.select_one(sel)
        inner = el.find("p") if el else None
        say_candidates.append(inner.get_text().strip() if inner else "")
    say_candidates.append(_text1(soup, "[data-hook='review-body'] span"))

    say_candidates = [s for s in say_candidates if len(s) > 30]
    customers_say = clean_text(say_candidates[0]) if say_candidates else None

    review_images = []

    def _add(src):
        if src and src.startswith("http") and "sprite" not in src and len(review_images) < 10 and src not in review_images:
            review_images.append(src)

    for el in soup.select(
        "[data-hook='review-image-tile'] img, .review-image-tile img, "
        "[data-hook='cr-media-gallery-thumbnail'] img, .cr-media-fullsize-thumbnail img, "
        ".cr-lighthouse-image img, #cm_cr-review_list img[src*='images-amazon'], "
        "#cm_cr-review_list img[src*='images-na']"
    ):
        src = el.get("src") or el.get("data-src") or ""
        _add(re.sub(r'\._[A-Z0-9_,]+_\.', '._SL500_.', src, flags=re.I))

    for pat in (
        r'"thumbnailImage"\s*:\s*"(https:[^"]+)"',
        r'"imageURL"\s*:\s*"(https:[^"]+)"',
        r'"large"\s*:\s*"(https://images[^"]+)"',
        r'"mediumImage"\s*:\s*"(https:[^"]+)"',
    ):
        for m in re.finditer(pat, html_text):
            _add(re.sub(r'\._[A-Z0-9_,]+_\.', '._SL500_.', m.group(1), flags=re.I))

    select_to_learn_more = []
    for sel in (
        ".cr-lighthouse-term",
        "[data-hook='cr-summarization-attribute'] span",
        "[data-hook='cr-summarization-attribute-name']",
        "#cr-summarization-attributes-list .a-list-item",
        "[data-hook='cr-lighthouse-term-list'] li",
        "[data-hook='cr-insights-widget'] .a-list-item",
        ".cr-insights-widget-aspects-list li",
        "[data-hook='cr-summarization-attributes-list'] li",
    ):
        for el in soup.select(sel):
            text = clean_text(el.get_text())
            if text and 1 < len(text) < 100 and text not in select_to_learn_more:
                select_to_learn_more.append(text)

    return {
        "customers_say": customers_say,
        "review_images": review_images[:10],
        "select_to_learn_more": select_to_learn_more[:20],
    }


# ============================================================
# 评论列表抓取与解析（评论采集工具：单条评论，支持分页/排序/筛选/增量去重）
# ============================================================
def _parse_helpful_count(text):
    """解析 "X people found this helpful" / "One person found this helpful" -> int，解析失败返回 None。"""
    if not text:
        return None
    t = text.strip()
    if not t:
        return None
    m = re.search(r'([\d,]+)\s+people', t, re.I)
    if m:
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            return None
    if re.search(r'\bone person\b', t, re.I):
        return 1
    m = re.search(r'([\d,]+)', t)
    if m:
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            return None
    return None


def parse_review_list(html_text):
    """解析评论列表页，返回单条评论 dict 列表（与 parse_reviews_page 的聚合信息不同）。"""
    soup = _make_soup(html_text)
    if soup is None:
        return []

    reviews = []
    for el in soup.select("[data-hook='review']"):
        review_id = el.get("id") or None

        rating = None
        rating_text = _text1(el, "[data-hook='review-star-rating'], [data-hook='cmps-review-star-rating']")
        m = re.search(r'([\d.]+)\s+out of', rating_text)
        if m:
            try:
                rating = float(m.group(1))
            except ValueError:
                rating = None

        title_raw = _text1(el, "[data-hook='review-title']")
        title = clean_text(re.sub(r'^[\d.]+\s+out of\s+5\s+stars\s*', '', title_raw, flags=re.I))

        author = clean_text(_text1(el, ".a-profile-name")) or None
        date_raw = clean_text(_text1(el, "[data-hook='review-date']")) or None
        verified = el.select_one("[data-hook='avp-badge']") is not None
        body = clean_text(_text1(el, "[data-hook='review-body']"))
        helpful_count = _parse_helpful_count(_text1(el, "[data-hook='helpful-vote-statement']"))

        images = []
        for img in el.select("[data-hook='review-image-tile'] img"):
            src = img.get("src") or img.get("data-src") or ""
            if src.startswith("http"):
                src = re.sub(r'\._[A-Z0-9_,]+_\.', '._SL500_.', src, flags=re.I)
                if src not in images:
                    images.append(src)

        reviews.append({
            "review_id": review_id,
            "rating": rating,
            "title": title,
            "author": author,
            "date_raw": date_raw,
            "verified": verified,
            "body": body,
            "helpful_count": helpful_count,
            "images": images[:5],
        })

    return reviews


def fetch_review_list(asin, marketplace, max_pages=3, sort_by="recent", filter_by_star=None, verified_only=False):
    """分页抓取 ASIN 的评论列表，返回 (reviews, error_message)。

    遇空列表/CAPTCHA/连续两页内容相同提前停止；error_message 仅在"完全没抓到任何评论"时设置，
    若已抓到部分评论后续页失败，视为部分成功（error_message 仍为 None）。
    """
    mp = MARKETPLACES.get(marketplace)
    if not mp:
        return [], f"不支持的站点: {marketplace}"

    session = get_session(marketplace)
    warm_up_session(marketplace)

    sort_by = sort_by if sort_by in ("recent", "helpful") else "recent"
    max_pages = max(1, min(int(max_pages or 1), 10))

    base_params = {
        "reviewerType": "all_reviews",
        "sortBy": sort_by,
    }
    if verified_only:
        base_params["reviewerType"] = "avp_only_reviews"
    if filter_by_star:
        star_names = {1: "one_star", 2: "two_star", 3: "three_star", 4: "four_star", 5: "five_star"}
        star_name = star_names.get(int(filter_by_star))
        if star_name:
            base_params["filterByStar"] = star_name

    referer = f"https://{mp['domain']}/dp/{asin}"

    reviews = []
    seen_keys = set()
    error_message = None
    prev_page_html = None

    for page_num in range(1, max_pages + 1):
        params = dict(base_params)
        params["pageNumber"] = page_num
        url = f"https://{mp['domain']}/product-reviews/{asin}?{urllib.parse.urlencode(params)}"

        last_error = None
        page_html = None
        for attempt in range(MAX_RETRIES + 1):
            if attempt > 0:
                session.profile = random.choice(BROWSER_PROFILES)
                time.sleep(RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)] + random.random() * 2)

            session.acquire_rate_limit()
            headers = build_headers(session, marketplace, referer)
            status, html_text, resp_headers, err = _http_get(url, headers, timeout=30)

            if err:
                last_error = err
                continue

            session.last_request_time = time.monotonic()
            session.request_count += 1
            if resp_headers is not None:
                session.merge_cookies(resp_headers.get_all("Set-Cookie"))
            if mp.get("currency"):
                session.cookies["i18n-prefs"] = mp["currency"]

            if status == 503 or is_dog_page(html_text):
                last_error = "Amazon服务暂时不可用(503)，正在重试..."
                continue

            if status != 200:
                last_error = f"http_{status}"
                continue

            if is_captcha_page(html_text):
                last_error = "检测到CAPTCHA验证页面"
                session.cookies = {}
                session.initialized = False
                continue

            page_html = html_text
            break

        if page_html is None:
            if not reviews:
                error_message = last_error or "抓取失败"
            break

        if prev_page_html is not None and page_html == prev_page_html:
            break
        prev_page_html = page_html

        page_reviews = parse_review_list(page_html)
        if not page_reviews:
            break

        new_on_page = 0
        for r in page_reviews:
            if verified_only and not r["verified"]:
                continue
            if filter_by_star and r["rating"] is not None and int(round(r["rating"])) != int(filter_by_star):
                continue
            key = r["review_id"] or (r["author"], r["date_raw"], r["body"])
            if key in seen_keys:
                continue
            seen_keys.add(key)
            reviews.append(r)
            new_on_page += 1

        if new_on_page == 0:
            break

        if page_num < max_pages:
            human_delay(1.0, 0.5)

    return reviews, error_message


def fetch_reviews_for_asins(asins, marketplace, max_pages=3, sort_by="recent", filter_by_star=None, verified_only=False, on_progress=None):
    """批量抓取多个 ASIN 的评论列表，返回与 asins 等长的结果列表：
    [{asin, marketplace, reviews, status, error_message}, ...]
    """
    batch_size = max(1, int(os.environ.get("SCRAPER_CONCURRENCY", "2")))
    asins = [a.strip().upper() for a in asins if a and a.strip()]
    results = [None] * len(asins)
    completed = 0

    def _run_one(idx, asin, stagger_sec):
        if stagger_sec > 0:
            time.sleep(stagger_sec)
        reviews, error_message = fetch_review_list(asin, marketplace, max_pages, sort_by, filter_by_star, verified_only)
        return idx, {
            "asin": asin,
            "marketplace": marketplace,
            "reviews": reviews,
            "status": "failed" if (error_message and not reviews) else "success",
            "error_message": error_message,
        }

    for start in range(0, len(asins), batch_size):
        batch = list(range(start, min(start + batch_size, len(asins))))
        with ThreadPoolExecutor(max_workers=batch_size) as executor:
            futures = [
                executor.submit(_run_one, idx, asins[idx], (pos * 0.6 + random.random() * 0.3) if pos > 0 else 0)
                for pos, idx in enumerate(batch)
            ]
            for fut in as_completed(futures):
                idx, result = fut.result()
                results[idx] = result
                completed += 1
                if on_progress:
                    on_progress(completed, len(asins), result)
        if start + batch_size < len(asins):
            human_delay(1.2, 0.6)

    return results


# ============================================================
# 公共接口
# ============================================================
def _empty_product(asin, marketplace, error_message=None):
    mp = MARKETPLACES.get(marketplace)
    domain = mp["domain"] if mp else "www.amazon.com"
    return {
        "asin": asin, "marketplace": marketplace, "url": f"https://{domain}/dp/{asin}",
        "title": None, "brand": None, "price": None, "rating": None,
        "review_count": None, "availability": None, "bullet_points": [],
        "description": None, "main_image": None, "images": [], "aplus_images": [],
        "specifications": {}, "product_details": {}, "categories": None, "seller": None,
        "bsr_main_category": None, "bsr_main_rank": None, "bsr_sub_category": None,
        "bsr_sub_rank": None, "bsr_raw_text": None,
        "customers_say": None, "review_images": [], "select_to_learn_more": [],
        "status": "failed", "error_message": error_message,
    }


def scrape_product(asin, marketplace, with_reviews=False):
    """抓取单个 ASIN，返回字段与 scrape_products 表列一一对应的 dict。"""
    asin = (asin or "").strip().upper()
    marketplace = (marketplace or "US").upper()

    if not _HAS_BS4:
        return _empty_product(asin, marketplace, "未安装 beautifulsoup4，无法解析产品页面")

    if marketplace not in MARKETPLACES:
        return _empty_product(asin, marketplace, f"不支持的站点: {marketplace}")

    try:
        html_text = fetch_product_page(asin, marketplace)
    except ProductNotFoundError as e:
        return _empty_product(asin, marketplace, str(e))
    except Exception as e:
        return _empty_product(asin, marketplace, str(e) or "抓取失败")

    try:
        product = parse_product_page(html_text, asin, marketplace)
    except Exception as e:
        return _empty_product(asin, marketplace, f"解析失败: {e}")

    if not product["title"] and not product["main_image"]:
        if is_captcha_page(html_text):
            product["error_message"] = "被亚马逊反爬虫机制拦截（CAPTCHA），请稍后重试或点击'刷新会话'后重试"
        elif is_dog_page(html_text):
            product["error_message"] = "亚马逊返回了错误页面，该ASIN可能已下架或不存在"
        else:
            product["error_message"] = "未能解析到产品数据，该ASIN可能已下架、不存在或页面结构已变更"
        product["status"] = "failed"
        return product

    if with_reviews:
        reviews_html = fetch_reviews_page(asin, marketplace, product["url"])
        if reviews_html:
            review_data = parse_reviews_page(reviews_html)
            if review_data.get("customers_say"):
                product["customers_say"] = review_data["customers_say"]
            if review_data.get("review_images"):
                merged = list(dict.fromkeys(review_data["review_images"] + product["review_images"]))
                product["review_images"] = merged[:10]
            if review_data.get("select_to_learn_more"):
                product["select_to_learn_more"] = review_data["select_to_learn_more"]

    return product


def scrape_products(asins, marketplace, with_reviews=False, on_progress=None):
    """批量抓取，返回与 asins 等长的结果列表；失败项会自动重试一轮。"""
    batch_size = max(1, int(os.environ.get("SCRAPER_CONCURRENCY", "2")))
    asins = [a.strip().upper() for a in asins if a and a.strip()]
    results = [None] * len(asins)
    completed = 0
    completed_lock = threading.Lock()

    def _run_one(idx, asin, stagger_sec):
        if stagger_sec > 0:
            time.sleep(stagger_sec)
        return idx, scrape_product(asin, marketplace, with_reviews)

    def _process(indices, stagger_base, jitter, count_progress):
        nonlocal completed
        with ThreadPoolExecutor(max_workers=batch_size) as executor:
            futures = [
                executor.submit(_run_one, idx, asins[idx], (pos * stagger_base + random.random() * jitter) if pos > 0 else 0)
                for pos, idx in enumerate(indices)
            ]
            for fut in as_completed(futures):
                idx, product = fut.result()
                results[idx] = product
                if count_progress:
                    with completed_lock:
                        completed += 1
                        if on_progress:
                            on_progress(completed, len(asins), product)

    # 第一轮
    for start in range(0, len(asins), batch_size):
        batch = list(range(start, min(start + batch_size, len(asins))))
        _process(batch, 0.6, 0.3, count_progress=True)
        if start + batch_size < len(asins):
            human_delay(1.2, 0.6)

    # 失败重试一轮（排除 ASIN 不存在/无效的明确失败）
    failed_indices = [
        i for i, r in enumerate(results)
        if r and r["status"] == "failed"
        and "不存在" not in (r.get("error_message") or "")
        and "无效" not in (r.get("error_message") or "")
    ]

    if failed_indices:
        session = get_session(marketplace)
        session.profile = random.choice(BROWSER_PROFILES)
        time.sleep(min(8 + len(failed_indices) * 1.5, 25))

        for start in range(0, len(failed_indices), batch_size):
            chunk = failed_indices[start:start + batch_size]
            _process(chunk, 1.2, 0.6, count_progress=False)
            if start + batch_size < len(failed_indices):
                human_delay(3.0, 1.0)

    return results


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--asin", required=True)
    ap.add_argument("--marketplace", default="US")
    ap.add_argument("--reviews", action="store_true")
    a = ap.parse_args()
    result = scrape_product(a.asin, a.marketplace, with_reviews=a.reviews)
    print(json.dumps(result, ensure_ascii=False, indent=2))
