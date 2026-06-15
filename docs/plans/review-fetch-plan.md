# 评论采集集成方案（工具模块：评论采集 / Review Fetch）

> 背景：2026-06-12 讨论"在工具列表新增一个获取亚马逊评论的工具，参考 Shulex 等第三方工具的实现原理"，
> 本文档整理该次讨论的结论并落地为可执行方案。架构与既有"产品采集"（`docs/plans/product-scrape-integration-plan.md`）
> 完全一致：复用 FBA 现有 SQLite / Bearer 鉴权 / 线程池 / 反爬基础设施，新增一个与"关键词排名""产品采集"并列的工具。

---

## 1. 现状与可行性结论

### 1.1 项目里现有的"评论采集"能力

`product_fetcher.py` 已有一部分基础，但远不是完整的评论工具：

- `fetch_reviews_page()`（`product_fetcher.py:899`）请求
  `/product-reviews/{asin}?reviewerType=all_reviews&sortBy=recent&pageNumber=1`——
  **这是亚马逊的公开评论页，匿名（不登录）即可访问**，也是"产品采集"工具"含评论"勾选项的数据来源。
- `parse_reviews_page()`（`product_fetcher.py:929`）目前只解析 3 类**聚合信息**：
  `customers_say`（AI 评论摘要）、`review_images`（评论图，最多10张）、`select_to_learn_more`（买家关注点标签）。
- **没有**单条评论列表（作者/星级/标题/正文/日期/Verified Purchase/有用数）、**没有分页**（只抓第1页）、**没有落库/历史快照**。
- 前端仅在产品详情弹窗里展示上述 3 类聚合信息，没有独立的"评论列表"UI。

结论：现有代码是可复用的"半成品入口"，核心解析（单条评论）和存储需要新写。

### 1.2 不登录获取评论的可行性

`https://{domain}/product-reviews/{ASIN}` 对匿名访客可访问，SSR 静态 HTML 中直接包含评论正文——
**不需要账号**，但有限流/CAPTCHA 风控，未登录用户通常只能翻到前 ~10 页（约100条）。

第三方付费 API（Rainforest API / Axesso / Unwrangle / ScraperAPI Amazon endpoint / Oxylabs 等）本质上
抓的也是这同一个公开页面，靠规模化代理池 + 反爬基础设施把"稳定抓取"这件事包装成 JSON API。

### 1.3 Shulex 等工具的技术原理

核心前提同 1.2——匿名访问 `/product-reviews/{asin}` 不需要登录买家/卖家账号。Shulex 能批量稳定拿到评论，
差距主要在"规模化反爬"：

- 大规模住宅代理 IP 池轮换（每个 ASIN/请求换不同出口 IP）
- 浏览器指纹池（UA、`sec-ch-ua`、TLS 指纹等保持一致性）
- 节流 + 随机延迟模拟真人翻页
- 遇 CAPTCHA/dog page 就换 IP + 换指纹重试
- 增量抓取：按 `sortBy=recent` 翻页，与历史库已有 `review_id` 做 diff，只存新增评论，定时轮询

`product_fetcher.py` 已实现这套机制的"单机小规模版本"（会话池 + 令牌桶 + 指纹池，无代理池），
本方案在此基础上新增"单条评论解析 + 分页 + 增量去重落库"。

### 1.4 现成 skill / 服务

无现成 Claude Code skill 可直接使用；不依赖第三方付费 API，沿用项目自建的反爬基础设施扩展。

---

## 2. 整体架构与数据流

```
前端 ReviewFetch.tsx
  │ 输入：ASIN 列表（多行）+ 站点 + 排序(recent/helpful) + 星级筛选 + 仅Verified + 抓取页数
  │ POST /api/review/run              （提交批量任务，返回每个ASIN的采集摘要）
  │ GET  /api/review/tasks            （历史任务列表）
  │ GET  /api/review/results?taskId=  （任务关联ASIN的全部评论，已去重）
  │ DELETE /api/review/tasks?id       （删除任务记录，不级联删评论池）
  ▼
server.py（复用 Bearer 鉴权 + ThreadingMixIn）
  │ run_review_task(state, asins, marketplace, sort_by, filter_star, verified_only, max_pages)
  ▼
product_fetcher.py（在现有反爬基础设施上扩展）
  │ fetch_review_list(asin, marketplace, max_pages, sort_by, filter_by_star, verified_only)
  │   循环 pageNumber=1..max_pages，复用 session/headers/rate_limit/CAPTCHA检测
  │   遇空列表/CAPTCHA/连续两页内容相同提前停止
  │ parse_review_list(html_text) → 单条评论 dict 列表
  ▼
SQLite（复用 fba 主库）：review_tasks + review_results 两张新表
```

