# 需求梳理：AI 分析新增「产品流量分析 / 竞品流量对比」（SIF 驱动）

> 状态：需求梳理阶段，未开发
> 日期：2026-10-21
> 目标一句话：**输入一个自身 ASIN（可选填竞品），自动产出「自身流量结构 + 竞品流量对比 + 归因 + 动作」的专业分析报告。**

---

## 一、需求定位与边界

### 1.1 做什么

| 能力 | 说明 |
|---|---|
| 自身流量体检 | 自然 / 广告流量占比、渠道拆解（SP 常规、SP 推荐、SB、SBV）、变体流量分布、词覆盖分布 |
| 流量趋势 | 近 7 / 30 / 90 天日粒度走势：总流量分、自然分、广告分、价格、BSR、评分、评论、月销 |
| 竞品流量对比 | 与 1~5 个竞品做同口径横向对比（结构占比、趋势斜率、渠道依赖、词覆盖、关键词重叠） |
| 归因 | 指出流量变化是由价格、广告、BSR、评论、变体、关键词排名中的哪一环导致 |
| 动作建议 | 3 条以内、可执行、带优先级（不改写文案、不做 Listing 优化） |

### 1.2 不做什么（明确边界，避免范围蔓延）

- **不依赖 Amazon 登录态 / Playwright**：与现有 `cosmo-diagnose` 完全解耦，纯 SIF API。
- 不做 Listing 文案改写、主图 Brief、Review 情感分析（那是 COSMO 诊断的活）。
- 不做市场选品 / 关键词机会挖掘（那是「SIF 关键词」模块的活）。
- 不做绝对流量估算：SIF 的 score 是无量纲相对分，**报告只能说"占比、倍数、涨跌幅"，不能说"多少 UV"**。

---

## 二、现状盘点（决定工作量大小的关键事实）

### 2.1 已经具备、可直接复用的

| 项 | 位置 | 说明 |
|---|---|---|
| AI 分析任务框架 | `backend/workers/ai_analysis_worker.py` | `claude -p` 无头会话跑 skill，报告落 `skills/<skill>/report/<taskId>/` |
| 任务表 | `ai_analysis_tasks`（`params` 是 JSON TEXT） | 无需改表就能存"竞品列表 / 时间窗" |
| 前端历史 / 预览 / 下载 | `src/features/tools/AiAnalyze.tsx` | 已支持 html iframe 预览与 md 渲染 |
| SIF MCP 授权 | AI 工具白名单已含 `mcp__sif-mcp__*`；`~/.claude.json` 已配 sif-mcp（HTTP + secret-key） | **接入零成本**，无需新建 MCP 配置 |
| Python 侧 SIF 封装 | `backend/sif_fetcher.py`（15 个工具） | `asin_traffic_trend` 已做日粒度字段解析、`asin_profiles` 批量、`root_competitors`、`asin_keyword_signals` 都可直接用 |
| 信号判定规则 | `backend/sif_signals.py` | `asin_traffic_shift` / `asin_bsr_jump` / `asin_price_drop` 的阈值口径可与报告对齐，避免两处说法不一致 |
| 图表 | `SifKeyword.tsx` 内自绘 SVG `LineChart`，无 echarts | 报告图表走内联 SVG，不引新依赖 |

### 2.2 三个必须先解决的阻塞点

1. **登录态强制检查**
   `POST /api/ai/run` 无条件调 `_check_login_state()`，缺失就返回 `login_required`。
   → SIF 型技能没有 Amazon 登录需求，必须按 skill 配置跳过，否则用户会被要求先登录 Amazon 才能看流量。

2. **参数区硬编码**
   `AiAnalyze.tsx` 里写死了「Alexa 反查问题数」一个输入框，且 `runAnalyze` 固定传 `{ alexaQuestions }`。
   → 需要把「参数表单」变成 skill 自带配置（`fields` 描述），否则新技能无法输入竞品 ASIN、时间窗。

