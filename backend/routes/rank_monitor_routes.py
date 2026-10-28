#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
排名监测路由
==============
两个动作要分清：
  · `/api/rank/query`  即时查询：抓一次直接返回，**不落盘、不进监测列表**（看完就走）
  · `/api/rank/targets` 加入监测：之后由定时线程每天/每周抓一次并存快照做变动检测

三种「排名」口径不同，返回里字段名已经区分（share_rank / organic_rank / aba.rankN），
前端不要都标成「排名」。
"""

import json
import re
import time
from urllib.parse import parse_qs, quote, urlparse

from .. import rank_export, rank_monitor, search_fetcher, sif_fetcher
from ..utils import _extract_token, _log

ASIN_RE = re.compile(r"^[A-Z0-9]{10}$")
HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _rank_int(v):
    """排名统一取整：SIF 给浮点（12.0），透到前端会显示成「#12.0 第2页」。"""
    if v is None:
        return None
    try:
        n = int(round(float(v)))
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def _norm_hhmm(v):
    """校验并规范化 HH:MM。空值返回 ""；格式非法返回 False（调用方据此回 400）。"""
    s = str(v or "").strip()
    if not s:
        return ""
    return s if HHMM_RE.match(s) else False


def register(GET, POST, PUT, DELETE, state, auth, ai_worker=None):

    def _user(handler):
        user = auth.verify(_extract_token(handler))
        if not user:
            handler._send_json(401, {"error": "请先登录"})
            return None
        return user

    def _norm_kind(kind: str) -> str:
        k = (kind or "keyword").strip().lower()
        return k if k in ("keyword", "asin") else "keyword"

    # ---- 即时查询（不入监测）----

    def get_rank_query(self):
        user = _user(self)          # 留痕要记发起人，这里必须接住返回值
        if not user:
            return
        q = parse_qs(urlparse(self.path).query)
        kind = _norm_kind((q.get("kind") or ["keyword"])[0])
        value = (q.get("value") or [""])[0].strip()
        country = ((q.get("country") or ["US"])[0] or "US").upper()[:4]
        own = ((q.get("ownAsin") or [""])[0] or "").strip().upper() or None
        if not value:
            self._send_json(400, {"error": "value required"})
            return
        if kind == "asin" and not ASIN_RE.match(value.upper()):
            self._send_json(400, {"error": "ASIN 格式不正确（10 位字母数字）"})
            return
        if not sif_fetcher.is_configured():
            self._send_json(400, {"error": "SIF MCP 未配置，请先在「SIF 关键词」里填写密钥",
                                  "code": "sif_not_configured"})
            return

        target = {"kind": kind, "value": value.upper() if kind == "asin" else value,
                  "country": country, "own_asin": own}
        try:
            data = rank_monitor.fetch_keyword(target) if kind == "keyword" \
                else rank_monitor.fetch_asin(target)
        except sif_fetcher.SifError as e:
            msg = str(e)
            low = msg.lower()
            if "qpm" in low or "限制已达上限" in msg:
                self._send_json(429, {"error": "SIF 调用过于频繁（每分钟 40 次），请等约 1 分钟",
                                      "code": "sif_rate_limited"})
                return
            if "timed out" in low or "超时" in msg:
                # 文案要按方向区分：词维度是「拉 100 名竞品」，ASIN 维度是「拉它自己的词表」，
                # 混用会让用户以为查 ASIN 也在拉竞品榜（曾这么错过）。
                tip = ("该 ASIN 覆盖的词较多，SIF 侧负载高时会超时。可稍后重试，或先加入监测让它在后台慢慢跑。"
                       if kind == "asin" else
                       "该词要拉前 100 名竞品，SIF 侧负载高时要 30~60 秒以上。可稍后重试，或换搜索量小一点的词。")
                self._send_json(504, {
                    "error": "SIF 侧响应超时，已自动重试一次", "hint": tip,
                    "code": "sif_timeout"})
                return
            self._send_json(502, {"error": msg})
            return
        except Exception as e:
            _log(f"[rank] query 失败 {kind}={value}: {type(e).__name__}: {e}")
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return

        # 查询留痕：即时查询也存历史（列表可删、可导出 Excel）
        qid = None
        try:
            summary = (f"{len(data.get('top') or [])} 个竞品" if kind == "keyword"
                       else f"{data.get('keyword_count') or 0} 个词")
            qid = state.add_rank_query(kind, target["value"], country, own,
                                       summary, data, user.get("username"))
        except Exception as e:
            _log(f"[rank] 存查询历史失败（不影响查询结果）: {e}")

        # 顺手告诉前端这个目标是否已在监测里，避免重复添加
        tracked = None
        try:
            for t in state.list_rank_targets():
                if t["kind"] == kind and t["value"].upper() == target["value"].upper() \
                        and (t.get("country") or "US") == country:
                    tracked = t["id"]
                    break
        except Exception:
            pass
        self._send_json(200, {"data": data, "tracked": tracked, "queryId": qid})
    GET["/api/rank/query"] = get_rank_query

    # ---- 单个 ASIN 在某关键词上的自然排名（点竞品榜某一行时懒查）----

    def get_asin_in_keyword(self):
        """给「关键词竞品榜」用：点某个竞品，查它在这个词上的**自然搜索位**。

        为什么单独开接口：`keyword_competition` 只给份额排名，不给自然位；
        而 `asin_keyword_signals` 一次能查一个 ASIN 的全部词。
        用户在榜上看到第 2 名视频占一半，想知道「它自然排第几」——点一下就行，
        按需查 1 次，不用把前 100 名全查一遍（那样 100 次调用会直接撞 QPM）。
        """
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        asin = ((q.get("asin") or [""])[0] or "").strip().upper()
        keyword = ((q.get("keyword") or [""])[0] or "").strip()
        country = ((q.get("country") or ["US"])[0] or "US").upper()[:4]
        if not ASIN_RE.match(asin):
            self._send_json(400, {"error": "ASIN 格式不正确"})
            return
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        try:
            sig = sif_fetcher.asin_keyword_signals(asin, country, 30, 50)
        except sif_fetcher.SifError as e:
            msg = str(e)
            low = msg.lower()
            if "qpm" in low or "限制已达上限" in msg:
                self._send_json(429, {"error": "SIF 调用过于频繁，请等约 1 分钟",
                                      "code": "sif_rate_limited"})
                return
            self._send_json(502, {"error": msg})
            return
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return

        hit = next((k for k in (sig.get("top_keywords") or [])
                    if (k.get("keyword") or "").strip().lower() == keyword.lower()), None)
        self._send_json(200, {
            "asin": asin,
            "keyword": keyword,
            # 该词没进它前 50 个流量词时，说明它在这个词上的量很小，不代表「掉出前三页」
            "in_keyword_list": bool(hit),
            "organic_rank": _rank_int((hit or {}).get("organic_rank")),
            "organic_page": (hit or {}).get("organic_page"),
            "organic_pos": (hit or {}).get("organic_pos"),
            "organic_rank_time": (hit or {}).get("organic_rank_time"),
            "traffic_share": (hit or {}).get("traffic_share"),
            "natural_ratio": (hit or {}).get("natural_ratio"),
            "search_volume": (hit or {}).get("search_volume"),
            "health": (hit or {}).get("health"),
            "notice": sig.get("data_notice") or sig.get("notice"),
        })
    GET["/api/rank/asin-in-keyword"] = get_asin_in_keyword

    def post_asin_in_keyword_batch(self):
        """批量查多个竞品在同一个词上的自然位。

        上限 10 个：每个 ASIN 要 1 次 SIF 调用，而 SIF 限制 QPM 40/60 秒。
        串行 + 每个之间停 1.5 秒，10 个约 20~30 秒，不会撞限流。
        """
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        keyword = str(payload.get("keyword") or "").strip()
        country = str(payload.get("country") or "US").upper()[:4]
        raw = payload.get("asins") or []
        asins, seen = [], set()
        for a in raw:
            a = str(a or "").strip().upper()
            if ASIN_RE.match(a) and a not in seen:
                seen.add(a)
                asins.append(a)
        asins = asins[:10]
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        if not asins:
            self._send_json(400, {"error": "asins required（最多 10 个）"})
            return

        results = {}
        for i, a in enumerate(asins):
            try:
                sig = sif_fetcher.asin_keyword_signals(a, country, 30, 50)
                hit = next((k for k in (sig.get("top_keywords") or [])
                            if (k.get("keyword") or "").strip().lower() == keyword.lower()), None)
                results[a] = {
                    "in_keyword_list": bool(hit),
                    "organic_rank": _rank_int((hit or {}).get("organic_rank")),
                    "organic_page": (hit or {}).get("organic_page"),
                    "organic_pos": (hit or {}).get("organic_pos"),
                    "organic_rank_time": (hit or {}).get("organic_rank_time"),
                    "traffic_share": (hit or {}).get("traffic_share"),
                    "natural_ratio": (hit or {}).get("natural_ratio"),
                    "health": (hit or {}).get("health"),
                }
            except Exception as e:
                results[a] = {"error": str(e)[:160]}
            if i < len(asins) - 1:
                time.sleep(1.5)          # 防撞 QPM 40
        _log(f"[rank] 批量查自然位 {len(asins)} 个 @ {keyword}")
        self._send_json(200, {"keyword": keyword, "count": len(asins), "results": results})
    POST["/api/rank/asin-in-keyword/batch"] = post_asin_in_keyword_batch

    # ---- 异步查询（前端轮询进度）----

    def post_rank_query_async(self):
        """起后台查询，立即返回 taskId；前端轮询 status 拿 stage 与结果。"""
        user = _user(self)
        if not user:
            return
        payload = self._read_json()
        if payload is None:
            return
        kind = _norm_kind(payload.get("kind"))
        value = str(payload.get("value") or "").strip()
        country = str(payload.get("country") or "US").upper()[:4]
        own = str(payload.get("ownAsin") or "").strip().upper() or None
        if not value:
            self._send_json(400, {"error": "value required"})
            return
        if kind == "asin" and not ASIN_RE.match(value.upper()):
            self._send_json(400, {"error": "ASIN 格式不正确（10 位字母数字）"})
            return
        if not sif_fetcher.is_configured():
            self._send_json(400, {"error": "SIF MCP 未配置，请先在「SIF 关键词」里填写密钥",
                                  "code": "sif_not_configured"})
            return
        tid = rank_monitor.start_query_task(
            state, kind, value.upper() if kind == "asin" else value, country, own,
            user.get("username"))
        self._send_json(200, {"taskId": tid, "kind": kind, "value": value})
    POST["/api/rank/query/async"] = post_rank_query_async

    def get_rank_query_status(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("taskId") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "taskId required"})
            return
        t = rank_monitor.get_query_task(tid)
        if not t:
            self._send_json(404, {"error": "任务不存在或已过期（10 分钟）"})
            return
        self._send_json(200, t)
    GET["/api/rank/query/status"] = get_rank_query_status

    # ---- 监测目标 ----

    def get_rank_targets(self):
        if not _user(self):
            return
        try:
            targets = state.list_rank_targets()
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        # 每条附上最新快照摘要与未读事件数，列表页一屏能看完
        out = []
        for t in targets:
            try:
                snap = state.get_latest_snapshot(t["id"])
                evs = state.list_rank_events(t["id"], 200)
            except Exception:
                snap, evs = None, []
            d = (snap or {}).get("data") or {}
            out.append({
                **{k: t.get(k) for k in ("id", "kind", "value", "label", "country",
                                         "own_asin", "freq", "competitor_n", "run_at",
                                         "extra_asins", "paused",
                                         "enabled", "created_at",
                                         "last_run_at", "last_status", "last_error")},
                "snapshot_date": (snap or {}).get("snap_date"),
                "summary": _summary(t["kind"], d),
                "event_count": len(evs),
                "high_count": sum(1 for e in evs if e.get("level") == "high"),
                "latest_event": (evs[0] if evs else None),
            })
        self._send_json(200, {"targets": out})
    GET["/api/rank/targets"] = get_rank_targets

    def _summary(kind: str, d: dict) -> dict:
        """列表页摘要：不返回整份快照，只给一眼能看的数。"""
        if not d:
            return {}
        if kind == "keyword":
            my = d.get("my") or {}
            return {
                "competitor_count": d.get("competitor_count"),
                "my_rank_tier": my.get("rank_tier"),
                "my_share_rank": my.get("share_rank"),
                "top3_click_share": (d.get("market") or {}).get("top3_click_share"),
                "top1": ((d.get("top") or [{}])[0]).get("asin"),
            }
        return {
            "keyword_count": d.get("keyword_count"),
            "no_organic_count": d.get("no_organic_count"),
            "aba_rank123": sum(int((d.get("aba") or {}).get(k) or 0)
                               for k in ("rank1", "rank2", "rank3")),
        }

    def post_rank_targets(self):
        user = _user(self)
        if not user:
            return
        payload = self._read_json()
        if payload is None:
            return
        kind = _norm_kind(payload.get("kind"))
        value = str(payload.get("value") or "").strip()
        if not value:
            self._send_json(400, {"error": "value required"})
            return
        if kind == "asin" and not ASIN_RE.match(value.upper()):
            self._send_json(400, {"error": "ASIN 格式不正确"})
            return
        freq = "weekly" if str(payload.get("freq") or "").lower() == "weekly" else "daily"
        try:
            cn = payload.get("competitorN")
            cn = max(1, min(15, int(cn))) if cn not in (None, "") else None
        except (TypeError, ValueError):
            cn = None
        run_at = _norm_hhmm(payload.get("runAt"))
        if run_at is False:
            self._send_json(400, {"error": "采集时刻格式应为 HH:MM（00:00~23:59）"})
            return
        extra = rank_monitor.parse_extra_asins(payload.get("extraAsins"))
        try:
            tid = state.upsert_rank_target(
                kind, value, country=(payload.get("country") or "US"),
                label=(payload.get("label") or None),
                own_asin=(str(payload.get("ownAsin") or "").strip().upper() or None),
                freq=freq, username=user.get("username"), competitor_n=cn,
                run_at=run_at or None, extra_asins=extra,
            )
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        _log(f"[rank] 加入监测 {kind}={value} freq={freq} by {user.get('username')}")
        self._send_json(200, {"id": tid, "kind": kind, "value": value, "freq": freq})
    POST["/api/rank/targets"] = post_rank_targets

    def patch_rank_target(self):
        """改单个目标的配置：竞品数 / 暂停 / 频率 / 备注 / 我的 ASIN。"""
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = str(payload.get("id") or "").strip()
        if not tid or not state.get_rank_target(tid):
            self._send_json(404, {"error": "监测目标不存在"})
            return
        fields = {}
        if "competitorN" in payload:
            try:
                fields["competitor_n"] = max(1, min(15, int(payload.get("competitorN"))))
            except (TypeError, ValueError):
                self._send_json(400, {"error": "competitorN 需为 1~15 的整数"})
                return
        if "paused" in payload:
            fields["paused"] = 1 if payload.get("paused") else 0
        if "extraAsins" in payload:
            fields["extra_asins"] = json.dumps(
                rank_monitor.parse_extra_asins(payload.get("extraAsins")), ensure_ascii=False)
        if "runAt" in payload:
            v = _norm_hhmm(payload.get("runAt"))
            if v is False:
                self._send_json(400, {"error": "采集时刻格式应为 HH:MM（00:00~23:59）"})
                return
            fields["run_at"] = v or None
        if "freq" in payload:
            fields["freq"] = "weekly" if str(payload.get("freq")).lower() == "weekly" else "daily"
        if "label" in payload:
            fields["label"] = payload.get("label")
        if "ownAsin" in payload:
            v = str(payload.get("ownAsin") or "").strip().upper()
            fields["own_asin"] = v or None
        if not fields:
            self._send_json(400, {"error": "没有可更新的字段"})
            return
        state.update_rank_target(tid, **fields)
        self._send_json(200, {"ok": True, "id": tid, **fields})
    POST["/api/rank/targets/update"] = patch_rank_target

    def get_asin_history(self):
        """某个 ASIN 在某个词上的逐日记录（点击竞品行弹窗用）。

        优先用监测快照（间隔规则）；没有监测目标就退回查询历史。
        每行含：日期 / 份额排名 / 总份额 / 自然位。
        """
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        asin = ((q.get("asin") or [""])[0] or "").strip().upper()
        keyword = ((q.get("keyword") or [""])[0] or "").strip()
        if not ASIN_RE.match(asin) or not keyword:
            self._send_json(400, {"error": "asin 与 keyword 必填"})
            return

        tid, source = None, "queries"
        for t in state.list_rank_targets(enabled_only=False):
            if t.get("kind") == "keyword" and (t.get("value") or "").upper() == keyword.upper():
                tid = t["id"]
                source = "snapshot"
                break

        rows = []
        if tid:
            for s in state.list_rank_snapshots_full(tid, 90):
                d = s.get("data") or {}
                hit = next((c for c in (d.get("top") or []) if c.get("asin") == asin), None)
                org = (d.get("organic") or {}).get(asin)
                rows.append({
                    "date": s.get("snap_date"),
                    "share_rank": (hit or {}).get("share_rank"),
                    "total_share": (hit or {}).get("total_share"),
                    "organic_rank": _rank_int(org),
                })
        else:
            by_date = {}
            for r in state.list_rank_queries_by_target("keyword", keyword, 60):
                day = (r.get("created_at") or "")[:10]
                if day:
                    by_date[day] = r
            for day in sorted(by_date):
                d = by_date[day].get("data") or {}
                hit = next((c for c in (d.get("top") or []) if c.get("asin") == asin), None)
                org = (d.get("organic") or {}).get(asin)
                rows.append({
                    "date": day,
                    "share_rank": (hit or {}).get("share_rank"),
                    "total_share": (hit or {}).get("total_share"),
                    "organic_rank": _rank_int(org),
                })

        self._send_json(200, {"asin": asin, "keyword": keyword,
                              "source": source, "history": rows})
    GET["/api/rank/asin-history"] = get_asin_history

    def get_rank_settings(self):
        if not _user(self):
            return
        self._send_json(200, {"settings": state.get_rmon_settings()})
    GET["/api/rank/settings"] = get_rank_settings

    def put_rank_settings(self):
        """全局设置：采集时刻 daily_at（HH:MM，空=不限）+ 默认竞品数。"""
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        kw = {}
        if "defaultCompetitorN" in payload:
            try:
                kw["default_competitor_n"] = str(max(1, min(15, int(payload.get("defaultCompetitorN")))))
            except (TypeError, ValueError):
                self._send_json(400, {"error": "默认竞品数需为 1~15"})
                return
        if not kw:
            self._send_json(400, {"error": "没有可更新的设置"})
            return
        state.set_rmon_settings(**kw)
        _log(f"[rank] 设置已更新 {kw}")
        self._send_json(200, {"ok": True, "settings": state.get_rmon_settings()})
    PUT["/api/rank/settings"] = put_rank_settings

    def get_asin_profile(self):
        """单个 ASIN 档案（悬浮弹窗数据缺失时兜底）。1 次 SIF 调用。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        asin = ((q.get("asin") or [""])[0] or "").strip().upper()
        country = ((q.get("country") or ["US"])[0] or "US").upper()[:4]
        if not ASIN_RE.match(asin):
            self._send_json(400, {"error": "ASIN 格式不正确"})
            return
        try:
            rows = sif_fetcher.asin_profiles([asin], country)
        except sif_fetcher.SifError as e:
            self._send_json(502, {"error": str(e)[:300]})
            return
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        p = rows[0] if rows else {}
        self._send_json(200, {"profile": {
            "asin": asin,
            "title": p.get("title") or "",
            "img": p.get("img") or "",
            "price": p.get("price"),
            "star": p.get("star"),
            "rating_num": p.get("rating_num"),
            "brand": p.get("brand") or "",
        }})
    GET["/api/rank/asin-profile"] = get_asin_profile

    def delete_rank_targets(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        state.delete_rank_target(tid)
        self._send_json(200, {"ok": True})
    DELETE["/api/rank/targets"] = delete_rank_targets

    def post_rank_run(self):
        """手动抓一次（立即刷新）。有 id 跑该目标，只有 kind+value 则先建再跑。"""
        user = _user(self)
        if not user:
            return
        payload = self._read_json()
        if payload is None:
            return
        tid = str(payload.get("id") or "").strip()
        if tid:
            target = state.get_rank_target(tid)
            if not target:
                self._send_json(404, {"error": "监测目标不存在"})
                return
        else:
            kind = _norm_kind(payload.get("kind"))
            value = str(payload.get("value") or "").strip()
            if not value:
                self._send_json(400, {"error": "id 或 value 至少填一个"})
                return
            tid = state.upsert_rank_target(
                kind, value, country=(payload.get("country") or "US"),
                own_asin=(str(payload.get("ownAsin") or "").strip().upper() or None),
                username=user.get("username"))
            target = state.get_rank_target(tid)
        try:
            result = rank_monitor.run_target(state, target)
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        if result.get("busy"):
            # 429 而不是 502：这是「等一下就能做」，不是失败
            self._send_json(429, {**result, "id": tid,
                                  "error": "已有抓取任务在进行（避免同时烧掉 SIF 额度），请稍候再试"})
            return
        status = 200 if result.get("ok") else 502
        self._send_json(status, {**result, "id": tid})
    POST["/api/rank/run"] = post_rank_run

    # ---- 快照与事件 ----

    def get_rank_snapshot(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "targetId required"})
            return
        snap = state.get_latest_snapshot(tid)
        if not snap:
            self._send_json(404, {"error": "还没有快照，先手动抓一次"})
            return
        target = state.get_rank_target(tid)
        self._send_json(200, {
            "target": target,
            "snapshot": snap,
            "events": state.list_rank_events(tid, 50),
        })
    # ---- 即时查询历史（可删、可导出）----

    def get_rank_queries(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        limit = int((q.get("limit") or ["100"])[0])
        try:
            rows = state.list_rank_queries(limit)
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        self._send_json(200, {"queries": rows})
    GET["/api/rank/queries"] = get_rank_queries

    def get_rank_query_detail(self):
        """取单条查询的完整结果（点历史记录回看）。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        qid = (q.get("id") or [""])[0].strip()
        if not qid:
            self._send_json(400, {"error": "id required"})
            return
        rec = state.get_rank_query(qid)
        if not rec:
            self._send_json(404, {"error": "查询记录不存在"})
            return
        self._send_json(200, {"query": rec})
    GET["/api/rank/query/detail"] = get_rank_query_detail

    def delete_rank_queries(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        qid = (q.get("id") or [""])[0].strip()
        if qid:
            state.delete_rank_query(qid)
        else:
            state.clear_rank_queries()      # 不带 id = 清空全部
        self._send_json(200, {"ok": True})
    DELETE["/api/rank/queries"] = delete_rank_queries

    def get_rank_export(self):
        """导出 Excel：?id=xxx 导单条；?all=1 导全部（最多 200 条）。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        qid = (q.get("id") or [""])[0].strip()
        try:
            if qid:
                rec = state.get_rank_query(qid)
                if not rec:
                    self._send_json(404, {"error": "查询记录不存在"})
                    return
                records = [rec]
                safe = re.sub(r"[^\w\u4e00-\u9fa5]+", "_", str(rec.get("value") or ""))[:30]
                fname = f"rank_{rec.get('kind')}_{safe or 'query'}.xlsx"
            else:
                rows = state.list_rank_queries(200)
                records = [r for r in (state.get_rank_query(x["id"]) for x in rows) if r]
                fname = "rank_queries.xlsx"
            if not records:
                self._send_json(404, {"error": "没有可导出的查询记录"})
                return
            blob = rank_export.export_queries(records)
        except Exception as e:
            _log(f"[rank] 导出失败: {type(e).__name__}: {e}")
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return

        encoded = quote(fname, safe="")
        self.send_response(200)
        self.send_header("Content-Type",
                         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.send_header("Content-Length", str(len(blob)))
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{fname.encode("ascii", "replace").decode("ascii")}"; '
            f"filename*=UTF-8''{encoded}",
        )
        self.end_headers()
        self.wfile.write(blob)
    GET["/api/rank/export"] = get_rank_export

    GET["/api/rank/snapshot"] = get_rank_snapshot

    def get_rank_trend(self):
        """排名趋势：把逐日快照拼成序列。

        SIF 前台有「变体自然位排名趋势」，但 MCP 没开放变体级接口；
        这里用我们自己每天存的快照算，攒几天就有曲线，且不额外消耗配额。
        """
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = ((q.get("targetId") or [""])[0] or "").strip()
        kind = ((q.get("kind") or [""])[0] or "").strip().lower()
        value = ((q.get("value") or [""])[0] or "").strip()
        if not tid and not (kind in ("keyword", "asin") and value):
            self._send_json(400, {"error": "需要 targetId，或 kind + value"})
            return
        asin = ((q.get("asin") or [""])[0] or "").strip().upper() or None
        # 默认条数 = 该目标采集设置里的竞品数（采集多少就画多少）；
        # 上限 15 与 fetch_keyword 的 competitor_n 一致，超了那些线本来就没有数据。
        default_n = 10
        if tid:
            _t = state.get_rank_target(tid)
            if _t:
                try:
                    default_n = max(1, min(15, int(_t.get("competitor_n") or 10)))
                except (TypeError, ValueError):
                    default_n = 10
        try:
            top_n = max(1, min(15, int((q.get("topN") or [str(default_n)])[0])))
        except ValueError:
            top_n = default_n
        try:
            # 有 targetId 用每日快照；否则退回该目标的查询历史（没建监测也能看趋势）
            data = (rank_monitor.build_trend(state, tid, asin, top_n) if tid
                    else rank_monitor.build_trend(state, None, asin, top_n, kind, value))
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        if data.get("error"):
            self._send_json(404, data)
            return
        self._send_json(200, data)
    GET["/api/rank/trend"] = get_rank_trend

    def get_rank_snapshots(self):
        """快照日期列表（趋势图与历史切换用），不带 data。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "targetId required"})
            return
        self._send_json(200, {"snapshots": state.list_rank_snapshots(tid, 60)})
    GET["/api/rank/snapshots"] = get_rank_snapshots

    def get_rank_events(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("targetId") or [""])[0].strip() or None
        limit = int((q.get("limit") or ["100"])[0])
        self._send_json(200, {"events": state.list_rank_events(tid, limit)})
    GET["/api/rank/events"] = get_rank_events

    def post_rank_events_clear(self):
        if not _user(self):
            return
        payload = self._read_json() or {}
        state.clear_rank_events(str(payload.get("targetId") or "").strip() or None)
        self._send_json(200, {"ok": True})
    POST["/api/rank/events/clear"] = post_rank_events_clear

    # ==================================================================
    # 搜索页抓取（爬虫实测榜单）
    # ==================================================================
    # 与上面 SIF 的即时查询/监测完全隔离：数据存 rmon_srps，接口全在 /api/rank/scrape/*。
    # 两条链路各自独立 —— 一边挂了另一边照常，页面上也不做任何交叉对比
    # （采集时刻与口径都不同，摆在一起只会让人纠结该信哪个）。

    def get_scrape_config(self):
        """该关键词自己的抓取页数。没配过就回落全局默认，再回落 3 页。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        keyword = (q.get("keyword") or [""])[0].strip()
        country = (q.get("country") or ["US"])[0].upper()[:4]

        saved = state.get_srp_cfg(keyword, country) if keyword else None
        fallback = state.get_rmon_settings().get("scrape_pages")
        try:
            pages = search_fetcher.clamp_pages(saved if saved is not None else fallback)
        except Exception:
            pages = search_fetcher.DEFAULT_PAGES

        self._send_json(200, {
            "pages": pages,
            "keyword": keyword or None,
            "perKeyword": saved is not None,
            "min": search_fetcher.MIN_PAGES,
            "max": search_fetcher.MAX_PAGES,
            "default": search_fetcher.DEFAULT_PAGES,
            "pageSize": search_fetcher.PAGE_SIZE,
            "hint": (f"每页 {search_fetcher.PAGE_SIZE} 条。1~2 页最快（约 40 秒）；"
                     f"3 页覆盖 144 位（约 1 分钟）；"
                     f"{search_fetcher.MAX_PAGES} 页是上限（240 位）—— "
                     f"再往后基本是无关长尾，而且请求越多越容易被亚马逊限流"),
        })
    GET["/api/rank/scrape/config"] = get_scrape_config

    def post_scrape_config(self):
        """保存页数。带 keyword 就存到这个词名下，不带则更新全局默认。"""
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        pages = search_fetcher.clamp_pages(payload.get("pages"))
        keyword = str(payload.get("keyword") or "").strip()
        country = str(payload.get("country") or "US").upper()[:4]
        if keyword:
            state.set_srp_cfg(keyword, country, pages)
        else:
            state.set_rmon_settings(scrape_pages=pages)
        self._send_json(200, {"ok": True, "pages": pages, "keyword": keyword or None})
    POST["/api/rank/scrape/config"] = post_scrape_config

    def post_scrape_async(self):
        """起后台抓取任务，立即返回 taskId；前端轮询 stage 看抓到第几页。

        必须异步：3 页要 1~2 分钟（页间限速 14~24 秒防封），
        同步请求会一直挂着，浏览器早就超时了。
        """
        user = _user(self)
        if not user:
            return
        payload = self._read_json()
        if payload is None:
            return
        keyword = str(payload.get("keyword") or "").strip()
        country = str(payload.get("country") or "US").upper()[:4]
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        if rank_monitor.scrape_busy():
            self._send_json(429, {"error": "已有抓取任务在进行，等它结束再试",
                                  "code": "scrape_busy"})
            return
        raw_pages = payload.get("pages")
        if raw_pages in (None, ""):
            # 没传就按这个词自己存的页数，再回落全局默认
            cfg = state.get_srp_cfg(keyword, country)
            if cfg is None:
                cfg = state.get_rmon_settings().get("scrape_pages")
            pages = search_fetcher.clamp_pages(cfg)
        else:
            pages = search_fetcher.clamp_pages(raw_pages)
        # 抓取用的页数就是这个词的配置，一并记下来（下次进来还是这个值）
        try:
            state.set_srp_cfg(keyword, country, pages)
        except Exception as e:
            _log(f"[srp] 存页数配置失败: {e}")

        tid = rank_monitor.start_scrape_task(
            state, keyword, country, pages, user.get("username"))
        _log(f"[srp] 开始抓取「{keyword}」{country} {pages} 页 ({tid})")
        self._send_json(200, {"taskId": tid, "keyword": keyword,
                              "country": country, "pages": pages})
    POST["/api/rank/scrape/async"] = post_scrape_async

    def get_scrape_status(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("taskId") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "taskId required"})
            return
        t = rank_monitor.get_scrape_task(tid)
        if not t:
            self._send_json(404, {"error": "任务不存在或已过期（15 分钟）"})
            return
        self._send_json(200, t)
    GET["/api/rank/scrape/status"] = get_scrape_status

    def post_scrape_stop(self):
        if not _user(self):
            return
        payload = self._read_json() or {}
        tid = str(payload.get("taskId") or "").strip()
        ok = rank_monitor.stop_scrape_task(tid) if tid else False
        self._send_json(200, {"ok": ok})
    POST["/api/rank/scrape/stop"] = post_scrape_stop

    def get_scrape_latest(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        keyword = (q.get("keyword") or [""])[0].strip()
        country = (q.get("country") or ["US"])[0].upper()[:4]
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        snap = state.get_rmon_srp_latest(keyword, country)
        self._send_json(200, {"snapshot": snap})
    GET["/api/rank/scrape/latest"] = get_scrape_latest

    def get_scrape_history(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        keyword = (q.get("keyword") or [""])[0].strip() or None
        country = (q.get("country") or [""])[0].upper()[:4] or None
        try:
            limit = max(1, min(200, int((q.get("limit") or ["60"])[0])))
        except ValueError:
            limit = 60
        self._send_json(200, {"history": state.list_rmon_srps(keyword, country, limit)})
    GET["/api/rank/scrape/history"] = get_scrape_history

    def get_scrape_snap(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        sid = (q.get("id") or [""])[0].strip()
        if not sid:
            self._send_json(400, {"error": "id required"})
            return
        snap = state.get_rmon_srp(sid)
        if not snap:
            self._send_json(404, {"error": "记录不存在"})
            return
        self._send_json(200, {"snapshot": snap})
    GET["/api/rank/scrape/snap"] = get_scrape_snap

    def delete_scrape_snap(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        sid = (q.get("id") or [""])[0].strip()
        if not sid:
            self._send_json(400, {"error": "id required"})
            return
        state.delete_rmon_srp(sid)
        self._send_json(200, {"ok": True})
    DELETE["/api/rank/scrape/snap"] = delete_scrape_snap

    def get_scrape_trend(self):
        """位次矩阵（日期 × ASIN），给热力图与趋势折线用。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        keyword = (q.get("keyword") or [""])[0].strip()
        country = (q.get("country") or ["US"])[0].upper()[:4]
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        try:
            limit = max(2, min(120, int((q.get("limit") or ["60"])[0])))
        except ValueError:
            limit = 60
        try:
            data = rank_monitor.build_srp_trend(state, keyword, country, limit)
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        self._send_json(200, data)
    GET["/api/rank/scrape/trend"] = get_scrape_trend

    def get_scrape_events(self):
        """榜单异动：相邻两天对比出的进榜 / 掉榜 / 大涨大跌。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        keyword = (q.get("keyword") or [""])[0].strip()
        country = (q.get("country") or ["US"])[0].upper()[:4]
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        try:
            data = rank_monitor.build_srp_events(state, keyword, country)
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        self._send_json(200, data)
    GET["/api/rank/scrape/events"] = get_scrape_events

    def post_scrape_meta(self):
        """补齐 ASIN 静态属性（上架日期 / 品牌）。

        搜索结果页没有上架时间（详情页才有），所以走 SIF 的批量档案，
        并按 ASIN 永久缓存：命中的不查，只补榜上的新面孔。
        前端打开一条榜单时调一次，只传当前这批 ASIN（上限 60，= 3 次调用）。
        """
        if not _user(self):
            return
        payload = self._read_json()
        if payload is None:
            return
        asins = payload.get("asins") or []
        if not isinstance(asins, list):
            self._send_json(400, {"error": "asins must be a list"})
            return
        country = str(payload.get("country") or "US").upper()[:4]
        keyword = str(payload.get("keyword") or "").strip() or None
        try:
            data = rank_monitor.enrich_asin_meta(state, asins, country, keyword=keyword)
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        self._send_json(200, data)
    POST["/api/rank/scrape/meta"] = post_scrape_meta

    def get_scrape_checks(self):
        """「检查过但没变化」的留痕列表（A/B 两套 source 分开）。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        source = (q.get("source") or ["scrape"])[0]
        if source not in ("scrape", "sif"):
            source = "scrape"
        keyword = (q.get("keyword") or [""])[0].strip()
        country = (q.get("country") or ["US"])[0].upper()[:4]
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        rows = state.list_rmon_checks(source, keyword, country)
        self._send_json(200, {"checks": rows, "count": len(rows)})
    GET["/api/rank/checks"] = get_scrape_checks

    def get_keyword_trend(self):
        """关键词搜索趋势（SIF ABA 周数据，类「产品时光机」的时长序列）。"""
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        keyword = (q.get("keyword") or [""])[0].strip()
        country = (q.get("country") or ["US"])[0].upper()[:4]
        try:
            weeks = int((q.get("weeks") or ["104"])[0])
        except ValueError:
            weeks = 104
        granularity = (q.get("granularity") or ["week"])[0]
        if granularity not in ("week", "month"):
            granularity = "week"
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        try:
            data = rank_monitor.keyword_trend(state, keyword, country, weeks, granularity)
        except Exception as e:
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        self._send_json(200, data)
    GET["/api/rank/keyword-trend"] = get_keyword_trend

    def get_scrape_targets(self):
        """前台实测的定时监测目标（每天自动抓某个词的搜索页）。"""
        if not _user(self):
            return
        self._send_json(200, {"targets": state.list_srp_targets()})
    GET["/api/rank/scrape/targets"] = get_scrape_targets

    def post_scrape_targets(self):
        user = _user(self)
        if not user:
            return
        payload = self._read_json()
        if payload is None:
            return
        keyword = str(payload.get("keyword") or "").strip()
        country = str(payload.get("country") or "US").upper()[:4]
        if not keyword:
            self._send_json(400, {"error": "keyword required"})
            return
        pages = search_fetcher.clamp_pages(payload.get("pages"))
        daily_at = _norm_hhmm(payload.get("dailyAt"))
        if daily_at is False:
            self._send_json(400, {"error": "抓取时间需为 HH:MM"})
            return
        enabled = payload.get("enabled")
        t = state.upsert_srp_target(
            keyword, country, pages, daily_at,
            True if enabled is None else bool(enabled),
            user.get("username"))
        _log(f"[srp] 保存定时目标「{keyword}」{pages} 页 @ {daily_at or '当天首次'}")
        self._send_json(200, {"target": t})
    POST["/api/rank/scrape/targets"] = post_scrape_targets

    def delete_scrape_target(self):
        if not _user(self):
            return
        q = parse_qs(urlparse(self.path).query)
        tid = (q.get("id") or [""])[0].strip()
        if not tid:
            self._send_json(400, {"error": "id required"})
            return
        state.delete_srp_target(tid)
        self._send_json(200, {"ok": True})
    DELETE["/api/rank/scrape/targets"] = delete_scrape_target
