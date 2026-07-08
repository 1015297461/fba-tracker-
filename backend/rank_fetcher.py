#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
关键词排名采集器（本地网络直连版）
====================================
输入 ASIN + 站点 + 关键词，抓取亚马逊搜索结果页，定位：
  - 自然排名 organic_rank（剔除广告后的跨页全局序号）
  - 广告位 sponsored（出现在搜索结果中的赞助坑位）

仅依赖 Python 标准库（urllib），与 backend/app.py 保持零第三方依赖。

注意：
  * 直连出口为本机住宅 IP，请控制频率（请求间随机间隔）。
  * 命中验证码/封锁时返回 status='blocked'，不写入脏数据。
  * 亚马逊页面结构会变，解析失效时返回 status='error'。

CLI 自测：
  python3 rank_fetcher.py --keyword "yoga mat" --marketplace US
  python3 rank_fetcher.py --keyword "yoga mat" --marketplace US --asin B0XXXXXXXX
"""

import urllib.request
import urllib.parse
import gzip
import io
import re
import json
import time
import random
import argparse
import datetime


# 站点配置：域名 + Accept-Language + 该语言下"赞助"标签关键词
MARKETPLACES = {
    "US": {"domain": "www.amazon.com",    "lang": "en-US,en;q=0.9", "sp": ["Sponsored"]},
    "UK": {"domain": "www.amazon.co.uk",  "lang": "en-GB,en;q=0.9", "sp": ["Sponsored"]},
    "CA": {"domain": "www.amazon.ca",     "lang": "en-CA,en;q=0.9", "sp": ["Sponsored"]},
    "DE": {"domain": "www.amazon.de",     "lang": "de-DE,de;q=0.9", "sp": ["Gesponsert", "Sponsored"]},
    "FR": {"domain": "www.amazon.fr",     "lang": "fr-FR,fr;q=0.9", "sp": ["Sponsorisé", "Sponsored"]},
    "IT": {"domain": "www.amazon.it",     "lang": "it-IT,it;q=0.9", "sp": ["Sponsorizzato", "Sponsored"]},
    "ES": {"domain": "www.amazon.es",     "lang": "es-ES,es;q=0.9", "sp": ["Patrocinado", "Sponsored"]},
    "JP": {"domain": "www.amazon.co.jp",  "lang": "ja-JP,ja;q=0.9", "sp": ["スポンサー", "Sponsored"]},
    "MX": {"domain": "www.amazon.com.mx", "lang": "es-MX,es;q=0.9", "sp": ["Patrocinado", "Sponsored"]},
    "AU": {"domain": "www.amazon.com.au", "lang": "en-AU,en;q=0.9", "sp": ["Sponsored"]},
}

# 浏览器指纹池：UA + 配套的 sec-ch-ua 头（Safari 不发此组头）
_FINGERPRINTS = [
    {
        "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
    },
    {
        "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    },
    {
        "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
              "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "sec-ch-ua": None,
        "sec-ch-ua-mobile": None,
        "sec-ch-ua-platform": None,
    },
]

# 一个搜索结果卡片的开标签：data-asin 与 s-search-result 同在 <div> 内
_CARD_RE = re.compile(
    r'<div[^>]*?data-asin="([A-Z0-9]{10})"[^>]*?data-component-type="s-search-result"',
    re.IGNORECASE,
)
# 封锁/验证码特征
_BLOCK_HINTS = [
    "Enter the characters you see below",
    "Type the characters you see in this image",
    "api-services-support@amazon.com",
    "To discuss automated access to Amazon data please contact",
    "Robot Check",
    "/errors/validateCaptcha",
]


def _now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _decompress(resp):
    raw = resp.read()
    enc = (resp.headers.get("Content-Encoding") or "").lower()
    if "gzip" in enc:
        return gzip.GzipFile(fileobj=io.BytesIO(raw)).read().decode("utf-8", "replace")
    return raw.decode("utf-8", "replace")


def fetch_page(marketplace, keyword, page=1, timeout=20, fingerprint=None):
    """抓取一页搜索结果，返回 (html, error)。被封返回 (None, 'blocked')。
    fingerprint: 来自 _FINGERPRINTS 的一个条目，None 时随机选取。
    """
    mk = MARKETPLACES.get(marketplace.upper())
    if not mk:
        return None, "unknown_marketplace"
    fp = fingerprint if fingerprint is not None else random.choice(_FINGERPRINTS)
    qs = urllib.parse.urlencode({"k": keyword, "page": page, "ref": "nb_sb_noss"})
    url = f"https://{mk['domain']}/s?{qs}"
    headers = {
        "User-Agent": fp["ua"],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": mk["lang"],
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none" if page == 1 else "same-origin",
        "sec-fetch-user": "?1",
    }
    if fp.get("sec-ch-ua"):
        headers["sec-ch-ua"] = fp["sec-ch-ua"]
        headers["sec-ch-ua-mobile"] = fp["sec-ch-ua-mobile"]
        headers["sec-ch-ua-platform"] = fp["sec-ch-ua-platform"]
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html_text = _decompress(resp)
    except urllib.error.HTTPError as e:
        if e.code in (503, 429):
            return None, "blocked"
        return None, f"http_{e.code}"
    except Exception as e:
        return None, f"neterr:{type(e).__name__}"

    if any(h in html_text for h in _BLOCK_HINTS):
        return None, "blocked"
    if "s-search-result" not in html_text:
        return None, "no_results"
    return html_text, None


def parse_cards(html_text, sp_words):
    """解析一页，按视觉顺序返回 [{asin, sponsored, slot}]，slot 为页内 1 基坑位。"""
    matches = list(_CARD_RE.finditer(html_text))
    cards = []
    for i, m in enumerate(matches):
        asin = m.group(1)
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(html_text)
        body = html_text[start:end]
        # 赞助判定：卡片内出现本地化"赞助"词，或带 sponsored class
        sponsored = any(w in body for w in sp_words) or \
            ("s-sponsored-label" in body) or ("AdHolder" in body) or \
            ("puis-sponsored" in body)
        cards.append({"asin": asin, "sponsored": sponsored, "slot": i + 1})
    return cards


def locate_rank(asin, marketplace, keyword, max_pages=3,
                delay_range=(2.0, 5.0), debug=False):
    """
    跨页定位 ASIN 排名。
    返回结构化结果（见模块文档）。organic_rank 为剔除广告后的全局自然序号。
    """
    asin = asin.upper().strip() if asin else None
    mk = MARKETPLACES.get(marketplace.upper())
    sp_words = mk["sp"] if mk else ["Sponsored"]
    fp = random.choice(_FINGERPRINTS)  # 同一关键词所有翻页使用同一指纹

    organic_seen = 0           # 截至目前累计的自然结果数（用于跨页全局排名）
    sponsored_hits = []        # 命中的广告坑位 [{page, slot}]
    organic_rank = None
    organic_page = None
    last_error = None

    for page in range(1, max_pages + 1):
        html_text, err = fetch_page(marketplace, keyword, page, fingerprint=fp)
        if err:
            last_error = err
            # 被封或网络错误直接中断
            if err in ("blocked",) or err.startswith("neterr") or err.startswith("http_"):
                break
            if err == "no_results":
                break
            continue

        cards = parse_cards(html_text, sp_words)
        if debug:
            print(f"  [page {page}] {len(cards)} cards, "
                  f"{sum(1 for c in cards if c['sponsored'])} sponsored")

        for c in cards:
            if not c["sponsored"]:
                organic_seen += 1
            if asin and c["asin"] == asin:
                if c["sponsored"]:
                    sponsored_hits.append({"page": page, "slot": c["slot"]})
                elif organic_rank is None:
                    organic_rank = organic_seen
                    organic_page = page

        # ASIN 已找到自然位即可停（广告位通常在前页，已记录）
        if asin and organic_rank is not None:
            break
        if page < max_pages:
            time.sleep(random.uniform(*delay_range))

    # 优先看是否找到结果：找到即 ok，即使后续页面出错也不覆盖
    if asin is None:
        status = "ok"          # 仅探测模式（无目标 ASIN）
    elif organic_rank is not None or sponsored_hits:
        status = "ok"
    elif last_error in ("blocked",) or (last_error and last_error.startswith(("neterr", "http_"))):
        status = "blocked" if last_error == "blocked" else "error"
    else:
        status = "not_found"

    return {
        "asin": asin,
        "keyword": keyword,
        "marketplace": marketplace.upper(),
        "status": status,
        "organic_rank": organic_rank,
        "organic_page": organic_page,
        "sponsored": sponsored_hits,
        "organic_scanned": organic_seen,
        "error": last_error,
        "captured_at": _now_iso(),
    }


def _selftest(keyword, marketplace, asin, debug):
    """先探测页面（列前若干自然/广告 ASIN），再定位目标。"""
    print(f"== 探测 {marketplace} / '{keyword}' ==")
    html_text, err = fetch_page(marketplace, keyword, 1)
    if err:
        print(f"  抓取失败: {err}")
        return
    mk = MARKETPLACES[marketplace.upper()]
    cards = parse_cards(html_text, mk["sp"])
    print(f"  第1页解析到 {len(cards)} 个卡片：")
    org = 0
    for c in cards[:12]:
        tag = "AD " if c["sponsored"] else "   "
        if not c["sponsored"]:
            org += 1
        n = "" if c["sponsored"] else f"自然#{org}"
        print(f"    slot{c['slot']:>2} [{tag}] {c['asin']}  {n}")

    target = asin or (next((c["asin"] for c in cards if not c["sponsored"]), None))
    if target:
        print(f"\n== 定位 ASIN {target} ==")
        res = locate_rank(target, marketplace, keyword, max_pages=2, debug=debug)
        print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--keyword", required=True)
    ap.add_argument("--marketplace", default="US")
    ap.add_argument("--asin", default=None)
    ap.add_argument("--debug", action="store_true")
    a = ap.parse_args()
    _selftest(a.keyword, a.marketplace, a.asin, a.debug)
