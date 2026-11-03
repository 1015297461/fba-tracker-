"""
卖家精灵「查竞品」批量取上架时间。

为什么走这个通道
----------------
2026-11-02 实测（PoC）：
  · 接口 `POST https://www.sellersprite.com/v3/api/competing-lookup`，同域、cookie 认证、**无签名**；
  · **`symbolFlag: true` 才是「精确查询」**——只返回传入的 ASIN（5 个 ASIN → total=5，
    位置 0~4）；传 false 会展开成竞品池（5 个 ASIN → total=148，目标散落到第 54 位）。
    （页面上「展示所有变体」勾选框与这个参数语义相反，以实测为准。）
  · 100 个 ASIN 一次请求 **1.08 秒**返回 99 条、漏 0 个、95 条带 `availableDate`；
  · 前台查询**不扣额度**（query-quota 返回 -1）。

实现方式
--------
不逆向签名、不解析 DOM：在**已登录的页面上下文里**用 `fetch()` 直接调同域接口
（自动带 cookie）。页面用专用 Chrome（profile 独立于任何人日常浏览器）。

登录态
------
profile 存 `data/sprite-profile/`。登录一次后长期有效；**退出时走 CDP 的
`Browser.close` 优雅关闭**，让 cookie 落盘（强杀进程会丢登录态，踩过）。
若检测到停在登录页，返回 `need_login`，不抛异常。

窗口可见性
----------
因为每次取完就关（保住 cookie），下次必然要重新拉起进程。**默认用 `--headless=new`
无头启动，屏幕上不会有任何弹窗**；只有当检测到未登录（profile 里没有有效 cookie）时，
才关掉无头实例、改用可见窗口重新拉起，让用户登录。
"""

import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request

from . import sprite_cred
from .utils import _log

# ---------------------------------------------------------------- 配置
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT = os.path.dirname(_HERE)
PROFILE_DIR = os.path.join(_PROJECT, "data", "sprite-profile")

CDP_PORT = int(os.environ.get("SPRITE_CDP_PORT", "9333"))
BASE = "https://www.sellersprite.com"
ENTRY_URL = f"{BASE}/v3/competitor-lookup"
API_PATH = "/v3/api/competing-lookup"

BATCH_SIZE = 100          # 单次请求 ASIN 数（页面支持 1000，这里保守取 100）
# 登录页（实测）：访问 /w/user/logout 会先登出、再跳登录页，标题「卖家精灵登录」，
# 页面上有「手机号/邮箱/子账号」+「密码」输入框和「密码登录」切换。
# 注意：这个 URL 对**已登录**会话有登出副作用，所以只在「探针已失败」的路径里用。
LOGIN_URL = f"{BASE}/w/user/logout"
LOGIN_MAX_FAILS = 3                 # 自动登录连续失败几次就熔断（避免把账号试锁）
COOKIE_FILE = "sprite-cookies.json"  # 登录态（加密存 data/ 下）
COOKIE_TTL = 3 * 86400               # 注入时把 session cookie 的过期时间推到 3 天后
LOGIN_COOLDOWN = 1800               # 熔断时长（秒）
START_TIMEOUT = 25        # 等 Chrome 起来的上限（秒）
EVAL_TIMEOUT = 90

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_run_lock = threading.Lock()

# ---------------------------------------------------------------- 运行状态
# 给前端看的「最近一次结果」：失败/需登录时前端显示提示，成功就自动更新掉
_last = {"at": None, "status": None, "message": None, "got": 0, "asked": 0}
_login_fails = []          # 自动登录失败的时间戳（熔断用）
_login_lock = threading.Lock()


def _record(status, message, got=0, asked=0):
    _last.update({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "status": status, "message": message, "got": got, "asked": asked,
    })


def last_result():
    return dict(_last)


def _login_blocked():
    """连续失败达上限后，冷却期内不再自动尝试（防止把账号试锁）。"""
    now = time.time()
    with _login_lock:
        _login_fails[:] = [t for t in _login_fails if now - t < LOGIN_COOLDOWN]
        return len(_login_fails) >= LOGIN_MAX_FAILS


