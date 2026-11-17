import datetime
import os

# backend/ 的上一级即仓库根目录 —— data/、skills/ 等资源目录都锚定在这里，
# 不用各模块自己的 __file__（那样挪目录/嵌套包时会算出错误的路径）。
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---- 定时任务时段红线（2026-11-17 复盘后定，前后端共用口径）----
# 本机 DNS 走路由器，凌晨 00:00~06:30 是固定故障窗口：按档位统计失败率
# 00:00 → 25.7%、05:00 → 44.6%、06:00 → 52.3%，08:00 之后降到 0~2%。
# 详见 AGENTS.md「定时任务时段红线」。
TIME_MIN = "08:30"
TIME_MAX = "21:00"


def time_in_window(hhmm):
    """HH:MM 是否落在允许时段内。空值视为通过（由调用方各自决定是否必填）。"""
    s = str(hhmm or "").strip()
    if not s:
        return True
    return TIME_MIN <= s <= TIME_MAX


def time_window_error(hhmm):
    """不合规时返回可直接回给前端的错误文案，合规返回 None。"""
    s = str(hhmm or "").strip()
    if not s or time_in_window(s):
        return None
    return f"{s} 超出允许时段（{TIME_MIN}~{TIME_MAX}）。凌晨 00:00~07:00 是本机网络故障窗口"


def _now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _log(msg):
    """统一日志输出：带本地时间前缀并立即刷新，便于实时观察长任务进度。

    服务端是长驻进程，stdout 默认块缓冲，长任务跑几分钟才刷出来会误判「卡死」。
    这里用 flush=True 保证每条日志立刻可见。
    """
    print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def _extract_token(handler):
    auth = handler.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None
