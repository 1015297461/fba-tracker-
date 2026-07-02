---
name: cosmo-diagnose
description: "Amazon Listing 端到端 COSMO 诊断：Alexa 反查 + SIF 数据 + 竞品对标，输出 HTML 报告、改写文案、主图 Brief、行动日历。"
version: 1.0.0
platforms: [macos, linux, windows]
metadata:
  tags: [amazon, listing, cosmo, sif, alexa, diagnosis, ecommerce]
  related_skills: []
---

# cosmo-diagnose

**触发**：用户说"诊断 ASIN B0XXXXXX"、"COSMO 诊断"、"/cosmo-diagnose B0XXXXXX" 时执行本 Skill。

**核心原则**
1. 每个结论必须有机制性证据，不接受模糊相关性。
2. 三域融合：前台页面 + SIF 数据 + Alexa 认知，交叉验证。
3. 竞品必须是**同形态**（功能/材质/风格一致）且**销量更高**的产品。
4. 输出可执行：改写文案可直接复制到 Seller Central。

> **术语**：亚马逊前台 AI 助手统一称 **Alexa**（`input[placeholder*="Ask"]`），不用"Rufus"。

---

## Phase 0 — 登录前置（Alexa 必须登录态）

检查 `CosmoDiagnose/data/amz_state.json` 是否存在：
- **不存在 / 过期** → 运行 `python3 CosmoDiagnose/amz_login.py`，等用户在弹出浏览器中登录，脚本自动保存登录态并关闭浏览器。
- **存在** → 继续 Phase 1。

> 登录判断依据：`at-main` 或 `sess-at-main` Cookie 出现即为登录成功。

---

## Phase 1 — 数据采集

### 1.1 前台页面（Playwright MCP）

打开 `https://www.amazon.com/dp/{ASIN}?language=en_US&th=1`，设置：
```js
page.setExtraHTTPHeaders({'Accept-Language': 'en-US,en;q=0.9'})
```

抓取以下选择器的完整文本：

| 数据项 | 选择器 |
|--------|--------|
| 标题 | `#productTitle` |
| 五点 | `#feature-bullets` |
| 价格/评分/评论数 | `#corePrice_feature_div` / `#acrPopover` / `#acrCustomerReviewText` |
| 产品信息 | `#detailBullets_feature_div` |
| A+ Content | `#aplus` |
| 主图 URL + alt | 所有主图元素 |
| 评论（前 30-50 条） | 在**当前产品页**滚动至底部后抓 `[data-hook="review-body"]`，**不跳转** `/product-reviews/` 单独评论 URL（该页需登录会跳 sign-in） |
| Q&A（前 10-15 对） | `#ask-btf_feature_div` |

> 若页面显示"cannot be shipped"，在报告中标注"以美国本土 IP 为准"，不判定 Buy Box 丢失。

### 1.2 Alexa 深度反查

运行：
```bash
python3 CosmoDiagnose/amz_alexa.py {ASIN}
```

等待脚本输出 `✅ 完成`，读取 `CosmoDiagnose/data/{ASIN}_alexa_qa.json`，获取 10 问回答。

若脚本输出错误提示（登录过期 / 面板不存在 / 超时），按提示处理后重跑，不做降级推断。

### 1.3 SIF 后台数据（SIF MCP）

依次调用：
- `ops_get_listing_traffic_overview` — 自然/广告流量占比
- `ops_get_asin_traffic_trend` — 近 12 周流量走势
- `market_get_asin_keyword_signals` — Top 50 关键词信号（gaining/declining/rank_gaps）
- `ops_get_listing_keyword_distribution` — 各变体关键词覆盖数
- `ops_get_asin_sales_list` — 各变体销量（如有权限）

### 1.4 竞品识别与采集

**筛选路径**（不能直接抓 Best Seller）：