3. **技能元信息两处维护 + 前端不知情**
   `AI_SKILLS` 在前端（`AiAnalyze.tsx`）和后端（`ai_analysis_worker.py`）各一份，字段不一致。
   → 建议后端为唯一事实源，前端通过 `GET /api/ai/skills` 拉取（一次改动，后面加技能只改后端 + 建目录）。

---

## 三、SIF 能给什么数据（按"能回答什么问题"组织）

> 全部为已验证存在的工具，字段名取自 MCP schema。

| # | 要回答的问题 | 工具 | 关键字段 | 口径红线 |
|---|---|---|---|---|
| 1 | 我的流量怎么构成的？自然占多少？ | `ops_get_listing_traffic_overview` | 每个节点四件套 `name/wholeName/score/ratio`；`total`、`overview`、`ad`、`recommend`（渠道名动态，键不固定） | `recommend` 下的渠道名必须遍历，不可假设；缺失=无数据，**不是 0** |
| 2 | 流量趋势怎么走的？价格 / BSR 同步变化吗？ | `ops_get_asin_traffic_trend` | `totalScore`、`nfScore`、`adScore`、`spScore`、`recSpScore`、`sbScore`、`sbvScore`、`dealPrice`、`buyboxPrice`、`bsr`、`star`、`review`、`boughtInPastMonth` | 默认 `listingSearch=true`（父体+全子体聚合）；末点可能未出完，看 `latest_point_complete`，**不得据此说"今天暴跌"** |
| 3 | 哪个变体吃掉了流量？ | `ops_get_listing_traffic_structure` | `chars.dims[i]` 与 `chars.nfs[i]/sps[i]/sbs[i]/sbvs[i]` 同下标配对；`ratio`=渠道内纵向占比，`dist`=变体内横向占比 | 两套 ratio 不可混用；`null`=该渠道无数据，不是得分为 0 |
| 4 | 各变体覆盖多少词？ | `ops_get_listing_keyword_distribution` | `asins[].total`（该 ASIN 词数，不是顶层 `total`）、`natural/ad/sp/rec/brand/vedio` + 各自 `*Ratio` | 顶层 `total` 是行数；`brand` 是 SB 词数不是品牌名 |
| 5 | 具体哪些词在涨 / 在掉？ | `ops_get_asin_traffic_trend_detail` | `details[]` 的 `score`、`scoreRatio`、`diffScore`、`affectWholeRatio`、`pchangeReason`（各渠道排名变化） | **只支持单 ASIN**（不能传父 ASIN 聚合）；`inFre=0` 只能表述为"未出现在本期采集数据中"，**禁止断言"掉出前三页"** |
| 6 | 竞品是谁？ | `market_get_keyword_root_competitors`（首次发现）/ `market_discover_competitors`（Top100 四维格局，须先调 root） | `competitors[]` 的 `asin/keyword_count/covered_volume/rank1_count`；格局维度 `price_bands/review_tiers/order_tiers` | 必须先 root 再 discover，不可越级 |
| 7 | 竞品在哪些词上强？我漏了什么词？ | `market_get_asin_keyword_signals` | `declining`、`gaining`、`rank_gaps`、`top_keywords` | 用于算"关键词重叠 / 缺口" |
| 8 | 竞品销量与静态属性 | `ops_get_asin_sales_list`、`market_get_asin_profile` | 月销、价格、评分、评论数、上架日期、BSR、变体数 | `boughtInPastMonth` 是档位文本（"5,000+"），**不能当精确数参与计算** |

---

## 四、报告结构设计（8 章）