设计要点：
- **同步返回 + 落库**：与"产品采集"`/api/scrape/run`一致，前端按批次调用展示进度，多批次合并进同一 `taskId`。
- **`review_results` 是跨任务共享的"评论池"**：`UNIQUE(asin, review_id)`，同一条评论无论在哪次任务里抓到都只存一份，
  实现"增量抓取"——重复运行同一 ASIN 只会写入新增评论。
- **删除任务只删 `review_tasks` 记录**，不级联删除 `review_results`（评论池跨任务共享，避免误删其他任务依赖的数据）。

---

## 3. 数据库表设计

紧挨现有 `scrape_tasks` / `scrape_products` 之后追加：

```sql
-- 一次"评论采集"提交 = 一个任务（记录本次的筛选条件 + 涉及的ASIN列表）
CREATE TABLE IF NOT EXISTS review_tasks (
    id            TEXT PRIMARY KEY,
    marketplace   TEXT NOT NULL,
    asins         TEXT DEFAULT '[]',     -- JSON array
    sort_by       TEXT DEFAULT 'recent', -- recent / helpful
    filter_star   TEXT,                  -- '1'..'5' 或 NULL（不筛选）
    verified_only INTEGER DEFAULT 0,
    max_pages     INTEGER DEFAULT 3,
    total         INTEGER DEFAULT 0,     -- 本次涉及的 ASIN 数
    new_count     INTEGER DEFAULT 0,     -- 本次新增评论数（增量）
    status        TEXT DEFAULT 'completed',
    created_at    TEXT
);

-- 评论池：跨任务共享，按 (asin, review_id) 去重
CREATE TABLE IF NOT EXISTS review_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,         -- 首次采集到该评论的任务 id
    asin          TEXT NOT NULL,
    marketplace   TEXT,
    review_id     TEXT NOT NULL,
    rating        REAL,
    title         TEXT,
    author        TEXT,
    date_raw      TEXT,
    verified      INTEGER DEFAULT 0,
    body          TEXT,
    helpful_count INTEGER,
    images        TEXT DEFAULT '[]',     -- JSON array
    fetched_at    TEXT,
    UNIQUE(asin, review_id)
);
CREATE INDEX IF NOT EXISTS idx_review_res_asin ON review_results(asin);
```

`get_review_results(task_id)` 查询逻辑：先读 `review_tasks.asins`，再
`SELECT * FROM review_results WHERE asin IN (...) ORDER BY asin, fetched_at DESC`——
返回这些 ASIN 累计采集到的**全部**评论（不仅是本次新增），符合"查看某ASIN已收集的评论"的直觉。

---

## 4. 后端 `product_fetcher.py` 新增内容

| 函数 | 说明 |
|---|---|
| `parse_review_list(html_text)` | 解析评论列表页里每个 `[data-hook="review"]` 容器，提取单条评论：`review_id`（容器 `id` 属性）、`rating`（`[data-hook="review-star-rating"]` 正则提取 "X.x out of 5"）、`title`、`author`（`.a-profile-name`）、`date_raw`（`[data-hook="review-date"]`）、`verified`（是否存在 `[data-hook="avp-badge"]`）、`body`（`[data-hook="review-body"]`）、`helpful_count`（解析 "X people found this helpful" / "One person..."）、`images`（评论配图，最多5张） |
| `fetch_review_list(asin, marketplace, max_pages, sort_by, filter_by_star, verified_only)` | 分页抓取（`pageNumber=1..max_pages`），复用 `get_session`/`warm_up_session`/`build_headers`/`acquire_rate_limit`/`is_captcha_page`/`is_dog_page`；遇空列表、CAPTCHA、或连续两页内容相同即提前停止；按 `(review_id 或 author+date+body)` 在本次抓取范围内去重 |
| `fetch_reviews_for_asins(asins, marketplace, max_pages, sort_by, filter_by_star, verified_only, on_progress)` | 批量入口，`ThreadPoolExecutor`（复用 `SCRAPER_CONCURRENCY`）逐 ASIN 抓取，返回 `[{asin, marketplace, reviews, status, error_message}, ...]` |

不复用 `fetch_reviews_page`/`parse_reviews_page`（聚合信息，供"产品采集"使用），新函数职责单一（单条评论列表）。

---

## 5. `server.py` 改动点

