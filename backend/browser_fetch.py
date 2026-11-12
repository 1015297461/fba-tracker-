"""
用「浏览器」取页面 HTML —— HTTP 抓取被判机器人时的兜底通道。

为什么需要它
------------
2026-10-30 实测：同一个 /dp/ 链接，urllib 直连连续 7 次全部拿到 CAPTCHA 页；
把同一 URL 交给浏览器打开，一次就得到 3.9MB 完整商品页、`#productTitle` 存在。
结论：**Amazon 拦的是 urllib 的客户端指纹（TLS/HTTP2 指纹、cookie 历史、请求节奏），
不是这台机器的 IP。**

两条可用通道
------------
1. **headless（默认，推荐）**：后端自己拉起一个**专用无头 Chrome**，profile 独立放在
   `data/chrome-profile/`，与任何人日常用的浏览器**完全隔离**。
   —— 同事们点「查看详情」时，用的是服务器自己的 Chrome，不会打扰任何人的电脑。
2. **local（可选，仅供本机调试）**：驱动「本机已开的 Chrome」（cdp-proxy 127.0.0.1:3456）。
   优点是有真实登录态；缺点是**谁点详情都会在跑后端那台机器的浏览器里开标签页**，
   多人共用时会打扰机主。故默认关闭，只有设置 `FBA_DETAIL_BROWSER=local` 才启用。

选择逻辑：`FBA_DETAIL_BROWSER = headless | local | off`，默认 `headless`。
`off` 表示完全不启用浏览器通道（退回纯 HTTP，易被 CAPTCHA）。
"""

import atexit
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .utils import _log

# ---------------------------------------------------------------- 配置
MODE = (os.environ.get("FBA_DETAIL_BROWSER") or "headless").strip().lower()

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT = os.path.dirname(_HERE)
CHROME_PROFILE_DIR = os.path.join(_PROJECT, "data", "chrome-profile")
# dump 的临时文件必须落在项目目录内：放系统临时目录（/private/var/folders/...）时，
# macOS 沙箱会拦掉 Chrome 子进程对它的写入，表现为「35 秒一个字节都没有」。
DUMP_TMP_DIR = os.path.join(_PROJECT, "data", ".dom-tmp")

DUMP_MIN_BYTES = 80_000      # 输出小于此值视为没抓到（空壳/错误页）
DUMP_STABLE_TICKS = 3        # 文件大小连续 N 次不变即视为写完
DUMP_POLL_SEC = 0.3
DUMP_TIMEOUT = 35            # 单次无头抓取总上限（秒）

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]

# 同一时刻只跑一个浏览器实例：避免同事并发点详情时把机器压满
_browser_lock = threading.Lock()


def _chrome_bin():
    for p in CHROME_CANDIDATES:
        if p and os.path.exists(p):
            return p
    for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            return found
    return None


