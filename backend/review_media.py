"""评论媒体（Customer photos and videos）按需抓取。

为什么走浏览器 CDP，而不是 requests
------------------------------------
2026-10-15 实测结论（详见 docs/AGENTS 备注）：
- 评论图片/视频由详情页的 **懒加载 widget `cr-customer-videos`** 提供，
  端点为 POST /portal/customer-reviews/ajax/lazy-widgets/stream
- 该端点**要求有效会话**：不带 cookie 返回 0 字节；干净匿名会话同样返回 0
  （对照实验：用户浏览器 168,632 字节 / 29 项；干净实例 3,282 字节 / 0 项）
- 因此 requests 抓不到。改为**驱动本机已开浏览器的 CDP**：
  请求从真实浏览器发出（真实 UA / cookie / headers），行为最接近真人，风险最低。

调用链
------
本模块 → cdp-proxy(127.0.0.1:3456) → 用户本机浏览器 → amazon.com

仅 root 账号可触发（路由层限制）。员工侧只读已落库的缓存。
"""

import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from .product_fetcher import MARKETPLACES
from .utils import _log

# ---------------------------------------------------------------------------
# CDP Proxy
# ---------------------------------------------------------------------------

PROXY_BASE = "http://127.0.0.1:3456"
SKILL_DIR = os.path.expanduser("~/.workbuddy/skills/web-access/scripts")
CHECK_DEPS = os.path.join(SKILL_DIR, "check-deps.mjs")
PROXY_SCRIPT = os.path.join(SKILL_DIR, "cdp-proxy.mjs")

PAGE_READY_TIMEOUT = 40      # 等待详情页出现 #cr-state-object 的上限（秒）
PAGE_POLL_INTERVAL = 1.0
WIDGETS = [
    "cr-reviews-ai-pills-t1",
    "cr-age-recommendation",
    "cr-solicitation",
    "cr-reviews-ai-pills-t2",
    "cr-customer-videos",
]

# 显式禁用环境代理：本机 127.0.0.1 的请求不该走 HTTP_PROXY（踩过坑）
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _http(url, data=None, method=None, timeout=30):
    """调 cdp-proxy 的 HTTP API，返回 (status, text)。"""
    req = urllib.request.Request(url, data=data, method=method)
    try:
        with _opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read() or b"").decode("utf-8", "replace")
    except Exception as e:
        return None, f"neterr:{type(e).__name__}"


def proxy_alive():
    """proxy 是否在跑且已连上浏览器。"""
    status, text = _http(f"{PROXY_BASE}/targets", timeout=6)
    if status != 200:
        return False
    try:
        return isinstance(json.loads(text), list)
    except Exception:
        return False


def ensure_ready():
    """确保 CDP 可用。返回 (ok, detail)。

    先看 proxy 是否已连上；没有则跑 check-deps（它会发现浏览器 + 拉起 proxy）。
    """
    if proxy_alive():
        return True, "ready"
    if not os.path.exists(CHECK_DEPS) or shutil.which("node") is None:
        return False, "unavailable"
    env = dict(os.environ, NO_PROXY="*", no_proxy="*")
    env.pop("HTTP_PROXY", None)
    env.pop("HTTPS_PROXY", None)
    env.pop("http_proxy", None)
    env.pop("https_proxy", None)
    try:
        r = subprocess.run(["node", CHECK_DEPS], env=env, capture_output=True,
                           text=True, timeout=90)
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as e:
        return False, f"spawn_failed:{type(e).__name__}"
    if r.returncode == 0 and proxy_alive():
        return True, "started"
    # 把 check-deps 的提示带出去，便于前端/日志显示「请开启浏览器调试开关」
    tail = (r.stdout or "").strip().splitlines()
    return False, (tail[-1][:200] if tail else "not_ready")


# ---------------------------------------------------------------------------
# 页面内抓取脚本
# ---------------------------------------------------------------------------

