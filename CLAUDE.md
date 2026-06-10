# FBA Tracker — 项目架构说明（给 AI 助手看的）

修改代码前先看这份文档，能省掉重新通读全项目的时间。面向最终用户的协作/同步说明见 `README-sync.md`。

## 一句话

一个局域网内多人协作的 FBA 选品/生产/上架进度追踪工具。Python `http.server` 后端 + SQLite 存储，
前端是 React/TypeScript（esbuild 打包成单个 `compiled/bundle.js`，由 `index.html` 直接引用，无路由库）。

## 技术栈与构建

- 前端：React 19 + TypeScript（`tsconfig.json` 严格模式），esbuild 打包，`--jsx=automatic`（**必须显式 `import { useState, ... } from 'react'`**，没有全局 React）
- 后端：纯标准库 `http.server`（`ThreadingHTTPServer`），无第三方 web 框架
- 数据库：SQLite，`fba-data.db`（默认路径，`.gitignore` 忽略，本地数据不进 git）
- 抓取依赖：`beautifulsoup4`（仅"产品采集"用到，"关键词排名"是正则解析）

常用命令：
```bash
npm run build        # esbuild 打包 src/ -> compiled/bundle.js
npx tsc --noEmit      # 类型检查（CI/改完前端代码后必须跑）
npm start             # = prestart(build) + python3 server.py
python3 server.py --port 8099   # 临时换端口测试，避免和正在跑的实例冲突
```

## 目录结构

```
server.py                  # 后端入口：HTTP 路由 + DbState(SQLite) + AuthManager + 定时任务
rank_fetcher.py             # 关键词排名抓取器（正则解析，无 bs4 依赖）
product_fetcher.py          # 产品详情抓取器（bs4 解析 + 反爬：会话池/令牌桶/CAPTCHA检测）

index.html                   # 唯一 HTML 入口，引用 styles.css + compiled/bundle.js
styles.css                   # 全局样式（2198 行，按模块分区注释，如 PRODUCT SCRAPE 区块）

src/
  main.tsx                   # ReactDOM.createRoot 挂载 <App/>
  app.tsx                    # App 根组件：登录态(AuthGate)、AppShell(顶层视图路由/Tabs)
  context/ProductContext.tsx # ProductsProvider + useProducts：全局状态、与后端同步逻辑、
                              #   ~19 个 update*() 字段更新函数（updateStage/updateVariant/...）
  components/index.tsx        # 通用 UI 组件：StatusChip/StatusSelect/EditField/StageCard/
                              #   RecordCard/AddRecordButton/VariantSelector
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
      ProductScrape.tsx         # 工具：产品采集（含详情预览弹窗 + 图片 Lightbox）

docs/
  product-scrape-integration-plan.md  # 产品采集模块的实施方案（参考用，已基本完成）
```

## 后端架构（server.py）

### SQLite 表（`DbState` 类管理，建表/迁移逻辑都在 `__init__`）

| 表 | 用途 |
|---|---|
| `meta` | 全局 key-value（如当前 `version` 号） |
| `products` | 产品主数据（JSON blob + version，乐观锁核心） |
| `audit_log` | 产品数据变更审计 |
| `keyword_tasks` / `rank_snapshots` | 关键词排名：任务配置 + 历史快照 |
| `scrape_tasks` / `scrape_products` | 产品采集：任务记录 + 落库的商品详情 |

### API 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/products` | 取产品数据 + 当前 version |
| PUT | `/api/products` | 写入，带 `baseVersion`，version 不匹配返回 409 + 最新数据 |
| GET | `/api/me` | 当前登录用户 |
| POST | `/api/login` / `/api/logout` | Token 登录/登出（`fba-users.json`） |
| GET/POST/DELETE | `/api/rank/*` | 关键词排名：任务列表/历史/创建/删除/单关键词 |
| GET/POST/DELETE | `/api/scrape/*` | 产品采集：任务列表/结果/运行/删除/重置会话 |

### 同步机制（详见 `README-sync.md` 第7节）
客户端每 4s 轮询 `version`，编辑后 600ms 防抖 PUT 带 `baseVersion`；后端乐观锁，冲突时返回服务器最新版本，客户端整体覆盖（`ProductContext.tsx` 中 `versionRef`/`syncedVersionRef` 相关逻辑）。

## 前端架构

- **状态管理**：单一 `ProductContext`（无 Redux/Zustand），`useProducts()` 暴露数据 + 一组 `update*()` 函数，每个对应 `Product`/`Variant`/`Stage` 等不同粒度的字段更新，最终都落到 `products` 数组并触发同步。
- **视图路由**：无 react-router，`app.tsx` 的 `AppShell` 用 `view` 状态字符串切换（`'list' | 'progress' | 'table' | 'keywordRank' | 'productScrape' | ...`），Sidebar/TopBar 负责切换按钮和标题映射。
- **数据模型核心**：`Product.stages: Record<stageKey, StageData>`，`stageKey` 取自 `STAGES`（18个阶段，每个归属 `TABS` 中某个 tab），`Product.variants: Variant[]` 为 SKU 变体，变体也有自己的 `stages` 子集（`VARIANT_STAGE_KEYS`）。
- **"工具模块"模式**（关键词排名 / 产品采集 共享）：左侧输入+历史任务列表，右侧结果表格+操作；后端各有一个 `xxx_fetcher.py` 抓取器 + `server.py` 中的 `/api/xxx/*` 路由 + `run_xxx_task()`。新增同类工具时可参照 `ProductScrape.tsx` + `product_fetcher.py` + `docs/product-scrape-integration-plan.md`。

## 已知的体量较大的文件（非 bug，但改动前建议先用 grep/大纲定位再改）

- `src/features/detail/index.tsx`（1355 行，11 个组件）
- `src/context/ProductContext.tsx`（867 行，~19 个 update 函数）
- `styles.css`（2198 行，按模块分区，新模块追加在文件末尾对应分区注释下）
- `product_fetcher.py`（1131 行，含完整反爬逻辑）

## 改前端代码的注意事项

1. 任何用到 hooks 的文件必须 `import { useState, useCallback, useEffect, ... } from 'react'`（没有全局 UMD React）。
2. 改完跑 `npx tsc --noEmit`（必须无报错）和 `npm run build`（确认 esbuild 也无报错——两者校验范围不完全重叠）。
3. 测试后端 API 时若默认端口被占用，用 `--port` 换一个临时端口，测完 `pkill` 掉，避免影响用户正在跑的实例。
