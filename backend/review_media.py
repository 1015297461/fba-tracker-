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
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .product_fetcher import MARKETPLACES
from .utils import _log

# ---------------------------------------------------------------------------
# CDP Proxy
# ---------------------------------------------------------------------------
# ⚠️ 2026-10-19：本模块的抓取路径已失效（Amazon 服务端改版）
#
# Amazon 移除了页面上的两个关键锚点：
#   1. #cr-state-object   —— 原来从这里取 lazyWidgetCsrfToken
#   2. cr-customer-videos —— 原来的评论媒体 lazy-widget 占位
#
# 实测（B0B49TY3RK / B0G6JYYML4，2026-10-19 15:00，登录态浏览器）：
#   · 新加载的详情页 getElementById('cr-state-object') === null
#   · HTML 中 "cr-customer-videos" 与 "lazyWidget" 均出现 0 次
#   · 页面正文没有 "customer photos" 字样
#   · 只剩空占位 <div data-testid="dp-reviews-btf-media-carousel-placement">，
#     滚动到位 + 静置 20s 仍不填充
#   · 三种 URL 变体（?language=en_US / 无参数 / ?th=1）结果一致
#   · **改版前加载的旧标签页仍保留 cr-state-object** —— 说明是 Amazon 服务端
#     改版，不是本地环境、登录态或参数问题
#
# 因此 fetch_review_media() 现在会在 PAGE_FAST_FAIL_AFTER_DONE 秒内返回
# error="page_changed"（前端有对应文案），而不是傻等 40 秒超时。
# 已有缓存（scrape_products.review_media 非 NULL）不受影响，仍可正常展示。
# 要恢复抓取，需要重新适配新版媒体模块（未完成）。
# ---------------------------------------------------------------------------

PROXY_BASE = "http://127.0.0.1:3456"
SKILL_DIR = os.path.expanduser("~/.workbuddy/skills/web-access/scripts")
CHECK_DEPS = os.path.join(SKILL_DIR, "check-deps.mjs")
PROXY_SCRIPT = os.path.join(SKILL_DIR, "cdp-proxy.mjs")

PAGE_READY_TIMEOUT = 24      # 等待详情页出现 #cr-state-object 的上限（秒）
PAGE_FAST_FAIL_AFTER_DONE = 3  # readyState=complete 后仍无锚点 -> 判定改版，立即失败
PAGE_POLL_INTERVAL = 0.4     # 就绪轮询间隔：调小可明显减少平均等待（原来 1.0s）
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


# ---------------------------------------------------------------------------
# 常驻标签页
#
# 早先是「每抓一个 ASIN 就新开一个标签、抓完关掉」，实际用起来等于「每点一次就闪一个标签」，
# 很吵。改为**复用同一个标签**：首次开一个（about:blank），之后每次在它里面
# navigate 到目标详情页。
#
# 实测过「CSRF 能否跨 ASIN 复用」—— 不能：token 是页面级签名，
# token(A) + asin=B 会被服务端拒绝（返回 0 字节）。所以「打开目标详情页」这步省不掉；
# 能省的只是「不要再新开标签」。抓完**不回到空白页**（用户要求停在原地），
# 标签闲置 IDLE_CLOSE_SEC 后由后台线程自动关掉。
# ---------------------------------------------------------------------------

IDLE_CLOSE_SEC = 600          # 标签闲置多久自动关闭（10 分钟）
_tab_state = {"id": None, "asin": "", "lastUsed": 0.0}
_tab_lock = threading.RLock()
_reaper_started = False


def _tab_alive(target_id):
    status, text = _http(f"{PROXY_BASE}/targets", timeout=8)
    if status != 200:
        return False
    try:
        return any(t.get("targetId") == target_id for t in json.loads(text))
    except Exception:
        return False


def _start_idle_reaper():
    """后台线程：标签闲置超时就关掉（用户也可随时手动关，这里只是兜底）。"""
    global _reaper_started
    with _tab_lock:
        if _reaper_started:
            return
        _reaper_started = True

    def loop():
        while True:
            time.sleep(60)
            with _tab_lock:
                tid = _tab_state["id"]
                idle = _tab_state["lastUsed"] and (time.time() - _tab_state["lastUsed"]) > IDLE_CLOSE_SEC
                if tid and idle:
                    _close_tab(tid)
                    _tab_state.update({"id": None, "asin": "", "lastUsed": 0.0})
                    _log(f"[review-media] 常驻标签闲置超过 {IDLE_CLOSE_SEC // 60} 分钟，已自动关闭")

    threading.Thread(target=loop, daemon=True, name="ReviewMediaTabReaper").start()


