# SIF 关键词监测模块深度文档

> 代码位置：`backend/sif_fetcher.py`（抓取器）/ `backend/routes/sif_keywords.py`（路由+调度器）/
> `src/features/tools/SifKeyword.tsx`（前端视图）/ 数据表 `sif_tasks` + `sif_snapshots`（`backend/db.py`）
>
> 模块定位与业务说明见 `docs/business-overview.md` 第 3.5 节；本项目技术架构见根目录 `CLAUDE.md`。

## 1. 模块职责

SIF 关键词监测是一个"数据直连型"工具模块：通过 HTTP JSON-RPC 直连 SIF 的 MCP 端点
（`https://mcp.sif.com/mcp`，Streamable HTTP 传输），按**每日定时**或**手动触发**批量抓取
关键词数据（机会词 / 需求画像 / 历史趋势），落库后在 FBA2 前端表格与趋势图展示。

与 AI 分析模块的关键区别：**本模块不经过 Claude Code / LLM**。SIF 返回的是预生成的结构化
JSON（含供 LLM 展示的 `_formatted` 块，程序忽略即可），抓取链路完全确定、可无人值守。

## 2. 数据模型

### 2.1 `sif_tasks`（任务表）

| 列 | 说明 |
|---|---|
| `id` | `sif` + 12 位 hex |
| `name` / `direction` | 任务名 / 方向标签（cooling/heating/gift/custom，前端预设的三大方向） |
| `mode` | `root`=按词根发现机会词；`keywords`=直接用指定关键词 |
| `roots` / `keywords` | JSON 数组（mode=root 用 roots，mode=keywords 用 keywords） |
| `country` | 站点（默认 US） |
| `top_n` | 每个词根取机会词数量（默认 8） |
| `quota_limit` | 本次最多画像词数（默认 30，防配额失控） |
| `schedule_time` | 每日定时时刻 `HH:MM`；为空 = 仅手动触发 |
| `enabled` | 是否启用定时 |
| `last_run_at` / `last_status` / `last_error` | 最近运行时间 / `idle|running|done|error` / 错误信息 |

### 2.2 `sif_snapshots`（快照表，每次运行一批）

按 `UNIQUE(task_id, run_date, keyword)` 去重——同一任务同一天重复运行会覆盖当天同词记录。

| 列 | 说明 |
|---|---|
| `run_date` / `captured_at` | 运行日期（YYYY-MM-DD）/ 精确时间 |
| `keyword` | 关键词 |
| `search_volume` / `rank` / `cpc` | 月搜索量 / ABA 排名（来自历史趋势最新点）/ CPC |
| `entry_signal` | SIF 预生成的入场信号文案（screen 的 `entry_signal` 或 demand 的 `diagnosis`） |
| `demand` | 需求画像 JSON（demand_type/ad_hint/trend_direction/yoy/peak_month/weeks_to_peak/season_position...） |
| `detail` | 扩展 JSON（screen 的点击份额/CVR/竞品 ASIN + history 的最近 60 周 dates/volumes/ranks） |

## 3. 执行链路

```
定时调度线程（每 60s 扫描，复用 rank.py 的模式）
  └─ 命中：enabled + scheduleTime 已到 + 今天未跑 → _launch() 起后台线程
     （手动 POST /api/sif/run 走同一条 _launch()，_running 集合去重）
        └─ sif_fetcher.execute_and_save(state, task)
            ├─ ① 发现：mode=root → 逐词根 screen_opportunities(root, topN)
            │         （词根间 MIN_INTERVAL=0.3s 节流；每个词根一次 SIF 调用）
            ├─ ② 合并去重 → 按搜索量降序 → 截断到 quota_limit
            ├─ ③ 画像：keyword_demand 分批（每批 ≤10 词）→ demand_map
            ├─ ④ 趋势：搜索量前 5 词 → keyword_history(weekly) → series
            ├─ ⑤ 组装 items → state.save_sif_snapshots(按 run_date+keyword 覆盖)
            └─ ⑥ 回写 last_status=done/error + last_run_at
```

每次运行的 SIF 调用量估算：`词根数 × 1（screen） + ⌈候选词数/10⌉（demand） + 1（history）`，
候选词数 ≤ quota_limit。**SIF 是付费服务，调小 topN/quotaLimit 是控制成本的主要手段。**

