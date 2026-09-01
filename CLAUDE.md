# FBA Tracker — 项目架构说明（给 AI 助手看的）

修改代码前先看这份文档，能省掉重新通读全项目的时间。
业务逻辑/领域规则见 `docs/business-overview.md`；面向最终用户的部署/协作说明见 `docs/operations.md`。

## AI 助手协作规则

**每次对代码做实质性改动后（新功能/参数调整/接口变更/文件增删），在提交前自动检查并同步更新所有涉及该改动的 MD 文档，包括但不限于：**
- **`CLAUDE.md`**：架构说明、路由表、行数、环境变量等技术细节
- **`docs/business-overview.md`**：面向业务的功能描述、模块定位
- **`docs/modules/` 下的模块专项文档**（如 `production.md`）：问题状态、计算链、流程图等随代码同步更新

**需要改的直接改，无需询问用户。**

**在回复或 commit message 中声称"已更新/已修复/已同步"某个文件之前，必须确认该文件已显式出现在 `git add` 命令中。不允许基于意图而非事实做出陈述——先执行，再描述结果，不能倒过来。**

**验证/测试阶段如有文件写入磁盘（如 `/tmp/*.xlsx`、scratchpad 下的文件等），测试结束后必须立即删除，不能遗留。优先用 `io.BytesIO` 等纯内存方式做验证，避免写磁盘。**

### Git 提交规范

**提交时机：以"一个完整的逻辑变更单元"为粒度，而非每完成一个子任务就提交。**

