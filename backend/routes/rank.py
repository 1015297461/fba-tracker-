import datetime
import random
import threading
import time
from urllib.parse import urlparse, parse_qs

from .. import rank_fetcher
from ..utils import _extract_token, _now_iso


def run_rank_task(state, task, delay_between_kw=(3.0, 7.0)):
    """串行采集任务下所有关键词，写入快照，返回结果列表。"""
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
                now  = datetime.datetime.now()
                slot = now.strftime("%Y-%m-%d-%H")
                today = now.strftime("%Y-%m-%d")
                for task in state.list_rank_tasks():
                    if not task["enabled"] or not task["keywords"]:
                        continue
                    hours = {h % 24 for h in task["schedule"]}  # 24:00 视作 0:00
                    if now.hour not in hours:
                        continue
                    key = (task["id"], slot)
                    if key in done:
                        continue
                    done.add(key)
                    print(f"[rank] 定时执行 {task['asin']}/{task['marketplace']} "
                          f"({len(task['keywords'])} 词) @ {slot}")
                    try:
                        run_rank_task(state, task)
                    except Exception as e:
                        print(f"[rank] 任务异常: {e}")
                if len(done) > 800:
                    done = {k for k in done if k[1] >= today}
            except Exception as e:
                print(f"[rank] 调度异常: {e}")
            time.sleep(60)

    th = threading.Thread(target=loop, daemon=True)
    th.start()
    print("[rank] 排名调度线程已启动（每分钟检查 0/6/12/18 档位）")


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def get_tasks(self):
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        self._send_json(200, {"tasks": state.list_rank_tasks()})
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
        if not auth.verify(_extract_token(self)):
            self._send_json(401, {"error": "请先登录"})
            return
        payload = self._read_json()
        if payload is None:
            return
        task_id = payload.get("taskId")
        task = state.get_rank_task(task_id) if task_id else payload
        if not task or not (task.get("asin") or "").strip():
            self._send_json(400, {"error": "task not found / asin required"})
            return
        if not task.get("id"):
            task = state.upsert_rank_task(task)
        print(f"  [rank] 手动执行 {task['asin']}/{task['marketplace']}")
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