def _note_login_fail():
    with _login_lock:
        _login_fails.append(time.time())


def _http(url, data=None, method=None, timeout=20):
    req = urllib.request.Request(url, data=data, method=method)
    try:
        with _opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, (e.read() or b"").decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception:
        return None, ""


def _chrome_bin():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def _alive():
    status, text = _http(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=3)
    return status == 200


def _targets():
    status, text = _http(f"http://127.0.0.1:{CDP_PORT}/json/list", timeout=5)
    if status != 200:
        return []
    try:
        return [t for t in json.loads(text) if t.get("type") == "page"]
    except Exception:
        return []


def _page():
    """优先返回停在「查竞品」页的标签；没有就返回任意 sellersprite 页。"""
    pages = [t for t in _targets() if "sellersprite" in (t.get("url") or "")]
    for t in pages:
        if "competitor-lookup" in (t.get("url") or ""):
            return t
    return pages[0] if pages else None


def _is_login_page(tab):
    u = (tab.get("url") or "") if tab else ""
    return ("/login" in u) or ("/w/user" in u) or (not u)


def _is_auth_error(err):
    """接口层判断登录态：比猜 URL 可靠（登录后跳到 /w/user 也不会误判）。"""
    e = str(err or "")
    # not_json = 接口返回了 HTML 页面，只有「登录态失效被重定向」会这样
    if e in ("http_401", "http_403", "not_json"):
        return True
    up = e.upper()
    return ("LOGIN" in up) or ("AUTH" in up) or ("NOT_SIGN" in up) or ("UNSIGN" in up)


def _clear_stale_locks():
    """清掉上次异常退出遗留的 profile 锁，否则新进程会弹「配置文件正在使用」对话框。"""
    for n in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        p = os.path.join(PROFILE_DIR, n)
        try:
            if os.path.islink(p) or os.path.exists(p):
                os.unlink(p)
        except Exception:
            pass


def _launch_chrome(headless=True):
    chrome = _chrome_bin()
    if not chrome:
        return False, "chrome_not_found"
    os.makedirs(PROFILE_DIR, exist_ok=True)
    if not _alive():
        _clear_stale_locks()
    cmd = [
        chrome,
        "--no-sandbox",            # 后端在受限环境里跑时，Chrome 自带沙箱会起不来
        "--disable-gpu",
        f"--user-data-dir={PROFILE_DIR}",
        f"--remote-debugging-port={CDP_PORT}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1400,900",
    ]
    if headless:
        # 无头：屏幕上不出现任何窗口/弹窗，cookie 与登录态照常走同一 profile
        cmd += ["--headless=new", "--hide-scrollbars", "--mute-audio",
                "--disable-features=Translate"]
    cmd.append(ENTRY_URL)
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception as e:
        return False, f"launch_failed:{type(e).__name__}"
    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        if _alive():
            time.sleep(1.5)          # 给页面一点加载时间
            return True, ("started_headless" if headless else "started_headed")
        time.sleep(0.5)
    return False, "cdp_timeout"


def _ensure_browser(headless=True):
    """返回 (ok, detail)。已开则复用。"""
    if _alive():
        return True, "reused"
    return _launch_chrome(headless=headless)


def _logged_in_tab(timeout=12):
    """等出现「已登录」的 sellersprite 页。

    headless 冷启动时页面可能还停在 about:blank/加载中，此时不能直接判成"未登录"
    （误判会白白弹出可见窗口）。所以轮询到超时为止。
    """
    deadline = time.time() + timeout
    while True:
        tab = _page()
        if tab and not _is_login_page(tab):
            return tab, True
        if time.time() >= deadline:
            return tab, False
        time.sleep(0.8)


