#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
流量分析报告生成（Markdown · 表格优先）
==========================================
输入：traffic_compare 落盘的 data.json（dataset）
输出：一份以表格为主体的 Markdown 报告，存 data/traffic-reports/<datasetId>.md

四个关键设计：
  1. **先裁剪再喂**：data.json 约 76KB，整份塞进模型既贵又容易抓错重点。
     这里压成 3~5KB 的「精简化验单」，数字全部预先换算成百分数，模型只负责抄。
  2. **能用表格就不用段落**：报告是每天要看的一页纸，不是文章。
     模型只写表注（每张表后 ≤1 句），非表格文字有硬上限。
  3. **可视化由 Python 生成**：占比条形图（█░）在 brief 里就算好，
     模型只负责复制到表格里 —— 让它自己画条形，长度一定会算错。
  4. **异常由 Python 判定**：预警项按固定阈值算好（广告跌 30%、HHI > 0.5 等），
     模型不许自己新增或改级别，保证同一份数据每次标出的红黄一致。

高亮用三个 CSS 类（前端 styles.css 里定义，自动适配深浅主题）：
  .hl-bad 红 / .hl-warn 橙 / .hl-good 绿
"""

import json
import os
import statistics

from . import llm_client
from .utils import PROJECT_ROOT, _now_iso, _log

REPORT_DIR = os.path.join(PROJECT_ROOT, "data", "traffic-reports")

MAX_VARIANTS = 6
MAX_KEYWORDS = 8
MAX_COMPETITORS = 5
MAX_DAILY_ROWS = 14


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def _pct(v, nd=1):
    """0~1 的比例 → 百分数。给模型看的字段统一带 _pct，避免它自己乘 100 乘错。"""
    if v is None:
        return None
    try:
        return round(float(v) * 100, nd)
    except (TypeError, ValueError):
        return None


def _num(v, nd=2):
    if v is None:
        return None
    try:
        return round(float(v), nd)
    except (TypeError, ValueError):
        return None


def _pct_str(v):
    """百分数 → '82.4%'。单位由代码补，模型只负责照抄，避免表格里漏写 %。"""
    return None if v is None else f"{v}%"


def _pp_str(v):
    """百分点差 → '-48.9pp'。"""
    return None if v is None else f"{v:+.1f}pp"


def _fmt_change(d):
    """把 {first, last, change_pct, improve_pct} 转成带单位的可读字段。"""
    if not isinstance(d, dict):
        return d
    out = {k: v for k, v in d.items() if k not in ("change_pct", "improve_pct")}
    if d.get("change_pct") is not None:
        out["变化"] = _pct_str(_num(d.get("change_pct"), 2))
    if d.get("improve_pct") is not None:
        out["改善"] = _pct_str(_num(d.get("improve_pct"), 2))
    return out


def _kw_row(k: dict) -> dict:
    """单个关键词 → 报告可直接引用的行。排名为空说明该词没有自然位。"""
    return {
        "词": k.get("keyword"),
        "流量占比": _pct_str(_pct(k.get("traffic_share"))),
        "自然排名": _num(k.get("organic_rank"), 0),
        "自然位占比": _pct_str(_pct(k.get("natural_ratio"))),
        "搜索量": k.get("search_volume"),
        "Top3点击占比": _pct_str(_pct(k.get("top3_click_share"))),
        "健康度": k.get("health"),
    }


def build_keyword_rows(signals: dict, limit=10) -> dict:
    """关键词信号：Top 词 / 排名断档 / 贡献下滑。

    这是「广告该调哪些词」的唯一数据依据 —— 没有它，行动建议只能写空话。
    """
    s = signals or {}
    out = {}
    for key, label in (("top_keywords", "Top词"), ("rank_gaps", "排名断档"),
                       ("declining", "贡献下滑"), ("gaining", "增长词")):
        rows = [_kw_row(k) for k in (s.get(key) or [])[:limit]]
        if rows:
            out[label] = rows
    return out


def build_price_band(competitors: list, own_price) -> dict:
    """自身价格 vs 可比竞品价格带。价格带差距常是自然位弱的直接原因，
    但 brief 里如果只列单个竞品价格，模型看不出这条线。"""
    prices = [c.get("价格") for c in (competitors or []) if c.get("价格")]
    if not prices or own_price is None:
        return None
    med = statistics.median(prices)
    return {
        "自身价格": _num(own_price, 2),
        "可比竞品数": len(prices),
        "竞品最低": _num(min(prices), 2),
        "竞品中位": _num(med, 2),
        "竞品最高": _num(max(prices), 2),
        "自身对中位溢价": _pct_str(_num((float(own_price) - med) / med * 100, 1) if med else None),
    }


def _bar(pct, width=18):
    """占比 → 字符条形图。由 Python 算，模型只负责复制，避免长度画错。"""
    if pct is None:
        return None
    try:
        p = max(0.0, min(100.0, float(pct)))
    except (TypeError, ValueError):
        return None
    filled = int(round(p / 100.0 * width))
    return "█" * filled + "░" * (width - filled)


def _clean(d):
    """去掉 None 字段，让 JSON 更短（模型也更不容易被 null 干扰）。"""
    if isinstance(d, dict):
        return {k: _clean(v) for k, v in d.items() if v is not None and v != ""}
    if isinstance(d, list):
        return [_clean(x) for x in d]
    return d


# ---------------------------------------------------------------------------
# 预警（Python 判定，模型不得新增或改级别）
# ---------------------------------------------------------------------------

_LEVEL_ORDER = {"高": 0, "中": 1, "低": 2}


def build_alerts(own: dict, meta: dict, competitors: list) -> list:
    """按固定阈值算出「需要关注」的项。同一份数据永远得到同一份清单。"""
    st = own.get("stats") or {}
    conc = own.get("variant_concentration") or {}
    price = st.get("price") or {}
    bsr = st.get("bsr") or {}
    out = []

    def add(level, metric, current, rule, hint=""):
        out.append({"级别": level, "指标": metric, "现状": current,
                    "触发条件": rule, "建议动作": hint or None})

    # 广告流量断崖
    ad_slope = st.get("slope_ad")
    if ad_slope is not None and ad_slope <= -30:
        add("高", "广告流量", f"{ad_slope:+.1f}% / 周", "周跌幅 > 30%",
            "先确认是主动降预算还是被竞价挤出")
    # 总流量下滑
    total_slope = st.get("slope_total")
    if total_slope is not None and total_slope <= -10:
        add("中", "总流量", f"{total_slope:+.1f}% / 周", "周跌幅 > 10%", "按渠道拆分定位流失点")

    # 自然占比过低 = 广告依赖（优先用与渠道表同源的 overview 值，避免同一份报告里出现两个数）
    nat = ((own.get("overview") or {}).get("nf") or {}).get("ratio")
    if nat is None:
        nat = st.get("natural_ratio_median")
    if nat is not None and nat < 0.60:
        add("高" if nat < 0.40 else "中", "自然流量占比", f"{_pct(nat)}%", "低于 60%",
            "广告一停流量就断，需补自然位")

    # 变体过度集中
    hhi = conc.get("hhi")
    if hhi is not None and hhi > 0.50:
        add("中", "变体集中度 HHI", f"{hhi:.2f}", "> 0.50",
            "单变体扛全部流量，抗风险能力弱")

    # 流量涨但排名退 = 背离
    improve = bsr.get("improve_pct")
    nf_slope = st.get("slope_nf")
    if improve is not None and improve <= -5 and nf_slope is not None and nf_slope > 0:
        add("中", "BSR 与自然流量背离",
            f"自然 {nf_slope:+.1f}%/周，BSR {improve:+.1f}%", "流量涨、排名退",
            "曝光结构或转化端可能已经变化")

    # 价格异动
    price_chg = price.get("change_pct")
    if price_chg is not None and abs(price_chg) >= 10:
        add("中", "价格", f"{price_chg:+.1f}%", "窗口内变动 ≥ 10%", "检查促销/跟价动作")

    # 竞品压制
    for c in competitors or []:
        mult = (c.get("compare") or {}).get("total_multiple_vs_own")
        if mult is not None and mult > 1.5:
            add("中", f"竞品 {c.get('asin')} 压制", f"{mult:.2f}× 于自身", "竞品流量 > 1.5 倍",
                "对该竞品的词与渠道做定点对标")

    # 数据完整性
    if meta.get("latest_point_complete") is False:
        add("低", "数据完整性", "最后一天未出完", "影响最新一天读数", "结论以完整日为准")

    out.sort(key=lambda x: _LEVEL_ORDER.get(x["级别"], 9))
    return out[:6]


# ---------------------------------------------------------------------------
# 逐日表
# ---------------------------------------------------------------------------

def build_daily(trend: dict, limit=MAX_DAILY_ROWS, drop_last=False) -> dict:
    """最近 N 天逐日数据（最多 14 行，超出只取最近 14 天并标注）。

    drop_last=True 时去掉最后一天：SIF 当天数据未结算完（latest_point_complete=False），
    留着会让读者把「还没采完」当成「暴跌」。
    """
    dates = list(trend.get("dates") or [])
    n = len(dates)
    if drop_last and n > 1:
        dates = dates[:-1]
        n -= 1
    if not n:
        return {}
    idx = list(range(max(0, n - limit), n))
    cols = (("total", "总流量", 0), ("nf", "自然", 0), ("ad", "广告", 0),
            ("price", "价格", 2), ("bsr", "BSR", 0))
    rows = []
    for i in idx:
        row = {"日期": dates[i]}
        for key, label, nd in cols:
            arr = trend.get(key) or []
            v = arr[i] if i < len(arr) else None
            # SIF 的 adScore 偶有负值（修正项），流量分语义上不应为负；
            # 缺失时通常自然≈总量，说明该日无广告投放。两种情况都归 0，
            # 避免报告里出现 "-4.0" 这种让人看不懂的读数。
            if key == "ad" and (v is None or v < 0):
                v = 0.0
            row[label] = _num(v, nd)
        rows.append(row)
    return {"展示天数": len(rows), "仅展示最近": limit if n > limit else None,
            "已排除末点": bool(drop_last and n < len(trend.get("dates") or [])),
            "数据": rows}


# ---------------------------------------------------------------------------
# 数据包
# ---------------------------------------------------------------------------

def build_brief(data: dict) -> dict:
    """把完整 dataset 裁成给模型看的精简版。所有数字都已算好、换算好。"""
    meta = data.get("meta") or {}
    own = data.get("own") or {}
    prof = own.get("profile") or {}
    ov = own.get("overview") or {}
    st = own.get("stats") or {}
    conc = own.get("variant_concentration") or {}
    trend = own.get("trend") or {}

    # 渠道表把「自然流量」放在第一行：它和广告渠道同源于 overview 快照，
    # 这样整张表加起来正好 100%，不会出现「自然 82.2% + 广告 17.7%」这种对不上的情况
    nat_share = _pct((ov.get("nf") or {}).get("ratio"))
    channels = [{"渠道": "自然流量", "占总流量": _pct_str(nat_share), "占广告": None,
                 "分布": _bar(nat_share)}]
    for c in ov.get("channels") or []:
        share = _pct(c.get("share_of_total"))
        channels.append({
            "渠道": c.get("name"),
            "占总流量": _pct_str(share),
            "占广告": _pct_str(_pct(c.get("share_of_ad"))),
            "分布": _bar(share),
        })

    recommend = [{"来源": r.get("name"), "占比": _pct_str(_pct(r.get("ratio")))}
                 for r in (ov.get("recommend") or [])[:4]]

    variants = []
    for v in (own.get("variants") or [])[:MAX_VARIANTS]:
        share = _pct(v.get("flow_ratio"))
        variants.append({
            "asin": v.get("asin"),
            "规格": " / ".join(v.get("features") or []) or None,
            "流量占比": _pct_str(share),
            "自然占比": _pct_str(_pct(v.get("nf_share_in_variant"))),
            "覆盖词数": v.get("kw_total"),
            "价格": _num(v.get("price")),
            "分布": _bar(share, 12),
        })

    comps = []
    for c in (data.get("competitors") or [])[:MAX_COMPETITORS]:
        if c.get("error"):
            continue
        cp = c.get("compare") or {}
        cs = c.get("stats") or {}
        cp_prof = c.get("profile") or {}
        diffs = {k: v for k, v in (cp.get("channel_share_diff_pp") or {}).items()
                 if v is not None and abs(v) >= 0.5}
        top_diff = None
        if diffs:
            k = max(diffs, key=lambda x: abs(diffs[x]))
            label = {"sp": "SP常规", "recommend": "SP推荐", "sb": "SB", "sbv": "SBV"}.get(k, k)
            top_diff = f"{label} {diffs[k]:+.1f}pp"
        comps.append({
            "asin": c.get("asin"),
            "品牌": cp_prof.get("brand"),
            "价格": _num(cp_prof.get("price")),
            "流量倍数": _num(cp.get("total_multiple_vs_own"), 2),
            "自然占比": _pct_str(_pct(cs.get("natural_ratio_median"))),
            "自然占比差": _pp_str(_num(cp.get("natural_ratio_diff_pp"), 1)),
            "主要结构差": top_diff,
            "价格差": _pct_str(_num(cp.get("price_gap_pct"), 1)),
            "可比性": (cp.get("warnings") or None),
        })

    brief = {
        "分析对象": {
            "asin": meta.get("asin"),
            "标题": (prof.get("title") or "")[:80] or None,
            "品牌": prof.get("brand"),
            "价格": _num(prof.get("price")),
            "评分": _num(prof.get("star"), 1),
            "评论数": prof.get("rating_num"),
            "BSR": prof.get("bsr"),
            "变体数": prof.get("variation_num"),
        },
        "口径": {
            "站点": meta.get("country"),
            "周期": meta.get("period_label"),
            "数据截止": meta.get("latest_point_date"),
            "末点完整": meta.get("latest_point_complete"),
            "统计范围": "父体+全部子体聚合" if meta.get("listing_search") else "单个 ASIN",
            "数据源": "SIF（第三方）",
            "已知局限": (meta.get("period_notes") or None),
        },
        "预警": build_alerts(own, meta, data.get("competitors") or []),
        "流量结构": {
            # 与渠道表同源于 overview 快照，保证「自然 + 各广告渠道 = 100%」自洽。
            # （stats.natural_ratio_median 是逐日中位数，会差零点几个点，不放进这里）
            "自然占比": _pct_str(_pct((ov.get("nf") or {}).get("ratio"))),
            "广告占比": _pct_str(_pct((ov.get("ad") or {}).get("ratio"))),
            "渠道": channels,
            "推荐来源": recommend,
        },
        "趋势": {
            "每周变化": {
                "总流量": _pct_str(_num(st.get("slope_total"), 1)),
                "自然": _pct_str(_num(st.get("slope_nf"), 1)),
                "广告": _pct_str(_num(st.get("slope_ad"), 1)),
            },
            "近7天vs前7天": _pct_str(_num(st.get("last_week_vs_prev_week_pct"), 1)),
            "波动系数": _num(st.get("volatility_cv"), 2),
            "最高日": st.get("peak"),
            "最低日": st.get("trough"),
            "价格": _fmt_change(st.get("price")),
            "BSR": _fmt_change(st.get("bsr")),
            "评论": _fmt_change(st.get("review")),
            "逐日": build_daily(trend, drop_last=meta.get("latest_point_complete") is False),
        },
        "变体": {
            "变体总数": conc.get("variant_count"),
            "有流量变体": conc.get("variants_with_flow"),
            "Top1占比": _pct_str(_pct(conc.get("top1_share"))),
            "HHI": _num(conc.get("hhi"), 2),
            "明细": variants,
        },
        "竞品": comps,
        "竞品价格带": build_price_band(comps, prof.get("price")),
        "关键词信号": build_keyword_rows(own.get("keyword_signals")),
    }

    return _clean(brief)


SYSTEM_PROMPT = """你是一名给电商团队做日常复盘的数据分析师。你的产出是**一页纸的表格化速览**，不是文章。

