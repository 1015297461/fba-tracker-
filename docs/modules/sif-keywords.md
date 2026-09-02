# SIF 爆品关键词监控 模块深度文档（v2）

> 代码位置：`backend/sif_fetcher.py`（工具封装 + 分层抓取）/ `backend/sif_signals.py`（信号引擎）/
> `backend/routes/sif_keywords.py`（调度器 + 编排 + 路由）/ `src/features/tools/SifKeyword.tsx`（前端）/
> 数据表 `sif_tasks`、`sif_kw_snapshots`、`sif_asins`、`sif_asin_snapshots`、`sif_kw_profiles`、
> `sif_asin_weekly`、`sif_signals`、`sif_runs`、`sif_settings`（均在 `backend/db.py`）
>
> 模块定位见 `docs/business-overview.md` 第 3.5 节；技术架构见根目录 `CLAUDE.md`。
> **v1 → v2 是彻底重写**：旧的单表快照架构与历史数据已按用户确认全部废弃（见第 8 节）。

## 1. 模块职责与三条设计前提

面向亚马逊选品的「**爆品 + 关键词**」双线日度监控：直连 SIF MCP 端点抓结构化数据（不经过 LLM），
每日落库形成时间序列，用本地规则引擎产出「值得看一眼」的信号，重接口只在手动点查时调用。

三条设计前提都是实测结论，改动前别按直觉推翻：

1. **SIF 的关键词历史只有周/月粒度**——`market_get_keyword_history` 传 `granularity=daily` 仍返回周序列，
   因为底层是 ABA（Amazon Brand Analytics）官方口径。所以**关键词侧的"日维度"是本模块每日快照累积出来的**，
   含义是"SIF 每日刷新的估算值逐日变化"，不是官方日搜索量。前端已标注该口径。
2. **唯一的真日粒度接口是 `ops_get_asin_traffic_trend(granularity=day)`**——逐日 BSR、成交价/购物车价、
   评论数、评分、卖家数、近30天销量、总/自然/广告/SP/SB/SBV 流量分数、促销与优惠券标记。**爆品线的日维度靠它。**
3. **SIF 数据每日刷新但有 T+1~T+2 延迟、且零星缺日**——实测出现过某天 price/BSR/月销全空而流量分数有值。
   因此看板取"该 ASIN 最近一个有值的点"（返回 `statDate`），信号引擎也按**数据日**而非运行日判断。

## 2. 数据模型

### 2.1 `sif_tasks`（任务）

| 列 | 说明 |
|---|---|
| `id` | `sif` + 12 位 hex |
| `name` / `direction` | 任务名 / 方向标签（cooling·heating·gift·car·custom，前端预设一键填词根） |
| `mode` | `root`=按词根发现机会词；`keywords`=固定词清单（只刷快照，不发现新词） |
| `roots` / `keywords` / `asins` | JSON 数组；`asins` 为手填 ASIN，创建/更新时直接入池 |
| `country` | 站点（默认 US） |
| `top_n` | 每词根取机会词数量 |
| `quota_limit` | 每日快照最多记录多少词（按搜索量降序截断） |
| `asin_limit` | **ASIN 监控池上限**——成本主阀门，每日调用数≈池内 ASIN 数 |
| `backfill_days` | 新入池 ASIN 首次回补天数（默认 90） |
| `auto_asin` | 是否允许自动入池（机会词 Top3 点击 ASIN + 词根头部竞品） |
| `freq_type` | `daily` / `every_n` / `weekly` 三档 |
| `every_n_days` / `schedule_weekday` | 分别是 `every_n` 的天数、`weekly` 的周几（ISO 1=周一..7=周日） |
| `schedule_time` | 触发时刻 `HH:MM`（服务器本地时区 Asia/Shanghai）；为空=只手动 |
| `enabled` | 定时开关 |
| `last_run_at` / `last_daily_at` / `last_weekly_at` | 最近整体运行 / 每日层最近日期 / 每周层最近日期（分层判定靠后两个） |
| `last_status` / `last_error` | `idle·running·done·partial·error` / 错误摘要（`partial`=有调用失败但未全崩） |
| `fail_count` / `fail_date` / `next_retry_at` | 失败重试计数 / 计数所属日期 / 下次重试时刻——退避闸门用（见 6.9） |

### 2.2 `sif_kw_snapshots`（关键词每日快照）

