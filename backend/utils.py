import datetime
import os

# backend/ 的上一级即仓库根目录 —— data/、skills/ 等资源目录都锚定在这里，
# 不用各模块自己的 __file__（那样挪目录/嵌套包时会算出错误的路径）。
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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