def _ws_call(tab_id, expression):
    """在页面里执行表达式并取回 JSON 字符串（用 CDP Runtime.evaluate）。"""
    port = CDP_PORT
    status, text = _http(f"http://127.0.0.1:{port}/json/list", timeout=5)
    if status != 200:
        return None, "cdp_unavailable"
    try:
        tabs = json.loads(text)
    except Exception:
        return None, "cdp_bad_json"
    tab = next((t for t in tabs if t.get("id") == tab_id), None)
    if not tab:
        return None, "tab_gone"

    ws_url = tab.get("webSocketDebuggerUrl")
    if not ws_url:
        return None, "no_ws_url"

    # 用 node 做一次 WS 调用（Python 标准库没有 WebSocket）
    script = (
        "const ws=new WebSocket(process.argv[1]);let id=0;const p=new Map();"
        "const send=(m,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pa}))});"
        "ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m.result);p.delete(m.id)}};"
        "ws.onopen=async()=>{const r=await send('Runtime.evaluate',{expression:process.argv[2],"
        "awaitPromise:true,returnByValue:true});"
        "process.stdout.write(JSON.stringify(r));process.exit(0)};"
        "setTimeout(()=>{process.stdout.write('{\"timeout\":1}');process.exit(0)},%d);"
    ) % int(EVAL_TIMEOUT * 1000)
    try:
        p = subprocess.run(["node", "-e", script, ws_url, expression],
                           capture_output=True, text=True, timeout=EVAL_TIMEOUT)
    except Exception as e:
        return None, f"node_failed:{type(e).__name__}"
    out = (p.stdout or "").strip()
    if not out:
        return None, f"node_empty:{(p.stderr or '')[:120]}"
    try:
        body = json.loads(out)
    except Exception:
        return None, "node_bad_json"
    if body.get("timeout"):
        return None, "eval_timeout"
    if body.get("exceptionDetails"):
        return None, "eval_exception"
    # node 脚本输出的是 CDP 的 Runtime.evaluate 结果：{"result": {"type": ..., "value": ...}}
    res = body.get("result") or {}
    return res.get("value"), None


_JS_TMPL = r"""
(async () => {
  const ASINS = %ASINS%;
  const body = {
    market: %MARKET%, monthName: "bsr_sales_nearly", asins: ASINS, page: 1,
    nodeIdPaths: [], symbolFlag: true,
    // ⚠️ size 只能用服务的合法档位（实测 20 / 60 / 100）。传 92、200、3 都直接返回
    // total=null / items 空——不是"越大越好"，固定 100 最稳（批次也按 100 切）。
    size: 100,
    order: { field: "amz_unit", desc: true }, lowPrice: "N", salesGrowthType: "30d"
  };
  const r = await fetch("/v3/api/competing-lookup", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const txt = await r.text();
  if (r.status !== 200) {
    return JSON.stringify({ error: "http_" + r.status, ctype: ct, body: txt.slice(0, 200) });
  }
  // 正常接口永远返回 JSON。返回 HTML = 登录态失效后被重定向到页面
  // （多端登录互踢就是这种表现：200 + text/html + 一大段 HTML）
  if (!ct.includes("json")) {
    return JSON.stringify({ error: "not_json", ctype: ct, len: txt.length,
                            snippet: txt.slice(0, 120).replace(/\s+/g, " ") });
  }
  let j;
  try { j = JSON.parse(txt); } catch (e) {
    return JSON.stringify({ error: "bad_json", ctype: ct });
  }
  if (j.code !== "OK") return JSON.stringify({ error: "code_" + j.code });
  const items = (j.data && j.data.items) || [];
  const out = {};
  for (const x of items) {
    out[x.asin] = x.availableDate ? new Date(x.availableDate).toISOString().slice(0, 10) : null;
  }
  return JSON.stringify({ total: j.data && j.data.total, got: items.length, dates: out });
})()
"""


# ---------------------------------------------------------------- 登录
_PROBE_JS = r"""
(async () => {
  try {
    const r = await fetch("/v3/api/competing-lookup", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ market: "US", monthName: "bsr_sales_nearly", asins: ["B09MKPDJRT"],
        page: 1, nodeIdPaths: [], symbolFlag: true, size: 100,
        order: { field: "amz_unit", desc: true }, lowPrice: "N", salesGrowthType: "30d" })
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    return JSON.stringify({ ok: r.status === 200 && ct.includes("json") });
  } catch (e) { return JSON.stringify({ ok: false, err: String(e) }); }
})()
"""