读者每天早上看 30 秒就要知道：哪里出事了、严重到什么程度、该动哪里。

## 输出形态（硬性）

- **表格是主体**，文字只做「表注」：每张表格下方最多 1 句结论，不超过 40 字。
- 全文**非表格文字合计不超过 400 字**。宁可少写，不要凑字数。
- 不要写「综上所述」「总的来说」「值得注意的是」这类过渡句。
- 不要解释方法论，不要复述口径（口径表里已有）。
- 不要为了完整而罗列每个数字；表格里已经有的，正文不要再念一遍。

## 高亮（必须使用，这是给读者的注意力引导）

用 HTML span 包裹**单个数字或短语**（不要包整句、不要包表格单元格外的说明）：

- `<span class="hl-bad">-42.4%</span>` 严重异常、大幅恶化
- `<span class="hl-warn">78</span>` 需要留意、轻微恶化或处于边界
- `<span class="hl-good">+7.6%</span>` 明显向好

判定依据：`预警` 字段里级别为「高」的用 hl-bad，级别为「中」的用 hl-warn。不要自己发明高亮对象。

## 铁律

1. **只准引用数据包里出现的数字**，一个都不许自己推算或补全。数据包里没有的，写「—」。
2. **绝对不许把相对分换算成绝对流量**（UV/曝光/点击/订单）。只能讲占比、倍数、涨跌幅。
3. **不许编造因果**。排除法可以（「同期价格未变，故价格不是直接原因」），推断不行。
4. **不许说「掉出前三页」「被降权」**。排名缺失只能写「本期未采集到」。
5. BSR 数值越小越好，数据包已把变化换算成「改善」口径（正数=变好），直接引用。