# ---------------------------------------------------------------- 通道 1：服务端无头 Chrome
def _kill_tree(proc, pgid=None):
    """回收整棵 Chrome 进程树（保证不常驻）。

    ⚠️ 只 kill 主进程不够：实测杀完主进程后仍有 3 个 helper（renderer/gpu/utility）
    继续存活几十秒才自行退出。所以 Popen 用 `start_new_session=True` 让它自成进程组，
    这里按**进程组** SIGKILL，确保「一次抓取 = 进程全部退出」。
    """
    if not proc:
        return
    if pgid is None:
        try:
            pgid = os.getpgid(proc.pid)
        except Exception:
            pgid = None
    if pgid:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except Exception:
            pass
    try:
        if proc.poll() is None:
            proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def _fetch_headless(url, timeout=DUMP_TIMEOUT):
    """用专用无头 Chrome 打开 url，返回 DOM 文本。

    实现要点：`--dump-dom` 会把 DOM 打到 stdout，但 Chrome **不会自己退出**（实测
    跑到 4 分钟还在），所以这里把输出重定向到临时文件，轮询大小直至稳定后主动 kill。
    """
    chrome = _chrome_bin()
    if not chrome:
        return None, "chrome_not_found"
    try:
        os.makedirs(CHROME_PROFILE_DIR, exist_ok=True)
    except Exception:
        pass

    cmd = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--window-size=1400,1000",
        # 与常驻实例一致：macOS 的 headless=new 是「真浏览器 + 隐藏窗口」，
        # 不挪出屏幕，CDP 兜底失败回落到这里时 Dock 就会闪。
        "--window-position=-10000,-10000",
        f"--user-data-dir={CHROME_PROFILE_DIR}",
        "--dump-dom",
        url,
    ]

    with _browser_lock:
        try:
            os.makedirs(DUMP_TMP_DIR, exist_ok=True)
            # 兜底清理：进程被杀等异常情况下遗留的 dump 文件（>10 分钟）
            now_ts = time.time()
            for name in os.listdir(DUMP_TMP_DIR):
                fp = os.path.join(DUMP_TMP_DIR, name)
                try:
                    if os.path.isfile(fp) and now_ts - os.path.getmtime(fp) > 600:
                        os.unlink(fp)
                except Exception:
                    pass
        except Exception:
            pass
        fd, tmp_path = tempfile.mkstemp(prefix="dom-", suffix=".html", dir=DUMP_TMP_DIR)
        os.close(fd)
        proc = None
        pgid = None
        try:
            with open(tmp_path, "wb") as out:
                proc = subprocess.Popen(cmd, stdout=out,
                                        stderr=subprocess.DEVNULL,
                                        stdin=subprocess.DEVNULL,
                                        start_new_session=True)   # 独立进程组，便于整组回收
                try:
                    pgid = os.getpgid(proc.pid)     # 先记下来：主进程退出后可能取不到
                except Exception:
                    pgid = None
                deadline = time.time() + timeout
                last, stable = -1, 0
                while time.time() < deadline:
                    time.sleep(DUMP_POLL_SEC)
                    try:
                        size = os.path.getsize(tmp_path)
                    except OSError:
                        size = 0
                    if size > 0 and size == last:
                        stable += 1
                        if stable >= DUMP_STABLE_TICKS and size >= DUMP_MIN_BYTES:
                            break
                    else:
                        stable = 0
                    last = size
        finally:
            _kill_tree(proc, pgid)

        html = None
        try:
            with open(tmp_path, "r", encoding="utf-8", errors="replace") as f:
                html = f.read()
        except Exception as e:
            return None, f"read_failed:{type(e).__name__}"
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    if not html or len(html) < DUMP_MIN_BYTES:
        return None, "empty_dom"
    return html, None


# ---------------------------------------------------------------- 通道 1b：CDP（需要带 cookie 时）
#
# `--dump-dom` 是一次性进程，**没法逐次注入 cookie**；而 Amazon 的货币是靠
# `i18n-prefs` cookie 决定的（没有它 → 按 IP 返回 CNY，价格直接错 6.7 倍）。
# 所以「需要指定货币」时必须走这条：自己拉起带调试端口的 Chrome，用 CDP
# `Network.setCookie` 设好 cookie，再导航、等就绪、取 DOM。
CDP_HEADLESS_PORT = int(os.environ.get("FBA_CDP_PORT", "9335"))
CDP_FETCH_TIMEOUT = 90       # 含启动 + 导航 + 等就绪

# ---------------------------------------------------------------- 常驻浏览器
#
# 2026-11-10 改：原先每次抓取都 `Popen` 一个 Chrome 再杀掉，实测 31s/页 ——
# 其中 3~5s 纯粹耗在冷启动和 profile 初始化上。用户要求「启动程序时就起好，
# 后续复用」，所以改成**一个常驻 Chrome + 每次开一个标签页、用完立刻关**。
#
# 标签页管理是这条通道唯一的泄漏风险：异常路径必须能在 finally 里关掉，
# 否则跑一晚就是几百个标签页把内存吃光。为此：
#   · 每次抓取 new 一个 target，id 记在 _CHROME["tabs"]，finally 里 close；
#   · 启动时先 _cleanup_stale_tabs()，把上次异常退出残留的标签全关掉。
_CHROME = {"proc": None, "pgid": None, "tabs": set(), "lock": threading.Lock()}
_CHROME_BASE = f"http://127.0.0.1:{CDP_HEADLESS_PORT}"


def _chrome_alive(timeout=2):
    status, _ = _http(f"{_CHROME_BASE}/json/version", timeout=timeout)
    return status == 200


