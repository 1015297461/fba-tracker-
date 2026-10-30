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
def fetch_html(url, timeout=None, ready_expr="!!document.getElementById('productTitle')"):
    """按 FBA_DETAIL_BROWSER 选择通道取页面 HTML。返回 (html, err)。"""
    if MODE == "off":
        return None, "disabled"
    if MODE == "local":
        return _fetch_local_cdp(url, ready_expr=ready_expr,
                                timeout=timeout or DEFAULT_READY_TIMEOUT)
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