## 行动建议的写法（整份报告最重要的一节）

每条动作必须四要素齐全，缺任何一条就是空话：

1. **对象**：具体到某个词、某个变体、某个渠道。不许写「listing」「广告」这种整体词。
2. **动作**：一个可执行的操作——改什么、加什么、关什么、调多少。
3. **依据**：数据包里的一个具体数字。
4. **预期**：一个能用数据观察到的变化（例如「该词自然排名进前 10 后，其流量占比应从 2.1% 往上走」）。

可用的运营抓手（只能从这里选，不许发明新概念）：

- **自然位**：标题/五点/A+ 的关键词布局、后台 Search Terms、类目节点、主图与价格竞争力、评论积累（Vine、售后卡）、变体合并把评价集中到主变体
- **SP 广告**：关键词分层（精准/词组/广泛）、否定无效流量词、按词调竞价、TOS 位置溢价、预算再分配
- **SB/SBV**：素材与落地页匹配度、视频卖点、人群定向、投放词选择
- **变体**：把广告预算从自然占比极低的变体挪到有自然承接力的变体

数据包里有「关键词信号」（Top词 / 排名断档 / 贡献下滑 / 增长词），**必须从中挑具体词名写进动作**。
哪类信号缺失就写「本期数据未覆盖」，不许拿别的词凑数。