_JS_HAS_PW = r"""
JSON.stringify({
  has: [...document.querySelectorAll("input[type=password]")].some(e => e.offsetParent !== null),
  url: location.href
})
"""

# 页面上「登录」入口的文字（右上角通常是 <a>登录</a> 或 <span>登录</span>）
_JS_CLICK_LOGIN = r"""
(() => {
  // 实测页面上的入口文字是「立即登录」「登录/注册」「未登录」这些，
  // 所以不能要求整串等于「登录」：包含匹配 + 排除「未登录/退出」，再取最短的那个
  const all = [...document.querySelectorAll("a,button,span,div,i")];
  const ok = all.filter(e => {
    const t = (e.textContent || "").trim();
    if (!t || t.length > 10 || e.offsetParent === null) return false;
    if (/未登录|退出|注销/.test(t)) return false;
    return /登录|登\s*录|login|log\s*in|sign\s*in/i.test(t);
  });
  ok.sort((a, b) => (a.textContent || "").trim().length - (b.textContent || "").trim().length);
  const hit = ok[0];
  if (!hit) return JSON.stringify({ clicked: false, tried: all.length });
  const text = (hit.textContent || "").trim();
  hit.click();
  return JSON.stringify({ clicked: true, text: text, tag: hit.tagName });
})()
"""


def _has_password(tab=None):
    tab = tab or _page()
    if not tab:
        return False
    val, err = _ws_call(tab["id"], _JS_HAS_PW)
    if err:
        return False
    try:
        return bool(json.loads(val or "{}").get("has"))
    except Exception:
        return False


def _ensure_login_form():
    """让页面上出现密码输入框。返回 (ok, detail)。

    卖家精灵没有稳定的登录 URL（/v3/login、/login 都 404），实际是「点登录 → 弹窗」，
    所以：先回榜单页 → 看有没有密码框 → 没有就点一下「登录」入口。
    """
    tab = _page()
    if not tab:
        return False, "no_tab"
    if _has_password(tab):
        return True, "already_open"

    # 访问 /w/user/logout 会跳登录页（实测）
    _cdp(tab["id"], "Page.navigate", {"url": LOGIN_URL})
    time.sleep(3.5)
    tab = _page() or tab
    if _has_password(tab):
        return True, "after_logout_redirect"

    val, err = _ws_call(tab["id"], _JS_CLICK_LOGIN)
    if err:
        return False, f"click_failed:{err}"
    time.sleep(2.5)
    if _has_password(_page()):
        return True, "opened_by_click"
    return False, "no_password_field"