`UNIQUE(task_id, run_date, keyword)`，**只存当日一个数据点**（v1 把 60 周历史塞 detail 的做法已废弃）。
列：`search_volume·rank·cpc·cvr·click_share·traffic_cost·entry_signal·top_asins(JSON)·root·data_period·is_new_entry`。

- `rank`/`click_share` **不由 screen 接口返回**，由每周层 `keyword_history` 回填（`update_kw_rank()`），
  所以首次抓取当天这两列为空、跑过每周层后才有值；同日重跑不会把它们冲掉（见 6.3）。
- `is_new_entry`：该词此前未在本任务出现过则标 1，同日重跑保留原值。

### 2.3 `sif_asins`（监控池）+ `sif_asin_snapshots`（真日粒度）

池表存静态画像（由 `market_get_asin_profile` 回填：标题/品牌/主图/价格/评分/评论数/类目/重量/包装尺寸/
**首次上架日期**/变体数）+ `source`（`opportunity`·`competitor`·`manual`）+ `source_ref`（来自哪个词或词根、
覆盖搜索量、ABA 首选词数）+ `last_stat_date`（增量拉取水位）。

日表 `UNIQUE(task_id, asin, stat_date)`：`price·bsr·bought_month·review_num·star·seller_num·
total_score·nf_score·ad_score·sp_score·sb_score·sbv_score·promotion·coupon`。

### 2.4 每周层产物

- `sif_kw_profiles`：`UNIQUE(task_id, keyword, iso_week)`，存 `market_get_keyword_demand` 画像
  （需求类型/广告建议/趋势方向/同比/旺季月/距旺季周数/季节位置/诊断文案）。
- `sif_asin_weekly`：`UNIQUE(task_id, root, iso_week)`，存词根头部竞品概览。

### 2.5 `sif_signals` / `sif_runs` / `sif_settings`

- 信号：`UNIQUE(date, task_id, kind, ref_type, ref_id)` **幂等**——同一天同一对象同一类只有一条。
  关键词信号 date 用运行日，ASIN 信号 date 用**数据日**（否则延迟会导致永不触发或天天重复）。`ack` 支持"已处理"。
- 运行日志：每次运行按层各写一行（`tier=daily|weekly`），`stats` 记 `calls`（实际 SIF 调用数）、`discovered`、
  `asin_monitored/asin_new`、`asin_points_saved`、`signals`、`error_detail[]`——成本可审计。
- 设置：`sif_settings(key,value)` 两行，`thresholds`（信号阈值）与 `defaults`（默认配额）；
  读取时用类常量 `SIF_DEFAULT_SETTINGS` 兜底，未知键忽略（防前端乱传）。

## 3. 执行链路

```
调度线程（每分钟扫描，start_scheduler）
  └─ _freq_hit(task)：enabled + 已过 schedule_time + 本档频率该跑 + 当天未跑 + 退避/熔断闸门
       daily   → 今天没跑过即可
       every_n → 距 last_daily_at ≥ N 天
       weekly  → 今天周几 == schedule_weekday
      退避闸门（早于频率判定）：next_retry_at 未到期 / 当天失败达上限已熔断 → 直接跳过
     命中 → _launch() 后台线程（_running 集合去重；手动 POST /api/sif/run 走同一入口）
        └─ execute_task(state, task)
            ├─ weekly_due = 距 last_weekly_at ≥ 7 天
            ├─ 【每日层】run_daily_layer
            │    ① root 模式：逐词根 screen_opportunities(topN) → 合并去重 → 按搜索量截断 quotaLimit
            │       keywords 模式：直接用固定词清单
            │    ② 写 sif_kw_snapshots（当日点，carry-forward 保留 rank/click_share）
            │    ③ 池内每只 ASIN：ops_get_asin_traffic_trend(day, lastDays=增量窗口) → sif_asin_snapshots
            │       窗口 = 首次入池 backfill_days；之后 = max(3, 距 last_stat_date 天数 + 2)
            ├─ 自动入池：机会词 top_asins（受 asin_limit 约束）→ asin_profile 补画像 → 回补日线
            ├─ 写 daily 运行日志（必须在入池回补之后写，调用数才完整）
            ├─ 【每周层】run_weekly_layer（weekly_due 时）
            │    ① keyword_demand(10/批) → sif_kw_profiles
            │    ② keyword_history(10/批) → update_kw_rank() 回填 ABA 排名/点击集中度
            │    ③ root_competitors(词根) → sif_asin_weekly + 新竞品入池
            │    └─ 写 weekly 运行日志
            ├─ 过期清理：prune_kw_snapshots(task, today - defaults.keepDays)（关键词快照 + ASIN 日数据）
            └─ 信号引擎 sif_signals.run_engine()（纯本地，0 配额）→ sif_signals；条数并回 daily 日志
```