| 章 | 标题 | 数据来源 | 核心产出 |
|---|---|---|---|
| 0 | 结论摘要 | 全部 | 3 条结论 + 1 个"如果只做一件事"的建议 |
| 1 | 数据口径与可比性声明 | 元数据 | 时间窗、站点、父子口径、竞品选取方式、数据延迟说明（放在最前，避免读者误读） |
| 2 | 自身流量结构 | 工具 1 | 自然 vs 广告占比、四渠道饼图（内联 SVG）、"广告依赖度"评级 |
| 3 | 自身流量趋势 | 工具 2 | 30/90 天双线图（总分 / 自然分 / 广告分）、价格与 BSR 叠加、拐点标注 |
| 4 | 变体与词覆盖 | 工具 3 + 4 | 变体流量条形图 + 词数分布；指出"吃流量但不产词"的变体 |
| 5 | 竞品流量横评 | 工具 1+2 对每个竞品 | 对比表：总流量分、自然占比、广告占比、SP/SB/SBV 结构、30 天斜率、价格、BSR、评论 |
| 6 | 关键词争夺 | 工具 5 + 7 | 重叠词 / 竞品独有词 / 我有他无的优势词；每类给 Top 10 |
| 7 | 归因与动作 | 上述综合 | 一张"问题 → 证据 → 建议动作 → 优先级"表 |

**竞品对比的强制口径**：自身和所有竞品必须使用**同一个 `listingSearch` 值**、同一时间窗、同一 `timePieceType`。混口径的对比结论一律作废。

---

## 五、核心指标定义（要求"可复算、可溯源"）

| 指标 | 公式 | 说明 |
|---|---|---|
| 自然流量占比 | `nfScore / totalScore`，取窗口内**中位数** | 不用单日值，单日噪声大 |
| 广告依赖度 | `1 − 自然占比`，拆 `sp/recSp/sb/sbv` | 分渠道看比看总和更有意义 |
| 趋势斜率 | 窗口内 `score` 对日序做最小二乘，归一化为"每周变化 %" | 避免"起止点相减"被单日异常带偏 |
| 相对流量倍数 | `竞品 totalScore 均值 / 自身 totalScore 均值` | SIF 分无量纲，只能讲倍数，不能讲绝对量 |
| 渠道结构差异 | 逐渠道 `自身占比 − 竞品占比`（pp） | 讲"差距在哪个渠道"，比总分差更有信息量 |
| 关键词重叠度 | `|自身 Top50 ∩ 竞品 Top50| / |并集|`（Jaccard） | 竞品间取平均 |
| 词缺口数 | 竞品 Top50 中自身 Top200 未覆盖的词数 | 两档阈值差异要写进口径注 |
| BSR 改善幅度 | `(前值 − 后值) / 前值` | 排名类指标"数值越小越好"，符号方向必须说明 |

**硬性要求**：报告里每个数字必须能回答"来自哪个工具、哪个参数、哪个日期窗口"。建议数据包 `data.json` 与报告一起落盘，报告页脚给"数据源与抓取时间"。

---

## 六、架构方案（关键决策点）

### 方案甲：AI 自己调 MCP（沿用 cosmo-diagnose 的方式）

```
claude -p → 自己决定调哪个 SIF 工具 → 自己算 → 自己写报告
```

- 优点：灵活，能临场下钻；改分析逻辑不用改 Python。
- 缺点：**慢**（1 自身 + 3 竞品 ≈ 15~25 次工具调用）、**贵**（每次返回原样 JSON 进上下文）、**口径易飘**（AI 可能把父体分和子体明细混着比）、**不可复现**（同样输入两次结论可能不同）、**无法预览**（钱花了才知道数据对不对）。

### 方案乙（推荐）：Python 取数算指标 → AI 只写叙述

```
前端 POST /api/ai/traffic/preview
  → backend/traffic_compare.py 调 sif_fetcher 取数（并发 + 节流）
  → 本地算出指标，写成规范化 data.json（含口径元数据）
  → 前端展示预览（趋势图 + 竞品候选），用户确认
  → POST /api/ai/run（skill=traffic-compare，params 带 dataSetId）
  → claude -p 读 data.json + 报告模板，只负责"解释、归因、写建议"
  → 输出 HTML 报告
```

- 优点：**快**（1 次 AI 调用）、**便宜**（上下文只放压缩后的指标，不是原始 JSON）、**口径稳定**（指标在 Python 里算死，AI 改不了）、**可复现**、**能先看数据再花钱**、数据可缓存复用。
- 缺点：分析维度受限于预设指标；AI 不能自主发现"计划外"的异常。
- 折中：**允许 AI 在归因阶段定向下钻 2~3 次**（例如"自然流量掉得最多的是哪几个词"，调 `traffic_trend_detail`），并把这几次调用写进 skill 的 SKILL.md 作为固定步骤，而不是放任自选。