若「竞品价格带」显示自身对中位溢价超过 20%，必须评估价格是否为自然位弱的直接原因，
并给出具体动作（例如调整券后价、换规格组合、或在文案里强化差异化卖点）。
"""

OUTLINE = """## 输出结构（严格照此，标题文字不要改）

# {asin} · {period}

## 一、需要关注

| 级别 | 指标 | 现状 | 触发条件 | 建议动作 |
|---|---|---|---|---|

数据来自 `预警` 字段，**逐行照抄，不要新增、不要合并、不要改级别**。「现状」里的数字按级别加高亮。
若 `预警` 为空，写一行「本周期无触发预警项」。

表下 1 句：这批问题里最该先动哪一个。

## 二、流量结构

| 渠道 | 占总流量 | 占广告 | 分布 |
|---|---|---|---|

「分布」列直接复制 `流量结构.渠道[].分布` 的字符条。
表下 1 句：这个结构说明什么（自然是否能自持、广告是否单腿走路）。

如有推荐来源，再用一行列出 Top 来源与占比，不单独成段。

## 三、逐日趋势

| 日期 | 总流量 | 自然 | 广告 | 价格 | BSR |
|---|---|---|---|---|---|

数据来自 `趋势.逐日.数据`，按顺序逐行照抄。
对该时间段内的最高日、最低日，在对应数值上加 hl-good / hl-bad；
广告列若出现连续下滑，把最后一个值标 hl-bad。
表下 1 句：方向与拐点在哪天。