# 登录表单不硬编码选择器：找 password 框，往前找最近的文本输入框当账号，
# 再找文字含「登录」的按钮。React/Vue 受控组件必须用原生 setter + 派发事件才认。
_FILL_JS = r"""
(async () => {
  const USER = __USER__, PASS = __PASS__;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = el => !!el && el.offsetParent !== null;
  const txt = el => (el.textContent || "").trim();
  const setVal = (el, v) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    try { Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, v); }
    catch (e) { el.value = v; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  };

  // ① 默认可能停在「验证码登录」，先切到「密码登录」
  if (![...document.querySelectorAll("input[type=password]")].some(vis)) {
    const tabEl = [...document.querySelectorAll("a,span,div,button")]
      .find(e => vis(e) && /^密码登录$/.test(txt(e)));
    if (tabEl) { tabEl.click(); await sleep(700); }
  }

  // ② 只认可见的密码框（页面上有两套表单，隐藏的那套也在 DOM 里）
  const pw = [...document.querySelectorAll("input[type=password]")].find(vis);
  if (!pw) return JSON.stringify({ error: "no_password_field", url: location.href });

  // ③ 账号框：优先按 placeholder 认（「手机号/邮箱/子账号」），否则取密码框前最近的可见文本框
  let user = [...document.querySelectorAll("input")]
    .find(e => vis(e) && /手机号|邮箱|账号|用户名|phone|email|account/i.test(e.placeholder || ""));
  if (!user) {
    const inputs = [...document.querySelectorAll("input")];
    const idx = inputs.indexOf(pw);
    for (let i = idx - 1; i >= 0; i--) {
      const t = (inputs[i].type || "text").toLowerCase();
      if (vis(inputs[i]) && ["text", "tel", "email", "number", ""].includes(t)) { user = inputs[i]; break; }
    }
  }
  if (!user) return JSON.stringify({ error: "no_user_field" });

  setVal(user, USER);
  setVal(pw, PASS);
  document.querySelectorAll("input[type=checkbox]").forEach(c => { if (!c.checked) c.click(); });
  await sleep(250);

  // ④ 提交：只认「立即登录」。
  // ⚠️ 页面上还有个「自动登录」勾选项，也是 4 个字 —— 按长度排序会误点到它（踩过），
  // 所以这里排除「自动登录」，并且**只从 button/[type=submit]/a 里找**，优先精确匹配。
  const SKIP = /账号登录|密码登录|验证码登录|扫码登录|注册|子账号无法登录|忘记密码|自动登录/;
  let pool = [...document.querySelectorAll("button, [type=submit], a")]
    .filter(e => vis(e) && txt(e) && txt(e).length <= 8 && /登录/.test(txt(e)) && !SKIP.test(txt(e)));
  if (!pool.length) {
    pool = [...document.querySelectorAll("span, div")]
      .filter(e => vis(e) && txt(e) && txt(e).length <= 8 && /登录/.test(txt(e)) && !SKIP.test(txt(e)));
  }
  const btn = pool.find(e => txt(e) === "立即登录")
           || pool.sort((a, b) => txt(a).length - txt(b).length)[0];
  if (btn) { btn.click(); return JSON.stringify({ clicked: txt(btn), tag: btn.tagName }); }
  const form = pw.closest("form");
  if (form) { form.submit(); return JSON.stringify({ submitted: "form" }); }
  return JSON.stringify({ error: "no_submit" });
})()
"""


def _cdp(tab_id, method, params=None, timeout=20):
    """通用 CDP 调用（Page.navigate 之类）。返回 (result, err)。"""
    status, text = _http(f"http://127.0.0.1:{CDP_PORT}/json/list", timeout=5)
    if status != 200:
        return None, "cdp_unavailable"
    try:
        tabs = json.loads(text)
    except Exception:
        return None, "cdp_bad_json"
    tab = next((t for t in tabs if t.get("id") == tab_id), None)
    if not tab or not tab.get("webSocketDebuggerUrl"):
        return None, "tab_gone"
    script = (
        "const ws=new WebSocket(process.argv[1]);let id=0;const p=new Map();"
        "const send=(m,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pa}))});"
        "ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){"
        "p.get(m.id)(m.error?{__error:m.error}:(m.result||{__ok:1}));p.delete(m.id)}};"
        "ws.onopen=async()=>{const r=await send(process.argv[2],JSON.parse(process.argv[3]));"
        "process.stdout.write(JSON.stringify(r||{}));process.exit(0)};"
        "setTimeout(()=>{process.stdout.write('{\"timeout\":1}');process.exit(0)},%d);"
    ) % (timeout * 1000)
    try:
        pr = subprocess.run(["node", "-e", script, tab["webSocketDebuggerUrl"],
                             method, json.dumps(params or {})],
                            capture_output=True, text=True, timeout=timeout + 5)
    except Exception as e:
        return None, f"node_failed:{type(e).__name__}"
    out = (pr.stdout or "").strip()
    if not out:
        return None, f"node_empty:{(pr.stderr or '')[:100]}"
    try:
        body = json.loads(out)
    except Exception:
        return None, "node_bad_json"
    if body.get("timeout"):
        return None, "cdp_timeout"
    if body.get("__error"):
        return None, "cdp_error:" + json.dumps(body["__error"], ensure_ascii=False)[:140]
    return body, None


_SAME_SITE = {0: "None", 1: "Lax", 2: "Strict"}


def _same_site(v):
    """CDP 两个方向的类型不一致：读出来可能是 0/1/2，写回去必须是字符串。"""
    if isinstance(v, str) and v:
        return v.capitalize()
    if isinstance(v, (int, float)):
        return _SAME_SITE.get(int(v), "Lax")
    return "Lax"