> 结论建议：**方案乙为主 + 定向下钻**。理由是这套分析是固定套路，且用户要求数字可复算——把算数交给 Python，把解释交给 AI，是唯一能同时满足"专业"和"不杜撰"的结构。

---

## 七、竞品从哪里来（三种取法）

| 方式 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 手工填 ASIN | 用户输入 1~5 个竞品 | 最准，符合业务直觉 | 用户得自己找，偷懒时不用 |
| B. 自动推荐 | 取自身 Top 流量词 → `root_competitors` → 出现频次最高的 ASIN | 零输入 | 可能混入"大词头部"而非真正同形态竞品，容易比错对象 |
| C. 混合（建议） | 自动推荐 Top 5 候选 + 前端可增删改，最终以用户确认为准 | 兼顾省事与准确 | 多一个确认步骤 |

**建议 C**，并且自动推荐时加两个过滤：① 与自身同叶子类目（`market_get_asin_profile.category`）；② 价格带在自身 ±50% 内。避免"拿大牌旗舰跟你比流量"这种无意义对比。

---

## 八、交互流程（两段式）

```
① 输入：自身 ASIN ｜ 时间窗（7/30/90）｜ 竞品来源（手填/自动）
        ↓
② 取数预览（不花 AI 费用，纯 sif_fetcher）
   · 自身流量结构卡 + 30 天迷你趋势图
   · 竞品候选表（ASIN / 品牌 / 价格 / BSR / 月销 / 自然占比）→ 可勾选可增删
        ↓
③ 点「生成分析」→ 创建 AI 任务（复用现有队列、轮询、终止）
        ↓
④ 报告预览（复用现有 iframe 预览）+ 下载 HTML + 下载 data.json
```

好处：数据不对可以在第 2 步就发现，不用等 10 分钟、不用付 AI 的钱。

---

## 九、改造清单（文件级）

### 后端

| 文件 | 改动 |
|---|---|
| `backend/traffic_compare.py`（新建） | 取数编排（并发 + 节流，复用 `sif_fetcher`）、指标计算、`data.json` 落盘、竞品自动推荐 |
| `backend/routes/ai_analysis.py` | ① `post_run` 按 skill 的 `requires_login` 决定是否检查登录态；② 新增 `POST /api/ai/traffic/preview`（取数预览）、`GET /api/ai/skills`（技能元信息，含参数表单描述） |
| `backend/workers/ai_analysis_worker.py` | `AI_SKILLS` 增加 `traffic-compare` 条目（`requires_login: False`、`build_prompt` 读竞品/窗口/dataSetId）；建议把 `AI_SKILLS` 升级为「技能注册表」并对外暴露 |
| `backend/db.py` | 不用改表；可选加 `ai_traffic_datasets` 缓存表（同 ASIN + 窗口 30 分钟内复用取数结果） |

### 前端

| 文件 | 改动 |
|---|---|
| `src/features/tools/AiAnalyze.tsx` | ① `AI_SKILLS` 增加 skill 级 `fields` 配置，参数区按配置渲染（ASIN 列表、下拉、数字）；② 新增「取数预览」区块（复用 `LineChart`）；③ `loginRequired` 提示按 skill 隐藏 |
| `src/features/sidebar/Sidebar.tsx` | 无需改（已按 `AI_SKILLS` 渲染） |

### Skill 与模板

| 文件 | 内容 |
|---|---|
| `skills/TrafficCompare/SKILL.md` | 分析步骤、指标口径红线、归因规则、下钻允许范围 |
| `skills/TrafficCompare/template/report.html` | HTML 报告模板（内联 SVG 图表、可打印、单文件离线） |

---

## 十、风险与口径红线（写进 SKILL.md 强制执行）