## 四、变体分布

| 变体 | 规格 | 流量占比 | 自然占比 | 覆盖词数 | 分布 |
|---|---|---|---|---|---|

表下 1 句：流量是否过度集中，哪个变体靠广告撑着（自然占比低但流量占比不低）。

## 五、竞品对比

| 竞品 | 价格 | 流量倍数 | 自然占比 | 主要结构差 | 可比性 |
|---|---|---|---|---|---|

「流量倍数」是竞品相对自身，>1 表示竞品更大，用 hl-warn 标出。
「可比性」列照抄 `竞品[].可比性`，为空写「可比」。
表下 1 句：最该盯的是哪个竞品、差在哪个渠道。

## 六、归因与行动

**归因**（不超过 2 句）：把上面的线索收敛成一个主因，并说明排除了什么。数据不足以定论时，直接写「需要 X 数据才能确认」。

| 优先级 | 动作（对象 + 操作 + 预期） | 依据 |
|---|---|---|

最多 3 行。优先级用 P0/P1/P2。
「依据」必须是数据包里的一个具体数字，含关键词信号里的词名或自然排名。
「动作」必须带具体对象与可观察的预期，不许写「补自然位」「优化 listing」这类没有对象的话。
"""


def build_messages(brief: dict) -> list:
    asin = (brief.get("分析对象") or {}).get("asin") or "该 ASIN"
    period = (brief.get("口径") or {}).get("周期") or ""
    user = (
        f"下面是 {asin} 的数据包：\n\n"
        f"```json\n{json.dumps(brief, ensure_ascii=False, indent=1)}\n```\n\n"
        + OUTLINE.replace("{asin}", asin).replace("{period}", period)
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def report_path(dataset_id: str, ext: str = "md") -> str:
    return os.path.join(REPORT_DIR, f"{dataset_id}.{ext}")


def load_report(dataset_id: str):
    """读已生成的报告（含 meta）。不存在返回 None。"""
    p = report_path(dataset_id, "md")
    if not dataset_id or not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            md = f.read()
    except Exception:
        return None
    meta = {}
    try:
        with open(report_path(dataset_id, "json"), "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        pass
    return {"markdown": md, "meta": meta, "cached": True}


def generate(dataset_id: str, force: bool = False, state=None, username: str = None) -> dict:
    """生成 Markdown 报告并落盘。force=False 时命中缓存直接返回。

    state 不为空时把这次生成写进 traffic_reports 历史表（前端历史列表的数据源）。
    抛 LLMError（未配置/鉴权/网络/余额）或 ValueError（dataset 不存在）。
    """

    def _record(meta, data):
        """写历史；写库失败不影响报告可用，只丢一条列表记录。"""
        if state is None:
            return
        try:
            state.upsert_traffic_report({
                "id": dataset_id,
                "asin": meta.get("asin"),
                "period_label": meta.get("period_label"),
                "period_value": ((data or {}).get("meta") or {}).get("period_value"),
                "username": username,
                "model": meta.get("model"),
                "report_chars": meta.get("report_chars") or 0,
                "alert_count": meta.get("alert_count") or 0,
                "md_path": report_path(dataset_id, "md"),
                "created_at": meta.get("generated_at"),
            })
        except Exception as e:
            _log(f"[traffic] 写报告历史失败 {dataset_id}: {e}")

    if not force:
        cached = load_report(dataset_id)
        if cached:
            # 缓存命中也要进历史（可能历史表被清过、但文件还在）
            _record(cached.get("meta") or {}, None)
            return cached

    from . import traffic_compare
    data = traffic_compare.load_dataset(dataset_id)
    if not data:
        raise ValueError(f"数据集不存在或已过期：{dataset_id}（请重新取数）")

    brief = build_brief(data)
    messages = build_messages(brief)
    result = llm_client.chat(messages)

    md = result["text"].strip()
    # 个别模型会把整段包在 ```markdown 里，剥掉围栏避免页面显示成代码块
    if md.startswith("```"):
        first_nl = md.find("\n")
        if first_nl != -1:
            md = md[first_nl + 1:]
        if md.rstrip().endswith("```"):
            md = md.rstrip()[:-3].rstrip()

    meta = {
        "dataset_id": dataset_id,
        "asin": (data.get("meta") or {}).get("asin"),
        "period_label": (data.get("meta") or {}).get("period_label"),
        "model": result.get("model"),
        "usage": result.get("usage"),
        "elapsed": result.get("elapsed"),
        "generated_at": _now_iso(),
        "prompt_chars": sum(len(m["content"]) for m in messages),
        "report_chars": len(md),
        "alert_count": len(brief.get("预警") or []),
    }

    os.makedirs(REPORT_DIR, exist_ok=True)
    with open(report_path(dataset_id, "md"), "w", encoding="utf-8") as f:
        f.write(md)
    with open(report_path(dataset_id, "json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    _record(meta, data)
    return {"markdown": md, "meta": meta, "cached": False}