def _save_cookies(tab=None):
    """把 sellersprite 的 cookie 加密存下来。

    为什么要自己存：`JSESSIONID` 和 `Sprite-X-Token` 都是**会话 cookie**（persistent=0），
    Chrome 一关就没了 —— 不存的话每次取数都得重新登录一遍。
    """
    tab = tab or _page()
    if not tab:
        return 0
    body, err = _cdp(tab["id"], "Network.getAllCookies", {}, timeout=20)
    if err:
        _log(f"[sprite] 读 cookie 失败：{err}")
        return 0
    cookies = (body or {}).get("cookies") or []
    keep = []
    for c in cookies:
        if "sellersprite" not in (c.get("domain") or ""):
            continue
        keep.append({
            "name": c.get("name"), "value": c.get("value"),
            "domain": c.get("domain"), "path": c.get("path"),
            "expires": c.get("expires"),
            "httpOnly": bool(c.get("httpOnly")), "secure": bool(c.get("secure")),
            "sameSite": _same_site(c.get("sameSite")),
        })
    if not keep:
        return 0
    sprite_cred.save_json(COOKIE_FILE, keep)
    return len(keep)


def _apply_cookies(tab=None):
    """启动浏览器后把上次存的 cookie 注入回去。

    会话 cookie 的 expires 会被推到 3 天后 —— 浏览器收到「有明确过期时间」的 cookie
    就会自己写盘，下次连注入都省了。
    """
    tab = tab or _page()
    if not tab:
        return 0
    data = sprite_cred.load_json(COOKIE_FILE)
    if not data:
        return 0
    now = time.time()
    fixed = []
    for c in data:
        c = dict(c)
        if not c.get("expires") or float(c["expires"]) < 0:
            c["expires"] = now + COOKIE_TTL
        # CDP 的 getAllCookies 返回数字，setCookies 只认字符串（踩过：Invalid parameters）
        c["sameSite"] = _same_site(c.get("sameSite"))
        fixed.append(c)
    body, err = _cdp(tab["id"], "Network.setCookies", {"cookies": fixed}, timeout=20)
    if err:
        _log(f"[sprite] cookie 注入失败：{err}")
        return 0
    return len(fixed)


def _probe(tab=None):
    """探针：接口能不能正常返回 JSON。True = 已登录且可用。"""
    tab = tab or _page()
    if not tab:
        return False
    val, err = _ws_call(tab["id"], _PROBE_JS)
    if err:
        return False
    try:
        return bool(json.loads(val or "{}").get("ok"))
    except Exception:
        return False


def _auto_login():
    """用本地加密凭据自动登录。返回 (ok, detail)。

    失败一律不抛异常 —— 调用方据此返回 need_login 让前端提示。
    """
    # ① 先判断登录态：还能正常取数就什么都不做。
    # （登录页是 /w/user/logout，带登出副作用，绝不能对有效会话白走一趟）
    if _probe():
        return True, "already_ok"

    # ② 真的失效了，才看有没有凭据 / 是否熔断
    cred = sprite_cred.load()
    if not cred:
        return False, "no_cred"
    if _login_blocked():
        _log("[sprite] 自动登录已熔断（连续失败过多），冷却期内不再尝试")
        return False, "rate_limited"

    tab = _page()
    if not tab:
        return False, "no_tab"

    _log("[sprite] 登录态失效，尝试用本地凭据自动登录…")
    ok_form, form_detail = _ensure_login_form()
    if not ok_form:
        _note_login_fail()
        _log(f"[sprite] 找不到登录表单：{form_detail}")
        return False, form_detail

    tab = _page() or tab
    expr = (_FILL_JS
            .replace("__USER__", json.dumps(cred["user"]))
            .replace("__PASS__", json.dumps(cred["password"])))
    val, err = _ws_call(tab["id"], expr)
    if err:
        _note_login_fail()
        return False, f"fill_failed:{err}"
    try:
        r = json.loads(val or "{}")
    except Exception:
        r = {"error": "bad_payload"}
    if r.get("error"):
        _note_login_fail()
        _log(f"[sprite] 自动登录填表失败：{r['error']}")
        return False, r["error"]

    # 等登录生效（跳转 + 探针通过），最多 30 秒
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(2.5)
        t = _page()
        if t and _probe(t):
            with _login_lock:
                _login_fails.clear()
            n = _save_cookies(t)
            _log(f"[sprite] 自动登录成功（已保存 {n} 条 cookie，下次免登）")
            return True, "ok"

    _note_login_fail()
    _log("[sprite] 自动登录超时（可能需要滑块验证，或账号密码不对）")
    return False, "login_timeout"