_JS_TMPL = r"""
(async () => {
  const ASIN = %ASIN%;
  const el = document.getElementById('cr-state-object');
  if (!el) return JSON.stringify({ error: 'no_state' });
  let st;
  try { st = JSON.parse(el.dataset.state); } catch (e) { return JSON.stringify({ error: 'bad_state' }); }
  const W = %WIDGETS%;
  const q = 'asin=' + encodeURIComponent(ASIN)
          + '&csrf=' + encodeURIComponent(st.lazyWidgetCsrfToken)
          + '&language=en_US' + W.map(w => '&lazyWidget=' + w).join('');
  const r = await fetch('/portal/customer-reviews/ajax/lazy-widgets/stream?' + q, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest'
    },
    body: 'scope=reviewsAjax0'
  });
  if (!r.ok) return JSON.stringify({ error: 'http_' + r.status });
  const t = await r.text();
  // 响应是 JSON 数组文本，HTML 里的引号处于 \" 转义态 —— 必须 JSON.parse 反转义后再解析
  let cv = '';
  for (const seg of t.split('&&&')) {
    try {
      const a = JSON.parse(seg.trim());
      if (a[0] === 'update' && String(a[1]).indexOf('cr-customer-videos') >= 0) { cv = a[2]; break; }
    } catch (e) {}
  }
  const doc = new DOMParser().parseFromString(cv, 'text/html');
  // 只取 button：<span data-mediatype="MIXED"> 是「See all」链接，不是媒体项
  const items = [...doc.querySelectorAll('button[data-mediatype]')].map(b => {
    const d = b.querySelector('[class*="duration"]');
    return {
      type: b.dataset.mediatype,
      id: b.dataset.physicalid || '',
      reviewId: b.dataset.reviewid || '',
      url: b.dataset.url || '',
      thumb: b.dataset.thumbnailurl || '',
      ext: b.dataset.extension || '',
      duration: d && d.textContent ? d.textContent.trim() : ''
    };
  }).filter(x => x.url);
  return JSON.stringify({ items: items, respLen: t.length, cvLen: cv.length });
})()
"""


def _js(asin):
    return (_JS_TMPL
            .replace("%ASIN%", json.dumps(asin))
            .replace("%WIDGETS%", json.dumps(WIDGETS)))


# ---------------------------------------------------------------------------
# 抓取主流程
# ---------------------------------------------------------------------------

def _new_tab(url):
    status, text = _http(f"{PROXY_BASE}/new", data=url.encode("utf-8"),
                         method="POST", timeout=60)
    if status != 200:
        return None
    try:
        return json.loads(text).get("targetId")
    except Exception:
        return None


def _eval(target, expression, timeout=45):
    url = f"{PROXY_BASE}/eval?target={urllib.parse.quote(target)}"
    status, text = _http(url, data=expression.encode("utf-8"), method="POST", timeout=timeout)
    if status != 200:
        return None, f"eval_http_{status}"
    try:
        body = json.loads(text)
    except Exception:
        return None, "eval_bad_json"
    if body.get("error"):
        return None, str(body["error"])[:200]
    value = body.get("value")
    if isinstance(value, str):
        try:
            return json.loads(value), None
        except Exception:
            return None, "eval_unparsable"
    return value, None


def _close_tab(target):
    try:
        _http(f"{PROXY_BASE}/close?target={urllib.parse.quote(target)}", timeout=10)
    except Exception:
        pass


def _page_url(asin, marketplace):
    mp = MARKETPLACES.get(marketplace) or MARKETPLACES["US"]
    return f"https://{mp['domain']}/dp/{asin}?language=en_US"


def fetch_review_media(asin, marketplace="US"):
    """抓取单个 ASIN 的评论媒体。

    返回 dict：
      {"ok": True,  "items": [...], "note": "ok" | "no_media"}
      {"ok": False, "error": "cdp_unavailable" | "page_not_ready" | "http_403" | ...,
       "detail": "..."}
    """
    asin = (asin or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{10}", asin):
        return {"ok": False, "error": "bad_asin"}

    ready, detail = ensure_ready()
    if not ready:
        return {"ok": False, "error": "cdp_unavailable", "detail": detail}

    target = _new_tab(_page_url(asin, marketplace))
    if not target:
        return {"ok": False, "error": "open_tab_failed"}
    try:
        # 等详情页把 #cr-state-object 渲染出来（懒加载脚本依赖它）
        deadline = time.time() + PAGE_READY_TIMEOUT
        ready_page = False
        while time.time() < deadline:
            val, err = _eval(target, "!!document.getElementById('cr-state-object')", timeout=15)
            if val is True:
                ready_page = True
                break
            if err:
                _log(f"[review-media] {asin} 等待页面时出错: {err}")
                break
            time.sleep(PAGE_POLL_INTERVAL)
        if not ready_page:
            return {"ok": False, "error": "page_not_ready"}

        data, err = _eval(target, _js(asin), timeout=45)
        if err or not isinstance(data, dict):
            return {"ok": False, "error": "eval_failed", "detail": str(err)[:200]}
        if data.get("error"):
            return {"ok": False, "error": str(data["error"])[:80]}

        items = data.get("items") or []
        _log(f"[review-media] {asin} 抓到 {len(items)} 项"
             f"（响应 {data.get('respLen', 0)} 字节）")
        return {"ok": True, "items": items,
                "note": "ok" if items else "no_media"}
    finally:
        _close_tab(target)