一次 commit 应包含：
- 本次变更的全部代码文件
- 因本次变更需要更新的所有文档（CLAUDE.md / business-overview.md / docs/modules/*.md）
- 同一问题的多个迭代修复（同一会话内反复调整同一功能，合并为一次）

**何时提交：**
- 一个功能/修复完整可用，build 通过后
- 用户明确要求提交时
- 切换到不相关的新任务之前

**何时不提交：**
- 文档改动与刚完成的代码变更属于同一逻辑单元 → 合并入同一 commit，不单独提交
- 同一会话内对同一功能连续调整 → 积累到调整完毕再提交
- 仅修改 CLAUDE.md 协作规则/行数 → 等待下一次代码变更时一并提交

**每次工作会话目标：1-3 个 commit，不超过 5 个。**

## 一句话

一个局域网内多人协作的 FBA 选品/生产/上架进度追踪工具。Python `http.server` 后端 + SQLite 存储，
前端是 React/TypeScript（esbuild 打包成单个 `compiled/bundle.js`，由 `index.html` 直接引用，无路由库）。

## 技术栈与构建

- 前端：React 19 + TypeScript（`tsconfig.json` 严格模式），esbuild 打包，`--jsx=automatic`（**必须显式 `import { useState, ... } from 'react'`**，没有全局 React）
- 后端：纯标准库 `http.server`（`ThreadingHTTPServer`），无第三方 web 框架
- 数据库：SQLite，`data/fba-data.db`（默认路径，整个 `data/` 目录 `.gitignore` 忽略，本地数据不进 git）
- Python 依赖：见根目录 `requirements.txt`（`beautifulsoup4` 仅"产品采集"用到、`pypdf` 仅"PDF拆分"用到、`openpyxl`/`Pillow` 仅"导出 Excel(含嵌入主图)"用到），`pip3 install -r requirements.txt` 一次装好

常用命令：
```bash
npm run build             # esbuild 打包 src/ -> compiled/bundle.js
npx tsc --noEmit           # 类型检查（CI/改完前端代码后必须跑）
npm start                  # = prestart(build) + python3 -m backend.app
python3 -m backend.app --port 8099   # 临时换端口测试，避免和正在跑的实例冲突
```
**必须从仓库根目录、以 `-m` 方式启动**（`python3 -m backend.app`）——`backend/` 内部模块间用的是包相对导入（`from .db import DbState` 这类），直接 `python3 backend/app.py` 当脚本执行会因为没有包上下文报 `ImportError: attempted relative import with no known parent package`。

## 目录结构

```
backend/                     # 后端 Python 包（启动方式：python3 -m backend.app，见上）
  app.py                      # 入口：main()/CLI 参数解析、make_handler()把各 routes/*.py 的路由
                              #   汇总成 GET/POST/PUT/DELETE 四张 dict[path->handler] 分发表、
                              #   ThreadingServer、get_lan_ip()
  utils.py                    # 全局共用：PROJECT_ROOT（=backend/ 的上一级，data/、skills/ 等
                              #   资源路径都锚定在这里，不用各模块自己的 __file__）、
                              #   _now_iso()、_extract_token()
  db.py                       # DbState 类：SQLite 建表/迁移 + 所有表的读写方法（乐观锁核心）
  auth.py                     # AuthManager 类：Token 登录/登出，fba-users.json 读写
  workers/
    export_worker.py           # ExportWorker + _build_products_xlsx()（导出Excel含嵌入主图，
                              #   依赖 openpyxl/Pillow）
    ai_analysis_worker.py      # AiAnalysisWorker + AI_SKILLS/AI_ALLOWED_TOOLS/AI_MAX_BUDGET_USD/
                              #   _check_login_state()（详见下方"AI分析模块"一节）
  routes/                     # 按业务域拆分的路由模块，每个导出 register(GET,POST,PUT,DELETE,state,auth,ai_worker)，
                              #   把自己的 handler 函数注册进 app.py 传入的四张 dict
    auth_routes.py             # /api/login /api/logout /api/me
    products.py                 # /api/products (GET/PUT) + /api/trash/*（回收站）
    rank.py                     # /api/rank/*，含 run_rank_task()/start_scheduler()
    scrape.py                   # /api/scrape/*，含 run_scrape_task()
    review.py                   # /api/review/*，含 run_review_task()
    sif_keywords.py              # /api/sif/*，SIF 爆品关键词监控：任务 CRUD + 三档频率调度器（daily/every_n/weekly）
                              #   + 分层抓取编排 execute_task() + 看板/趋势/信号/入池/设置/点查路由
    exports.py                  # /api/exports/*（新版后台导出任务）
    pdf.py                      # /api/pdf/*
    ai_analysis.py               # /api/ai/*
  rank_fetcher.py              # 关键词排名抓取器（正则解析，无 bs4 依赖）
  product_fetcher.py           # 产品详情抓取器（bs4 解析 + 反爬：会话池/令牌桶/CAPTCHA/Dog-page检测）
  sif_fetcher.py               # SIF 抓取器 v2（HTTP JSON-RPC 直连 mcp.sif.com，零第三方依赖；封装关键词域/ASIN域/
                              #   决策域共 14 个工具 + 每日层/每周层编排 run_daily_layer()/run_weekly_layer()；
                              #   密钥读环境变量 SIF_MCP_KEY 或 data/sif-config.json，见"SIF 爆品关键词监控模块"一节）
  sif_signals.py               # SIF 信号引擎（纯本地计算、不消耗 SIF 配额）：读已落库的日快照算出关键词异动与
                              #   ASIN 爆品信号并写 sif_signals；全部阈值取自 sif_settings.thresholds，前端设置页可改
  pdf_splitter.py              # PDF 拆分工具后端逻辑（依赖 pypdf，见 requirements.txt；
                              #   TMP_DIR 锚定在 PROJECT_ROOT/data/pdf_tmp，不是 backend/ 自己的目录）

requirements.txt              # Python 依赖声明（beautifulsoup4/pypdf/openpyxl/Pillow）

index.html                   # 唯一 HTML 入口，引用 styles.css + compiled/bundle.js
styles.css                   # 全局样式（2759 行，按模块分区注释，如 PRODUCT SCRAPE / PDF SPLIT 区块）

src/
  main.tsx                   # ReactDOM.createRoot 挂载 <App/>
  app.tsx                    # App 根组件：登录态(AuthGate)、AppShell(顶层视图路由/Tabs)
  context/ProductContext.tsx # ProductsProvider + useProducts：全局状态、与后端同步逻辑、
                              #   ~19 个 update*() 字段更新函数（updateStage/updateVariant/...）
                              #   回收站相关：`trash` 状态（随 GET /api/products 响应一起刷新，无独立轮询）+
                              #   restoreFromTrash/purgeFromTrash/emptyTrash（调完后端接口都用 refreshFromServer()
                              #   整体拉取最新 products+trash 覆盖本地，不走增量 setProducts，避免和其他终端的未同步编辑冲突）
  components/index.tsx        # 通用 UI 组件：StatusChip/StatusSelect/EditField/StageCard/
                              #   RecordCard/AddRecordButton/VariantSelector/FieldHint
                              #   （FieldHint：字段标题 hover 显示计算过程说明的通用 tooltip，
                              #    EditField 新增 hint? 透传给它；生产出货模块的计算字段大量使用）
  data/
    types.ts                 # 核心类型：Product / Variant / StageData / LogEntry / ProfitResult
    constants.ts              # STAGES(18个阶段)/TABS(7个分页)/STAGE_STATUSES/DEFAULT_FX 等常量
    calc.ts                   # 利润测算公式
    products.ts               # 内置示例产品数据（首次启动/离线兜底）
  features/
    sidebar/Sidebar.tsx        # 左侧产品列表筛选 + 顶部 TopBar（同步状态/用户/主题切换）
    list-view/index.tsx        # ProductList + TabEval(立项评估) + NewProductModal
    detail/index.tsx           # Detail 主容器，内含 7 个 Tab 组件（按 TABS 顺序）：
                              #   TabVariants/TabSup/TabDesign/TabProd/TabOps/TabReview + VocCard/LogRow 等
    table/TableView.tsx        # 数据表格视图（类 Excel）
    progress/ProgressView.tsx  # 进度总览（甘特图等）
    tweaks/TweaksPanel.tsx     # 右侧"Tweaks"调试面板（主题/布局微调，开发用）
    tools/
      KeywordRank.tsx           # 工具：关键词排名监控
      ProductScrape.tsx         # 工具：产品采集（含详情预览弹窗 + 图片 Lightbox + ASIN搜索过滤 + 列头排序 + 多选导出 + 每页50/100/150条分页跳转）
      ReviewFetch.tsx           # 工具：评论采集（多ASIN批量抓取，按评分/排序/是否验证购买过滤）
      PdfSplit.tsx              # 工具：批量 PDF 拆分（每文件独立配置拆分方式，拆分结果通过浏览器下载）
      AiAnalyze.tsx             # 工具：AI分析（无人值守 shell 出去跑 `claude -p` 执行 Claude Code Skill；
                                #   导出 AI_SKILLS 常量供 Sidebar.tsx / app.tsx 渲染"AI分析"分组按钮/视图路由/Tweaks下拉，
                                #   新增 skill 只需在这个数组里加一条 + backend/workers/ai_analysis_worker.py 的 AI_SKILLS 字典加同 id 的一条）
      SifKeyword.tsx            # 工具：SIF 爆品关键词监控 v2（六页签：监控看板 / 关键词 / 爆品池 / 信号中心 / 运行记录 / 设置；
                                #   方向预设 降温·升温·礼物·车载·自定义；纯 SVG 手绘图表——关键词自建日序列 +
                                #   ASIN 真日粒度多指标折线 + 迷你 sparkline；点查弹窗复用 /api/sif/inspect；
                                #   详见"SIF 爆品关键词监控模块"一节）
    exports/
      MyExports.tsx           # 共用「我的导出」视图：展示所有后台导出任务进度和下载入口；useExportBadge() 供侧边栏徽标使用
    trash/
      Trash.tsx               # 回收站视图：列出被删除的产品，支持单个恢复/彻底删除 + 清空回收站；
                              #   数据来自 ProductContext 的 trash 状态（GET /api/products 响应内嵌，非独立轮询）

README.md                    # 项目入口：简介 + 快速开始 + 文档导航
docs/
  business-overview.md        # 业务逻辑：FBA流程/SKU变体/生产批次规则/工具模块定位
  operations.md               # 部署/协作/同步操作手册（原 README-sync.md）
  modules/
    production.md             # 生产出货模块深度文档：数据模型/计算链/流程图/已知问题/优化建议
  plans/
    product-scrape-integration-plan.md  # 产品采集模块实施方案（已完成，归档）
  uploads/                     # 参考文档（产品文档等，非应用功能使用）
  screenshots/                 # 文档配图

skills/                        # vendor 进来的 Claude Code Skill 副本（AI分析模块专用，各自自包含）
  CosmoDiagnose/                # 与 /Users/dihting/Desktop/DT-20251208/200/PY/DTCOSMO/CosmoDiagnose 同源手动拷贝，
                                #   非软链接/非自动同步，skill 本体升级需手动 cp 一份过来
    SKILL.md / amz_login.py / amz_alexa.py
    data/                      # 该 skill 自己的登录态 cookie + Alexa 反查结果（.gitignore 忽略）
    report/{taskId}/           # 每次分析任务的4个输出文件，按 taskId 隔离，避免同 ASIN 重复分析互相覆盖（.gitignore 忽略）

data/                          # 运行时数据（.gitignore 忽略，不进 git）
  fba-data.db / -shm / -wal     # SQLite 主库 + WAL 临时文件
  fba-users.json                # 用户名/密码（明文）
```

## 后端架构（backend/）

### SQLite 表（`backend/db.py` 的 `DbState` 类管理，建表/迁移逻辑都在 `__init__`）

| 表 | 用途 |
|---|---|
| `meta` | 全局 key-value（如当前 `version` 号） |
| `products` | 产品主数据（JSON blob + version，乐观锁核心） |
| `trash` | 回收站：产品被删除时的完整快照（`product_json`），`write()` 检测到某 id 从新列表中消失即挪进这张表而非真删 |
| `audit_log` | 产品数据变更审计 |
| `keyword_tasks` / `rank_snapshots` | 关键词排名：任务配置 + 历史快照 |
| `scrape_tasks` / `scrape_products` | 产品采集：任务记录 + 落库的商品详情 |
| `review_tasks` / `review_results` | 评论采集：任务记录 + 评论池（按 asin+review_id 去重） |
| `export_jobs` | 后台导出任务（`ExportWorker` 消费，最多2并发） |
| `ai_analysis_tasks` | AI分析任务（`AiAnalysisWorker` 消费，强制串行1并发；`files` 字段是产出文件名列表 JSON；`status` 除 pending/running/done/failed 外还有 `cancelled`；`username` 记录发起人，登录态按用户名分区要用） |
| `sif_tasks` + `sif_kw_snapshots` / `sif_asins` / `sif_asin_snapshots` / `sif_kw_profiles` / `sif_asin_weekly` / `sif_signals` / `sif_runs` / `sif_settings` | SIF 爆品关键词监控 v2：任务配置（方向/模式/词根/配额/频率三档 daily·every_n·weekly + 时刻 + 两层最近运行日）；关键词每日快照（只存当日点，日序列由累积得到，UNIQUE(task,run_date,keyword)）；ASIN 监控池（含静态画像与 last_stat_date）；ASIN 真日粒度数据（UNIQUE(task,asin,stat_date)）；每周需求画像与词根竞品概览（按 ISO 周覆盖）；信号（UNIQUE(date,task,kind,ref_type,ref_id) 幂等）；运行日志（每次分层调用的 stats）；全局设置（thresholds 信号阈值 / defaults 默认配额，前端可改） |

### API 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/products` | 取产品数据 + 当前 version + `trash`（回收站列表） |
| PUT | `/api/products` | 写入，带 `baseVersion`，version 不匹配返回 409 + 最新数据；请求体里消失的产品 id 会被移入回收站而非真删 |
| POST | `/api/trash/restore` | body `{id}`，把回收站里的产品搬回 `products`；找不到该 id 返回 404 |
| DELETE | `/api/trash?id=` | 从回收站彻底删除单个产品（不可恢复） |
| DELETE | `/api/trash/empty` | 清空整个回收站（不可恢复） |
| GET | `/api/me` | 当前登录用户 |
| POST | `/api/login` / `/api/logout` | Token 登录/登出（`fba-users.json`） |
| GET/POST/DELETE | `/api/rank/*` | 关键词排名：任务列表/历史/创建/删除/单关键词 |
| GET/POST/PUT/DELETE | `/api/scrape/*` | 产品采集：任务列表/结果/运行/重命名/删除/重置会话 |
| POST | `/api/exports/create` | 创建后台导出任务，body `{type,label,fileName,params}`，立即返回 `{jobId}` |
| GET | `/api/exports/list` | 列出所有导出记录（最近 100 条） |
| DELETE | `/api/exports?id=` | 删除导出记录及临时文件 |
| GET/POST/DELETE | `/api/review/*` | 评论采集：任务列表/结果/运行/删除 |
| POST | `/api/pdf/upload` | 上传 PDF（`application/octet-stream` + `X-Filename`），返回 `{file_id,name,pages,size}` |
| POST | `/api/pdf/split` | 拆分任务，body `{jobs:[...]}`，返回 `{results:[...]}` |
| GET | `/api/pdf/download?id=` | 下载拆分结果文件（按 download_id 查临时注册表） |
| POST | `/api/ai/run` | 创建AI分析任务，body `{skillId,asin,params}`，立即返回 `{taskId}`（实际执行交给 `AiAnalysisWorker` 后台线程，不阻塞） |
| GET | `/api/ai/tasks?skillId=` | 列出AI分析历史任务（可按 skillId 过滤） |
| GET | `/api/ai/task?id=` | 单个AI分析任务详情（前端轮询用） |
| DELETE | `/api/ai/tasks?id=` | 删除AI分析任务记录，并 `shutil.rmtree` 对应 `skills/<Skill>/report/<taskId>/` 目录 |
| GET | `/api/ai/file?taskId=&name=&mode=inline\|download` | 读取AI分析产出文件；**不做 Bearer 头校验**（iframe/下载链接等浏览器原生导航不带自定义头，和 `/api/pdf/download` 一致），靠不可猜测的 taskId + 该任务的文件名白名单做访问控制 |
| POST | `/api/ai/login` | body `{skillId}`，后台 fire-and-forget 跑一次 `amz_login.py`（本机弹出有头浏览器，人工登录一次即可，最长等5分钟），按 `(skillId, username)` 去重防止重复点击弹多个窗口 |
| POST | `/api/ai/cancel` | body `{id}`，终止一个 `pending`/`running` 的AI分析任务（不可恢复）；`pending` 直接改状态，`running` 调 `AiAnalysisWorker.cancel()` 终止子进程 |
| GET/POST/PUT/DELETE | `/api/sif/tasks` | SIF 爆品监控任务：列表/创建/更新/删除（删除连带清空该任务的快照、ASIN 池、日数据、信号与运行日志） |
| GET | `/api/sif/board?taskId=&days=&date=` | 一次拉齐看板：任务列表 + 概览 + 当日关键词榜（含日环比/7日环比/画像/近7日 spark）+ 爆品榜（含 BSR/价格/月销环比、statDate）+ 信号 + 运行日志 + 可选日期 + 设置 |
| POST | `/api/sif/run` | body `{id}`，立即运行一次（后台线程不阻塞；每日层必跑，每周层满 7 天附带；同任务运行中去重） |
| GET | `/api/sif/runs?taskId=` | 运行日志（每次分层的实际 SIF 调用数与统计，成本透明） |
| GET | `/api/sif/kw-trend?taskId=&keyword=&days=` | 关键词自建日序列 + 最新需求画像 |
| GET | `/api/sif/asin-trend?taskId=&asin=&days=` | ASIN 真日粒度序列 + 监控池画像 |
| GET | `/api/sif/universe?taskId=` | 该任务监控过的全部关键词（含历史峰值） |
| GET/POST | `/api/sif/pool`、`/pool/add`、`/pool/toggle`、`/pool/remove` | ASIN 监控池：查询 / 手动加入并回补日数据 / 停用启用 / 删除（含其日数据） |
| GET | `/api/sif/signals?days=&taskId=&limit=`、`/api/sif/signal-top` | 信号列表与按词/ASIN 聚合的异动榜 |
| POST | `/api/sif/signals/ack` | body `{id,ack}`，标记信号已处理 |
| GET/PUT | `/api/sif/settings` | 读/写信号阈值（thresholds）与默认配额（defaults）——前端「设置」页对应 |
| POST | `/api/sif/preview` | body `{root,country,topN,withCompetitors}` 试查词根机会词+头部竞品（不落库） |
| POST | `/api/sif/inspect` | body `{type,...}` 点查重接口，type ∈ competition·discover·root_competitors·root_trend·history·screen·asin_signals·asin_profile·asin_sales·listing_keywords·promotion·profit |

路由对应的源文件：`/api/login`/`/api/logout`/`/api/me` → `routes/auth_routes.py`；`/api/products`/`/api/trash/*` → `routes/products.py`；`/api/rank/*` → `routes/rank.py`；`/api/scrape/*` → `routes/scrape.py`；`/api/review/*` → `routes/review.py`；`/api/exports/*` → `routes/exports.py`；`/api/pdf/*` → `routes/pdf.py`；`/api/ai/*` → `routes/ai_analysis.py`；`/api/sif/*` → `routes/sif_keywords.py`。

### 同步机制（详见 `docs/operations.md` 第7节）
客户端每 4s 轮询 `version`，编辑后 600ms 防抖 PUT 带 `baseVersion`；后端乐观锁，冲突时返回服务器最新版本，客户端整体覆盖（`ProductContext.tsx` 中 `versionRef`/`syncedVersionRef` 相关逻辑）。

### AI分析模块（`backend/workers/ai_analysis_worker.py` 的 `AiAnalysisWorker` + `AI_SKILLS`，路由在 `backend/routes/ai_analysis.py`）

不同于其它"工具模块"（本地计算/请求外部页面），AI分析是无人值守 shell 出去跑一次真实的 `claude -p`（Claude Code headless 会话），复用 `skills/<Skill>/SKILL.md` 里已经写好的分析流程，不是重新实现一套 agent 循环：

- **并发**：强制串行（`ThreadPoolExecutor(max_workers=1)`），因为单次分析涉及真实 Playwright 浏览器 + Claude API 调用，成本和资源都不便宜。
- **权限**：`AI_ALLOWED_TOOLS` 收窄到 skill 自己声明允许用的工具（`Bash Read Write Edit mcp__playwright__* mcp__sif-mcp__*`），不用 `--dangerously-skip-permissions`/`bypassPermissions` 整体放开——无人值守时被 Claude Code 自身的安全分类器判定为高风险操作，需要显式收窄权限而非笼统跳过。
- **预算**：`AI_MAX_BUDGET_USD`（当前 `8`）是初始估值，未经真实多次运行校准，跑几次后应参考 `--output-format json` 返回的 `total_cost_usd` 调整。
- **输出隔离**：调用时在 prompt 里显式让 skill 把产物存到 `report/<taskId>/` 而非 skill 自己 `SKILL.md` 里默认的 `report/` 根目录，避免同一 ASIN 反复分析互相覆盖。
- **新增 skill**：`backend/workers/ai_analysis_worker.py` 的 `AI_SKILLS` 字典和 `AiAnalyze.tsx` 的 `AI_SKILLS` 数组各加一条同 `id` 的项即可，Sidebar 的"AI分析"分组、`app.tsx` 的视图路由/Tweaks下拉都是从这个数组派生的，不用逐处手改。
- **登录态按 FBA2 用户名分区**：`amz_login.py`/`amz_alexa.py` 的 `DATA_DIR` 读环境变量 `COSMO_FBA_USER`（未设置时退化为 `default` 子目录），实际存储路径是 `skills/<Skill>/data/<username>/amz_state.json`。`AiAnalysisWorker` 起 `claude -p` 子进程、`/api/ai/login` 起 `amz_login.py` 子进程时，都把当前 FBA2 用户名注入这个环境变量——环境变量沿子进程继承链一路传到底层脚本，SKILL.md 里的 Bash 指令文字不用跟着改。`ai_analysis_tasks.username` 列记录任务归属，因为 `AiAnalysisWorker` 异步消费队列时原始 HTTP 请求早就结束了，只能从任务行里取。
- **登录态自愈**：`POST /api/ai/run` 建任务前先用 `_check_login_state()`（逻辑照抄 `amz_alexa.py` 的 `check_state_validity()`）检查登录态，缺失/过期时不建任务、返回 `{code: "login_required"}`，前端展示专门的"去登录"状态块（调 `/api/ai/login`），而不是任由无人值守的 `claude -p` 子进程自己决定要不要交互登录（`build_prompt` 里也显式告诉 Claude 不要在这个场景下自己跑 `amz_login.py`，作为预检查之外的兜底）。
- **终止**：`_run_job` 用 `subprocess.Popen`（而非 `subprocess.run`）保留进程句柄，存进 `self._procs`；`cancel(task_id)` 调 `proc.terminate()` 并记入 `self._cancelled`，`_run_job` 收尾时按这个集合区分「用户终止」和「正常失败」两种终态，不可恢复（没有暂停/继续——活跃的 Playwright 会话/网络连接没法被操作系统级暂停后干净恢复，做不到）。
- **root 专属**：目前"AI分析"整个功能只对 `role: "root"` 的账号开放（`AuthManager._ensure_default_users()` 幂等补充一个默认 `root` 账号，密码见 `data/fba-users.json` 或找部署者，不写进代码仓库文档；不影响已有的 `admin`/`editor`）。所有 `/api/ai/*` 路由（`/api/ai/file` 除外——它靠不可猜测的 taskId 做访问控制，不能挂 Bearer 校验）在登录校验之后都加了 `role != "root"` 时返回 403 的强制校验，前端 Sidebar/app.tsx/TweaksPanel 里的隐藏只是体验层面，真正的门禁在后端。

### SIF 爆品关键词监控模块（`backend/sif_fetcher.py` 抓取器 + `backend/sif_signals.py` 信号引擎 + `backend/routes/sif_keywords.py` 路由/调度/编排 + `SifKeyword.tsx` 前端视图）

面向亚马逊选品的"爆品 + 关键词"双线监控：通过 **HTTP JSON-RPC 直连 SIF 的 MCP 端点**（`https://mcp.sif.com/mcp`，Streamable HTTP，`tools/call`），**不经过 Claude Code / LLM**，抓取结果全是 SIF 预生成的结构化 JSON（`_formatted` LLM 展示块在 fetcher 层裁掉）。数据每日刷新（`data_notice` = "refreshes daily, 1-day delay"），所以按天抓取能捕捉真实变化。深度文档见 `docs/modules/sif-keywords.md`。

- **端点与密钥**：环境变量 `SIF_MCP_URL`/`SIF_MCP_KEY` 优先，兜底读 `data/sif-config.json`（data/ 已 gitignore）。`_load_config()` 带 30s 缓存，`is_configured()` 供路由提前返回 400。**密钥绝不硬编码进代码**。
- **时间粒度的真相（重要）**：SIF 的**关键词历史只有周/月粒度**（ABA 官方口径），`granularity=daily` 实测仍返回周序列；**唯一的真日粒度接口是 `ops_get_asin_traffic_trend(granularity=day, lastDays=N)`**——逐日 BSR/价格/成交价/评论数/评分/卖家数/近30天销量/自然 vs 各广告渠道流量分数/促销标记。因此：ASIN 侧是原生日线，关键词侧的"日序列"是**本模块自己每日快照累积出来的**（口径为 SIF 每日刷新的估算值逐日对比，前端已明确标注）。SIF 的 ASIN 日数据还有 T+1~T+2 延迟与零星缺口，所以看板取"最近一个有值的日期"（`statDate`），信号引擎也按数据日而非运行日判断（否则 ASIN 信号永远不触发——这是实测踩过的坑）。
- **分层抓取（成本阀门）**：
  - **每日层**（必跑）：`market_screen_keyword_opportunities` 按词根发现机会词 → 写当日关键词快照；池内每只 ASIN 各调一次 `ops_get_asin_traffic_trend(day)` 入日表；新入池 ASIN 用 `market_get_asin_profile`（≤20/批）补静态属性并按 `backfillDays` 回补历史日线。
  - **每周层**（距上次 ≥7 天时附带）：`market_get_keyword_demand`（10 词/批）刷需求画像、`market_get_keyword_history`（10 词/批）回填当周 ABA 排名/点击集中度、`market_get_keyword_root_competitors` 取词根头部竞品自动扩充 ASIN 池。
  - **点查层**（前端手动，绝不进定时）：`market_get_keyword_competition`、`market_discover_competitors`（Top100 四维格局）、`market_get_keyword_root_trend`（词根盘子/长尾占比）、`market_assess_keyword_promotion`（该不该打广告）、`market_estimate_profit_threshold`（采购成本上限）、`market_get_asin_keyword_signals`、`ops_get_listing_keyword_distribution`、`ops_get_asin_sales_list`（近 N 天/变体维度）。统一走 `POST /api/sif/inspect {type, ...}` 分派。
- **任务模型**：`mode='root'`（按词根发现）/ `'keywords'`（固定词清单）；`direction` 预设 cooling/heating/gift/car/custom（前端一键填词根）；**频率三档 `freq_type`** = `daily` / `every_n`（每 N 天）/ `weekly`（周几）+ `schedule_time`（HH:MM 北京时间，错过当天不补跑）；配额字段 `top_n`/`quota_limit`/`asin_limit`/`backfill_days` + `auto_asin`（是否自动入池）。`last_daily_at`/`last_weekly_at` 分别记录两层的最近运行日。
- **调度器**：`start_scheduler()` 守护线程每分钟扫描，命中即 `_launch()` 后台线程执行（同任务用 `_running` 集合去重，手动与定时同路径）。**启动时把残留 `running` 标为 `error`**（崩溃恢复）。
- **信号引擎**（`sif_signals.py`，纯本地计算、0 配额）：关键词侧 kw_volume_surge / kw_volume_drop / kw_rank_jump / kw_new_entry；ASIN 侧 asin_bsr_jump / asin_price_drop / asin_sales_surge / asin_review_surge / asin_new_hot（上架 N 天内月销过门槛的黑马）/ asin_traffic_shift（自然流量占比骤降 = 转靠广告撑量）。全部阈值走 `sif_settings.thresholds`，**前端「设置」页可改并立即生效**；信号写入 `sif_signals`，UNIQUE(date,task,kind,ref_type,ref_id) 幂等，同日重跑不堆重复。
- **成本透明**：每次运行按层写 `sif_runs`（含实际 `calls` 调用数、发现词数、监控/新增 ASIN 数、入库数据点数、信号数、错误详情），前端「运行记录」直接展示；`_Throttle` 保证两次调用间隔 ≥0.3s。想砍成本优先降 `asin_limit`，其次降 `topN`。
- **v1 → v2 迁移**：旧版单表 `sif_snapshots`（detail 里冗余存 60 周历史）与新结构不兼容，`_init_db()` 检测到 `sif_tasks` 缺 `freq_type` 列即 DROP 旧 `sif_tasks`/`sif_snapshots` 并重建 v2 表——**旧任务与历史快照会被清空**（本次升级已与用户确认）。
- **SIF 已知坑**：批量工具（demand/history）实测单次最多返回 10 词，必须分批；`market_get_asin_keyword_signals` 用 `time_type=lately` + `time_value='7'|'30'`（`week` 需传该周**周日**日期，当周因 T+1 不可用）；响应里 ASIN 常被包成 markdown 链接 `[B0XXX](url)`，统一用 `_clean()` 剥壳；数字字段混着 `'1,234'`/`'45%'`/`'$3.2'`，统一 `_num()` 解析。

## 前端架构

- **状态管理**：单一 `ProductContext`（无 Redux/Zustand），`useProducts()` 暴露数据 + 一组 `update*()` 函数，每个对应 `Product`/`Variant`/`Stage` 等不同粒度的字段更新，最终都落到 `products` 数组并触发同步。
- **视图路由**：无 react-router，`app.tsx` 的 `AppShell` 用 `view` 状态字符串切换（`'list' | 'progress' | 'table' | 'keywordRank' | 'productScrape' | 'reviewFetch' | 'pdfSplit' | 'sifKeyword' | 'myExports' | 'trash'`），Sidebar/TopBar 负责切换按钮和标题映射。新增视图需同时更新 `app.tsx`（渲染分支）、`Sidebar.tsx`（工具列表 + titles 映射）。
  "AI分析"是个例外：`view` 用 `'aiAnalyze:' + skillId` 动态拼出来的 key（而非固定字符串），因为它是一个按 skill 分组、未来会有多个入口的分组，`app.tsx` 用 `view.startsWith('aiAnalyze:')` 判断+ `.slice()` 取出 skillId 传给 `<AiAnalyze skillId=.../>`，Sidebar 的按钮和 TopBar 的标题也是从 `AiAnalyze.tsx` 导出的 `AI_SKILLS` 数组动态渲染，不是写死的按钮列表。
- **数据模型核心**：`Product.stages: Record<stageKey, StageData>`，`stageKey` 取自 `STAGES`（18个阶段，每个归属 `TABS` 中某个 tab，各阶段业务含义见 `docs/business-overview.md` 第1节），`Product.variants: Variant[]` 为 SKU 变体，变体也有自己的 `stages` 子集（`VARIANT_STAGE_KEYS`）。
- **"工具模块"模式**（关键词排名 / 产品采集 / SIF爆品监控 共享）：左侧输入+历史任务列表，右侧结果表格+操作；后端各有一个 `backend/xxx_fetcher.py` 抓取器 + `backend/routes/xxx.py` 里的 `/api/xxx/*` 路由 + `run_xxx_task()`（SIF 模块另有三档频率的分层定时调度器 `start_scheduler()` + 本地信号引擎 `sif_signals.py`）。新增同类工具时可参照 `ProductScrape.tsx` + `backend/product_fetcher.py` + `docs/plans/product-scrape-integration-plan.md`。

## 已知的体量较大的文件（非 bug，但改动前建议先用 grep/大纲定位再改）

- `src/features/detail/index.tsx`（1413 行，11 个组件；`TabProd` 前有 `getEffectiveBalancePayments(b)` 辅助函数；跨批次汇总通过 `titleExtra` 注入 StageCard 标题行）
- `src/context/ProductContext.tsx`（927 行，~19 个 update 函数）
- `src/features/tools/SifKeyword.tsx`（1586 行，SIF 爆品监控 v2：六页签 + 任务表单 + 关键词/ASIN 详情弹窗 + 点查弹窗 + 设置面板全在一个文件里）
- `backend/db.py`（1979 行，SIF v2 的 8 张表读写集中在文件后半段，改前先 grep `SIF v2` 分区注释定位）
- `backend/routes/sif_keywords.py`（941 行，前半是分层编排 `execute_task()` + 调度器，后半是 `register()` 里的路由表）
- `styles.css`（3006 行，按模块分区，新模块追加在文件末尾对应分区注释下；SIF v2 组件样式在文件最末）
- `backend/product_fetcher.py`（1368 行，含完整反爬逻辑；Dog page 检测会在 503 分支同步重置 session cookies）
  限流参数（均可用环境变量覆盖，当前默认值）：
  `SCRAPER_CONCURRENCY=3`（并发 worker 数）、`SCRAPER_MIN_INTERVAL_MS=700`（请求最小间隔 ms）、
  `SCRAPER_REFILL_MS=1500`（令牌桶补充间隔 ms）、`SCRAPER_BUCKET_CAPACITY=8`（令牌桶容量）

## 暂时隐藏的功能（注释保留，可随时恢复）

- **`Sidebar.tsx` `sb-stats` 区块**：进行中/本月完成/30天到期/已逾期四项数字统计已注释，对应 `computeStats` 调用及 import 同步注释。
- **`ProgressView.tsx` KPI**：进度总览顶部卡片中的「本月完成」「30天到期」「已逾期」三项已注释，其余（总产品/开发中/已上架/已暂停）保留。

## 改前端代码的注意事项

1. 任何用到 hooks 的文件必须 `import { useState, useCallback, useEffect, ... } from 'react'`（没有全局 UMD React）。
2. 改完跑 `npx tsc --noEmit`（必须无报错）和 `npm run build`（确认 esbuild 也无报错——两者校验范围不完全重叠）。
3. 测试后端 API 时若默认端口被占用，用 `--port` 换一个临时端口，测完 `pkill` 掉，避免影响用户正在跑的实例。