def _run_batches(tab, uniq, country):
    """跑完所有批次，返回 (result, info)。info.auth_failed 表示登录态问题。"""
    result = {}
    info = {"batches": 0, "errors": [], "auth_failed": False}
    for i in range(0, len(uniq), BATCH_SIZE):
        chunk = uniq[i:i + BATCH_SIZE]
        expr = (_JS_TMPL
                .replace("%ASINS%", json.dumps(chunk))
                .replace("%MARKET%", json.dumps(country or "US")))
        val, err = _ws_call(tab["id"], expr)
        info["batches"] += 1
        if err:
            info["errors"].append(err)
            continue
        try:
            payload = json.loads(val or "{}")
        except Exception:
            info["errors"].append("bad_payload")
            continue
        if payload.get("error"):
            e = payload["error"]
            if _is_auth_error(e):
                info["auth_failed"] = True
                info["errors"].append(e)
                break
            info["errors"].append(e)
            continue
        for a, d in (payload.get("dates") or {}).items():
            if d:
                result[a] = d
    return result, info


def fetch_dates(asins, country="US", close_browser=True):
    """批量取上架时间。返回 (dict{asin: 'YYYY-MM-DD'}, info)。

    info.status：ok / need_login / no_asins / 错误码。
    **无论成功、失败、需登录，结束时都会关掉浏览器**（唯一的例外是用户主动点了
    「重新登录」，那由 `open_login_window` 管理窗口生命周期）。
    """
    keys = [str(a or "").strip().upper() for a in (asins or []) if str(a or "").strip()]
    seen, uniq = set(), []
    for k in keys:
        if k not in seen:
            seen.add(k)
            uniq.append(k)
    if not uniq:
        return {}, {"status": "no_asins", "asked": 0}

    with _run_lock:
        ok, detail = _ensure_browser(headless=True)   # 无头：屏幕上不会有窗口
        if not ok:
            _log(f"[sprite] 浏览器不可用：{detail}")
            _record("error", f"浏览器启动失败：{detail}")
            return {}, {"status": detail, "asked": len(uniq)}

        result, info = {}, {"asked": len(uniq), "batches": 0, "errors": [], "auth_failed": False}
        try:
            tab = _page() or _logged_in_tab(timeout=10)[0]
            if not tab:
                info["status"] = "no_tab"
                _record("error", "没有可用的页面")
                return {}, info

            # 先把上次存下来的登录态注入（会话 cookie 关浏览器就没了，只能自己存）
            n_ck = _apply_cookies(tab)
            if n_ck:
                time.sleep(0.6)

            result, info = _run_batches(tab, uniq, country)
            info["asked"] = len(uniq)          # _run_batches 只返回批次信息，asked 要补回

            # 登录态失效 + 有凭据 → 自动登录一次再重跑。
            # ⚠️ 先探针二次确认：登录页是 /w/user/logout（带登出副作用），
            # 不能因为某批次的偶发失败就把**有效会话**踢掉。
            if info.get("auth_failed") and not result:
                if _probe():
                    info["auth_failed"] = False
                    info["errors"].append("probe_ok")
                else:
                    lg_ok, lg_detail = _auto_login()
                    info["login"] = lg_detail
                    if lg_ok:
                        tab = _page()
                        if tab:
                            r2, i2 = _run_batches(tab, uniq, country)
                            result = r2
                            info["batches"] += i2.get("batches", 0)
                            # 重跑就是「重来一次」，错误列表以这一次为准，别把登录前的失败留着
                            info["errors"] = [e for e in i2.get("errors", []) if e != "probe_ok"]
                            info["auth_failed"] = i2.get("auth_failed", False)

            if info.get("auth_failed") and not result:
                reason = {"no_cred": "登录已失效（未配置账号，无法自动重登）",
                          "rate_limited": "自动登录失败次数过多，已暂停 30 分钟",
                          "login_timeout": "自动登录超时，可能需要滑块验证",
                          "no_password_field": "登录页结构变了，自动填表失败",
                          "no_submit": "登录页找不到提交按钮",
                          }.get(info.get("login") or "", "登录已失效（可能在其他端登录过）")
                info["status"] = "need_login"
                _record("need_login", f"卖家精灵：{reason}", asked=len(uniq))
            elif result:
                info["status"] = "ok"
                _save_cookies(tab)          # 服务端可能轮换 token，成功时顺手刷新
                _record("ok", f"已取到 {len(result)} 条上架时间", got=len(result), asked=len(uniq))
            else:
                info["status"] = "error"
                errs = [e for e in (info.get("errors") or []) if e != "probe_ok"]
                _record("error", "取数失败：" + (",".join(errs) or "未知原因"), asked=len(uniq))
        except Exception as e:
            info["status"] = "error"
            _record("error", f"取数异常：{type(e).__name__}: {e}")
        finally:
            # ⚠️ 关键：任何出口都关浏览器，**绝不留后台窗口**
            if close_browser:
                close_browser_gracefully()

        info["got"] = len(result)
        _log(f"[sprite] 取上架时间：{info['got']}/{info.get('asked', 0)} 个，"
             f"{info.get('batches', 0)} 批"
             + (f"，异常 {info['errors']}" if info.get("errors") else ""))
        return result, info


