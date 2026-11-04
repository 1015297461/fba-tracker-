import datetime
import random
import re
import threading
import time
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

from .. import rank_fetcher
from ..utils import _extract_token, _now_iso, _log

# 可选时区：定时档位按哪个时区的时间解释（用户可切中国/美东/美西）
TIMEZONES = {
    "Asia/Shanghai": {"label": "中国时间（北京）", "short": "中国"},
    "America/New_York": {"label": "美国东部时间（纽约）", "short": "美东"},
    "America/Los_Angeles": {"label": "美国西部时间（洛杉矶）", "short": "美西"},
}
DEFAULT_TZ = "Asia/Shanghai"

# 定时档位命中后的容忍窗口（秒）。服务重启/进程卡顿时，只要还在窗口内就补跑一次，
# 不会因为「刚好错过那一分钟」整天不采。
SLOT_GRACE_SEC = 600


def task_tz(task):
    """任务时区对象；配错/未知一律退回中国时间，不让调度线程挂掉。"""
    name = (task.get("timezone") or DEFAULT_TZ).strip()
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def _due_slot(task, now_utc=None):
    """返回此刻命中的档位（任务本地时间当天），没命中返回 None。

    档位统一是 "HH:MM"（db._norm_schedule 已归一化），old 数据也转好了。
    """
    slots = task.get("schedule") or []
    if not slots:
        return None
    tz = task_tz(task)
    now = now_utc.astimezone(tz) if now_utc else datetime.datetime.now(tz)
    for slot in slots:
        m = re.match(r"^(\d{2}):(\d{2})$", str(slot))
        if not m:
            continue
        target = now.replace(hour=int(m.group(1)), minute=int(m.group(2)),
                             second=0, microsecond=0)
        delta = (now - target).total_seconds()
        if 0 <= delta < SLOT_GRACE_SEC:
            return target
    return None


def run_rank_task(state, task, delay_between_kw=(3.0, 7.0)):
    """串行采集任务下所有关键词，写入快照，返回结果列表。

    task["keywords"] 只留一个词时，就是「只采这个词」（立即采集按钮用）。
    """
    results = []
    kws = task.get("keywords", [])
    for i, kw in enumerate(kws):
        kw = (kw or "").strip()
        if not kw:
            continue
        try:
            res = rank_fetcher.locate_rank(task["asin"], task["marketplace"], kw, max_pages=3)
        except Exception as e:
            res = {
                "asin": task["asin"], "keyword": kw,
                "marketplace": task["marketplace"], "status": "error",
                "organic_rank": None, "organic_page": None, "sponsored": [],
                "error": f"fetch_exc:{type(e).__name__}", "captured_at": _now_iso(),
            }
        state.add_snapshot(task["id"], res)
        results.append(res)
        if i < len(kws) - 1:
            time.sleep(random.uniform(*delay_between_kw))
    state.mark_task_run(task["id"])
    return results


def start_scheduler(state):
    """后台守护线程：每分钟检查定时档位，命中即采集（同一小时不重复）。"""
    def loop():
        done = set()  # (task_id, 'YYYY-MM-DD-HH')，避免同一小时重复触发
        while True:
            try:
                today = datetime.datetime.now().strftime("%Y-%m-%d")
                for task in state.list_rank_tasks():
                    if not task["enabled"] or not task["keywords"]:
                        continue
                    # 命中的档位按**任务自己的时区**算：中国任务 06:00 = 北京 06:00，
                    # 美东任务 06:00 = 纽约 06:00（= 北京 18:00/19:00，随夏令时变）。
                    target = _due_slot(task)
                    if not target:
                        continue
                    key = (task["id"], target.strftime("%Y-%m-%d-%H:%M"))
                    if key in done:
                        continue
                    done.add(key)
                    tz_short = TIMEZONES.get(task.get("timezone") or DEFAULT_TZ, {}).get("short", "")
                    _log(f"[rank] 定时执行 {task['asin']}/{task['marketplace']} "
                         f"({len(task['keywords'])} 词) @ {tz_short} {target.strftime('%m-%d %H:%M')}")
                    try:
                        run_rank_task(state, task)
                    except Exception as e:
                        _log(f"[rank] 任务异常: {e}")
                if len(done) > 800:
                    done = {k for k in done if k[1][:10] >= today}
            except Exception as e:
                _log(f"[rank] 调度异常: {e}")
            time.sleep(60)

    th = threading.Thread(target=loop, daemon=True)
    th.start()
    _log("[rank] 排名调度线程已启动（每分钟按任务时区检查自定义档位）")


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_tasks(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, {
            "tasks": state.list_rank_tasks(),
            # 可选的定时时区（前端下拉直接用，避免两边各写一份对不上）
            "timezones": [{"id": k, **v} for k, v in TIMEZONES.items()],
        })
    GET["/api/rank/tasks"] = get_tasks

    def get_history(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        keyword = (q.get("keyword") or [None])[0]
        if not task_id:
            self._send_json(400, {"error": "taskId required"})
            return
        self._send_json(200, {
            "taskId": task_id,
            "snapshots": state.get_rank_history(task_id, keyword),
        })
    GET["/api/rank/history"] = get_history

    def post_tasks(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        if not (payload.get("asin") or "").strip():
            self._send_json(400, {"error": "asin required"})
            return
        self._send_json(200, {"task": state.upsert_rank_task(payload)})
    POST["/api/rank/tasks"] = post_tasks

    def post_run(self):
        """立即采集。传 keyword 就只采那一个词（表格每行的「采集」按钮）。"""
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        task_id = payload.get("taskId")
        keyword = (payload.get("keyword") or "").strip()
        task = state.get_rank_task(task_id) if task_id else payload
        if not task or not (task.get("asin") or "").strip():
            self._send_json(400, {"error": "task not found / asin required"})
            return
        if not task.get("id"):
            task = state.upsert_rank_task(task)
        if keyword:
            if keyword not in (task.get("keywords") or []):
                self._send_json(404, {"error": f"任务里没有这个词：{keyword}"})
                return
            task = dict(task, keywords=[keyword])
        _log(f"[rank] 手动执行 {task['asin']}/{task['marketplace']}"
             + (f" · 单词 {keyword}" if keyword else f"（{len(task.get('keywords') or [])} 词）"))
        results = run_rank_task(state, task)
        self._send_json(200, {"taskId": task["id"], "results": results})
    POST["/api/rank/run"] = post_run

    def delete_task(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("id") or [""])[0]
        if not task_id:
            self._send_json(400, {"error": "id required"})
            return
        state.delete_rank_task(task_id)
        self._send_json(200, {"ok": True})
    DELETE["/api/rank/tasks"] = delete_task

    def delete_keyword(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        q = parse_qs(urlparse(self.path).query)
        task_id = (q.get("taskId") or [""])[0]
        keyword = (q.get("keyword") or [""])[0]
        if not task_id or not keyword:
            self._send_json(400, {"error": "taskId and keyword required"})
            return
        task = state.get_rank_task(task_id)
        if task:
            new_kws = [k for k in task["keywords"] if k != keyword]
            new_notes = {k: v for k, v in task["keywordNotes"].items() if k != keyword}
            state.upsert_rank_task({**task, "keywords": new_kws, "keywordNotes": new_notes})
            with state.lock:
                with state._conn() as conn:
                    conn.execute(
                        "DELETE FROM rank_snapshots WHERE task_id=? AND keyword=?",
                        [task_id, keyword]
                    )
                    conn.commit()
        self._send_json(200, {"ok": True})
    DELETE["/api/rank/keyword"] = delete_keyword
