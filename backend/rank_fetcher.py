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

import socket
import urllib.request
import urllib.parse
import gzip
import io
import re
import json
import time
import random
import threading
import argparse
import datetime

from .utils import _log


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
    "Sorry! Something went wrong",
    # 与 search_fetcher 对齐：2026 年三种挑战页，别只靠后面的 bm-verify / 长度兜底
    "bm-verify=",
    "triggerInterstitialChallenge",
    'id="checkpointForm"',
    "/checkpoint/validate",
]


def _now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _decompress(resp):
    raw = resp.read()
    enc = (resp.headers.get("Content-Encoding") or "").lower()
    if "gzip" in enc:
        return gzip.GzipFile(fileobj=io.BytesIO(raw)).read().decode("utf-8", "replace")
    return raw.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# 全局请求节流
#
# 亚马逊对未登录访客的社区经验上限是 10~15 请求/分钟（200~300/小时），
# 超过就可能收到 CAPTCHA / bm-verify 挑战。
# 取 7~9 秒/请求（≈7 次/分钟）留余量；所有 HTTP 抓取共用同一条速率线（跨线程）。
# 注意：CDP 真实浏览器通道不走这里 —— 它本身就是慢的，且不是同一套指纹。
# ---------------------------------------------------------------------------
MIN_REQ_INTERVAL = 7.0
REQ_JITTER = 2.0
_rate_lock = threading.Lock()
_rate_state = {"next_at": 0.0}


def _throttle():
    """全局节流：等到下一次允许发请求的时刻，再预约下一次。"""
    with _rate_lock:
        now = time.monotonic()
        wait = _rate_state["next_at"] - now
        if wait > 0:
            time.sleep(wait)
            now = time.monotonic()
        _rate_state["next_at"] = now + MIN_REQ_INTERVAL + random.uniform(0, REQ_JITTER)


def search_url(marketplace, keyword, page=1):
    """搜索结果页 URL（HTTP 与 CDP 两条通道共用，避免两处拼参不一致）。"""
    mk = MARKETPLACES.get((marketplace or "US").upper())
    if not mk:
        return None
    qs = urllib.parse.urlencode({"k": keyword, "page": page, "ref": "nb_sb_noss"})
    return f"https://{mk['domain']}/s?{qs}"


def fetch_via_cdp(marketplace, keyword, page=1, timeout=18, retries=1):
    """用真实浏览器（CDP）抓搜索页 —— HTTP 被 bm-verify 拦时的兜底。

    为什么有效：bm-verify 是一个要执行 JS 才能通过的插页，纯 HTTP 客户端
    天生过不了；真实 Chrome 跑完脚本会自动跳转回正常结果页。

    timeout=18（2026-11-16 从 12 上调）：实测同一页要 14.3s 才渲染出 50 张卡片，
    12s 到点取 DOM 时偶尔还是空壳 → `cdp_no_results`（steering wheel cover
    09:51 那次就是）。留 4 秒余量。
    另加一次重试：第二次导航资源已在缓存里，通常更快；只有 `cdp_no_results`
    才值得重试（blocked / cdp 异常重试没用）。
    """
    url = search_url(marketplace, keyword, page)
    if not url:
        return None, "unknown_marketplace"
    try:
        from . import browser_fetch
        if not browser_fetch.available():
            return None, "cdp_unavailable"
    except Exception as e:
        return None, f"cdp_exc:{type(e).__name__}"

    last = None
    for attempt in range(max(1, int(retries) + 1)):
        try:
            html, err = browser_fetch._fetch_headless_cdp(
                url, ready_expr="!!document.querySelector('.s-search-result')",
                timeout=timeout)
        except Exception as e:
            return None, f"cdp_exc:{type(e).__name__}"
        if err:
            return None, f"cdp_{err}"          # 超时/打不开，重试也一样
        if any(h in html for h in _BLOCK_HINTS) or "bm-verify" in html:
            return None, "cdp_blocked"
        if "s-search-result" in html:
            return html, None
        last = "cdp_no_results"
        if attempt < retries:
            _log(f"[rank] CDP 拿到空壳（{len(html)} 字节），{timeout}s 后重试一次")
            time.sleep(2)
    return None, last or "cdp_no_results"