# ---------------------------------------------------------------- 手动登录窗口
def _watch_login(timeout=300):
    """盯着有头登录窗口：登录成功就关，超时也关（用户要求「不能一直开着」）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(3)
        if _run_lock.locked():        # 有取数任务在跑，这一轮别抢浏览器
            continue
        tab = _page()
        if tab and _probe(tab):
            _save_cookies(tab)
            _record("ok", "登录成功，可以继续取数")
            with _login_lock:
                _login_fails.clear()
            close_browser_gracefully()
            return
    _record("need_login", "登录窗口已超时关闭，需要时再点一次「重新登录」")
    close_browser_gracefully()


def open_login_window():
    """用户点「重新登录」时调用：开可见窗口，登录成功后自动关闭。"""
    with _run_lock:
        if _alive():
            close_browser_gracefully()
            time.sleep(1.0)
        ok, detail = _launch_chrome(headless=False)
        if not ok:
            _record("error", f"登录窗口启动失败：{detail}")
            return {"ok": False, "detail": detail}
        threading.Thread(target=_watch_login, daemon=True, name="SpriteLoginWatch").start()
        _record("need_login", "已打开登录窗口，登录成功后会自动关闭")
        return {"ok": True, "detail": "headed_started"}


def close_browser_gracefully():
    """优雅关闭专用 Chrome —— 让 cookie 落盘，下次免登录。

    ⚠️ 直接 kill 进程会丢登录态（实测：强杀后重开停在登录页）。
    """
    status, text = _http(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=3)
    if status != 200:
        return
    try:
        ws_url = json.loads(text).get("webSocketDebuggerUrl")
    except Exception:
        return
    if not ws_url:
        return
    script = (
        "const ws=new WebSocket(process.argv[1]);"
        "ws.onopen=()=>{ws.send(JSON.stringify({id:1,method:'Browser.close'}));setTimeout(()=>process.exit(0),800)};"
    )
    try:
        subprocess.run(["node", "-e", script, ws_url], capture_output=True, timeout=10)
    except Exception:
        pass


def status():
    """给前端/诊断用：浏览器状态、登录态、凭据是否配置、最近一次取数结果。"""
    out = {
        "running": _alive(),
        "logged_in": False,
        "url": None,
        "last": last_result(),
        "cred": sprite_cred.status(),
        "loginBlocked": _login_blocked(),
    }
    if out["running"]:
        tab = _page()
        out["logged_in"] = not _is_login_page(tab)
        out["url"] = (tab or {}).get("url")
    return out