1. **score 不是流量绝对值**：只能讲占比、倍数、涨跌幅。禁止出现"日均 X 次曝光/UV"。
2. **父子口径不可混**：对比表里自身与竞品必须同为 `listingSearch=true`（或同为 false），并在口径注里写明。
3. **末点未出完**：`latest_point_complete=false` 时，该日不参与趋势判断与环比。
4. **排名缺失 ≠ 掉出前三页**：只能表述为"未出现在本期采集数据中"。
5. **推荐渠道键名必须遍历**：不得假设 `recommend` 下有哪些渠道。
6. **缺失 = 无数据，不是 0**：`null` 一律不进分母。
7. **竞品可比性**：跨类目 / 价差 >2 倍的竞品，报告需标注"仅作规模参照，不可直接对标"。
8. **成本上限**：默认 3 个竞品（可到 5）。每多一个竞品 ≈ 2 次 API + 报告篇幅。`AI_MAX_BUDGET_USD` 建议对 SIF 型技能单独设 2~3 美元（远低于 cosmo 的 8）。

---

## 十一、已确认的决策（2026-10-21）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 竞品怎么来 | **自动推荐 + 可改**：从自身 Top 流量词自动找候选（过滤同类目、价差 ±50%），前端列出后用户勾选/增删，以确认为准 |
| 2 | 是否两段式 | **做**：取数预览（不花 AI 费用）→ 确认 → 生成分析 |
| 3 | 报告形态 | **单文件 HTML + 内联 SVG 图表**（可打印、离线可看） |
| 4 | 默认时间窗 | **30 天**，可切 7 天 / 90 天 |

---

## 十二、实施顺序（建议分 4 步，每步可独立验收）

> 原则：先把"数据对不对"解决，再解决"写得专不专业"。每一步做完都能单独跑通，不追求一次到位。

### 第 1 步：打通取数与指标（无 AI，纯后端 + 预览页）✅ 已完成（2026-10-21）

- 新建 `backend/traffic_compare.py`：自身取数（结构 + 30/90 天趋势 + 变体 + 词覆盖）、竞品自动推荐、指标计算、`data.json` 落盘。
- 新建 `POST /api/ai/traffic/preview`。
- 前端 `AiAnalyze.tsx` 增加预览区块（复用 `LineChart`）：自身结构卡 + 趋势图 + 竞品候选勾选表。
- **验收**：输入一个真实 ASIN，能在页面上看到正确的自然/广告占比、趋势图、竞品候选列表；`data.json` 内容与页面一致。

**实施结果**

| 项 | 结果 |
|---|---|
| 新增文件 | `backend/traffic_compare.py`（取数编排 + 指标 + 落盘，~600 行） |
| 改动文件 | `backend/sif_fetcher.py`（新增 2 个封装 + 1 个 full 版本 + 修 1 个 bug）、`backend/routes/ai_analysis.py`（新路由）、`src/features/tools/AiAnalyze.tsx`（预览面板 + 技能条目）、`styles.css`（`.tf-*` 样式）、`SifKeyword.tsx`（仅 `export LineChart`） |
| 实测耗时 | 自身 5 次 + 自动推荐 4 次 + 5 竞品 × 3 次 = **22 次 SIF 调用 / 8.9 秒** |
| 手工指定 2 竞品 | 11 次调用 / 约 4 秒 |
| 边界验证 | 无效 ASIN→400、无 token→401、admin 角色→403、历史接口回归 200 |
| 落盘 | `data/ai-traffic/<datasetId>.json`（约 76 KB/次） |

**实施中发现并修掉的问题**

1. **`sif_fetcher.asin_listing_keywords()` 恒返回空列表**：返回键写成了 `data.get("list")`，真实键是 `asins`。
   这是个既有 bug（SIF 关键词模块若用到该函数会一直是空数据），已修并补上 `brand_name` / `price` / `is_best_seller` 等字段。
2. **类目判等误判「跨类目」**：`category_name` 层级不统一（自身 `Baby`、竞品 `Baby Burp Cloths`），
   改用 `category_id` 路径前缀判断（`baby-products` vs `baby-products/7874767011`）。
