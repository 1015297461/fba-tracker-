# FBA Tracker — 项目架构说明（给 AI 助手看的）

修改代码前先看这份文档，能省掉重新通读全项目的时间。
业务逻辑/领域规则见 `docs/business-overview.md`；面向最终用户的部署/协作说明见 `docs/operations.md`。

## AI 助手协作规则

**每次对代码做实质性改动后（新功能/参数调整/接口变更/文件增删），在提交前自动检查并同步更新所有涉及该改动的 MD 文档，包括但不限于：**
- **`AGENTS.md`**：架构说明、路由表、行数、环境变量等技术细节
- **`docs/business-overview.md`**：面向业务的功能描述、模块定位
- **`docs/modules/` 下的模块专项文档**（如 `production.md`）：问题状态、计算链、流程图等随代码同步更新

**需要改的直接改，无需询问用户。**

**在回复或 commit message 中声称"已更新/已修复/已同步"某个文件之前，必须确认该文件已显式出现在 `git add` 命令中。不允许基于意图而非事实做出陈述——先执行，再描述结果，不能倒过来。**

**验证/测试阶段如有文件写入磁盘（如 `/tmp/*.xlsx`、scratchpad 下的文件等），测试结束后必须立即删除，不能遗留。优先用 `io.BytesIO` 等纯内存方式做验证，避免写磁盘。**

### Git 提交规范

**提交时机：以"一个完整的逻辑变更单元"为粒度，而非每完成一个子任务就提交。**