## 4. API

| 方法/路径 | 说明 |
|---|---|
| GET `/api/sif/tasks` | 任务列表 |
| POST `/api/sif/tasks` | 创建（校验 mode/roots/keywords 必填） |
| PUT `/api/sif/tasks` | 更新（运行中任务拒绝修改） |
| DELETE `/api/sif/tasks?id=` | 删除任务 + 连带清空快照 |
| POST `/api/sif/run` | `{id}` 立即运行（后台线程，不阻塞 HTTP） |
| GET `/api/sif/snapshots?taskId=&date=` | 快照；缺省 date 只返回最近一次运行 |
| GET `/api/sif/runs?taskId=` | 历史运行日期列表 |
| POST `/api/sif/preview` | `{root,country,topN}` 试查词根（不落库，前端表单"试查"用） |
| GET `/api/sif/history?keywords=&country=` | 按需查历史趋势（≤5 词，详情弹窗趋势图用） |

全部路由需登录（`auth.verify`），无 root 专属限制（与关键词排名等工具一致）。

## 5. SIF 工具实测记录（P0）

| 工具 | 状态 | 关键字段 | 备注 |
|---|---|---|---|
| `market_screen_keyword_opportunities` | ✅ 已接入 | keyword/search_volume/click_share_top3/cvr/cpc/entry_signal/top3_click_asins | 词根发现核心 |
| `market_get_keyword_demand` | ✅ 已接入 | demand_structure/trend/seasonality/peak_month/weeks_to_peak/timing_summary | 批量画像核心 |
| `market_get_keyword_history` | ✅ 已接入 | dates/volumes/ranks/top3_click_shares | 6 年周度；granularity 传 weekly |
| `market_get_asin_aba_footprint` | ✅ 实测通过 | rank_distribution/keywords[{keyword,search_volume,rank}] | ASIN 维度，P2 候选 |
| `market_get_asin_keyword_signals` | ✅ 实测通过 | summary/top_keywords[{keyword,traffic_share,organic_rank,sp_rank}] | 时间格式：`time_type=month` + `time_value=YYYY-MM`；P2 候选 |
| `market_get_keyword_competition` | ✅ 实测通过 | top_competitors(100)/market_structure/strategy_path | 返回重，仅点查 |
| `market_get_keyword_root_trend` | ✅ 实测通过 | keyword_search_volumes/keyword_ranks(103周) | 词根级趋势 |
| `sif_catalog` | ✅ 实测通过 | 6 大类工具目录 | 导航用 |

数据新鲜度：所有工具 `data_notice` 统一返回 `"refreshes daily, 1-day delay"` —— 数据每日刷新。

已知格式坑：`time_type=week` 配 `time_value=2026-W34` 会报 `INVALID_REQUEST 时间格式错误`；
统一用 `month` + `YYYY-MM`（如 `2026-08`）。

## 6. 已知问题与优化方向

- **配额计费未确认**：SIF 单次 `tools/call` 的计费口径未向官方确认。若长期运行发现成本问题，
  优先动作：调小 topN/quotaLimit、降低任务频率、把 history 补全改为仅对"重点词"点查。
- **week/day 时间粒度**：`granularity=daily` 实测仍返回周序列（历史趋势是周级的，但数据每日刷新）。
  若业务需要日粒度趋势，需向 SIF 确认是否有近期日粒度数据接口。
- **ASIN 维度未接入**：`market_get_asin_aba_footprint` / `market_get_asin_keyword_signals` 已实测
  可用（按 ASIN 看 ABA 卡位词与流量信号），但需要产品关联 ASIN——`products` 表目前没有 asin 字段，
  P2 可给产品补 asin 字段或做成独立的手填 ASIN 任务。
- **无并发上限**：多个任务同时到点会各自起线程（每任务独立，`_running` 只防同任务重复）。
  任务数不多时没问题；若未来任务很多，可加全局并发信号量。
- **历史快照无清理**：`sif_snapshots` 按天累积，长期运行会增长。可在任务删除时清理（已做），
  如需自动归档/清理可按 run_date 加保留策略。
- **竞品工具较重**：`market_get_keyword_competition` 一次返回 100 个竞品，未纳入定时链路，
  只建议 P2 做成"点查"（选中关键词 → 查看竞争格局）。