def _list_targets(timeout=3):
    status, text = _http(f"{_CHROME_BASE}/json/list", timeout=timeout)
    if status != 200:
        return []
    try:
        return json.loads(text) or []
    except Exception:
        return []


def _close_target(tid, timeout=3):
    """关标签页（幂等，失败也不抛）。"""
    if not tid:
        return
    try:
        _http(f"{_CHROME_BASE}/json/close/{urllib.parse.quote(str(tid))}", timeout=timeout)
    except Exception:
        pass
    _CHROME["tabs"].discard(tid)


def _cleanup_stale_tabs():
    """关掉除空白页以外的所有标签（上次异常退出的残留）。"""
    n = 0
    for t in _list_targets():
        if t.get("type") != "page":
            continue
        url = str(t.get("url") or "")
        tid = t.get("id")
        if tid and not url.startswith("about:blank"):
            _close_target(tid)
            n += 1
    if n:
        _log(f"[browser] 清理了 {n} 个残留标签页")


def _trim_tabs(rounds=3):
    """兜底闸门：只保留一个空白标签，其余 page 一律关掉。

    关闭标签是异步的（Chrome 要几百毫秒才真正销毁），所以这里带重试 +
    短暂等待，否则下一次查询还能看到「已经请求关闭」的那个 —— 实测第一次
    抓完会残留一个，正是这个原因。
    """
    for i in range(rounds):
        pages = [t for t in _list_targets() if t.get("type") == "page"]
        if len(pages) <= 1:
            return
        keep = next((t for t in pages if str(t.get("url") or "").startswith("about:blank")), pages[0])
        for t in pages:
            if t.get("id") != keep.get("id"):
                _close_target(t.get("id"))
        time.sleep(0.25)


def ensure_chrome(wait=20):
    """确保常驻无头 Chrome 在跑（幂等）。程序启动时调一次即可。"""
    if MODE == "off":
        return False
    if _chrome_alive():
        _cleanup_stale_tabs()
        return True
    with _CHROME["lock"]:
        if _chrome_alive():
            return True
        chrome = _chrome_bin()
        if not chrome:
            _log("[browser] 没找到 Chrome/Chromium，浏览器通道不可用")
            return False
        try:
            os.makedirs(CHROME_PROFILE_DIR, exist_ok=True)
        except Exception:
            pass
        cmd = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--window-size=1400,1000",
            # `--headless=new` 在 macOS 上是「真浏览器 + 隐藏窗口」，建新标签时窗口
            # 偶尔会闪一下（用户实测：每次定时任务开始都闪）。挪到屏幕外最省事。
            "--window-position=-10000,-10000",
            f"--user-data-dir={CHROME_PROFILE_DIR}",
            f"--remote-debugging-port={CDP_HEADLESS_PORT}",
            "about:blank",
        ]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
        except Exception as e:
            _log(f"[browser] 启动 Chrome 失败：{type(e).__name__}: {e}")
            return False
        _CHROME["proc"] = proc
        try:
            _CHROME["pgid"] = os.getpgid(proc.pid)
        except Exception:
            _CHROME["pgid"] = None
        deadline = time.time() + wait
        while time.time() < deadline:
            if _chrome_alive(1):
                _log(f"[browser] 常驻无头 Chrome 已就绪（端口 {CDP_HEADLESS_PORT}）")
                _cleanup_stale_tabs()
                return True
            time.sleep(0.3)
        _log("[browser] Chrome 启动超时")
        return False


def shutdown_chrome():
    """退出时清理（注册在 atexit）。"""
    proc = _CHROME.get("proc")
    if not proc:
        return
    try:
        _kill_tree(proc, _CHROME.get("pgid"))
    except Exception:
        pass
    _CHROME["proc"] = None