一次 commit 应包含：
- 本次变更的全部代码文件
- 因本次变更需要更新的所有文档（AGENTS.md / business-overview.md / docs/modules/*.md）
- 同一问题的多个迭代修复（同一会话内反复调整同一功能，合并为一次）

**何时提交：**
- 一个功能/修复完整可用，build 通过后
- 用户明确要求提交时
- 切换到不相关的新任务之前

**何时不提交：**
- 文档改动与刚完成的代码变更属于同一逻辑单元 → 合并入同一 commit，不单独提交
- 同一会话内对同一功能连续调整 → 积累到调整完毕再提交
- 仅修改 AGENTS.md 协作规则/行数 → 等待下一次代码变更时一并提交

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
                              #   _now_iso()、_extract_token()、
                              #   _log()（统一日志出口：带 [YYYY-MM-DD HH:MM:SS] 前缀 + flush，
                              #   所有后端运行时日志都应走它，别用裸 print）
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
    scrape.py                   # /api/scrape/*：start_scrape_task()/_run_scrape() 服务端后台
                                #   执行器（POST /start 立即返回 taskId，前端轮询 /progress，
                                #   刷新不丢任务）+ 运行时暂停/取消/继续（/pause /resume /cancel，
                                #   断点续跑）+ recover_stale_tasks() 重启自动恢复。
                                #   /progress 除 task 外还返回 run{done,total}＝「本轮」口径
                                #   （分母=本轮工作集）；重试用它，否则任务累计口径
                                #   (success+failed) 会把待重试项算成已完成 → 一开跑就 100%
                                #   且不动。计算见 _run_progress()
                                #   重采通道：/start 支持 force（待跑**恰好是这批 ASIN**，
                                #   绕过「已成功就跳过」——否则重采已成功的项会什么都不发生）
                                #   + append（落库写 seq=max+1 追加新版本，否则写 seq=0 覆盖）。
                                #   重采进度与任务计数脱钩，走 ctl.force_done/force_total
    review.py                   # /api/review/*，含 run_review_task()
    sif_keywords.py              # /api/sif/*，SIF 爆品关键词监控：任务 CRUD + 三档频率调度器（daily/every_n/weekly）
                              #   + 分层抓取编排 execute_task() + 看板/趋势/信号/入池/设置/点查路由
    exports.py                  # /api/exports/*（新版后台导出任务）
    pdf.py                      # /api/pdf/*
    ai_analysis.py               # /api/ai/*
    shipment.py                  # /api/shipment/*，货件跟踪（2026-10-19 由独立项目 shipment-tracker 迁入）：
                                 #   货件/产品库 CRUD + 批量改 ETA + 按渠道时效自动算 ETA + JSON/Excel 导入。
                                 #   出入参 camelCase、DB 用 snake_case（db.py 里机械互转）；
                                 #   Excel 导入只把工作簿转成 TSV 文本，列映射解析留在前端（与原项目一致）。
                                 #   权限 admin/root。
  rank_fetcher.py              # 关键词排名抓取器（正则解析，无 bs4 依赖）
  product_fetcher.py           # 产品详情抓取器（bs4 解析 + 反爬：会话池/令牌桶/CAPTCHA/Dog-page检测）；
                              #   含 parse_customers_say()——解析 Customers say（AI 摘要 + 各关注点计数/
                              #   正负面/总结句/评论引用）。Amazon 已改混淆类名，旧 data-hook 选择器
                              #   （cr-insights-widget 等）全部失效，现锚点用 data-testid
                              #   （overall-summary/aspect-label/aspect-summary）+ id=rh_controls_aspect_N。
                              #   全量内容在初始 HTML 中，无额外请求，实测净增约 44ms。
                              #   scrape_product()/scrape_products() 有 with_customers_say 开关（默认 True）
                              #   ⚠️ detailBullets 解析必须**先剥 RTL 控制符**（\u200e/\u200f/\u202a-\u202e）再按
                              #   冒号切分：Amazon 把控制符插在 key 与 value 之间，它们不属于 \s，
                              #   会让 `re.split(r'\s*[:：]\s*')` 切不开 → 整条 li 被丢弃 → productDetails 全空
                              #   （曾因此让「上架时间」整列消失）。注意 parse_product_page 返回的是
                              #   **下划线**键名 product_details，别和接口层的驼峰 productDetails 搞混。
  review_media.py              # 评论媒体（Customer photos and videos）按需抓取 —— **唯一走浏览器 CDP 的模块**。
                              #   评论图片/视频由详情页懒加载 widget cr-customer-videos 提供，端点为
                              #   POST /portal/customer-reviews/ajax/lazy-widgets/stream。该端点**要求有效会话**：
                              #   不带 cookie 返回 0 字节，干净匿名会话同样 0（对照实测 168,632 vs 3,282），
                              #   因此 requests 抓不到，改为驱动本机已开浏览器（cdp-proxy 127.0.0.1:3456）。
                              #   实测单个 ASIN 约 4–9s、仅 1 次 AJAX 请求、返回 13–17 项媒体。
                              #   依赖「浏览器开着 + 已允许远程调试」；不可用时 ensure_ready() 返回明确原因。
                              #   **常驻标签复用**：不再每抓一个就新开标签，而是复用一个常驻标签
                              #   （首次开 about:blank，之后在其中 navigate；抓完停在原地、不返回空白页），
                              #   闲置 10 分钟由守护线程自动关闭；被手动关掉/浏览器重启则下次自动重建。
                              #   实测连抓 3 个 ASIN 标签数净增 1。
                              #   ⚠️ CSRF 是**页面级签名、与 ASIN 绑定**（实测 token(A)+asin=B 返回 0 字节），
                              #   所以「打开目标详情页」这步省不掉，能省的只是「不新开标签」。
                              #   解析要点：响应是 JSON 数组文本（多段 &&& 分隔），HTML 引号处于 \" 转义态，
                              #   必须先 JSON.parse 反转义；选择器用 button[data-mediatype]（span 那条是 See all）；
                              #   图片ID 取 data-physicalid，地址取 data-url（视频给的是 HLS m3u8）。
  sif_fetcher.py               # SIF 抓取器 v2（HTTP JSON-RPC 直连 mcp.sif.com，零第三方依赖；封装关键词域/ASIN域/
                              #   决策域共 14 个工具 + 每日层/每周层编排 run_daily_layer()/run_weekly_layer()；
                              #   密钥读环境变量 SIF_MCP_KEY 或 data/sif-config.json，见"SIF 爆品关键词监控模块"一节）
  sif_signals.py               # SIF 信号引擎（纯本地计算、不消耗 SIF 配额）：读已落库的日快照算出关键词异动与
                              #   ASIN 爆品信号并写 sif_signals；全部阈值取自 sif_settings.thresholds，前端设置页可改
  traffic_compare.py           # AI 流量分析的「取数与指标层」：自身流量结构/趋势/变体/词覆盖 + 竞品自动推荐
                              #   + 同口径对比指标，产出 data/ai-traffic/<id>.json 供 AI 只做解释（见 AI分析模块）
  traffic_report.py            # 流量分析的「报告层」：把 data.json 裁成精简数据包（约 2.4KB）+ 红线 prompt
                              #   → 调模型 → 输出 Markdown，存 data/traffic-reports/<id>.md
  llm_client.py                # 通用模型调用（OpenAI 兼容，默认 DeepSeek）：读 data/ai-config.json，
                              #   零第三方依赖（urllib）。换供应商只改配置，不动代码
  rank_monitor.py              # 排名监测的抓取/快照/变动检测/定时调度。rmon_* 共 8 张表：
                              #   SIF 链路 targets/snapshots/events/settings/queries；
                              #   前台实测链路 srps（榜单快照）/srp_cfg（每词页数）/srp_targets（每天定时）
  routes/rank_monitor_routes.py # 排名监测路由：SIF 即时查询/监测目标 CRUD/快照/事件/导出
                              #   + 前台实测 `/api/rank/scrape/*`（异步抓取/进度/日期快照/趋势/异动/定时目标）
  search_fetcher.py            # 前台实测：抓亚马逊搜索结果页整页榜单（自然位/广告位/标题/价格），
                              #   复用 product_fetcher 的会话（i18n-prefs 货币 + 令牌桶），见「前台实测」
  rank_fetcher.py              # 老版「逐个 ASIN 定位排名」（裸 urllib，无会话，仅 routes/rank.py 在用）

  pdf_splitter.py              # PDF 拆分工具后端逻辑（依赖 pypdf，见 requirements.txt；
                              #   TMP_DIR 锚定在 PROJECT_ROOT/data/pdf_tmp，不是 backend/ 自己的目录）

requirements.txt              # Python 依赖声明（beautifulsoup4/pypdf/openpyxl/Pillow）

index.html                   # 唯一 HTML 入口，引用 styles.css + compiled/bundle.js
styles.css                   # 全局样式（3032 行，按模块分区注释，如 PRODUCT SCRAPE / PDF SPLIT 区块）

src/
  main.tsx                   # ReactDOM.createRoot 挂载 <App/>
  app.tsx                    # App 根组件：登录态(AuthGate)、AppShell(顶层视图路由/Tabs)
  context/ProductContext.tsx # ProductsProvider + useProducts：全局状态、与后端同步逻辑、
                              #   ~19 个 update*() 字段更新函数（updateStage/updateVariant/...）
                              #   + 两个重排函数：reorderProducts（产品级）/ reorderRecords（记录级，
                              #     拖拽排序落地用，只重排数组、不改记录任何字段）
                              #   回收站相关：`trash` 状态（随 GET /api/products 响应一起刷新，无独立轮询）+
                              #   restoreFromTrash/purgeFromTrash/emptyTrash（调完后端接口都用 refreshFromServer()
                              #   整体拉取最新 products+trash 覆盖本地，不走增量 setProducts，避免和其他终端的未同步编辑冲突）
  components/index.tsx        # 通用 UI 组件：StatusChip/StatusSelect/EditField/StageCard/
                              #   RecordCard/SortableRecordCard/AddRecordButton/VariantSelector/FieldHint
                              #   （FieldHint：字段标题 hover 显示计算过程说明的通用 tooltip，
                              #    EditField 新增 hint? 透传给它；生产出货模块的计算字段大量使用）
                              #   SortableRecordCard：用 dnd-kit `useSortable` 包裹 RecordCard，
                              #   只在被 DndContext+SortableContext 包裹时使用，给卡片标题栏加 ⋮⋮ 拖拽把手
                              #   （键盘可用：聚焦把手后空格激活、↑↓ 移动、空格确认）。RecordCard 自身不带
                              #   把手，未接入排序上下文的 Tab 行为完全不变。目前仅生产出货的批次列表使用。
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
    shipment/
      index.tsx                 # 业务：货件跟踪（由 shipment-tracker 迁移，单文件约 800 行）
                                #   两种视图（顶部 ss-seg 切换）：
                                #     ① 状态看板 —— KPI 卡片（可点击筛选，再点取消）+ 按 classify 分区
                                #        预警类（逾期/本周/未来7天/下周核对）默认展开，其余默认折叠
                                #     ② 按发货时间 —— 左侧日期列表（含未填组，倒序）+ 右侧
                                #        发货汇总（可编辑/重新生成/复制，局域网 http 无 clipboard API
                                #        时用 execCommand 兜底）+ 按产品折叠分组 + 整批改送达
                                #   卡片 + 搜索 + 货件表单（40 字段，物流进度 / 报关财务两段）+ 产品库
                                #   + 批量改送达 + 按渠道时效自动算 ETA + Excel 导入预览
                                #   ⚠️ classify/shipKind/detectStore/generateSummary 与
                                #   原项目 app.js **逐行对齐**：判定顺序、阈值（diff<=6/13、
                                #   逾期按 etaEndDate、本周以周日为界）都不要擅自"优化"
    tools/
      KeywordRank.tsx           # 工具：关键词排名监控
      ProductScrape.tsx         # 工具：产品采集（含详情预览弹窗 + 图片 Lightbox + ASIN搜索过滤 + 列头排序；
                                #   结果表列见 findDateFirstAvailable()——「上架时间」取亚马逊详情的
                                #   Date First Available（productDetails 优先、回退 specifications）；
                                #   「评分数量」列取 reviewCount；「分类路径」列已移除
                                #   （categories 字段仍在数据里，只是不再展示）
                                #   多选导出 + 每页50/100/150条分页跳转）
                                #   左栏「历史任务」为紧凑单行列表：今天/昨天/更早分组 + 名称/站点检索
                                #   + 全部/进行中/有失败筛选 + 每页 10/15/25/50 翻页；
                                #   输入区常驻不随列表滚动（.ps-history flex:1 + .ps-hist-list 独立滚动），
                                #   操作按钮悬停/选中才出现，避免挤压任务名
                                #   顶部 BATCH_SIZE 决定每次 POST 带多少个 ASIN（现为 50）；
                                #   后端速率闸门与批大小无关，改小它只会增加 HTTP 往返与后端空等
                                #   输入区采集开关：withCustomersSay（Customers say 评价摘要，默认开，
                                #   几乎不影响速度）；关掉时 customers_say/tags/aspects 三列全部写 NULL。
                                #   withReviews（评论数据，慢）的 checkbox 自 2026-10-15 起**暂时隐藏**
                                #   （JSX 注释包住，state/参数/后端链路均未删），需要时去掉注释即可恢复
                                #   详情弹窗「顾客评价 · Customers say」：摘要整段 + 关注点折叠列表
                                #   （CsAspectRow，点开展示计数/正负面/总结句/评论引用，引用不标截断）
                                #   详情弹窗已 tab 化：「商品信息」/「Customer photos and videos」。
                                #   后者**切过去才挂载**（懒加载 → 才发请求）：优先读缓存；无缓存时
                                #   仅 root 会真正抓取（经本机浏览器 CDP，见 review_media.py），
                                #   其他账号拿到 needsFetch + 一句「请联系管理员」提示。
                                #   网格展示图片缩略图 / 视频（播放图标 + 时长），点击开 MediaLightbox
                                #   （图片给原图；视频是 HLS，给缩略图 + 打开链接；另给「在 Amazon 打开评论」
                                #   —— 评论正文端点 403，拿不到原文，只能跳转）
                                #   工具栏「抓取评论媒体」批量入口**仅 root 可见**（isRoot 门控）：
                                #   右下角浮层显示逐条日志 + 停止；默认随机间隔 20–60s / 单批 ≤25 / 日 ≤50
                                #   CSV 导出（exportCSV，纯前端 Blob）新增两列，均由 customersSayAspects 现算：
                                #     「Customers say 关注点」= Name(N) - X Positive / Y Negative / 情感 · …
                                #     情感值一律英文（Positive / Mixed / Negative），与详情弹窗一致
                                #     「CustomersReview」    = 每关注点一块，**名称**:摘要 + 逐行引用，块间空行
                                #   （**名称** 是 Markdown 写法，CSV 本身无加粗能力）
                                #   工具栏：搜索 ASIN / 重试失败(N) / 导出 CSV / 重采▾
                                #     「重采」下拉两个选项：替换当前记录（覆盖）/ 新增一条记录（追加）
                                #     范围 = 已勾选的，**没勾就重采当前任务全部**（与「导出 CSV」同一约定）
                                #     提交前自动 apiResetSession()（失败/重采多半撞 CAPTCHA）
                                #   表格多一列「采集时间」（scrapedAt），用于区分重采产生的多行；
                                #   行 key 用 asin#seq
                                #   ⚠️ 「导出 Excel（含主图）」按钮自 2026-10-15 起**暂时隐藏**
                                #   （JSX 注释包住，createExportJob 逻辑保留），恢复＝去掉注释
      ReviewFetch.tsx           # 工具：评论采集（多ASIN批量抓取，按评分/排序/是否验证购买过滤）
                                #   ⚠️ 自 2026-10-15 起**前端入口暂时隐藏**（用户要求）：Sidebar 工具
                                #   列表与 app.tsx 的 Tweaks 视图下拉均已注释掉，另在 app.tsx 加了一条
                                #   兜底 effect（持久化的 view 若为 reviewFetch 自动回落 list）。
                                #   组件本身、渲染分支、后端 /api/review/* 全部保留未删。
                                #   恢复：取消这两处「暂时隐藏」注释 + 删掉那条 effect 即可。
      PdfSplit.tsx              # 工具：批量 PDF 拆分（每文件独立配置拆分方式，拆分结果通过浏览器下载）
      AiAnalyze.tsx             # 工具：AI分析（无人值守 shell 出去跑 `Codex -p` 执行 Codex Skill；
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
    production.md             # 生产出货模块深度文档：数据模型/计算链/批次拖拽排序/流程图/已知问题/优化建议
  plans/
    product-scrape-integration-plan.md  # 产品采集模块实施方案（已完成，归档）
  uploads/                     # 参考文档（产品文档等，非应用功能使用）
  screenshots/                 # 文档配图

skills/                        # vendor 进来的 Codex Skill 副本（AI分析模块专用，各自自包含）
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
| `scrape_tasks` / `scrape_products` | 产品采集：任务记录 + 落库的商品详情。`scrape_tasks.with_reviews`/`with_customers_say` 两个采集开关（后者默认 1）；`scrape_products` 的 Customers say 占三列——`customers_say`（AI 摘要整段）、`customers_say_tags`（`Effectiveness(100) · …` 一行；**前端已不再消费它**，导出改由 aspects 现算，留作历史数据备用）、`customers_say_aspects`（JSON，含每关注点计数/正负面/总结句/引用；**详情弹窗与 CSV 两列的单一来源**）。唯一约束是 `(task_id, asin, seq)`——`seq=0` 是正常采集/「重采·替换」覆盖的那条，「重采·新增一条记录」写 `seq=max+1` 保留旧版（**用户显式点击才产生多行**，早期那个「同 ASIN 攒 3 行」是 bug、已修，两回事）；`refresh_scrape_task_counts` 按 asin 去重统计，避免多行让 success 超过 total。另有 `review_media` 列（JSON）缓存评论媒体（图片/视频）——按 **asin** 更新（产品级属性，抓一次多任务共享）；`NULL`=从未抓过、`[]`=抓过但该产品确实没媒体，两态不能混（否则会反复重抓） |
| `review_tasks` / `review_results` | 评论采集：任务记录 + 评论池（按 asin+review_id 去重） |
| `export_jobs` | 后台导出任务（`ExportWorker` 消费，最多2并发） |
| `ai_analysis_tasks` | AI分析任务（`AiAnalysisWorker` 消费，强制串行1并发；`files` 字段是产出文件名列表 JSON；`status` 除 pending/running/done/failed 外还有 `cancelled`；`username` 记录发起人，登录态按用户名分区要用） |
| `sif_tasks` + `sif_kw_snapshots` / `sif_asins` / `sif_asin_snapshots` / `sif_kw_profiles` / `sif_asin_weekly` / `sif_signals` / `sif_runs` / `sif_settings` | SIF 爆品关键词监控 v2：任务配置（方向/模式/词根/配额/频率三档 daily·every_n·weekly + 时刻 + 两层最近运行日 + 失败退避熔断 fail_count/fail_date/next_retry_at）；关键词每日快照（只存当日点，日序列由累积得到，UNIQUE(task,run_date,keyword)）；ASIN 监控池（含静态画像与 last_stat_date）；ASIN 真日粒度数据（UNIQUE(task,asin,stat_date)）；每周需求画像与词根竞品概览（按 ISO 周覆盖）；信号（UNIQUE(date,task,kind,ref_type,ref_id) 幂等）；运行日志（每次分层调用的 stats）；全局设置（thresholds 信号阈值 / defaults 默认配额，前端可改） |

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
| POST | `/api/ai/traffic/preview` | **流量分析取数预览**，body `{asin, periodType?, periodValue?, competitorAsins?, autoCompetitors?}`；同步调 SIF（约 18 次调用/9 秒）算好指标并落盘 `data/ai-traffic/<datasetId>.json`，返回 `{datasetId, data}`。**不创建 AI 任务、不产生 AI 费用**，供用户先确认数据与竞品选择。周期由 `normalize_period()` 归一化（见下），`competitorAsins` 为空且 `autoCompetitors!==false` 时走自动推荐（自身 Top 3 流量词 → 词根头部竞品 → 同类目/价格带过滤）。**不限角色**，任何登录用户可调 |
| GET | `/api/ai/traffic/llm` | 模型配置摘要 `{configured, provider, base_url, model, key_hint}`（**不含 key**），前端据此决定「生成报告」按钮是否可用 |
| POST | `/api/ai/traffic/report` | 生成 Markdown 报告，body `{datasetId, force?}`；**同步**调模型（DeepSeek 约 30~90 秒），返回 `{markdown, meta, cached}`。`force=false` 命中已生成文件时直接返回。错误码：`400 not_configured` / `404` 数据集不存在 / `429 rate_limit` / `502` 鉴权/网络/余额。**不限角色** |
| GET | `/api/ai/traffic/report?datasetId=` | 读取已生成的 Markdown 报告（不存在返回 404） |
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

路由对应的源文件：`/api/login`/`/api/logout`/`/api/me` → `routes/auth_routes.py`；`/api/products`/`/api/trash/*` → `routes/products.py`；`/api/rank/*` → `routes/rank.py`；`/api/scrape/*` → `routes/scrape.py`；`/api/review/*` → `routes/review.py`；`/api/exports/*` → `routes/exports.py`；`/api/pdf/*` → `routes/pdf.py`；`/api/ai/*` → `routes/ai_analysis.py`；`/api/sif/*` → `routes/sif_keywords.py`；`/api/shipment/*` → `routes/shipment.py`。

### 同步机制（详见 `docs/operations.md` 第7节）
客户端每 4s 轮询 `version`，编辑后 600ms 防抖 PUT 带 `baseVersion`；后端乐观锁，冲突时返回服务器最新版本，客户端整体覆盖（`ProductContext.tsx` 中 `versionRef`/`syncedVersionRef` 相关逻辑）。

### AI分析模块（`backend/workers/ai_analysis_worker.py` 的 `AiAnalysisWorker` + `AI_SKILLS`，路由在 `backend/routes/ai_analysis.py`）

不同于其它"工具模块"（本地计算/请求外部页面），AI分析是无人值守 shell 出去跑一次真实的 `Codex -p`（Codex headless 会话），复用 `skills/<Skill>/SKILL.md` 里已经写好的分析流程，不是重新实现一套 agent 循环：

- **并发**：强制串行（`ThreadPoolExecutor(max_workers=1)`），因为单次分析涉及真实 Playwright 浏览器 + Codex API 调用，成本和资源都不便宜。
- **权限**：`AI_ALLOWED_TOOLS` 收窄到 skill 自己声明允许用的工具（`Bash Read Write Edit mcp__playwright__* mcp__sif-mcp__*`），不用 `--dangerously-skip-permissions`/`bypassPermissions` 整体放开——无人值守时被 Codex 自身的安全分类器判定为高风险操作，需要显式收窄权限而非笼统跳过。
- **预算**：`AI_MAX_BUDGET_USD`（当前 `8`）是初始估值，未经真实多次运行校准，跑几次后应参考 `--output-format json` 返回的 `total_cost_usd` 调整。
- **输出隔离**：调用时在 prompt 里显式让 skill 把产物存到 `report/<taskId>/` 而非 skill 自己 `SKILL.md` 里默认的 `report/` 根目录，避免同一 ASIN 反复分析互相覆盖。
- **新增 skill**：`backend/workers/ai_analysis_worker.py` 的 `AI_SKILLS` 字典和 `AiAnalyze.tsx` 的 `AI_SKILLS` 数组各加一条同 `id` 的项即可，Sidebar 的"AI分析"分组、`app.tsx` 的视图路由/Tweaks下拉都是从这个数组派生的，不用逐处手改。
- **登录态按 FBA2 用户名分区**：`amz_login.py`/`amz_alexa.py` 的 `DATA_DIR` 读环境变量 `COSMO_FBA_USER`（未设置时退化为 `default` 子目录），实际存储路径是 `skills/<Skill>/data/<username>/amz_state.json`。`AiAnalysisWorker` 起 `Codex -p` 子进程、`/api/ai/login` 起 `amz_login.py` 子进程时，都把当前 FBA2 用户名注入这个环境变量——环境变量沿子进程继承链一路传到底层脚本，SKILL.md 里的 Bash 指令文字不用跟着改。`ai_analysis_tasks.username` 列记录任务归属，因为 `AiAnalysisWorker` 异步消费队列时原始 HTTP 请求早就结束了，只能从任务行里取。
- **登录态自愈**：`POST /api/ai/run` 建任务前先用 `_check_login_state()`（逻辑照抄 `amz_alexa.py` 的 `check_state_validity()`）检查登录态，缺失/过期时不建任务、返回 `{code: "login_required"}`，前端展示专门的"去登录"状态块（调 `/api/ai/login`），而不是任由无人值守的 `Codex -p` 子进程自己决定要不要交互登录（`build_prompt` 里也显式告诉 Codex 不要在这个场景下自己跑 `amz_login.py`，作为预检查之外的兜底）。
- **终止**：`_run_job` 用 `subprocess.Popen`（而非 `subprocess.run`）保留进程句柄，存进 `self._procs`；`cancel(task_id)` 调 `proc.terminate()` 并记入 `self._cancelled`，`_run_job` 收尾时按这个集合区分「用户终止」和「正常失败」两种终态，不可恢复（没有暂停/继续——活跃的 Playwright 会话/网络连接没法被操作系统级暂停后干净恢复，做不到）。
- **root 专属**：目前"AI分析"整个功能只对 `role: "root"` 的账号开放（`AuthManager._ensure_default_users()` 幂等补充一个默认 `root` 账号，密码见 `data/fba-users.json` 或找部署者，不写进代码仓库文档；不影响已有的 `admin`/`editor`）。所有 `/api/ai/*` 路由（`/api/ai/file` 除外——它靠不可猜测的 taskId 做访问控制，不能挂 Bearer 校验）在登录校验之后都加了 `role != "root"` 时返回 403 的强制校验，前端 Sidebar/app.tsx/TweaksPanel 里的隐藏只是体验层面，真正的门禁在后端。

#### 流量分析（`traffic-compare`）：Python 算数，AI 只写话

和 `cosmo-diagnose`「让 AI 自己调 MCP」不同，流量分析是**两段式**：

1. **取数预览**（`POST /api/ai/traffic/preview` → `traffic_compare.preview()`）：Python 调 SIF 把数据取全、把指标算死，落盘 `data/ai-traffic/<datasetId>.json`，前端画图给用户确认。此阶段**不花 AI 费用**。
2. **生成分析**（待接入，复用 `datasetId`）：`claude -p` 只读这份 data.json 做归因与写建议，**不允许自己重算指标**。

这么设计的原因：1 自身 + 5 竞品 ≈ 22 次工具调用，让 AI 自己调既慢又贵；且原始 JSON 进上下文后，AI 容易把「父体聚合分」和「子体明细」混着比，结论不可复现。指标算在代码里，才能做到「报告里每个数字都能复算」。

**口径红线（已写进 `traffic_compare.py` 的模块 docstring 与 `meta.metric_notes`）**：

- SIF 的 `score` 是**无量纲相对分**，只能讲占比/倍数/涨跌，不得换算成 UV 或绝对流量。
- `overview.ad.<channel>.ratio` 是**占广告**的比例，不是占总量；占总量需 `ad.ratio × channel.ratio`，代码里分别命名为 `share_of_ad` / `share_of_total`。
- 自身与全部竞品必须同 `listingSearch`（默认 `true` = 父体+全子体聚合）、同时间窗。
- `latest_point_complete=false` 时最后一天不参与趋势与环比（否则会误报「今天暴跌」）。
- 渠道/变体缺失 = 无数据，**不补 0、不进分母**。
- 竞品可比性用 `category_id` 路径前缀判断（实测 `category_name` 层级不统一：自身 `Baby`、竞品 `Baby Burp Cloths`，直接字符串相等会误判跨类目）。

**竞品自动推荐**：自身 Top 3 流量词（按 `traffic_share`）→ `market_get_keyword_root_competitors` → 按命中词数/覆盖搜索量聚合 → 排除自身与同品牌 → `market_get_asin_profile` 补价格/类目并标注「跨类目 / 价差 >50%」。**warnings 只做标注不做排除**（曾因把 warnings 当过滤器导致候选全被滤光、竞品数为 0）。

### 排名监测（`rank_monitor.py`）

两个方向、三种「排名」口径，**字段名刻意分开，页面也必须分开标注**：

| 字段 | 来源 | 含义 |
|---|---|---|
| `share_rank` | `market_get_keyword_competition` | 该词下的**流量份额排名**（按 total_share 排） |
| `organic_rank` | `market_get_asin_keyword_signals` | SIF 观测的**自然搜索位**（null = 无自然位，不等于排名靠后） |
| `aba_rank` | `market_get_asin_aba_footprint` | ABA **买家实际点击**的第 1/2/3 位 |

同一个 ASIN 在同一个词上可以同时「不在份额榜 + 自然第 130 位 + ABA 未进 top3」。
`total_share` 量级与市场 Top3 点击份额对不上（前者 Top3 合计 1.4%、后者 61.2%），
**只能用于排序，不可当百分比展示**。

- **表**：`rmon_targets` / `rmon_snapshots` / `rmon_events` / `rmon_settings` / `rmon_queries`
  （SIF 链路）+ `rmon_srps` / `rmon_srp_cfg` / `rmon_srp_targets` / `rmon_asin_meta`
  （前台实测链路 + ASIN 静态属性缓存，见下一节）。
  **前缀 rmon_ 是必须的**：项目里已有 SIF 爆品监控用的 `rank_snapshots`，同名建表会被
  `IF NOT EXISTS` 静默跳过，然后索引报 `no such column`。
- **阈值**集中在 `rank_monitor.py` 顶部：`RANK_STEP_ALERT=10`（自然排名变差位数）、
  `SHARE_RANK_STEP=5`（份额排名变化位）、`TOP3_SHARE_STEP=0.05`（Top3 点击份额变化）。
- **首次抓取不产生事件**（没有基准，产生全是噪音）；同一天重跑覆盖当日快照，不累积。
- **定时**：`RankMonitorWorker` 每 5 分钟检查一次。
  因为 SIF 的份额榜与 `organic_rank` 都是**周维度**（同一周期内重复抓结果完全一样，官方口径：
  自然位是「周期内最后一次抓取值」），所以 `daily` 目标**也按「距上次 ≥6 天」限制**，
  `weekly` 只在周一跑；目标之间 `RUN_GAP_SEC=1.5` 秒串行，防撞 SIF 的 QPM 40。
  早先 daily 是真每天跑，结果是同一周内存七份完全一样的快照、趋势图上一串重合点。
- **左栏只有一个「记录」列表**（2026-10-28 简化）：`rmon_queries`（SIF）与 `rmon_srps`（前台实测）  混排、按时间倒序，每项带来源标签 + 结果摘要 + 单条导出（CSV / Excel）+ 删除。
  定时信息**挂成记录上的徽章**（`每天 09:00` / `每周一`），不再单独占一块「定时监控」区域 ——
  曾经是「定时监控（折叠）+ 查询记录」双层结构，用户抓完榜单在两个地方都找不到，看着像数据没变。
  · 只加了定时、还没跑过的词补一条「待首次抓取」，否则加完监测在列表里看不到它
  · 徽章上的暂停/删除直接作用于对应的 target（`toggleSrpTarget` / `toggleSifTarget`）
  · 切换记录时按词判断清空对侧数据，避免出现「上下两块显示不同词的数据」。
- **监测详情页已删除**（`MonitorDetail` / `Fold` / 「返回双栏」）。点任何记录，右栏直接显示
  A/B 两块；不再有「点进去看详情 → 再返回」这一层，也就不需要返回按钮。
  原先详情页里的历史快照、变动记录、采集设置，现在分别由左侧记录列表、A 区异动流、配置弹窗承担。
- **快照存全量 100 条**（`TOP_N_KEEP=100`），前端默认显示 20 行 + 「展开全部」，别在后端截断。
- **我的卡位有两级兜底**：`my_position` 判 `absent` 时先扫份额榜（可能仍在榜内，只是卡位不足），
  榜内也没有就**额外查一次 `asin_keyword_signals` 补自然搜索位**（`asin_organic_rank`）——
  用户问「我这个 ASIN 在这个词排第几」，十有八九想问的是这个，不是份额名次。
- **额外指定的 ASIN（`rmon_targets.extra_asins`）**：用户可以在「采集设置」里手填任意 ASIN，
  和「我的 ASIN + 份额前 N 名」一起采自然位。库里存 JSON 数组串，
  统一用 `rank_monitor.parse_extra_asins()` 解析（兼容 list / JSON / 逗号 / 空格 / 中文顿号，
  自动大写去重，上限 `MAX_EXTRA_ASINS=10`）。
  · 采集范围顺序：我的 ASIN → 份额前 n → 额外 ASIN（去重）
  · 快照里同时写 `extra_asins` 字段，**趋势图靠它才知道要画这几条线**（它们不在 `top` 里）
  · 每个额外 ASIN = **+1 次 SIF 调用/次**，前端在采集设置里实时显示总调用量
- **查询历史按天去重**（`add_rank_query`）：同一天、同一目标**只保留一条**，
  重查会先删当日旧行再插入。之前是纯 INSERT，早上查一次下午再查一次，列表里就是
  **两条一模一样的记录**，看起来像「点一下刷新多出一条」。趋势按天取点，本来也只用最后一条。
- **变动记录同日重跑不重复**（`_run_target_locked`）：同日刷新时基准仍是「上一个不同日期」，
  diff 结果和第一次相同，所以写之前先 `clear_rank_events_on(tid, today)`；
  不清理就会每刷一次追加一遍（症状同样是「两条一样的记录」）。
- **⚠ `organic_rank` 是复合串，必须走 `sif_fetcher.parse_rank()`**：SIF 原始值是
  `"p{页},{页内位次}/{每页条数}"`（如 `"p1,2/48"`）。用 `_num()` 会先把逗号去掉变成
  `"p12/48"`、再正则取第一段数字 → **12**，于是「第 1 页第 2 位」被存成「第 12 位」，
  整列自然位全是脏数据（2026-10-28 修复）。绝对位次 = `(页-1)*48 + 页内位次`，
  换算后与 SIF 官方 `rankAvg` 逐词吻合（`p1,2`→2 vs rankAvg 2；`p2,42`→90 vs 84）。
- **`organic_rank` 的口径（官方 schema 原文）**：「自然排名 = 所选周期内**最后一次抓取值**，
  与官网列表「最新自然排名」列同口径；`null` 表示该周期内未出现在自然位」。
  配套字段 `organic_rank_time_cn/us` 是该值的**抓取时间**。
  所以它不是日均值、也不是当日实时排名——**同一周期内重复抓取值不变**，
  这正是「每天抓到的自然位完全一样」的原因（先用时间字段确认，别急着当 bug 修）。
- **MCP 没有「每词每日自然排名」序列**：`ops_get_asin_traffic_trend_detail` 虽支持
  `granularity=day`，但日粒度下 `pchangeReason.nfInfo.rankAvg` 为 `null`，只给
  `change`（如 `"11_10"`，官方 schema 未定义其格式）；周粒度才有 `rankAvg`（期内均值）
  + `inFre`（期内出现天数）。要做每日曲线只能等 SIF 开放或自行爬前台。
- **竞品份额榜有「自然位」列**：直接读快照里的 `data.organic`（`{asin: rank|null}`），
  采集范围内 **0 次额外调用**即显示；范围外的行才显示「查」按钮按需查 1 次。
  注意 `organic` 里**没有 key 表示没采集**，`key=null` 表示「查了确实没有自然位」，两者不能混。
- **趋势条数跟随采集设置**：`/api/rank/trend` 的 `topN` 默认取该目标的 `competitor_n`（1~15），
  前端 `apiTrend(id, cn)` 把「采集设置」里的 cn 直接传过去，cn 变化会立刻重画。
  曾经前端写死 `topN=5`、后端又 `min(5, …)` 截断，结果配了 10 个竞品也只画 5 条。
  前端还会**过滤掉全 null 的线**（配大了但还没采到的末尾竞品），否则图例有、图上没有，像丢数据。
- **大块 JSX 重排后要统计渲染点数量**：`KeywordKpis` / `KeywordResult` / `AsinResult` 曾被
  重复渲染成「两套 KPI + 两张竞品份额榜」，这类重复 tsc/build 都不报错，只有肉眼能发现。
- **折线图支持单点**（`LineChart`）：守卫从「至少 2 天」放宽到「至少 1 个点」，
  `n===1` 时 path 只有一个 M 点画不出线，额外渲染圆点。
- **查询也留痕**：`/api/rank/query` 成功后自动写 `rmon_queries`（kind/value/own_asin/summary/data/username），
  支持列表、详情回看、单条删除、清空；导出 Excel 走 `/api/rank/export?id=`（单条）或 `?all=1`。

#### 前台实测（爬虫抓搜索结果页，`search_fetcher.py`）

**与上面的 SIF 链路完全隔离**：数据存 `rmon_srps`，接口全在 `/api/rank/scrape/*`，
页面上也不做交叉对比。同一个 ASIN 两边数字不一样是**正常的**——
SIF 是周期内最后一次采样值，爬虫是点击那一刻的实测值，中间排名变了就会不同；
何况亚马逊本身给不同 IP/会话的顺序就有差异。加「差异列」只会让人纠结该信哪个。

- **必须复用 `product_fetcher` 的 `SessionState`**，不能裸 `urllib` 请求：
  · 会话里预置 `i18n-prefs=USD` + `warm_up_session()` 先拿 cookie，
    否则本机出口 IP 被地理定位成日本用户，`amazon.com` 也返回 **JPY 价格**（实测 8,995/11,520）
  · 每次响应后要**覆写回 `i18n-prefs`**（Amazon 会改它）
  · 令牌桶限流 + Cookie 池是躲 503 的前提
- **页数 1~5，默认 3，且是「每个关键词一份」**（`rmon_srp_cfg`）：每页实测 48 个卡片，
  所以**页数 = 请求数**。5 页 = 240 位是上限，再往后基本是无关长尾，且请求越多越容易被拦。
  不同词的榜单深度需求不一样（头部词 2 页够、长尾词要多翻几页），所以不再用全局一个值：
  抓取时传了就存到该词名下；不传则依次回落「该词配置 → 全局默认 `scrape_pages` → 3」。
- **结果页是上下两块并列，不是 tab 切换**：`A · 前台实测（爬虫）` / `B · SIF 平台数据`，
  各自带独立空状态（没抓过 / 没查过都会提示下一步该点哪个按钮）。
  曾经做成 tab 互斥，用户只看到一块，以为另一块的数据没出来 —— 这两块要「同时可见」。
- **限速实测**（US 站，本机住宅 IP）：短间隔连发 3~4 次即 503，静默 60~90s 恢复；
  页间 14~24s 随机、首次退避 25s、二次 60s、三次 120s 都能过。
  **同一时间只允许一个抓取任务**（`scrape_busy()`），并发只会互相加剧限流。
- **软限流降级页要识别**：200 但 `s-search-result` 为空 → 记 `no_cards` 并重试，
  不能当「这个词没结果」；真没结果页有明确文案（`No results for` / `did not match any products`）→ 记 `empty` 且**不重试**。
  卡片数 < 10 视为异常，整页丢弃不写脏数据。
- **广告判定**用多重信号（本地化「赞助」词 + `s-sponsored-label` / `AdHolder` / `puis-sponsored`）。
  注意页面上还有大量 `Sponsored Ad - xxx` 的**独立广告横幅模块**，它们不在搜索结果流里，
  本就不该计入 —— 曾据此误判「广告识别失灵」，实际是搜索流里只有 1 个广告位。
- **榜单表每行带「页数」和「销量」**：`page` 在 `fetch_srp` 跨页合并时写入（`it["page"] = page`），
  `sales` 由 `_SALES_RE` 从卡片里抽「`500+ bought in past month`」得到，只留量级（`500+`）。
  实测一页 60 个卡片里约 22 个有销量 —— **其余是亚马逊本来就不展示**，`None` 不是 0，页面显示「—」。
  两者的意义不同：自然位是跨页累加的全局位次，页数是这条结果落在第几页（每页约 48~60 个卡位）。
- **首屏自动选中必须等四个列表都加载完**（`initDone`）：`queries` 常比 `srpList` 先返回，
  若「records 一非空就选第一条」，会选中一条只有 SIF 的临时记录，A 区被 `setScrapeSnap(null)` 清空，
  表现为「第一次进来 A 没数据、再点一次才出来」。选中时优先挑 `scrape && !scrape.pending` 的那条。
- **上架日期搜索页拿不到**（实测 1.6MB 原始 HTML 里 `Date First Available` 出现 **0 次**），
  它只在商品详情页。但「一个词 60 个 ASIN = 60 次网页请求」必被封，所以改走 SIF。
  · ⚠ **`market_get_asin_profile` 的 `first_available_day` 覆盖率极低**：实测某词 145 个
    ASIN 只有 **6 个**有值，连 2013 年的老品都是空串（不是新品才缺）。所以它只能当兜底。
  · **主源改成竞品份额榜的 `listed_age_days`（上架天数）**：实测 100/100 齐全，
    而且这份数据 B 区本来就要拉，从已存的 `rmon_queries.data.top` 里读 —— **零额外调用**。
    日期 = 今天 − 天数，所以 `rmon_asin_meta.src` 记 `age` 表示「换算式」，
    tooltip 必须注明「可能差 1 天」，不能当亚马逊原文。
  · 三路取数顺序：缓存 → 竞品榜天数 → asin_profile。**竞品榜要能覆盖缓存里的空值**，
    否则早期把「没有日期」写进负缓存后永远补不上（踩过）。
  · 实测补齐率：4%（只用 asin_profile）→ **58%**（144 个里 84 个）。剩下的都是
    排名 100 以后、不在竞品榜里的长尾 ASIN，SIF 确实没有。
  · 详情页兜底**已验证不可行**：抓回来 2.1MB 但可见文本为空（降级页），且成本是每 ASIN 1 次请求。
- **榜单表点表头排序**（`sort` state）：循环「升序 → 降序 → 恢复原始顺序」。
  空值（广告位没有自然位 / 商品没展示销量 / SIF 无上架日期）**无论升降都恒排最后**，
  否则降序时它们会全部冒到第一屏。销量列要按数值排，不能按字符串：
  `1.2K+` 必须大于 `500+`（正则取数字+单位换算）。
- **「获取最新数据」按天分组去重**（`save_rmon_srp` / `add_rank_query` 返回 `{changed, id}`）：
  · **跨天**：每天至少一条，保证趋势/热力图不断点
  · **同天**：与当天最后一条比对指纹 —— 相同则只更新 `checked_at`（不新增），不同则**追加**一条
  · 指纹只取**结构**（榜单 = ASIN 顺序 + 自然位 + 广告标记；SIF = 份额 + 自然位），
    **不含价格/评分/销量**：这三样每次抓都在变，纳入比对等于每次都是「有变化」，
    一天点 5 次就 5 条，去重形同虚设。
  · ⚠ 老库有 `UNIQUE INDEX ux_rmon_srps(keyword,country,snap_date)`，**必须 DROP**，
    否则同日第二条直接报 `UNIQUE constraint failed`（一开始就是这么踩的）
  · 升级前的老记录 `fingerprint` 为 NULL：保存时会用它自己的 data 现算一次补上，
    否则第一次点击会误判成「有变化」而凭空多一条
  · 实现在 `backend/fingerprint.py`（单独成文件是为了 db 层也能用，避免循环依赖）
  · 「无变化」那几次写 `rmon_checks` 留痕（只存时间+一句话，不存快照），
    前端显示「上次检查 15:22」
- **暂停/继续是 A、B 各自一份**（`.rk-li-pause`，就在各自那行末尾的徽章右侧）：
  · A 走 `apiSaveScrapeTarget({enabled: !enabled})`，只停「每天自动抓取」，已抓到的榜单不动
  · B 走 `apiUpdateTarget({id, paused})`，只置暂停，不删目标（历史快照要留）
  · ⚠ 列表项主区从 `<button>` 改成了 `<div role="button">`：行内要放暂停按钮，
    按钮套按钮是非法 HTML，点击还会连带触发「打开记录」。改完要保留键盘可达（Enter/Space）
  · `.rk-li-row` 的网格从 3 列改成 4 列（来源 / 摘要 / 徽章 / 暂停），没有定时的行补一个空
    `<span />` 占位，否则列会错位
- **趋势在定时任务跑完时顺带刷新**（`RankMonitorWorker._refresh_trend`，`force=True` 绕过 12h 缓存）：
  否则定时跑完趋势还是旧的，只有你打开页面才会去取。
- **关键词搜索趋势走 `market_get_keyword_history`**（不是 `root_trend`）：
  要的是「这个词自己」的周搜索量与 ABA 排名，`root_trend` 是词根含长尾的盘子，两者口径不同。
  · 缓存 12 小时落 `rmon_kw_trend`（ABA 是周数据，一天内不该反复变化，也不该反复烧调用）
  · 前端 `KeywordTrendCard`：**两条曲线同图 + 左右双 Y 轴**。搜索量 0~20 万、排名 0~5000，
    共用一根轴时排名线会被压成贴地直线，所以 `Series` 加了 `axis: left|right`，
    `LineChart` 按左右各自算值域（`dLeft` / `dRight`），右侧刻度用橙色、右列留 62px。
  · 排名用 `negative` 反转，让「名次靠前」显示成「线在上」；右轴刻度因此是
    「越往上数字越小」—— 别照着数值大小去改，会反。
  · **点图例单独查看**（`legendClick`）：点一条只画这一条，再点同一恢复两条。
    关键点：只画一条时另一侧值域为 `null`，网格必须退化成「有哪侧用哪侧」，
    否则单看排名时整张图空白。切换时间范围时要重置 `only`，不然索引可能越界。
- **自然位是跨页累加的**：`org` 只对非广告卡片 +1，广告卡片 `org=None`。
  所以「自然位 92 / 总条目 96」是正常的（4 个广告位不占自然位）。
- **趋势聚合只留常驻者**（`build_srp_trend`）：一个词一天 144 条，直接按 ASIN 画线会糊成一片。
  只保留「出现 ≥2 天」或「最近一次仍在榜」的 ASIN，其余只出现在榜单表和异动里。
  **主视图用热力图（日期 × ASIN）而不是折线** —— 位次是「存在/缺失」的离散事件，
  折线要么断开、要么连出误导性的直线，热力图空白格天然表达「掉榜」。
- **异动流阈值**：`SRP_TOP_N=20`（只看前 20 名的进出）、`SRP_STEP_ALERT=10`（位次变化 ≥10 位才算）。
  设太小会天天报警 —— 亚马逊自身排序就有 ±2~3 位抖动，同一时刻不同 IP 抓到的顺序都不完全一样；
  报警一多用户就再也不看了。事件类型：`drop_out` / `enter_top` / `down` / `up`，
  按严重度排序后返回（掉榜 > 新进 > 下跌 > 上升）。
- **异步任务必须**：3 页要 1~2 分钟（页间限速），同步请求浏览器早就超时了。
  任务记录放内存（15 分钟过期），结果本身落 `rmon_srps`，过期不影响数据。
- **定时抓取走独立表 `rmon_srp_targets`**（keyword / pages / daily_at / enabled），
  与 SIF 的 `rmon_targets` 分开：那条是周数据 + SIF 配额，这条是每天爬搜索页 + IP 限流，
  节奏约束完全不同。`RankMonitorWorker` 里单独一段处理，同一天只跑一次、到点才跑，
  且与手动异步抓取共用 `_SRP_RUN_LOCK` 互斥锁（若用户正在手动抓，定时抓取自动顺延至下一轮，防止并发撞 503）。
- **双入口交互**：
  · 左栏「查询 / 抓取」按钮或回车键：弹出 `RunConfigModal`，支持 A/B 两组同时勾选并配置每日自动抓取 / 每周 SIF 监测；
  · 右栏顶部 `.rk-setup` 卡片：A 区「立即抓取」直接按所选页数抓搜索页，B 区「立即查询」直接查一次 SIF，无需重复弹窗。
- **A 区支持「我的 ASIN」卡位识别、商品主图与 CSV 导出**：
  · 填写「我的 ASIN」后，A 区 KPI 第四格直接展示自然位次/广告位状态，表格对应行 `.rk-mine` 高亮；
  · 表格渲染商品主图缩略图（悬停放大）、评论数，并支持按 ASIN/标题实时过滤及一键导出 UTF-8 BOM CSV。

  **注意**：`_user(self)` 只判空、返回 user，需要记发起人时必须接住返回值 `user = _user(self)`，
  否则 except 会把 `name 'user' is not defined` 吞掉，表现为「逻辑没生效但不报错」。
- **导出分两个 sheet**（`rank_export.py`，openpyxl）：关键词竞品榜 / ASIN自然排名。
  两种结果列结构不同，不硬塞一张表。
- **趋势画的是自然位，不是份额排名**：`fetch_keyword` 抓完份额榜后会额外查
  「我的 ASIN + 份额前 N 名」的自然搜索位，存进快照的 `organic: {asin: rank}`；
  `_series_from_docs` 关键词维度只读 `organic`，**不读 `share_rank`**。
  调用量从 1 次变 1+N 次（`track_organic` 默认 **5**，即「我的 ASIN + 份额前 5 名」= 最多 6 次，
  实测整词抓取约 24 秒；传 0 可关掉省配额）。
  ⚠ `track_organic` 必须 ≥ 趋势图要显示的竞品数（`build_trend` 的 `top_n`，默认 5，路由上限也收到 5），
  否则多出来的线永远是空的——曾经一个 3 一个 5，图上就是两条永久空线。
  补采之前的老快照没有 `organic` 字段 → 曲线全空，UI 要明确提示"下一次抓取后才有"，别画空图。
  ⚠ **采集失败绝不能写 `None`**：`None` 的语义是「查了，确实没有自然位」，失败写成 None
  会让趋势变成「自然位消失」，是假数据。失败一律记进 `organic_failed`，key 不进 `organic`，
  前端在 B 区提示「N 个竞品没采到，图上空白 ≠ 没有自然位」。
  ⚠ 自然位/份额排名**一律取整**（`_rank_of` / `_rank_int` / 前端 `Math.round`）：
  SIF 返回 `12.0` 这种浮点，直接插值会显示成「#12.0 第2页」。
- **配置全部下沉到单个关键词**（2026-10 交互改版）：
  · `rmon_targets.run_at`（HH:MM，空=当天首次检查即采集）、`competitor_n`（1~15，默认 10）、
    `freq`（daily/weekly）、`paused`
  · 全局只保留 `rmon_settings.default_competitor_n`，仅用于「加入监测」弹层的预填值，不参与调度
  · **`get_rmon_settings()` 只返回白名单键** —— 老库可能残留已废弃行（如 `daily_at`），
    不过滤会跟着返回，UI 上像"删了还在"（实际踩过一次）
  · `competitor_n` 同时决定「采集几个竞品的自然位」和「趋势图画几条线」，**两者必须是同一个数**
- **采集时刻**：`RankMonitorWorker` 每 5 分钟检查，`paused=1` 跳过，到该目标自己的 `run_at` 之后才跑；
  weekly 仍限周一。
- **加入监测也走同一个配置弹窗**（`RunConfigModal`）：竞品数/时刻/频率/我的 ASIN 都在里面，
  不再有独立的 `AddTargetModal`。弹窗里会算「每次约 N 次 SIF 调用」（`1 份额榜 + (n+1) 自然位 + 1 批量档案`）。
  ⚠ **打开时必须带出该词已有的定时配置**（`srpSched` / `sifSched` 两个 prop）。曾经硬编码
  `setSrpDaily(false)`，结果顶部显示「已加入每天 07:00 抓取」而弹窗里没勾上 —— 用户看到的是自相矛盾。
  ⚠ **取消勾选 = 停掉定时**：爬虫侧写 `enabled:false`（保留已抓到的榜单），SIF 侧设 `paused:true`（不删目标，
  历史快照要留）。早先只处理「勾上」，取消勾选点了确定后台还在跑。
- 错误提示统一用顶部 toast（4.5 秒自动消失），不占左栏空间。
- **ASIN 悬浮弹窗**：档案来自 `asin_profiles`（批量 ≤20 个/批，**1 次调用**，查词时预取进
  `data.profiles`），不用产品采集爬虫（那个每个 3~10 秒还有反爬）。
  浮层必须 `createPortal` 挂到 body —— 表格容器是 `overflow:auto`，普通 absolute 会被裁掉；
  鼠标从 ASIN 移到浮层靠「220ms 延迟关闭」保住。点击弹窗用 `/api/rank/asin-history` 拉逐日记录。
- **排名趋势有两个数据源**（`build_trend()` + `/api/rank/trend`）：
  ① 传 `targetId` → 用每日快照 `rmon_snapshots`（间隔规则，最准）；
  ② 传 `kind` + `value` → 用该目标的**查询历史** `rmon_queries`（间隔不规则，同一天只取最后一次）。
  后者让「没建监测目标」的用户也能看趋势——反复查同一个词本身就是时间序列。
  关键词维度出「我方份额排名 + 前 N 名竞品排名」，ASIN 维度出「主要 N 个词的自然排名」。
  ⚠ 排名的数字**越小越好**，折线往下是变好，UI 必须写清楚，否则会被读反。
- **SIF 前台的「变体自然位排名趋势」MCP 没有开放**（24 个工具里无变体级自然位接口），
  别去找；能做的是 ASIN 级排名趋势，自己算。
- **两种动作别混**：`/api/rank/query` 是即时查询（抓一次直接返回，结果只进 `rmon_queries` 历史，
  不建监测目标、不产生每日快照）；`/api/rank/targets` 才是加入监测（之后每天抓并存快照做变动检测）。

**时间维度归一化（`normalize_period()`，所有时间入参的唯一入口）**

SIF 的时间参数有硬约束，且**违反约束的表现不一致**（有的报错、有的静默空数据），因此前端不直接拼参数，统一交给 `normalize_period()` 纠正并在 `meta.period_notes` 里说明：

| periodType | periodValue 合法值 | 实测行为（2026-10-21） |
|---|---|---|
| `latelyDay` | `'7'` / `'30'` | 传 14/45/90 直接「参数错误」→ 收敛到最近档位并提示 |
| `week` | 该周**周日**日期 `'2026-10-11'` | 传周三**不报错**，返回 `total=None`（静默空数据）→ 自动对齐到周日 |
| `month` | 月初 `'2026-10-01'`（`'2026-10'` 也接受） | 正常 |

- 未指定周/月时默认取**上一个完整周/上个月**（当周当月因 T+1 延迟不完整，会额外提示）。
- 前端 `AiAnalyze.tsx` 里同款对齐逻辑（`weekSundayOf()`）用于输入框旁的实时预览，后端仍会再校验一次，双保险。
- 趋势接口走 `beginDate`/`endDate`（周/月）或 `lastDays`（近 N 天），保证概览/结构/词覆盖/趋势四个接口取的是**同一段时间**。

**权限**：`routes/ai_analysis.py` 的 `PUBLIC_SKILLS = {"traffic-compare"}` 里的技能不挂 root 门禁（只用 SIF 公开数据、不碰 Amazon 登录态与本机文件），其余技能仍限 root；`/api/ai/tasks` 不带 `skillId` 时仍只给 root。前端 `AI_SKILLS` 用 `rootOnly` 标记，`visibleAiSkills(isRoot)` 统一算可见列表，Sidebar / app.tsx 视图路由 / Tweaks 下拉三处都从它派生。

**报告层（`traffic_report.py` + `llm_client.py`）：直接调模型接口，不走 `claude -p`**

流量分析只需要「读 JSON、写 Markdown」，不需要 agent 能力（不开浏览器、不调 MCP），所以**不用 claude 子进程**：

- **配置**：`data/ai-config.json`（`{provider, base_url, api_key, model, temperature, max_tokens, timeout}`，data/ 已 gitignore）。默认 DeepSeek，任何 OpenAI 兼容服务都能用（换 `base_url` + `model` 即可）。环境变量 `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` 可覆盖。配置缓存 30 秒，改完不用重启。
- **先裁剪再喂**：data.json 约 76KB，整份塞进模型既贵又容易抓错重点。`build_brief()` 压成约 2.4KB 的「精简化验单」，**所有比例已乘 100 并改成 `_pct` 字段**，模型只负责抄，不负责换算。
- **红线写在 system prompt**：只准引用不给推算、不许把相对分换算成 UV/曝光、不许编因果、不许说「掉出前三页」、BSR 改善率已取正。
- **输出 Markdown**（不是 HTML）：页面用现成的 `marked` 渲染，省 token 且不会跑版。落盘 `data/traffic-reports/<datasetId>.md` + 同名 `.json`（模型/耗时/token 元数据）。
- **渲染前净化**：模型输出属于半可信内容，前端 `sanitizeHtml()` 会剥掉 `<script>` / `<iframe>` / `on*` 事件属性再塞进 `dangerouslySetInnerHTML`。
- **成本参考**：一次生成约 2700 prompt token + 4200 completion token（其中约 2500 是思考），DeepSeek 约几分钱。
- **推理型模型要留够输出额度**：`deepseek-flash` / `*-reasoner` 会先返回 `reasoning_content`（思考）再给 `content`（正文）。`max_tokens` 太小时 token 全被思考吃掉，`content` 为空且 `finish_reason=length` —— 这种"看着成功其实空"最容易误判成配置错。`llm_client.chat()` 已识别该情况并提示调大 `max_tokens`，默认值因此设为 8000（思考 + 2000 字正文）。

**已知坑**：`sif_fetcher.asin_listing_keywords()` 曾把返回键误写成 `data.get("list")`（真实键是 `asins`），导致该函数恒返回空列表，2026-10-21 实测修正；同时补齐了 `listing_traffic_overview()` / `listing_traffic_structure()`（后者按 `chars.dims[i]` 与 `chars.nfs[i]/ads[i]/...` 同下标配对，调用方不会错位）和 `asin_traffic_trend_full()`（返回 `latest_point_date` / `latest_point_complete`，并支持 `begin_date`/`end_date`）。

**登录态持久化（2026-10-27）**：Token 落在 `data/fba-tokens.json`（与 `fba-users.json` 同目录，
`data/` 已 gitignore），启动时 `_load_tokens()` 恢复未过期的登录态，有效期 `TOKEN_TTL_DAYS=30`。
**早期 Token 只在内存里，服务一重启全员被登出**：前端拿不到数据 → 各列表变空，
表现像「数据被清空」，实际是读不到。`_save_tokens()` 用 `.tmp` + `os.replace` 原子写。
前端 `api()` 抛错带 `status`，401 转成 **sticky toast**（不自动消失），文案明确说
「不是数据被删了，是登录态过期」，不再让用户误判。

**超时与重试**：`call_tool(name, args, timeout=60, retries=0)` —— 默认不重试。
重接口（`market_get_keyword_competition`、`market_get_asin_aba_footprint`）自带
`timeout=90, retries=1`：`competePattern` 要拉前 100 名竞品，**实测 51 秒**才返回，
60 秒超时线很容易踩到，报错形如 `请求失败：/api/search/competePattern?... Read timed out`。
重试只对网络类错误生效（超时/连接断开/5xx）；**fatal 错误（配置/鉴权/工具不存在）一次都不重试**；
限流与配额耗尽也不重试（交给调度层退避）。注意 SIF 按 tools/call 计费，超时那次通常已计费，
重试会再花一次，所以只给重接口开。

**限流**：SIF 有 **QPM 40/60秒** 限制（实测 1 次 `tools/call` = 1 个额度，滑动窗口）。

**全局 QPM 闸门（`_acquire_slot()`，2026-10-27 加）**：所有调用（定时抓取 / 手动刷新 / 异步查询 /
批量查自然位 / 悬浮档案）**共用同一份额度**，按 `60/QPM_LIMIT`（默认 34/分 → 间隔 1.76s）均匀排队。
超额的调用是**排队等待**，不是失败 —— 之前各条路各走各的，一叠加就报
`当期订阅QPM限制已达上限(40/40)`。可用 `SIF_QPM_LIMIT` 环境变量调整。
撞到限流时 `call_tool` 会等 `QPM_COOLDOWN_SEC=15` 秒重试，最多 `QPM_RETRIES=3` 次，
**不受 `retries` 参数控制**（限流不是真失败，抛出去只会让上层写出假数据）。

**抓取互斥（`_capture_lock`）**：`run_target` 同一时间只允许一个在跑，拿不到锁就返回
`{"busy": True}`（路由回 429）。定时、手动刷新、批量查询并发时会互相烧额度，
而且会覆盖同一目标的快照。一次完整取数约 18 次调用，正常单次没问题，但连续快速点两次预览会撞「当期订阅QPM限制已达上限(40/40)」。竞品属性已改为批量取（省 4 次），其余不再激进优化；错误信息原样透传给前端。

### SIF 爆品关键词监控模块（`backend/sif_fetcher.py` 抓取器 + `backend/sif_signals.py` 信号引擎 + `backend/routes/sif_keywords.py` 路由/调度/编排 + `SifKeyword.tsx` 前端视图）

面向亚马逊选品的"爆品 + 关键词"双线监控：通过 **HTTP JSON-RPC 直连 SIF 的 MCP 端点**（`https://mcp.sif.com/mcp`，Streamable HTTP，`tools/call`），**不经过 Codex / LLM**，抓取结果全是 SIF 预生成的结构化 JSON（`_formatted` LLM 展示块在 fetcher 层裁掉）。数据每日刷新（`data_notice` = "refreshes daily, 1-day delay"），所以按天抓取能捕捉真实变化。深度文档见 `docs/modules/sif-keywords.md`。

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
- **失败退避 + 熔断（防无限重试）**：单次运行抛硬异常不再每分钟重烧配额——`mark_sif_task_failed()` 记 `fail_count` 并按 5m→30m→2h 指数退避写 `next_retry_at`，`_freq_hit` 早于频率判定做闸门拦截；当天第 4 次失败熔断到次日计划时刻，成功一次清零，手动「启用」也会清零。`SifError.fatal`（密钥未配/HTTP 401·403/工具不存在）直接停用任务，一次都不重试。任务卡片展示「第 n 次失败，HH:MM 重试」或「已熔断，明日自动恢复」。
- **v1 → v2 迁移**：旧版单表 `sif_snapshots`（detail 里冗余存 60 周历史）与新结构不兼容，`_init_db()` 检测到 `sif_tasks` 缺 `freq_type` 列即 DROP 旧 `sif_tasks`/`sif_snapshots` 并重建 v2 表——**旧任务与历史快照会被清空**（本次升级已与用户确认）。
- **SIF 已知坑**：批量工具（demand/history）实测单次最多返回 10 词，必须分批；`market_get_asin_keyword_signals` 用 `time_type=lately` + `time_value='7'|'30'`（`week` 需传该周**周日**日期，当周因 T+1 不可用）；响应里 ASIN 常被包成 markdown 链接 `[B0XXX](url)`，统一用 `_clean()` 剥壳；数字字段混着 `'1,234'`/`'45%'`/`'$3.2'`，统一 `_num()` 解析。

## 前端架构

- **状态管理**：单一 `ProductContext`（无 Redux/Zustand），`useProducts()` 暴露数据 + 一组 `update*()` 函数，每个对应 `Product`/`Variant`/`Stage` 等不同粒度的字段更新，最终都落到 `products` 数组并触发同步。
- **视图路由**：无 react-router，`app.tsx` 的 `AppShell` 用 `view` 状态字符串切换（`'list' | 'progress' | 'table' | 'keywordRank' | 'productScrape' | 'reviewFetch' | 'pdfSplit' | 'sifKeyword' | 'myExports' | 'trash'`），Sidebar/TopBar 负责切换按钮和标题映射。新增视图需同时更新 `app.tsx`（渲染分支）、`Sidebar.tsx`（工具列表 + titles 映射）。`reviewFetch` 视图自 2026-10-15 起入口暂时隐藏（见 `ReviewFetch.tsx` 条目）。
  "AI分析"是个例外：`view` 用 `'aiAnalyze:' + skillId` 动态拼出来的 key（而非固定字符串），因为它是一个按 skill 分组、未来会有多个入口的分组，`app.tsx` 用 `view.startsWith('aiAnalyze:')` 判断+ `.slice()` 取出 skillId 传给 `<AiAnalyze skillId=.../>`，Sidebar 的按钮和 TopBar 的标题也是从 `AiAnalyze.tsx` 导出的 `AI_SKILLS` 数组动态渲染，不是写死的按钮列表。
- **数据模型核心**：`Product.stages: Record<stageKey, StageData>`，`stageKey` 取自 `STAGES`（18个阶段，每个归属 `TABS` 中某个 tab，各阶段业务含义见 `docs/business-overview.md` 第1节），`Product.variants: Variant[]` 为 SKU 变体，变体也有自己的 `stages` 子集（`VARIANT_STAGE_KEYS`）。
- **"工具模块"模式**（关键词排名 / 产品采集 / SIF爆品监控 共享）：左侧输入+历史任务列表，右侧结果表格+操作；后端各有一个 `backend/xxx_fetcher.py` 抓取器 + `backend/routes/xxx.py` 里的 `/api/xxx/*` 路由 + `run_xxx_task()`（SIF 模块另有三档频率的分层定时调度器 `start_scheduler()` + 本地信号引擎 `sif_signals.py`）。新增同类工具时可参照 `ProductScrape.tsx` + `backend/product_fetcher.py` + `docs/plans/product-scrape-integration-plan.md`。

## 已知的体量较大的文件（非 bug，但改动前建议先用 grep/大纲定位再改）

- `src/features/detail/index.tsx`（1577 行，11 个组件；`TabProd` 前有 `getEffectiveBalancePayments(b)` 辅助函数；跨批次汇总通过 `titleExtra` 注入 StageCard 标题行；`TabProd` 的批次列表被 DndContext+SortableContext 包裹以支持拖拽调序）
- `src/context/ProductContext.tsx`（943 行，~19 个 update 函数 + reorderProducts/reorderRecords 两个重排函数）
- `src/features/tools/SifKeyword.tsx`（1751 行，SIF 爆品监控 v2：六页签 + 任务表单 + 关键词/ASIN 详情弹窗 + 点查弹窗 + 设置面板全在一个文件里）
- `backend/db.py`（2063 行，SIF v2 的 8 张表读写集中在文件后半段，改前先 grep `SIF v2` 分区注释定位）
- `backend/routes/sif_keywords.py`（1015 行，前半是分层编排 `execute_task()` + 调度器，后半是 `register()` 里的路由表）
- `styles.css`（3030 行，按模块分区，新模块追加在文件末尾对应分区注释下；SIF v2 组件样式在文件最末）
- `backend/product_fetcher.py`（1512 行，含完整反爬逻辑；Dog page 检测会在 503 分支同步重置 session cookies）

  **限流的两层概念（改参数前务必分清）**：
  - **速率闸门**：`SCRAPER_REFILL_MS=1500`（令牌桶补充间隔 ms）、`SCRAPER_BUCKET_CAPACITY=8`（令牌桶容量）、
    `SCRAPER_MIN_INTERVAL_MS=700`（请求最小间隔 ms）→ 稳态 **40 请求/分钟**。
    **只有这三项会改变真实请求速率上限**，因此只有它们影响封禁风险。
  - **填充能力**：`SCRAPER_CONCURRENCY=3`（并发 worker 数）、`SCRAPER_BATCH_SIZE=40`（每批提交多少个 ASIN）。
    二者只决定「能否把闸门吃满」。批大小与并发数**已解耦**：批大而并发小 → worker 始终有活干；
    批小则会反复重建线程池、批间空等，吞吐反而更低。
  - `scrape_products` 内的 `stagger` 只对「同时启动的那一批」生效，排队中的任务由空闲 worker 自然错开。
  - 失败重试轮前的等待是固定短值（约 2 秒）；失败项在 `fetch_product_page` 内部已退避过 2/5/10 秒。

## 暂时隐藏的功能（注释保留，可随时恢复）

- **`Sidebar.tsx` `sb-stats` 区块**：进行中/本月完成/30天到期/已逾期四项数字统计已注释，对应 `computeStats` 调用及 import 同步注释。
- **`ProgressView.tsx` KPI**：进度总览顶部卡片中的「本月完成」「30天到期」「已逾期」三项已注释，其余（总产品/开发中/已上架/已暂停）保留。

## 货件跟踪模块（`backend/routes/shipment.py` + `src/features/shipment/index.tsx`）

2026-10-19 由独立 Node 项目 `../shipment-tracker` **整体迁入**，原项目已停用（目录只读保留）。

**为什么要迁**：原项目是单机工具（Node + JSON 文件 + `localhost:8100`），局域网同事用不了；
迁入后复用 fba2 的登录/权限/局域网访问。

**数据**（SQLite 两张表，字段名与原 JSON 一一对应）：

| 表 | 来源 | 条数 | 字段 |
|---|---|---|---|
| `shipments` | `data/shipments.json` | 84 | 44 个原字段 + `updated_at` |
| `shipment_products` | `data/products.json` | 42 | 20 个原字段 + `updated_at` |

- **所有列都是 TEXT**：原数据本身就是字符串（`"1500"`、`"9.83"`），不做类型转换以免丢精度
- `cancelled` 存 0/1、接口层还原 bool；`history` 存 JSON 文本、接口层还原数组
- camelCase(接口) ↔ snake_case(DB) 由 `db.py` 的 `_snake_key` / `_camel_key` 机械转换，
  不维护 40+ 字段的手写映射

**接口**（前缀 `/api/shipment`，权限 **admin / root**）：

```
GET/POST/PUT/DELETE  shipments
POST  shipments/import | shipments/batch-update | shipments/auto-calc-eta
GET/POST/PUT/DELETE  products
POST  products/import
POST  import/xlsx
```

**业务规则（移植自原项目，改之前先看原码）**：

- 货件导入去重键 **`shipmentId|product|shipDate|warehouse`** —— 同一个 FBA 号可能含
  多个厂家的多个产品、多个提货时间，**不能只按 FBA 号去重**
- 产品库导入去重键 `fnsku || product`，已存在则**只补空字段**，不覆盖已有值
- 自动算 ETA：`普船 45 / 加班 38 / 正班 36 / 空派 14` 天；
  `etaDate = 发货日 + N`、`etaEndDate = 发货日 + N + 6`；
  跳过：已取消 / 非 FBA 开头 / 已有 etaDate / 缺 channel 或 shipDate
- 看板分类 `classify()`（**顺序即优先级，勿调整**）：
  已取消 → 卫星仓(AL0) → 沃尔玛 → 已入库(有 actualDate) → 无日期 →
  **逾期（按 `etaEndDate` 判断，送达是一个区间）** → 本周（以**周日**为界，美国周起始）→
  未来 7 天（diff ≤ 6）→ 下周核对（diff ≤ 13）→ 在途
- 店铺归属 `detectStore()`：产品名含「钻石画」→ 宁熙，其余 FBA → 谛听

**前端视图与筛选（2026-10-19 补）**：

- **两种视图**，同一个 tab 内切换：`状态看板` / `按发货时间`
- **KPI 卡片可点击筛选**：7 个 KPI → `classify` 的 key（全部 / 逾期 / 本周 / 未来7天 /
  下周核对 / 在途 / 已入库）。再点一次取消；点其他 KPI 直接切换
- 状态看板显示**全部分区**（含卫星仓/沃尔玛/已入库/无日期/已取消），
  但非预警分区**默认折叠** —— 否则 84 张卡会淹没预警。筛选某一类时强制展开
- **按发货时间**对齐原项目 `groupByShip()`：排除已取消、按日期**倒序**、未填发货时间排最后；
  右侧按产品名折叠分组（同名产品多条）
- `counts.total` 用 `filtered.length`（跟着搜索走），不是全库条数 —— 避免"搜索后数字与内容不符"
- ⚠️ 局部变量 `groups`（基于 `filtered`，供 KPI 计数）与 `visibleGroups`（基于 `visible`，
  供渲染）**必须分开**：合并会让"点 KPI 后其他 KPI 数字全变 0"，导致无法再切换

**数据导入脚本**：`scripts/import_shipment_tracker.py`
（幂等 upsert + 逐条逐字段比对，可重复执行；WAL 模式下复制库文件要连 `-wal` 一起拷）

**⚠️ 关于 Mac 定时提醒（实际核查结果）**

原目录里 `reminder.js` 与 `install-schedule.sh` **文件还在，但 launchd 从未安装过**
（`launchctl list` 无相关条目、`~/Library/LaunchAgents` 无 plist）→ **当前没有提醒在跑**，
不存在"读旧数据"的隐患。

若以后想启用，**必须先把 `reminder.js` 的数据源从 `data/shipments.json` 改成
`fba2/data/fba-data.db`**（或调 fba2 的 `/api/shipment/shipments`），否则会一直基于冻结的旧快照。
若要继续用每日弹窗，需把 `reminder.js` 的数据源改成调
`http://localhost:8002/api/shipment/shipments`（用 root 账号登录拿 token），
或改成直接读 `data/fba-data.db`。**此项未做**。

## 改前端代码的注意事项

1. 任何用到 hooks 的文件必须 `import { useState, useCallback, useEffect, ... } from 'react'`（没有全局 UMD React）。
2. 改完跑 `npx tsc --noEmit`（必须无报错）和 `npm run build`（确认 esbuild 也无报错——两者校验范围不完全重叠）。
3. 测试后端 API 时若默认端口被占用，用 `--port` 换一个临时端口，测完 `pkill` 掉，避免影响用户正在跑的实例。