3. **候选被 warnings 全过滤**：初版把 `warnings` 当过滤条件，导致 5 个候选全部 `suggested=false`、竞品数为 0。
   改为「warnings 只标注不排除」，排序时警告少的优先。
4. **变体计数失真**：占比为 0 的变体被当成缺失排除，改为只排除 `None`，并新增 `variants_with_flow` 区分「有流量的变体数」。

**尚未完成**：右侧面板的「生成分析」按钮（依赖第 2、3 步），当前只到取数预览。

### 第 1 步补充（2026-10-21 追加）：放开权限 + 自定义时间维度

用户提出两点：① 该功能不设权限，任何用户都能访问；② 时间维度不要写死，要能自定义且格式与 SIF 一致。

**权限**

| 层 | 改法 |
|---|---|
| 后端 | 新增 `PUBLIC_SKILLS = {"traffic-compare"}`：该集合内的技能只校验登录、不校验 root；其余技能（cosmo-diagnose 要跑 Playwright）仍限 root。`/api/ai/tasks` 不带 `skillId` 时仍只给 root，避免普通用户看到别人的记录 |
| 前端 | `AI_SKILLS` 加 `rootOnly` 标记 + `visibleAiSkills(isRoot)`，Sidebar 分组、`app.tsx` 视图路由、Tweaks 下拉三处统一派生，不再各处硬写 `role === 'root'` |

**时间维度（关键：SIF 的约束是不对称的）**

实测发现 SIF 对时间参数的处理**三种情况表现不同**，这正是"传参错误"的来源：

| periodType | 合法值 | 违规时的表现 |
|---|---|---|
| `latelyDay` | `'7'` / `'30'` | 传 14/45/90 → **直接报「参数错误」**（整次取数失败） |
| `week` | 该周**周日**日期 | 传周三 → **不报错，静默返回 `total=None`**（最危险：看起来成功，实际空数据） |
| `month` | 月初日期（`'2026-10'` 也接受） | 正常 |

因此做了「入口归一化 + 纠正说明」，而不是把判断丢给用户或 AI：

- 后端 `traffic_compare.normalize_period()` 是**所有时间入参的唯一入口**，返回归一化后的 `type/value`、窗口区间、人类可读 label、以及 `notes`（自动纠正说明）。
- 前端三档选择器：近 N 天（只有 7/30 两个选项，从 UI 上就杜绝非法值）/ 指定周（选任意日期，实时显示"将对齐到 2026-10-11 ~ 10-17"）/ 指定月（`<input type="month">`，显示"将传 2026-10-01"）。
- 未指定周/月时默认取**上一个完整周/上个月**（当周当月有 T+1 延迟，数据不完整）。
- 预览面板顶部回显 `实际查询：week / 2026-10-11（2026-10-11 ~ 2026-10-17）`，纠正过的话还会有一条橙色提示说明改了什么。

**顺带的性能修正**：竞品静态属性从「每个竞品各查一次」改成「一次批量取」，完整取数从 22 次调用降到 18 次——因为实测撞到了 SIF 的 **QPM 40/60 秒** 限流（连续快速点两次预览就会超）。

**验证结果**

| 场景 | 结果 |
|---|---|
| admin（非 root）调 preview | 200，取数成功 |
| admin 查 traffic 历史 | 200 |
| admin 查 cosmo 历史 / 全部任务 | 403（仍限 root） |
| 无 token | 401 |
| `week` 传周三 2026-10-15 | 自动对齐 2026-10-11，趋势正好 7 天（10-11~10-17） |
| `month` 传 2026-09-15 | 归一化 2026-09-01，窗口 09-01~09-30，趋势 30 天 |
| `latelyDay` 传 45 | 收敛为 30 并提示 |
| 未知类型 `bogus` | 回落近 7 天并提示 |

### 第 3 步（简化版）：Markdown 报告 + DeepSeek ✅ 已完成（2026-10-21）

原计划是「SKILL.md + HTML 模板 + `claude -p`」。实际按用户要求简化为 **Markdown 报告 + 直接调模型接口**，理由：