**实测调用数**：1 词根 / 3 词 / 池 3 只，含每周层的首次运行 = **8 次**（daily 5 + weekly 3）；
同日第二次运行 = **4 次**（weekly 跳过、ASIN 只拉 4 天增量）。任务表单会预估并展示。

## 4. API

清单见 `CLAUDE.md` 路由表。要点：

- 看板 `GET /api/sif/board` 一次性返回组装好的 `keywords[]`（含 `dod`/`wow`/`spark`/`profile`）与
  `asins[]`（含 `bsrChg`/`priceChg`/`salesWow`/`nfShare`/`onSaleDays`/`statDate`），前端不逐行请求。
- 点查统一 `POST /api/sif/inspect {type,...}`，`_do_inspect()` 分派 12 种 type；缺参 400、SIF 报错 502；
  **不进任何定时链路**。
- 全部路由需登录（`auth.verify`），与其他工具一致，无 root 限制。

## 5. 已接入的 SIF 工具（实测记录）

| 工具 | 用途 | 粒度 / 限制 |
|---|---|---|
| `market_screen_keyword_opportunities` | 机会词发现（entry_signal、Top3 点击 ASIN） | 词根级，月度 ABA 口径 |
| `market_get_keyword_demand` | 需求画像 | **单次最多 10 词**（实测 30 词只回 10） |
| `market_get_keyword_history` | 周度趋势 + ABA 排名回填 | **仅 week/month，无日粒度** |
| `market_get_keyword_root_trend` | 词根盘子 vs 精确词、长尾占比 | 点查 |
| `market_get_keyword_root_competitors` | 词根头部竞品（覆盖搜索量/ABA 首选词数） | 点查 + 每周层入池 |
| `market_get_keyword_competition` | 单词竞争格局 | 重，仅点查，响应裁到 20 竞品 |
| `market_discover_competitors` | Top100 四维格局（价格带/评论门槛/真实销量/竞争姿态） | 点查，最近 7 天 SERP 快照 |
| `market_assess_keyword_promotion` | 该不该打广告（出价区间/盈亏平衡） | 点查，≤20 词 |
| `market_estimate_profit_threshold` | 采购成本上限反推 | 点查，本地费率计算 |
| `market_get_asin_profile` | ASIN 静态属性（含上架日期、包装尺寸重量） | ≤20 个/批 |
| `ops_get_asin_traffic_trend` ⭐ | **真日粒度** BSR/价格/销量/评论/流量分数/促销 | granularity=day + lastDays，T+1~T+2 |
| `ops_get_asin_sales_list` | 近 N 天销量（可按 color/size 维度） | 点查 |
| `market_get_asin_keyword_signals` | ASIN 的流失词/增长词/排名断档 | 点查，`time_type=lately` + `time_value='7'|'30'` |
| `ops_get_listing_keyword_distribution` | Listing 各变体词量（自然/SP/SB/SBV） | 点查 |

通用坑：响应里 ASIN 常是 markdown 链接 `[B0XXX](url)` → `_clean()` 剥壳；数字混 `'1,234'/'45%'/'$3.2'` → `_num()` 解析；
`_formatted`/`_next_step` 是给 LLM 看的展示块，封装层裁掉。`week` 类时间参数必须传该周**周日**日期，当周因 T+1 不可用。

## 6. 可靠性要点（改这个模块前先看）

1. **0.3s 节流 + 严格分批**：`_Throttle` 保证串行间隔，批量接口按 10/20 上限分批，避免撞限流。
2. **失败不中断**：单词根/单 ASIN 失败只计入 `errors` 与 `error_detail`，任务转 `partial`，其余数据照常入库。
3. **carry-forward**：`save_kw_snapshots()` 同日重跑先读回旧行，把新数据缺失的 `rank/click_share/cpc/cvr/
   traffic_cost/entry_signal/top_asins/is_new_entry/captured_at` 带过来——否则每周层回填的排名会被下一次每日运行冲成 NULL。
