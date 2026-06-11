# 产品详情采集集成方案（路径 B：Python + BeautifulSoup）

> 目标：将 `mine/amazon-scraper` 的产品详情爬虫，作为「工具」模块下的新工具
> "产品采集"集成进 FBA Tracker，与现有"关键词排名"并列。
> 技术路线：把 `server/scraper.ts`（axios + cheerio）移植为 Python（urllib + BeautifulSoup），
> 复用 FBA 现有的 SQLite、Bearer 鉴权、线程池。**不搬** MySQL/Drizzle/tRPC/Radix。

---

## 1. 整体架构与数据流

```
前端 ProductScrape.tsx
  │ 输入：ASIN 列表（多行）+ 站点 + 是否抓评论
  │ POST /api/scrape/run            （提交批量任务，实时返回结果）
  │ GET  /api/scrape/tasks          （历史任务列表）
  │ GET  /api/scrape/products?taskId（某任务的产品明细，分页）
  │ DELETE /api/scrape/tasks?id     （删除任务+明细）
  ▼
server.py（http.server，复用 Bearer 鉴权 + ThreadingMixIn）
  │ run_scrape_task(state, asins, marketplace, with_reviews)
  ▼
product_fetcher.py（移植 scraper.ts）
  │ 反爬：会话预热 + Cookie 池 + 令牌桶限流 + 浏览器指纹 + 退避重试 + CAPTCHA 检测
  │ 解析：BeautifulSoup（cheerio 选择器 1:1 翻译）+ 正则（图片/BSR/评论 JSON）
  ▼
SQLite（复用 fba 主库）：scrape_tasks + scrape_products 两张新表
```

设计要点：
- **同步返回 + 落库**：和现有 `/api/rank/run` 一致，请求内串行/小并发抓取，完成后一次性返回并写库。批量大时前端可分批调用展示进度（原项目 Home.tsx 的 BATCH 逻辑）。
- **单后端单进程单 DB**：不引入第二运行时，架构与 FBA 完全一致。

---

## 2. 依赖处理（唯一的新增依赖）

新增 `beautifulsoup4`（可选叠加 `lxml` 解析器，没有则回落到标准库 `html.parser`）。

- 安装：`pip3 install beautifulsoup4`（约几百 KB，远轻于 node_modules）
- **优雅降级**：`product_fetcher.py` 顶部 `try: import bs4 except ImportError:`，
  缺失时该工具接口返回明确错误"未安装 beautifulsoup4"，**不影响** FBA 其余功能与启动。
- `rank_fetcher.py` 保持纯标准库不动，依赖只作用于新文件。
- README/启动脚本补一行依赖说明。

> 备注：BSR、图片、评论图等"藏在 `<script>` JSON 里"的数据，原项目本来就用正则抽取，
> 这部分移植后仍是正则，不依赖 BeautifulSoup。BeautifulSoup 只承担 DOM 选择器部分。

---

## 3. 数据库表设计（SQLite DDL，加入 `_init_db`）

紧挨现有 `keyword_tasks` / `rank_snapshots`（server.py:131 起）追加：

```sql
-- 一次批量采集 = 一个任务
CREATE TABLE IF NOT EXISTS scrape_tasks (
    id           TEXT PRIMARY KEY,        -- nanoid/uuid
    marketplace  TEXT NOT NULL,
    total        INTEGER DEFAULT 0,
    success      INTEGER DEFAULT 0,
    failed       INTEGER DEFAULT 0,
    with_reviews INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'completed', -- running/completed/failed
    created_at   TEXT
);

-- 每个 ASIN 的采集结果（复杂字段以 JSON 文本存）
CREATE TABLE IF NOT EXISTS scrape_products (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    asin          TEXT NOT NULL,
    marketplace   TEXT,
    title         TEXT,
    brand         TEXT,
    price         TEXT,
    rating        TEXT,
    review_count  TEXT,
    availability  TEXT,
    bullet_points TEXT,    -- JSON array
    description   TEXT,
    main_image    TEXT,
    images        TEXT,    -- JSON array
    aplus_images  TEXT,    -- JSON array
    specifications TEXT,   -- JSON object
    product_details TEXT,  -- JSON object
    categories    TEXT,
    seller        TEXT,
    bsr_main_category TEXT,
    bsr_main_rank     INTEGER,
    bsr_sub_category  TEXT,
    bsr_sub_rank      INTEGER,
    bsr_raw_text      TEXT,
    customers_say     TEXT,
    review_images     TEXT, -- JSON array
    select_to_learn_more TEXT, -- JSON array
    status        TEXT,    -- success/failed
    error_message TEXT,
    scraped_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_scrape_prod_task ON scrape_products(task_id);
```