def _new_target(url=None):
    """开一个新的标签页，返回 (id, ws_url)。Chrome 111+ 的 /json/new 要求 PUT。

    ⚠️ 不要把 url 拼进 query（`/json/new?about:blank`）：实测编码后 Chrome 会直接
    断开调试端口（后续 /json/list 全部连不上）。开空白页、由 node 脚本去 navigate 更稳。
    """
    for method in ("PUT", "GET"):
        # 加 /json/new?background=1 优先（部分版本支持），拿到的标签不抢焦点
        status, text = _http(f"{_CHROME_BASE}/json/new?background=1", method=method, timeout=10)
        if status != 200:
            status, text = _http(f"{_CHROME_BASE}/json/new", method=method, timeout=10)
        if status == 200:
            try:
                d = json.loads(text)
            except Exception:
                continue
            tid = d.get("id")
            ws = d.get("webSocketDebuggerUrl")
            if tid and ws:
                _CHROME["tabs"].add(tid)
                return tid, ws
    return None, None


atexit.register(shutdown_chrome)


# node 侧脚本：一次收齐「设 cookie → 导航 → 轮询就绪 → 取 outerHTML」
#
# ⚠️ HTML 必须**写文件**再回传路径，不能直接 stdout：2MB 的字符串配合
# `process.exit()` 会被截断（stdout 未 flush 就退出），Python 侧只拿到半截 JSON。
_JS_CDP_FETCH = r"""
const fs = require("fs");
const ws = new WebSocket(process.argv[1]);
const URL_ = process.argv[2];
const READY = process.argv[3];
const COOKIES = JSON.parse(process.argv[4] || "[]");
// 页面级等待上限：超过就不再等（按当前 DOM 取），避免个别重页面把用户卡在 90s。
// 实测正常页 6~13s 就稳定；25s 是「肯定已经渲染完」的天花板。
const MAX_MS = Math.min(parseInt(process.argv[5] || "60000", 10), 25000);
const OUT = process.argv[6];
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise(r => {
  const i = ++id; pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const done = obj => {
  try { process.stdout.write(JSON.stringify(obj), () => { setTimeout(() => process.exit(0), 50); }); }
  catch (e) { process.exit(1); }
};
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error || {}); pend.delete(m.id); }
};
ws.onopen = async () => {
  try {
    await send("Network.enable", {});
    // 拦掉图片/字体/媒体与已知追踪域：排名只需要 DOM 里的 data-asin，
    // 图片一张都不看。搜索页 1.5MB 里大头就是这些，实测能省 30~50% 时间。
    // ⚠️ 绝不能拦 js/css —— 卡片是前端渲染出来的，拦了就没有 DOM 了。
    await send("Network.setBlockedURLs", { urls: [
      "*.jpg", "*.jpeg", "*.png", "*.gif", "*.webp", "*.avif", "*.svg", "*.ico",
      "*media-amazon.com/images/*",
      "*doubleclick.net/*", "*google-analytics.com/*", "*googletagmanager.com/*",
      "*amazon-adsystem.com/*", "*fls-na.amazon.com/*"
    ] });
    for (const c of COOKIES) await send("Network.setCookie", c);
    await send("Page.enable", {});
    await send("Page.navigate", { url: URL_ });
    const t0 = Date.now();
    // 就绪判定：业务锚点出现 + **DOM 元素数连续两次不变**。
    //   · 只看 productTitle → 拿到半渲染页（440KB，图片/A+/Customers say 全缺）
    //   · 等 readyState==='complete' → 要等广告/追踪像素等长尾资源，实测多花 5~20s
    //   · 元素数稳定 == 原来的「dump 文件大小稳定」，既有完整内容又快
    let lastCount = -1, stable = 0;
    while (Date.now() - t0 < MAX_MS) {
      await new Promise(r => setTimeout(r, 400));
      const r = await send("Runtime.evaluate", {
        expression: "(" + READY + ") + '|' + document.getElementsByTagName('*').length",
        returnByValue: true
      });
      const s = String((r && r.result && r.result.value) || "");
      if (!s.startsWith("true|")) { lastCount = -1; stable = 0; continue; }
      const cnt = parseInt(s.slice(5), 10) || 0;
      if (cnt > 0 && cnt === lastCount) {
        stable++;
        if (stable >= 2) break;          // ≈800ms 内元素数没再变 → 认为渲染完
      } else {
        stable = 0;
      }
      lastCount = cnt;
    }
    const h = await send("Runtime.evaluate",
      { expression: "document.documentElement.outerHTML", returnByValue: true });
    const html = (h && h.result && h.result.value) || "";
    fs.writeFileSync(OUT, html, "utf8");
    done({ ok: 1, bytes: html.length });
  } catch (e) {
    done({ error: String(e) });
  }
};
setTimeout(() => { done({ error: "timeout" }); }, MAX_MS + 20000);
"""


