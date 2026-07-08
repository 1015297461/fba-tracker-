import datetime
import os

# backend/ 的上一级即仓库根目录 —— data/、skills/ 等资源目录都锚定在这里，
# 不用各模块自己的 __file__（那样挪目录/嵌套包时会算出错误的路径）。
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _extract_token(handler):
    auth = handler.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None