def fetch_page(marketplace, keyword, page=1, timeout=20, fingerprint=None):
    """抓取一页搜索结果，返回 (html, error)。被封返回 (None, 'blocked')。
    fingerprint: 来自 _FINGERPRINTS 的一个条目，None 时随机选取。
    """
    mk = MARKETPLACES.get(marketplace.upper())
    if not mk:
        return None, "unknown_marketplace"
    _throttle()
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
    except urllib.error.URLError as e:
        # 只记 "neterr:URLError" 根本没法诊断（DNS？超时？连接重置？）——
        # 把 reason 带上：neterr:URLError:gaierror / :timeout / :ConnectionResetError
        reason = getattr(e, "reason", None)
        kind = type(reason).__name__ if reason is not None else "unknown"
        return None, f"neterr:URLError:{kind}"
    except Exception as e:
        return None, f"neterr:{type(e).__name__}"

    if any(h in html_text for h in _BLOCK_HINTS):
        return None, "blocked"
    # Amazon 的 bot 验证跳转页：HTTP 200、只有 2KB，正文是一句
    # `<meta http-equiv="refresh" content="5; URL='/s?...&bm-verify=AAQ...'">`。
    # 里面没有 s-search-result，原来会被误判成 "no_results"（看着像「这个词没结果」），
    # 其实是**被拦了**——两者的处理策略完全不同（前者要重抓，后者要等风控解除）。
    if "bm-verify" in html_text or len(html_text) < 20000:
        if "bm-verify" in html_text or 'http-equiv="refresh"' in html_text:
            return None, "blocked"
    if "s-search-result" not in html_text:
        return None, "no_results"
    return html_text, None


# 这两个错误多半是「这一下被拦了」，不是真的没结果：换一个指纹、等几秒再来
# 通常就好了（实测 12:00 整批 24 条 no_results，几小时后同一批词全部正常拿到 50 条）。
# 原实现遇到 no_results 直接 break，于是整批被记成 not_found、当天数据全空。
_SOFT_FAILS = ("blocked", "no_results")

# 瞬时网络故障：换指纹没用，但**退避重试有用**（DNS 几秒后恢复、代理节点切换完成）。
# 原来这些被当「硬错误」第一次就 break，于是 11-17 06:00 那批 4 个词
# 12 条快照全是 gaierror —— 一次失败就整页放弃，连重试都没有。
_NET_RETRY_HINTS = ("gaierror", "ssleof", "ssl", "timeout", "timed out",
                    "connectionreset", "remotedisconnected", "eof",
                    "connection refused", "connectionrefused")


def _net_retryable(err):
    """`neterr:*` 里哪些值得重试（瞬时网络故障）。"""
    e = (err or "").lower()
    return e.startswith("neterr") and any(h in e for h in _NET_RETRY_HINTS)


def _dns_ok(host="www.amazon.com"):
    """系统 DNS 能否解析 —— gaierror 时判断「值不值得交给浏览器」。

    Chrome 用同一套系统解析：DNS 服务器都不可达时，CDP 只是白等 18 秒。
    """
    try:
        socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        return True
    except Exception:
        return False