def _fetch_headless_cdp(url, cookies=None, ready_expr="!!document.getElementById('productTitle')",
                        timeout=CDP_FETCH_TIMEOUT):
    """无头 Chrome + CDP：注入 cookie 后取 DOM（需要指定货币/会话时用）。

    用**常驻**的 Chrome，每次开一个标签页、跑完在 finally 里关掉 —— 既不重复付
    冷启动的钱，也不会让标签页越攒越多。
    """
    # 全局串行：常驻 Chrome 只有一份，多线程同时开标签会互相踩
    with _browser_lock:
        return _cdp_fetch_locked(url, cookies, ready_expr, timeout)


def _cdp_fetch_locked(url, cookies, ready_expr, timeout):
    if not ensure_chrome():
        return None, "chrome_not_started"

    tid, ws_url = _new_target()
    if not ws_url:
        return None, "open_tab_failed"
    try:
        try:
            os.makedirs(DUMP_TMP_DIR, exist_ok=True)
        except Exception:
            pass
        fd, out_path = tempfile.mkstemp(prefix="cdp-", suffix=".html", dir=DUMP_TMP_DIR)
        os.close(fd)
        try:
            p = subprocess.run(
                ["node", "-e", _JS_CDP_FETCH, ws_url, url, ready_expr,
                 json.dumps(cookies or [], ensure_ascii=False),
                 str(int(timeout * 1000)), out_path],
                capture_output=True, text=True, timeout=timeout + 30)
            out = (p.stdout or "").strip()
            if not out:
                return None, f"node_empty:{(p.stderr or '')[:120]}"
            try:
                body = json.loads(out)
            except Exception:
                return None, "node_bad_json"
            if body.get("error"):
                return None, f"cdp_{body['error']}"
            try:
                with open(out_path, "r", encoding="utf-8", errors="replace") as f:
                    html = f.read()
            except Exception as e:
                return None, f"read_failed:{type(e).__name__}"
        finally:
            try:
                os.unlink(out_path)
            except Exception:
                pass
        if len(html) < DUMP_MIN_BYTES:
            return None, "empty_dom"
        return html, None
    except subprocess.TimeoutExpired:
        return None, "cdp_timeout"
    except Exception as e:
        return None, f"cdp_fail:{type(e).__name__}"
    finally:
        # 关键：无论成功、失败还是超时，标签页必须关掉；再统一收一次防残留
        _close_target(tid)
        _trim_tabs()


# ---------------------------------------------------------------- 通道 2：本机 CDP（默认不用）
PROXY_BASE = "http://127.0.0.1:3456"
POLL_INTERVAL = 0.5
NAV_CLIENT_TIMEOUT = 8
DEFAULT_READY_TIMEOUT = 30
TAB_IDLE_CLOSE_SEC = 240

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_tab = {"id": None, "lastUsed": 0.0}
_tab_lock = threading.Lock()


def _http(url, data=None, method=None, timeout=30):
    req = urllib.request.Request(url, data=data, method=method)
    try:
        with _opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, (e.read() or b"").decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return None, f"neterr:{type(e).__name__}"


def cdp_available(timeout=3):
    status, text = _http(f"{PROXY_BASE}/targets", timeout=timeout)
    if status != 200:
        return False
    try:
        return isinstance(json.loads(text), list)
    except Exception:
        return False


def _eval(target, expr, timeout=90):
    url = f"{PROXY_BASE}/eval?target={urllib.parse.quote(target)}"
    status, text = _http(url, data=expr.encode("utf-8"), method="POST", timeout=timeout)
    if status != 200:
        return None, f"eval_http_{status}"
    try:
        body = json.loads(text)
    except Exception:
        return None, "eval_bad_json"
    if body.get("error"):
        return None, str(body["error"])[:200]
    return body.get("value"), None


def _close(target):
    _http(f"{PROXY_BASE}/close?target={urllib.parse.quote(target)}", timeout=10)


def _drop_tab():
    with _tab_lock:
        _tab.update({"id": None, "lastUsed": 0.0})