1. 从 `market_get_asin_keyword_signals` 取本品 Top 5 流量词。
2. 对 Top 2-3 核心词调用 `market_get_keyword_competition`，取流量份额最高的候选 ASIN（排除本品）。
3. SIF 预筛选（直接过滤，不打开前台）：
   - 价格带 ±30%
   - 评论数 > 本品 × 1.5
   - 与本品共享 ≥2 个 Top 10 流量词
4. 对剩余候选（通常 3-5 个）用 Playwright 快速验证前台：功能/材质/风格与本品一致。
5. 确定 1-3 个同形态竞品，对每个执行 1.1 + 1.3 数据采集，Alexa 简化为 3 问：
   - "Who is this product for?"
   - "What are the top pros and cons?"
   - "What do buyers commonly compare it to?"

---

## Phase 2 — 分析诊断

按以下维度逐一分析（每条结论必须标注数据来源，证据来源缩写：T=标题 B=五点 I=图片 A=A+ R=评论 X=Alexa S=SIF）：

1. **基础数据对比表** — 本品 vs 竞品：价格/评分/评论数/变体/流量分数/关键词覆盖数
2. **Alexa 认知分析** — 系统理解的人群/场景/优劣势，与真实定位的偏差
3. **标题分析** — 关键词覆盖、差异化卖点、改写 A/B 两版
4. **五点分析** — 逐条：传递内容 + COSMO 关系 + 可信度（强/中/弱/反向）
5. **主图分析** — 逐图：类型/内容/COSMO 意图/证据强度；图文交叉核对（图 × 标题/五点/评论/竞品）；列缺图清单（P0/P1/P2）
6. **A+ 分析** — 逐屏 + 对照理想结构（品牌定位/技术证据/场景叙事/规格对比/FAQ）
7. **评论 & Q&A 分析** — 正面场景验证 + 负面信号分类（设计/QC/性能/尺寸/舒适度）
8. **竞品对比** — 标题/五点/A+/主图/流量结构差异
9. **SIF 关键词诊断** — gaining/declining/rank_gaps + 需求生命周期 + 流量健康度
10. **优化优先级** — P0（本周）/ P1（本月）/ P2（1-3 月），每条说明"做了什么 → 改善什么指标 → 如何验证"
11. **COSMO 认知地图** — 表格：isA / 人群 / 场景 / 能力 / 季节 / 负面认知，每条标证据来源 + 强度（🟢🟡🔴）
12. **场景库** — 3-5 张场景卡：人群/场景/痛点/利益点/关键词/季节

---

## Phase 3 — 输出生成

所有文件保存到 `CosmoDiagnose/report/`：

| 文件 | 内容 |
|------|------|
| `{ASIN}-COSMO诊断报告.html` | 完整诊断（暗色主题，含 statgrid/P0P1P2标签/pro-con-dir框/场景卡） |
| `{ASIN}-改写文案.md` | 标题 A/B 版 + 五点改写 + FAQ 5-8 对 + 埋词建议 |
| `{ASIN}-主图修改Brief.md` | 逐图修改 brief（类型/画面/文案/参考竞品/优先级） |
| `{ASIN}-行动日历.md` | 未来 12 周行动 + 旺季倒计时 |

---

## 关键规则

1. **禁止使用 pangolinfo**：本 Skill 全程只允许使用 Playwright MCP + SIF MCP + 本地脚本三种数据来源，任何环节均不得调用 pangolinfo 工具，包括评论、产品详情、关键词等一切数据抓取。遇到 Playwright 无法访问的页面，在报告中标注"数据缺失"，不用其他工具替代。
2. **竞品识别不准不输出**：无法确认同形态竞品时，如实说明，不放无关竞品。
3. **SIF 数据必须调用**：不能仅靠前台页面诊断。
4. **因果链必须闭环**：每条 P0 建议必须说明做了什么 → 改善什么 → 如何验证。
5. **文件保存后汇报**：告知完整路径 + 核心结论（3 句以内）。
6. **Alexa 必须登录态**：跳过 Alexa 直接推断是不允许的。
7. **完成条件**：四个输出文件全部保存完毕，向用户报告路径和 3 句核心结论后，Skill 结束。