def fetch_page_resilient(marketplace, keyword, page=1, timeout=20, fingerprint=None,
                         tries=3, allow_cdp=False):
    """带「换指纹 + 退避」重试的 fetch_page，返回 (html, err, fingerprint)。

    返回值多带一个 fingerprint：重试时换过指纹的话，调用方后续翻页要用同一个，
    否则同一关键词的几页来自不同身份，容易又被拦。

    allow_cdp：遇到 blocked 时改用真实浏览器（CDP）兜底。
    bm-verify 是「要执行 JS 才能过」的插页，换指纹重试是白撞——实测量子级概率
    还不如直接上浏览器。CDP 慢（25~40s/页），由调用方控制用几次。
    """
    fp = fingerprint or random.choice(_FINGERPRINTS)
    last = None
    via = "http"
    for i in range(max(1, int(tries))):
        if i:
            fp = random.choice(_FINGERPRINTS)
            # 网络类退避短一些：DNS 恢复 / 代理切节点通常几秒就好
            if _net_retryable(last):
                time.sleep(random.uniform(2.0, 4.0))
            else:
                time.sleep(random.uniform(4.0, 8.0))
        html, err = fetch_page(marketplace, keyword, page, timeout=timeout, fingerprint=fp)
        if not err:
            return html, None, fp, via
        last = err

        if err == "blocked" and allow_cdp:
            # bm-verify 要执行 JS 才过，换指纹是白撞 → 直接上浏览器
            html, cdp_err = fetch_via_cdp(marketplace, keyword, page)
            if not cdp_err:
                return html, None, fp, "cdp"
            last = f"{err}|{cdp_err}"
            via = "cdp_failed"
            break
        if err in _SOFT_FAILS or _net_retryable(err):
            continue                   # 软失败 / 瞬时网络：继续换指纹重试
        break                          # http_404 / unknown_marketplace 等真硬错误

    # 重试用尽：网络类故障最后交给浏览器试一次。Chrome 的连接复用与代理规则不同于
    # urllib，实测 SSLEOFError 这类能过；但 gaierror 若系统 DNS 也不通就跳过（白等 18s）。
    if allow_cdp and _net_retryable(last) and last not in _SOFT_FAILS:
        if "gaierror" not in (last or "").lower() or _dns_ok():
            _log(f"[rank] 「{keyword}」HTTP 网络失败（{last}），改用真实浏览器兜底")
            html, cdp_err = fetch_via_cdp(marketplace, keyword, page)
            if not cdp_err:
                return html, None, fp, "cdp"
            last = f"{last}|{cdp_err}"
            via = "cdp_failed"
        else:
            _log(f"[rank] 「{keyword}」系统 DNS 也不通（{last}），跳过浏览器兜底")

    # 重试过还不行 → 标记一下，方便前端区分「试了一次就空」与「试了三次都空」
    if last in _SOFT_FAILS:
        last = f"{last}_x{max(1, int(tries))}"
    return None, last, fp, via


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
                delay_range=(2.0, 5.0), debug=False, allow_cdp=False):
    """
    跨页定位 ASIN 排名。
    返回结构化结果（见模块文档）。organic_rank 为剔除广告后的全局自然序号。

    allow_cdp=True 时，HTTP 被 bm-verify 拦就改用真实浏览器兜底（慢但能过）。
    """
    asin = asin.upper().strip() if asin else None
    mk = MARKETPLACES.get(marketplace.upper())
    sp_words = mk["sp"] if mk else ["Sponsored"]
    fp = random.choice(_FINGERPRINTS)  # 同一关键词所有翻页使用同一指纹

    used_cdp = False           # 本词是否用真实浏览器兜底成功（调用方据此扣配额）
    cdp_tried = False          # 是否尝试过兜底（失败也要让前端「来源」列看得出来）
    organic_seen = 0           # 截至目前累计的自然结果数（用于跨页全局排名）
    sponsored_hits = []        # 命中的广告坑位 [{page, slot}]
    organic_rank = None
    organic_page = None
    last_error = None

    for page in range(1, max_pages + 1):
        html_text, err, fp, via = fetch_page_resilient(
            marketplace, keyword, page, fingerprint=fp, allow_cdp=allow_cdp)
        if via == "cdp":
            used_cdp = True
        elif via == "cdp_failed":
            cdp_tried = True
        if err:
            last_error = err
            # 被封 / 网络错误 / 重试后仍空 → 这个关键词到此为止
            break

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
    elif last_error and last_error.startswith("blocked"):
        status = "blocked"     # 被验证码/风控拦了，页面没打开成功
    elif last_error and last_error.startswith(("neterr", "http_")):
        status = "error"       # 网络/HTTP 错误
    elif last_error:
        status = "failed"      # no_results(_x3)：页面打开了，但里面没有商品列表
    else:
        # 页面全部正常、也解析到了商品，只是这几页里没有这个 ASIN。
        # 这是一个**有效结论**（排名掉出前 N 页），不是采集失败 —— 必须和
        # 「页面没抓到」分开，否则用户看到「失败」会以为是网络问题。
        status = "not_ranked"

    return {
        "asin": asin,
        "keyword": keyword,
        "marketplace": marketplace.upper(),
        "status": status,
        "organic_rank": organic_rank,
        "organic_page": organic_page,
        "sponsored": sponsored_hits,
        "organic_scanned": organic_seen,
        "via": ("cdp" if used_cdp else
                ("cdp_failed" if cdp_tried else "http")),
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