4. **ASIN 幂等入库**：日数据按 `UNIQUE(task_id, asin, stat_date)` 覆盖，滚动窗口重叠回补不产生重复行。
5. **信号按数据日 + 滞后上限 3 天**：既避免"ASIN 信号永不触发"，也避免同一份延迟数据天天重报。
6. **无全局并发上限**：多任务同时到点各自起线程（仅同任务去重）。任务多时再加全局信号量。
7. **删除即清干净**：`delete_sif_task()` 连带清 7 张子表；`pool/remove` 清该 ASIN 日线；`keepDays` 控快照保留期。
8. **崩溃恢复**：服务启动把残留 `running` 的任务记一次失败（走退避逻辑，非无脑标 error），随后按退避节奏收敛。
9. **失败退避 + 熔断（防无限重试）**：单次运行抛硬异常不再每分钟重烧配额——`_note_failure()` 记 `fail_count`
   并按 5m→30m→2h 指数退避写 `next_retry_at`，`_freq_hit` 早于频率判定做闸门拦截；当天第 4 次失败熔断到次日
   计划时刻，成功一次清零，手动「启用」也清零。`SifError.fatal`（密钥未配 / HTTP 401·403 / 工具不存在）由
   `_disable_task()` 直接停用任务，一次都不重试。任务卡片展示「第 n 次失败，HH:MM 重试」或「已熔断，明日自动恢复」。

## 7. 前端（`SifKeyword.tsx`）

左栏任务卡（方向图标 / 频率 / 池上限 / 最近运行日 / 启停 / 立即抓取 / 编辑 / 删除），右侧六页签：

- **监控看板**：4 张统计卡 + 近 14 天异动榜（同对象命中多种信号排前）+ 关键词榜与爆品榜双表 + 最新信号流。
- **关键词**：当日全表（搜索量/日环比/7日环比/近 7 日 spark/ABA 排名/CPC/CVR/点击集中度/趋势·旺季/入场信号），
  可切排序、导出 CSV；点行进详情——自建日序列图 + ABA 排名图（负轴，越靠上越好）+ 可叠加 SIF 周度历史（1 次点查）
  + 画像摘要 + 5 个点查入口。
- **爆品池**：全表（月销/7日增速/BSR/价格及变动/评论/自然流量占比/上架天数/已入库天数），手动加 ASIN
  （立即回补并产信号）、停用、删除；点行进详情——月销/BSR/价格/流量结构/评论五张日线图 + 4 个点查入口。
- **信号中心**：按严重度与类别筛选、展开 detail 数值、"已处理"标记，每条直接挂下一步点查按钮
  （关键词→竞争格局/该打广告吗/词根规模；ASIN→它靠哪些词/算采购上限/看日趋势）。
- **运行记录**：分层展示每次实际调用数与统计（成本审计入口）。
- **设置**：`thresholds` 12 个信号阈值 + `defaults` 6 个默认配额，每项带口径说明，保存后下次抓取/算信号即生效。

图表全部手写 SVG（与项目其他模块一致，不引第三方库）：`LineChart` 支持多系列、缺点断线、
`negative` 负轴（排名/BSR 用，tooltip 显示绝对值）、悬停十字线 + tooltip；表内用 `Spark` 迷你折线。

## 8. v1 → v2 迁移

`_init_db()` 检测 `sif_tasks` 是否缺 `freq_type` 列：缺则判为 v1，DROP `sif_snapshots` + `sif_tasks`（含旧索引）
并按 v2 重建，打印迁移日志。**旧任务与全部历史快照被清空**（已与用户确认旧架构与数据都可丢弃）。
线上库副本实测：2 个旧任务 + 240 行快照清空，14 个产品与 1 个排名任务不受影响。

## 9. 已知边界与后续方向

- **成本**：SIF 单次 `tools/call` 的计费口径仍未向官方确认。现靠 `asin_limit` / `topN` / 频率三档 + 分层设计控制；
  若成本偏高，先降 `asin_limit`（每日调用数≈池内 ASIN 数），再把频率拉长到"每 N 天"。
- **关键词日粒度本质**：是自建快照序列。若跑几天后发现 SIF 侧数值实际按周更（日环比长期为 0），
  就把关键词信号基线改成周环比——看 `spark` 是否真有日间变化即可判断。
- **`asin_limit` 与手动入池**：自动入池受限，手动添加可超（用户明确意图优先），UI 已注明。
- **数据缺口滞后**：某日 price/BSR 全空时看板回退到最近有值日，ASIN 信号也随之按该日计算，可能滞后 1~2 天。
- **待接入**：广告域（`ads_get_asin_ad_structure` 等）与 `market_get_asin_aba_footprint`（更轻的卡位查询）
  已在探测清单但未进 UI；与"关键词排名"模块的 ASIN 双视角打通也值得做。