def _new_tab(url):
    status, text = _http(f"{PROXY_BASE}/new", data=url.encode("utf-8"),
                         method="POST", timeout=60)
    if status != 200:
        return None, f"open_tab_http_{status}"
    try:
        return json.loads(text).get("targetId"), None
    except Exception:
        return None, "open_tab_bad_json"


def _navigate(target, url, timeout=NAV_CLIENT_TIMEOUT):
    """发导航但不干等整页加载（cdp-proxy 的 /navigate 会等 load，重页面 6~60s）。"""
    status, _t = _http(f"{PROXY_BASE}/navigate?target={urllib.parse.quote(target)}",
                       data=url.encode("utf-8"), method="POST", timeout=timeout)
    return status == 200


def _open_tab(url):
    with _tab_lock:
        tid = _tab["id"]
        idle = _tab["lastUsed"] and (time.time() - _tab["lastUsed"]) > TAB_IDLE_CLOSE_SEC
        if tid and idle:
            _close(tid)
            tid = None
            _tab.update({"id": None, "lastUsed": 0.0})
        if tid:
            _navigate(tid, url)
            _tab["lastUsed"] = time.time()
            return tid, None
    tid, err = _new_tab("about:blank")
    if not tid:
        return None, err or "open_tab_failed"
    with _tab_lock:
        _tab.update({"id": tid, "lastUsed": time.time()})
    _navigate(tid, url)
    return tid, None


def _fetch_local_cdp(url, ready_expr="!!document.getElementById('productTitle')",
                     timeout=DEFAULT_READY_TIMEOUT):
    if not cdp_available():
        return None, "cdp_unavailable"
    tid, err = _open_tab(url)
    if not tid:
        return None, err or "open_tab_failed"
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            val, eval_err = _eval(tid, f"document.readyState + '|' + ({ready_expr})")
            if isinstance(val, str) and val.endswith("|true"):
                html, err2 = _eval(tid, "document.documentElement.outerHTML", timeout=90)
                if isinstance(html, str) and len(html) > 5000:
                    return html, None
                err = err2 or "html_too_short"
            elif eval_err:
                err = eval_err
            time.sleep(POLL_INTERVAL)
    finally:
        with _tab_lock:
            if _tab["id"] == tid:
                _tab["lastUsed"] = time.time()
    _close(tid)
    _drop_tab()
    return None, err or "page_not_ready"


# ---------------------------------------------------------------- 统一入口
def fetch_html(url, timeout=None, ready_expr="!!document.getElementById('productTitle')",
               cookies=None):
    """按 FBA_DETAIL_BROWSER 选择通道取页面 HTML。返回 (html, err)。

    cookies：CDP 格式的 cookie 列表，如
      [{"name": "i18n-prefs", "value": "USD", "domain": ".amazon.com",
        "path": "/", "secure": True}]。
    传了就**必须走 CDP 通道**（dump-dom 注入不了），没传则走更轻的 dump 通道。
    """
    if MODE == "off":
        return None, "disabled"
    if cookies:
        if MODE == "local":
            return _fetch_local_cdp(url, ready_expr=ready_expr,
                                    timeout=timeout or DEFAULT_READY_TIMEOUT)
        return _fetch_headless_cdp(url, cookies=cookies, ready_expr=ready_expr,
                                   timeout=timeout or CDP_FETCH_TIMEOUT)
    if MODE == "local":
        return _fetch_local_cdp(url, ready_expr=ready_expr,
                                timeout=timeout or DEFAULT_READY_TIMEOUT)
    # 无 cookies 也优先走常驻 CDP：`_fetch_headless`（--dump-dom）每次都要 Popen 一个
    # 新 Chrome，macOS 上会闪一下窗口。常驻实例只在 CDP 不可用时才退回 dump。
    if ensure_chrome():
        return _fetch_headless_cdp(url, ready_expr=ready_expr,
                                   timeout=timeout or CDP_FETCH_TIMEOUT)
    return _fetch_headless(url, timeout=timeout or DUMP_TIMEOUT)


def available():
    """浏览器通道是否可用（给调用方决定要不要走这条）。"""
    if MODE == "off":
        return False
    if MODE == "local":
        return cdp_available()
    return _chrome_bin() is not None


def mode():
    return MODE