| 原方案 | 现方案 | 原因 |
|---|---|---|
| `claude -p` 跑 skill | 直接 HTTP 调模型（OpenAI 兼容） | 报告生成不需要 agent 能力（不开浏览器、不调 MCP），一次调用就够；且不绑某个人的 CLI 登录态，多人可用一把共享 key |
| HTML 模板 + 内联 SVG | Markdown | 前端已有 md 渲染器，省 token、不会跑版；用户明确要求"能快速执行、页面快捷查看" |
| 模型写整份文档 | 模型只写正文，结构由 prompt 约束 | 布局可控，且数字全部预先换算好，模型只负责抄 |

**实现结构**

1. `backend/llm_client.py`：读 `data/ai-config.json`（缓存 30 秒），调 `/chat/completions`，零第三方依赖。错误分类型：`not_configured` / `auth` / `insufficient` / `rate_limit` / `network` / `http`。
2. `backend/traffic_report.py`：
   - `build_brief()` 把 76KB 的 data.json 压成 **约 2.4KB** 的精简数据包，所有比例已乘 100 并命名 `_pct`（模型不用换算，也就不会换算错）；
   - `SYSTEM_PROMPT` 五条铁律：只准引用不推算、不许换算成绝对流量、不许编因果、不许说"掉出前三页"、BSR 改善率已取正；
   - 输出 6 章结构（结论摘要 / 数据口径 / 流量结构 / 趋势变化 / 竞品对比 / 归因与行动）；
   - 落盘 `data/traffic-reports/<datasetId>.md` + 同名 `.json`（模型、耗时、token）。
3. 三个新接口：`GET /api/ai/traffic/llm`（配置摘要，不含 key）、`POST /api/ai/traffic/report`（同步生成，带缓存）、`GET /api/ai/traffic/report?datasetId=`。
4. 前端：预览面板底部新增「分析报告」卡，未配置时按钮禁用并给出配置指引；生成后用 `marked` 渲染，前端 `sanitizeHtml()` 剥掉 script/iframe/on* 再插入 DOM。

**配置**：`data/ai-config.json`（已创建，key 留空）
```json
{
  "provider": "deepseek",
  "base_url": "https://api.deepseek.com",
  "api_key": "填你的 key",
  "model": "deepseek-chat",
  "temperature": 0.3,
  "max_tokens": 4000,
  "timeout": 120
}
```
也可用环境变量 `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` 覆盖。换供应商（通义/Kimi/豆包/Claude）只改 base_url + model。

**验证结果**

| 场景 | 结果 |
|---|---|
| brief 裁剪 | 76KB → 2423 字符；四渠道占比之和（13.1+4.7+2.1+1.1=16.0）与广告占比 16.0 自洽 |
| prompt 总长 | 3827 字符（约 2500 token） |
| 假模型跑通全流程 | 围栏剥离 ✓ 落盘 ✓ 二次调用命中缓存 ✓ 读回 ✓ |
| 数据集不存在 | 404 |
| 未配 key | 400 + `not_configured` |
| 未登录 | 401 |
| 网络异常 | `LLMError(code=http)`，信息含 `Connection refused`（沙箱环境走了代理，生产直连正常） |

**实施中修掉的 bug**：`post_traffic_report` 里把闭包函数写成了 Handler 方法（`self._generate_report(...)`），
导致 `AttributeError: 'Handler' object has no attribute '_generate_report'`，服务端直接断连返回空响应。
已改为显式传 handler 的普通函数，并加注释说明这是闭包不是方法。

**未做**：数字溯源硬校验（生成后程序化比对 md 里的数字是否都在 brief 中）。当前靠 prompt 约束 + 数据包只给该给的数，后续可加。

### 真实模型连通性与端到端验证（2026-10-21，用户配好 DeepSeek key 后）

配置：`model = deepseek-flash`（推理型），`api_key` 已填。