字段与原 Drizzle `products` 表一一对应（MySQL `json` → SQLite `TEXT` 存 JSON 字符串）。

---

## 4. 后端 `product_fetcher.py`（移植 scraper.ts）

新建文件，结构对照 scraper.ts：

| scraper.ts 模块 | 移植为 Python | 说明 |
|---|---|---|
| `MARKETPLACES` / `MARKETPLACE_CURRENCY` | dict | 直接照搬，20 站点 |
| `BROWSER_PROFILES`（12 套指纹） | list[dict] | 照搬 UA + sec-ch-ua |
| `SessionState` + 令牌桶 `acquireRateLimit` | class + time-based | 用 `time.monotonic()` 实现令牌桶 |
| Cookie 池 `mergeCookies/cookieString` | `http.cookiejar` 或手写 dict | 维持 i18n-prefs 等 |
| `warmUpSession` | 函数 | 先访问首页收 Cookie |
| `fetchProductPage`（退避重试） | 函数 | urllib + `RETRY_DELAYS` |
| `isCaptchaPage/isDogPage` | 函数 | 字符串匹配，照搬 |
| `parseProductPage`（cheerio） | **BeautifulSoup** | 选择器 1:1 翻译，见下 |
| `fetchReviewsPage/parseReviewsPage` | 函数 + BS | /product-reviews/ 页 |
| `scrapeProduct` / `scrapeProducts`（并发批） | 函数 | 单进程用 `ThreadPoolExecutor` 控并发 |

**cheerio → BeautifulSoup 映射示例**（机械翻译）：

```
$("#productTitle").text()                  → soup.select_one("#productTitle").get_text()
$(".a-price .a-offscreen").first().text()  → soup.select_one(".a-price .a-offscreen").get_text()
$("#feature-bullets ul li span.a-list-item").each(...)
                                           → soup.select("#feature-bullets ul li span.a-list-item")
$(el).attr("data-a-dynamic-image")         → el.get("data-a-dynamic-image")
```

正则部分（hiRes 图片、reviewImage JSON、BSR `#NUMBER in CATEGORY`、A+ noscript）原样保留。
`cleanText` / `cleanRecord` 文本清洗逻辑照搬为 Python 正则。

**频率/反爬调参**（无代理走本机住宅 IP，比关键词排名更重，要更保守）：
- `SCRAPER_CONCURRENCY` 默认 2（原项目无代理时 3）
- 令牌桶容量、最小请求间隔上调
- `with_reviews` 默认 **关闭**（每 ASIN 少一个请求），按需开

---

## 5. server.py 改动点（精确锚点）

| 位置 | 改动 |
|---|---|
| 顶部 import | `import product_fetcher`（与 `import rank_fetcher` 并列） |
| `_init_db`（:97） | 追加上节两张表的 `CREATE TABLE` |
| `DbState` 方法区（:280 附近） | 新增 `create_scrape_task / save_scrape_products / list_scrape_tasks / get_scrape_products / delete_scrape_task` |
| 模块级函数（`run_rank_task` 旁，:502 附近） | 新增 `run_scrape_task(state, asins, marketplace, with_reviews)` |
| `do_GET`（:586） | 加 `/api/scrape/tasks`、`/api/scrape/products`（均校验 Bearer） |
| `do_POST`（:632） | 加 `/api/scrape/run` |
| `do_DELETE`（:692） | 加 `/api/scrape/tasks?id=` |

鉴权、`_send_json`、`_read_json`、`_extract_token` 全部复用，无需新建。

---

## 6. 前端改动点

