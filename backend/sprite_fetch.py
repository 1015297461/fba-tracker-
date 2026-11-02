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
"""

import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request

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


def _launch_chrome():
    chrome = _chrome_bin()
    if not chrome:
        return False, "chrome_not_found"
    os.makedirs(PROFILE_DIR, exist_ok=True)
    cmd = [
        chrome,
        "--no-sandbox",            # 后端在受限环境里跑时，Chrome 自带沙箱会起不来
        "--disable-gpu",
        f"--user-data-dir={PROFILE_DIR}",
        f"--remote-debugging-port={CDP_PORT}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1400,900",
        ENTRY_URL,
    ]
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except Exception as e:
        return False, f"launch_failed:{type(e).__name__}"
    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        if _alive():
            time.sleep(1.5)          # 给页面一点加载时间
            return True, "started"
        time.sleep(0.5)
    return False, "cdp_timeout"


def _ensure_browser():
    """返回 (ok, detail)。已开则复用。"""
    if _alive():
        return True, "reused"
    return _launch_chrome()


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
  const txt = await r.text();
  if (r.status !== 200) return JSON.stringify({ error: "http_" + r.status, body: txt.slice(0, 200) });
  let j;
  try { j = JSON.parse(txt); } catch (e) { return JSON.stringify({ error: "bad_json" }); }
  if (j.code !== "OK") return JSON.stringify({ error: "code_" + j.code });
  const items = (j.data && j.data.items) || [];
  const out = {};
  for (const x of items) {
    out[x.asin] = x.availableDate ? new Date(x.availableDate).toISOString().slice(0, 10) : null;
  }
  return JSON.stringify({ total: j.data && j.data.total, got: items.length, dates: out });
})()
"""


def fetch_dates(asins, country="US", close_browser=True):
    """批量取上架时间。返回 (dict{asin: 'YYYY-MM-DD'}, info)。

    info 里带 status：ok / need_login / no_asins / 错误码。
    任何异常都不抛出——上架时间属于"锦上添花"，不能因此拖垮采集。
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
        ok, detail = _ensure_browser()
        if not ok:
            _log(f"[sprite] 浏览器不可用：{detail}")
            return {}, {"status": detail, "asked": len(uniq)}

        tab = _page()
        if not tab:
            _log("[sprite] 没有可用的 sellersprite 标签页")
            return {}, {"status": "no_tab", "asked": len(uniq)}
        if _is_login_page(tab):
            _log("[sprite] 需要登录：请在专用窗口登录一次（data/sprite-profile）")
            return {}, {"status": "need_login", "asked": len(uniq)}

        result, info = {}, {"asked": len(uniq), "batches": 0, "errors": []}
        try:
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
                    info["errors"].append(payload["error"])
                    continue
                for a, d in (payload.get("dates") or {}).items():
                    if d:
                        result[a] = d
        finally:
            # 只有真取到数据才关浏览器；登录页/失败时**保持窗口开着**，否则用户没法登录
            if close_browser and result:
                close_browser_gracefully()

        info["status"] = "ok" if result else ("empty" if not info["errors"] else "error")
        info["got"] = len(result)
        _log(f"[sprite] 取上架时间：{info['got']}/{info['asked']} 个"
             f"，{info['batches']} 批" + (f"，异常 {info['errors']}" if info["errors"] else ""))
        return result, info


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
    """给前端/诊断用：浏览器是否就绪、是否需要登录。"""
    if not _alive():
        return {"running": False, "logged_in": False}
    tab = _page()
    return {"running": True, "logged_in": not _is_login_page(tab),
            "url": (tab or {}).get("url")}