**首次测试暴露的问题**：用 `max_tokens=20` 发一句"回复：通了"，返回 `finish_reason=length` 且 `content` 为空。
查原始响应发现该模型会先输出 `reasoning_content`（思考），额度全被思考吃掉，正文来不及生成。
**不是配置错误，是额度不够** —— 但现象很像"配错了"，容易误判。

处理：
1. `llm_client.chat()` 识别「空内容 + length + 有 reasoning」这一组合，抛出明确提示「输出额度被推理过程占满，请把 max_tokens 调到 6000 以上」（`code=truncated`）。
2. `max_tokens` 默认值与用户配置均从 4000 调到 **8000**（思考约 2500 + 正文约 2000 字）。
3. `usage` 里新增 `reasoning_tokens`，便于观察思考成本占比。

**端到端结果**（ASIN B0CLPGQWNB / 近 7 天 / 1 个竞品）

| 项 | 结果 |
|---|---|
| SIF 取数 | 8 次调用 / 4 秒 |
| 模型生成 | 24.1 秒 / 2801 字 |
| token | prompt 2671 + completion 4229（其中 reasoning 2472） |
| 章节 | 6 章齐全（结论摘要 / 数据口径 / 结构 / 趋势 / 竞品 / 归因与行动） |
| 接口 | GET 报告 200、POST 命中缓存 `cached=true`、LLM 配置接口只回显 `sk-cc8…cfb8` |

**数字溯源校验**（脚本比对报告里的 `%`/`pp` 数字是否出现在 brief 中，容差 0.25，取绝对值比较）
- 报告共 **52** 个百分比/百分点数字
- **51 个**能在数据包中直接找到
- **1 个**（56.5）是两个推荐来源占比之和（36.0 + 20.5），属合理推导
- **编造数：0**

> 校验脚本第一版没取绝对值，把 `-42.4` 与 `42.4` 判为不匹配，误报 10 个"编造"。修正后归零 —— 校验工具本身也要先验证。

**报告质量观察**：模型会主动标注不确定性（"需要订单/转化率数据才能确认，目前只能列为待验证项"）、
指出口径缺失（"斜率差 -74.0pp/周 的计算口径数据包未说明，只能当作方向性参考"）、
并给出落到具体变体 ASIN 的行动建议，而不是"优化 listing"这类空话。



### 第 2 步：技能参数化改造（为第 3 步铺路）

- `AI_SKILLS` 增加 `fields`（参数表单描述）、`requires_login`、`budget_usd` 三个字段；后端为唯一事实源，新增 `GET /api/ai/skills`。
- `post_run` 按 `requires_login` 决定是否检查登录态；`AiAnalyze.tsx` 参数区改为按 `fields` 渲染。
- **验收**：`cosmo-diagnose` 行为与现在完全一致（回归重点），新 skill 能带竞品列表参数进任务。

### 第 3 步：写 SKILL.md + 报告模板，跑通一次端到端

- `skills/TrafficCompare/SKILL.md`：读 `data.json` → 按第十节红线归因 → 允许的下钻范围 → 输出到 `report/<taskId>/`。
- `skills/TrafficCompare/template/report.html`：8 章结构 + 内联 SVG 图表 + 口径注页脚。
- **验收**：真实 ASIN + 3 个竞品跑一次，报告 8 章齐全，每个数字能在 `data.json` 里找到出处。

### 第 4 步：口径与成本校准

- 用 3~5 个不同类目 ASIN 各跑一次，检查：占比定义是否一致、竞品可比性标注是否到位、是否出现"绝对流量"这类违规表述。
- 记录实际 `total_cost_usd`，把 `traffic-compare` 的 `budget_usd` 定死在实测值 ×2 以内。

---

## 十三、实现前需再确认的两个细节（开发时遇到再定即可）

1. **自身 ASIN 是父体还是子体**：用户可能填子体。计划里默认 `listingSearch=true` 走父体聚合口径，若用户填的是子体则报告需注明"该 ASIN 所属父体的聚合数据"。
2. **竞品推荐依赖自身 Top 词**：若自身流量词过少（新品/无数据），自动推荐会失败 → 降级为"请手工填写竞品 ASIN"，不报错卡死。