| 文件 | 改动 |
|---|---|
| `src/features/tools/ProductScrape.tsx` | **新建**：ASIN 多行输入 + 站点下拉 + 抓评论开关 + 采集按钮 + 结果表格 + 历史任务侧栏 + 进度条（移植 Home.tsx 核心，去 tRPC 改 fetch） |
| `src/features/tools/ProductDetail.tsx` | **新建**：详情弹窗（移植 ProductDetailDialog.tsx：图片画廊/Lightbox、五点、规格、BSR、评论、A+），用现有 `modal-backdrop` 样式替代 Radix Dialog |
| `src/features/sidebar/Sidebar.tsx`（:84 工具区） | 加一个按钮 `{ k: 'productScrape', ic: '🛒', label: '产品采集' }` |
| `src/app.tsx` | 加 `{view === 'productScrape' && <ProductScrape />}` + Tweaks 入口 + import |
| `styles.css` | 新增 `ps-*` 类（参照现有 `kr-*` 风格，复用变量） |

UI 适配：
- 原项目 xlsx 导出 → 复用 FBA 已有的 lazy-load xlsx，或导 CSV（原 Home.tsx 本就是 CSV）。
- 图片代理下载（原 `downloadImagesViaProxy` 走后端代理）→ 一期可简化为直接 `<a download>` 或后端加一个 `/api/scrape/img-proxy`（二期）。

---

## 7. 字段映射总表（ScrapedProduct → SQLite 列）

| scraper.ts | SQLite 列 | 类型处理 |
|---|---|---|
| asin/marketplace/title/brand/price/rating | 同名 snake_case | TEXT |
| reviewCount → review_count | TEXT | |
| availability/description/categories/seller | 同名 | TEXT |
| bulletPoints/images/aplusImages/reviewImages/selectToLearnMore | JSON array → TEXT | `json.dumps` |
| specifications/productDetails | JSON object → TEXT | `json.dumps` |
| mainImage → main_image | TEXT | |
| bestSellerRank.{mainCategory,mainRank,subCategory,subRank,rawText} | bsr_* 五列 | rank 为 INTEGER |
| customerReviews.{customersSay,reviewImages,selectToLearnMore} | customers_say / review_images / select_to_learn_more | |
| status/errorMessage | status / error_message | TEXT |

前端读取时对 JSON 列 `JSON.parse`。

---

## 8. 分阶段实施计划

- **阶段 1（核心打通）**：`product_fetcher.py` 移植 + `run_scrape_task` + 4 个路由 + 建表。
  用 CLI/接口验证单 ASIN、批量 ASIN 能抓到完整字段并落库。
- **阶段 2（前端表格）**：ProductScrape.tsx 输入 + 结果表 + 历史任务 + 进度。
- **阶段 3（详情弹窗）**：ProductDetail.tsx 图片画廊/规格/BSR/评论/A+。
- **阶段 4（打磨）**：CSV/xlsx 导出、图片打包下载、刷新会话按钮、失败重试。

每阶段可独立验收。

---

## 9. 风险与取舍

1. **住宅 IP 被封**：详情页比排名页重（含评论页），批量易触发 CAPTCHA。
   缓解：低并发（默认 2）、令牌桶限流、评论默认关、退避重试、CAPTCHA 检测后刷新会话。
2. **页面改版**：详情解析依赖大量选择器，Amazon 改版会失效。
   BeautifulSoup 版比纯正则（路径 A）抗改版，但仍需偶尔维护选择器。
3. **AJAX 数据缺失**：A+/评论很多走 AJAX，初始 HTML 只有部分——原项目固有限制，移植后一致。
4. **依赖**：引入 beautifulsoup4，打破"纯标准库"。已用可选导入 + 优雅降级把影响降到最低。
5. **大批量耗时**：同步请求内抓取，量大时请求时间长。前端按 BATCH 分批调用 + 进度条缓解；
   二期可改为后端任务 + 轮询进度（参考关键词排名的 scheduler 思路）。

---

## 10. 不做的事（明确边界）
- 不搬 MySQL / Drizzle / tRPC / Express / Radix / Vite / Tailwind。
- 不引入第二运行时（Node）。
- 不动 `rank_fetcher.py` 与关键词排名功能。
- 用户体系复用 FBA 现有 Bearer 鉴权，不引入原项目的用户/角色表。
```