| 位置 | 改动 |
|---|---|
| `_init_db` | 追加 `review_tasks` / `review_results` 两张表（第3节 DDL） |
| `DbState` 方法区（紧邻 scrape 系列方法） | 新增 `create_review_task` / `accumulate_review_task` / `list_review_tasks` / `get_review_task` / `save_review_results`（`INSERT OR IGNORE` 去重，返回新增数）/ `get_review_results` / `delete_review_task` |
| 模块级函数（`run_scrape_task` 旁） | 新增 `run_review_task(state, asins, marketplace, sort_by, filter_star, verified_only, max_pages, task_id=None)` |
| `do_GET` | 加 `GET /api/review/tasks`、`GET /api/review/results?taskId=`（均校验 Bearer） |
| `do_POST` | 加 `POST /api/review/run`（参数校验：`asins` 非空数组、`marketplace` 合法、`sortBy∈{recent,helpful}`、`filterStar∈{1..5,null}`、`maxPages` 取值范围 1~10，默认 3） |
| `do_DELETE` | 加 `DELETE /api/review/tasks?id=`（只删 `review_tasks` 记录） |

鉴权、`_send_json`、`_read_json`、`_extract_token` 全部复用。

---

## 6. 前端改动点

| 文件 | 改动 |
|---|---|
| `src/features/tools/ReviewFetch.tsx` | **新建**：参照 `ProductScrape.tsx` 模式。左侧：站点下拉、ASIN多行输入、排序(最新/最有用)、星级筛选(全部/1~5星)、仅看Verified Purchase、抓取页数(1~10，默认3)、开始采集/清空、进度条、历史任务列表。右侧：扁平评论结果表格（ASIN/图片/评分/标题+正文/作者/日期/Verified/有用数/查看），分页 + CSV 导出，图片悬浮放大复用 `.ps-thumb`/`.ps-thumb-preview` 样式 |
| `src/app.tsx` | import `ReviewFetch`；`view === 'reviewFetch'` 渲染；Tweaks 下拉新增选项 |
| `src/features/sidebar/Sidebar.tsx` | 工具区新增入口 `{ k: 'reviewFetch', ic: '💬', label: '评论采集' }`；`TopBar` 标题映射加 `reviewFetch: '评论采集'` |
| `styles.css` | 新增 `rf-*` 分区，参照 `ps-*`/`kr-*` 风格，复用变量与 `.ps-thumb`/`.ps-thumb-preview` |

前端调用 `/api/review/run` 后只拿到"每ASIN采集摘要"（`{asin, status, totalFetched, newCount, errorMessage}`），
全部批次完成后再调用一次 `/api/review/results?taskId=` 拉取该任务关联 ASIN 的完整评论列表用于展示。

---

## 7. 风控注意事项

- 单 ASIN 多页 = 请求量倍增，`maxPages` 默认 **3**（约30条/ASIN），前端可调但后端硬性上限 **10**。
- 复用"产品采集"已有的"刷新会话"按钮逻辑（`/api/scrape/reset-session`，按 marketplace 重置 session）。
- 遇 CAPTCHA 立即终止当前 ASIN 的剩余页面抓取并标记 `status=failed`，不影响其他 ASIN。

---

## 8. 分阶段实施计划

- **阶段 1（后端核心）**：`parse_review_list` + `fetch_review_list` + `fetch_reviews_for_asins`；
  `review_tasks`/`review_results` 建表 + DbState 方法；`run_review_task` + 4 个路由。
  用真实 ASIN 验证：能拿到结构化单条评论、去重生效（重复运行 newCount=0）。
- **阶段 2（前端）**：`ReviewFetch.tsx`（输入/筛选/结果表/历史任务/分页/CSV导出）+ 路由接入（Sidebar/app.tsx/styles.css）。
- **阶段 3（验证）**：`npx tsc --noEmit` + `npm run build`；后端按用户要求以代码审查方式验证（鉴权/参数校验/SQL参数化/去重逻辑/错误处理与现有模式一致），不依赖截图验证渲染。

---

## 9. 已知限制 / 不做的事

- `review_id` 取自评论容器的 `id` 属性；极少数情况下该属性缺失时，去重退化为本次抓取范围内按
  `(author, date_raw, body)` 去重，**不写入 `review_results`**（避免破坏 `UNIQUE(asin, review_id)` 约束）——
  这部分评论不会被持久化，是已知的小范围限制。
- 不做评论情感分析/标签聚类（如需可在 VOC 模块二期基于 `review_results` 数据做）。
- 不引入代理池/付费 SERP API；仍是"本机直连 + 反爬基础设施"的小规模方案，吞吐量低于 Shulex 等商业工具。
- 不做"评论图片打包下载"（与产品采集的图片下载是同一类二期需求，未来可统一做）。