def _ensure_tab():
    """取常驻标签：还活着就复用，否则新开一个（about:blank）。"""
    with _tab_lock:
        tid = _tab_state["id"]
        if tid and _tab_alive(tid):
            return tid
        tid = _new_tab("about:blank")
        if not tid:
            return None
        _tab_state.update({"id": tid, "asin": "", "lastUsed": time.time()})
        _log(f"[review-media] 已开常驻标签 {tid[:8]}（后续抓取复用它，不再新开）")
    _start_idle_reaper()
    return tid


def _probe_page(tab, asin):
    """一次 CDP 往返取三个状态：URL 命中 / 锚点存在 / readyState。

    必须返回 JSON 字符串 —— _eval() 会把字符串再 json.loads 一次，
    返回 "true|false|complete" 这种非 JSON 文本会被判成 eval_unparsable -> None。
    """
    js = ("JSON.stringify({u: location.href.indexOf(%s) >= 0, "
          "s: !!document.getElementById('cr-state-object'), "
          "r: document.readyState})") % json.dumps(asin)
    val, _err = _eval(tab, js, timeout=10)
    if not isinstance(val, dict):
        return False, False, ""
    return bool(val.get("u")), bool(val.get("s")), str(val.get("r") or "")


def _navigate_and_wait(tab, asin, marketplace):
    """在常驻标签里导航到目标详情页并等就绪。

    返回 (ok, reason)，reason ∈ ready / page_changed / page_not_ready / navigate_failed。
    必须同时满足「URL 已是目标 ASIN」和「cr-state-object 已渲染」——
    只查元素会读到上一个页面的残留节点。

    page_changed 是给 Amazon 改版留的快速失败通道：页面 readyState 已经是 complete，
    但等 PAGE_FAST_FAIL_AFTER_DONE 秒仍找不到锚点 → 判定页面结构变更，
    立即返回而不是耗满 40 秒总超时（否则用户点一次要等将近一分钟才看到失败）。
    """
    def ready():
        url_ok, has_state, _rs = _probe_page(tab, asin)
        return url_ok and has_state

    with _tab_lock:
        if _tab_state.get("asin") == asin and ready():
            return True, "ready"

    status, _text = _http(f"{PROXY_BASE}/navigate?target={urllib.parse.quote(tab)}",
                          data=_page_url(asin, marketplace).encode("utf-8"),
                          method="POST", timeout=45)
    if status != 200:
        return False, "navigate_failed"

    deadline = time.time() + PAGE_READY_TIMEOUT
    complete_at = None
    while time.time() < deadline:
        url_ok, has_state, rs = _probe_page(tab, asin)
        if url_ok and has_state:
            with _tab_lock:
                _tab_state["asin"] = asin
            return True, "ready"
        if rs == "complete":
            if complete_at is None:
                complete_at = time.time()
            elif time.time() - complete_at >= PAGE_FAST_FAIL_AFTER_DONE:
                _log(f"[review-media] {asin} 页面已加载但缺少 #cr-state-object，判定页面结构变更")
                return False, "page_changed"
        else:
            complete_at = None
        time.sleep(PAGE_POLL_INTERVAL)
    return False, "page_not_ready"


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

    tab = _ensure_tab()
    if not tab:
        return {"ok": False, "error": "open_tab_failed"}
    try:
        # 复用常驻标签：在其中导航到目标详情页（token 与 ASIN 绑定，这步省不掉）
        ok, reason = _navigate_and_wait(tab, asin, marketplace)
        if not ok:
            return {"ok": False, "error": reason}

        data, err = _eval(tab, _js(asin), timeout=45)
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
        # 不关标签：留着给下一个 ASIN 复用；闲置由后台线程兜底关闭
        with _tab_lock:
            _tab_state["lastUsed"] = time.time()
