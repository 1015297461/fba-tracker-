/* eslint-disable no-undef */
// Product list + detail panel — fully editable

function ProductList({
  products,
  activeId,
  setActiveId
}) {
  const [search, setSearch] = React.useState('');
  const filtered = products.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase()));
  return /*#__PURE__*/React.createElement("div", {
    className: "plist"
  }, /*#__PURE__*/React.createElement("div", {
    className: "plist-search"
  }, /*#__PURE__*/React.createElement("div", {
    className: "plist-search-wrap"
  }, /*#__PURE__*/React.createElement("input", {
    value: search,
    onChange: e => setSearch(e.target.value),
    placeholder: "\u641C\u7D22\u4EA7\u54C1\u540D\u79F0\u6216 SKU\u2026"
  }))), /*#__PURE__*/React.createElement("div", null, filtered.map(p => {
    const stage = STAGES.find(s => s.key === p.currentStage);
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      className: "pcard",
      "data-active": p.id === activeId,
      onClick: () => setActiveId(p.id)
    }, /*#__PURE__*/React.createElement("div", {
      className: "pcard-row1"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pcard-name"
    }, p.name), /*#__PURE__*/React.createElement("span", {
      className: `badge badge-${p.status}`
    }, STATUS_LABELS[p.status].label)), /*#__PURE__*/React.createElement("div", {
      className: "pcard-row2"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pcard-sku mono"
    }, p.sku), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, p.category)), /*#__PURE__*/React.createElement("div", {
      className: "pcard-bar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pcard-bar-fill",
      style: {
        width: p.progress + '%'
      }
    })), /*#__PURE__*/React.createElement("div", {
      className: "pcard-row3"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pcard-stage"
    }, /*#__PURE__*/React.createElement("span", {
      className: "dot",
      style: {
        background: stage?.color
      }
    }), /*#__PURE__*/React.createElement("span", null, stage?.name)), /*#__PURE__*/React.createElement("span", {
      className: "pcard-pct"
    }, p.progress, "%")));
  })));
}

// ============ TAB: 立项评估 ============
function TabEval({
  p
}) {
  const {
    updateStage,
    update
  } = useProducts();
  const set = (key, patch) => updateStage(p.id, key, patch);
  const init = p.stages.initiation;
  const research = p.stages.research;
  const profit = p.stages.profit;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[0],
    productId: p.id,
    stageKey: "initiation",
    stageData: init
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u8D1F\u8D23\u4EBA",
    value: p.lead ?? init.lead,
    onChange: v => {
      set('initiation', {
        lead: v
      });
      update(p.id, prev => ({
        ...prev,
        lead: v
      }));
    }
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u76EE\u6807\u5E02\u573A",
    value: init.market,
    options: ['美国 US', '英国 UK', '德国 DE', '日本 JP', '加拿大 CA', '澳大利亚 AU'],
    onChange: v => set('initiation', {
      market: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9009\u54C1\u6765\u6E90",
    value: init.source,
    options: ['关键词工具 / Helium 10', '卖家精灵', 'TikTok 爆款', '品类雷达', '线下展会', '其他'],
    onChange: v => set('initiation', {
      source: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u54C1\u7C7B",
    value: p.category,
    placeholder: "\u81EA\u5B9A\u4E49\u54C1\u7C7B\uFF0C\u4F8B\u5982\uFF1A\u5BB6\u5C45 / \u88C5\u9970",
    onChange: v => update(p.id, prev => ({
      ...prev,
      category: v
    }))
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "SKU",
    mono: true,
    value: p.sku,
    onChange: v => update(p.id, prev => ({
      ...prev,
      sku: v
    }))
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u7ACB\u9879\u65E5\u671F",
    type: "date",
    mono: true,
    value: p.createdAt,
    onChange: v => update(p.id, prev => ({
      ...prev,
      createdAt: v
    }))
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u7ACB\u9879\u7406\u7531",
    wide: true,
    multi: true,
    value: init.reason,
    onChange: v => set('initiation', {
      reason: v
    })
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[1],
    productId: p.id,
    stageKey: "research",
    stageData: research
  }, /*#__PURE__*/React.createElement("div", {
    className: "kpi-strip"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u6708\u9500\u603B\u91CF"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, research.monthSales?.toLocaleString() || '—'), /*#__PURE__*/React.createElement("div", {
    className: "s"
  }, "Top10 \u7D2F\u8BA1")), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u7ADE\u54C1\u6570"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, research.competitorCount || '—')), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u5747\u4EF7"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "$", research.avgPrice ?? '—')), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u5747\u8BC4\u5206"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, research.avgRating ?? '—', " \u2605"), /*#__PURE__*/React.createElement("div", {
    className: "s"
  }, "\u673A\u4F1A\u8BC4\u7EA7 ", research.opportunity || '—'))), /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u6708\u9500\u603B\u91CF",
    type: "number",
    mono: true,
    value: research.monthSales,
    onChange: v => set('research', {
      monthSales: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u7ADE\u54C1\u6570",
    type: "number",
    mono: true,
    value: research.competitorCount,
    onChange: v => set('research', {
      competitorCount: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5747\u4EF7 (USD)",
    type: "number",
    mono: true,
    prefix: "$",
    value: research.avgPrice,
    onChange: v => set('research', {
      avgPrice: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "Top ASIN",
    mono: true,
    value: research.topAsin,
    onChange: v => set('research', {
      topAsin: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5747\u8BC4\u5206",
    type: "number",
    mono: true,
    value: research.avgRating,
    onChange: v => set('research', {
      avgRating: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u673A\u4F1A\u8BC4\u7EA7",
    value: research.opportunity,
    options: ['A', 'B', 'C', 'D'],
    onChange: v => set('research', {
      opportunity: v
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u75DB\u70B9\u5173\u952E\u8BCD",
    wide: true,
    multi: true,
    value: research.painPoints,
    onChange: v => set('research', {
      painPoints: v
    })
  }))), /*#__PURE__*/React.createElement(ProfitCard, {
    p: p
  }), /*#__PURE__*/React.createElement(BomCard, {
    p: p
  }));
}

// ============ Profit (with tax on product cost, return rate, dual currency) ============
function ProfitCard({
  p
}) {
  const {
    updateStage,
    update
  } = useProducts();
  const pr = p.stages.profit;
  const fx = Number(p.fxRate) || window.DEFAULT_FX || 7.20;
  const set = patch => updateStage(p.id, 'profit', patch);

  // Inputs
  const targetPrice = Number(pr.targetPrice) || 0; // USD
  const taxRate = Number(pr.taxRate ?? 0); // %
  const cogsCny = Number(pr.cogs) || 0; // CNY (pre-tax)
  const shippingCny = Number(pr.shipping) || 0; // CNY
  const otherCny = Number(pr.otherCost) || 0; // CNY
  const fbaFee = Number(pr.fbaFee) || 0; // USD
  const referralPct = Number(pr.referralPct) || 0; // %
  const adPct = Number(pr.adPct) || 0; // %
  const returnRate = Number(pr.returnRate ?? 0); // %

  // Derived
  const cogsUsd = fx > 0 ? cogsCny / fx : 0; // USD 不含税（参与计算）
  const cogsInclCny = cogsCny * (1 + taxRate / 100); // CNY 含税（仅展示）
  const cogsInclUsd = fx > 0 ? cogsInclCny / fx : 0; // USD 含税（仅展示）
  const shippingUsd = fx > 0 ? shippingCny / fx : 0;
  const otherUsd = fx > 0 ? otherCny / fx : 0;
  const referralFee = targetPrice * referralPct / 100;
  const adFee = targetPrice * adPct / 100;
  const returnCost = targetPrice * (returnRate / 100); // 退货成本 = 售价 × 退货率

  // 毛利润 = 目标售价 - FBA费用 - 头程运费 - 不含税产品成本
  const grossProfit = targetPrice - fbaFee - shippingUsd - cogsUsd;
  // 净利润 = 毛利润 - 平台佣金 - 广告费 - 退货成本 - 其他费用
  const netProfit = grossProfit - referralFee - adFee - returnCost - otherUsd;
  const margin = targetPrice ? netProfit / targetPrice * 100 : 0;
  const marginCls = margin >= 20 ? 'green' : margin >= 10 ? 'orange' : 'red';
  return /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[2],
    productId: p.id,
    stageKey: "profit",
    stageData: pr,
    extraHeader: /*#__PURE__*/React.createElement("span", {
      className: `decision-pill ${pr.decision || 'hold'}`,
      style: {
        marginLeft: 6
      }
    }, pr.decision === 'pass' ? '✓ 通过立项' : pr.decision === 'hold' ? '⏸ 暂缓观察' : pr.decision === 'reject' ? '✗ 否决' : '— 待决策')
  }, /*#__PURE__*/React.createElement("div", {
    className: "currency-bar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "cb-label"
  }, "\u6C47\u7387"), /*#__PURE__*/React.createElement("div", {
    className: "cb-fx-input"
  }, /*#__PURE__*/React.createElement("span", {
    className: "cb-prefix"
  }, "\xA5"), /*#__PURE__*/React.createElement("input", {
    className: "cb-input mono",
    type: "number",
    step: "0.01",
    value: fx,
    onChange: e => update(p.id, prev => ({
      ...prev,
      fxRate: Number(e.target.value)
    }))
  }), /*#__PURE__*/React.createElement("span", {
    className: "cb-suffix"
  }, "= $1")), /*#__PURE__*/React.createElement("span", {
    className: "cb-hint"
  }, "\xA5 \u7528\u4E8E\u4EA7\u54C1\u6210\u672C/\u5934\u7A0B/\u5176\u4ED6\u8D39\u7528 \xB7 $ \u7528\u4E8E\u552E\u4EF7/FBA/\u6BDB\u51C0\u5229")), /*#__PURE__*/React.createElement("div", {
    className: "kpi-strip cols-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u76EE\u6807\u552E\u4EF7 ($)"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "$", targetPrice.toFixed(2))), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u4E0D\u542B\u7A0E\u4EA7\u54C1\u6210\u672C"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "\xA5", cogsCny.toFixed(2)), /*#__PURE__*/React.createElement("div", {
    className: "s"
  }, "\u2248 $", cogsUsd.toFixed(2))), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u6BDB\u5229\u6DA6 ($)"), /*#__PURE__*/React.createElement("div", {
    className: "v"
  }, "$", grossProfit.toFixed(2))), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u51C0\u5229\u6DA6 ($)"), /*#__PURE__*/React.createElement("div", {
    className: `v ${marginCls}`
  }, "$", netProfit.toFixed(2))), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "l"
  }, "\u51C0\u5229\u7387"), /*#__PURE__*/React.createElement("div", {
    className: `v ${marginCls}`
  }, margin.toFixed(1), "%"), /*#__PURE__*/React.createElement("div", {
    className: "s"
  }, margin >= 20 ? '健康' : margin >= 10 ? '可接受' : '风险'))), /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-4"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u76EE\u6807\u552E\u4EF7 ($)",
    type: "number",
    mono: true,
    prefix: "$",
    value: pr.targetPrice,
    onChange: v => set({
      targetPrice: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u4EA7\u54C1\u6210\u672C (\xA5)",
    type: "number",
    mono: true,
    prefix: "\xA5",
    value: pr.cogs,
    onChange: v => set({
      cogs: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u7A0E\u70B9 (%)",
    type: "number",
    mono: true,
    suffix: "%",
    value: pr.taxRate,
    onChange: v => set({
      taxRate: v
    })
  }), /*#__PURE__*/React.createElement("div", {
    className: "field-static"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field-static-label"
  }, "\u542B\u7A0E\u4EA7\u54C1\u6210\u672C (\xA5) ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--ink-4)',
      fontWeight: 400,
      fontSize: 10
    }
  }, "\u4EC5\u5C55\u793A")), /*#__PURE__*/React.createElement("div", {
    className: "field-static-value mono"
  }, "\xA5", cogsInclCny.toFixed(2), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--ink-4)',
      fontSize: 10.5
    }
  }, "\u2248 $", cogsInclUsd.toFixed(2)))), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5934\u7A0B\u8FD0\u8D39 (\xA5)",
    type: "number",
    mono: true,
    prefix: "\xA5",
    value: pr.shipping,
    onChange: v => set({
      shipping: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "FBA \u8D39\u7528 ($)",
    type: "number",
    mono: true,
    prefix: "$",
    value: pr.fbaFee,
    onChange: v => set({
      fbaFee: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5176\u4ED6\u8D39\u7528 (\xA5)",
    type: "number",
    mono: true,
    prefix: "\xA5",
    value: pr.otherCost,
    onChange: v => set({
      otherCost: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9000\u8D27\u7387 (%)",
    type: "number",
    mono: true,
    suffix: "%",
    value: pr.returnRate,
    onChange: v => set({
      returnRate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5E73\u53F0\u4F63\u91D1 (%)",
    type: "number",
    mono: true,
    suffix: "%",
    value: pr.referralPct,
    onChange: v => set({
      referralPct: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5E7F\u544A\u9884\u7B97 (%)",
    type: "number",
    mono: true,
    suffix: "%",
    value: pr.adPct,
    onChange: v => set({
      adPct: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u7ACB\u9879\u51B3\u7B56",
    value: pr.decision,
    options: [{
      value: 'pass',
      label: '通过立项'
    }, {
      value: 'hold',
      label: '暂缓观察'
    }, {
      value: 'reject',
      label: '否决'
    }],
    onChange: v => set({
      decision: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u51B3\u7B56\u65E5\u671F",
    type: "date",
    mono: true,
    value: pr.endDate,
    onChange: v => updateStage(p.id, 'profit', {
      endDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u51B3\u7B56\u5907\u6CE8",
    wide: true,
    value: pr.decisionNote,
    onChange: v => set({
      decisionNote: v
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      padding: '10px 12px',
      background: 'var(--bg-2)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      fontSize: 11.5,
      color: 'var(--ink-3)',
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCA1 BOM \u53C2\u8003\u6210\u672C (\xA5): ", /*#__PURE__*/React.createElement("strong", {
    className: "mono",
    style: {
      color: 'var(--ink)'
    }
  }, "\xA5", (p.stages.bom.items || []).reduce((s, i) => s + i.qty * i.unitCost, 0).toFixed(2))), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => {
      const total = (p.stages.bom.items || []).reduce((s, i) => s + i.qty * i.unitCost, 0);
      set({
        cogs: +total.toFixed(2)
      });
    }
  }, "\uD83D\uDD04 \u540C\u6B65\u5230\u4EA7\u54C1\u6210\u672C")), /*#__PURE__*/React.createElement("div", {
    className: "formula-block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "formula-hdr"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCD0 \u8BA1\u7B97\u516C\u5F0F"), /*#__PURE__*/React.createElement("span", {
    className: "formula-fx mono"
  }, "\xA5", fx.toFixed(2), " = $1")), /*#__PURE__*/React.createElement("div", {
    className: "formula-rows"
  }, /*#__PURE__*/React.createElement("div", {
    className: "formula-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fr-label"
  }, "\u542B\u7A0E\u4EA7\u54C1\u6210\u672C"), /*#__PURE__*/React.createElement("span", {
    className: "fr-eq"
  }, "="), /*#__PURE__*/React.createElement("span", {
    className: "fr-expr"
  }, "\u4EA7\u54C1\u6210\u672C \xD7 (1 + \u7A0E\u70B9)"), /*#__PURE__*/React.createElement("span", {
    className: "fr-calc mono"
  }, "\xA5", cogsCny.toFixed(2), " \xD7 (1 + ", taxRate, "%) = ", /*#__PURE__*/React.createElement("strong", null, "\xA5", cogsInclCny.toFixed(2)), " \u2248 $", cogsInclUsd.toFixed(2))), /*#__PURE__*/React.createElement("div", {
    className: "formula-row highlight strong"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fr-label"
  }, "\u6BDB\u5229\u6DA6 ($)"), /*#__PURE__*/React.createElement("span", {
    className: "fr-eq"
  }, "="), /*#__PURE__*/React.createElement("span", {
    className: "fr-expr"
  }, "\u76EE\u6807\u552E\u4EF7 \u2212 FBA\u8D39\u7528 \u2212 \u5934\u7A0B\u8FD0\u8D39 \u2212 \u4EA7\u54C1\u6210\u672C(\u4E0D\u542B\u7A0E)"), /*#__PURE__*/React.createElement("span", {
    className: "fr-calc mono"
  }, "$", targetPrice.toFixed(2), " \u2212 $", fbaFee.toFixed(2), " \u2212 $", shippingUsd.toFixed(2), " \u2212 $", cogsUsd.toFixed(2), " = ", /*#__PURE__*/React.createElement("strong", {
    className: grossProfit >= 0 ? 'green' : 'red'
  }, "$", grossProfit.toFixed(2)))), /*#__PURE__*/React.createElement("div", {
    className: "formula-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fr-label"
  }, "\u5E73\u53F0\u4F63\u91D1"), /*#__PURE__*/React.createElement("span", {
    className: "fr-eq"
  }, "="), /*#__PURE__*/React.createElement("span", {
    className: "fr-expr"
  }, "\u76EE\u6807\u552E\u4EF7 \xD7 \u4F63\u91D1%"), /*#__PURE__*/React.createElement("span", {
    className: "fr-calc mono"
  }, "$", targetPrice.toFixed(2), " \xD7 ", referralPct, "% = ", /*#__PURE__*/React.createElement("strong", null, "$", referralFee.toFixed(2)))), /*#__PURE__*/React.createElement("div", {
    className: "formula-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fr-label"
  }, "\u5E7F\u544A\u8D39"), /*#__PURE__*/React.createElement("span", {
    className: "fr-eq"
  }, "="), /*#__PURE__*/React.createElement("span", {
    className: "fr-expr"
  }, "\u76EE\u6807\u552E\u4EF7 \xD7 \u5E7F\u544A\u9884\u7B97%"), /*#__PURE__*/React.createElement("span", {
    className: "fr-calc mono"
  }, "$", targetPrice.toFixed(2), " \xD7 ", adPct, "% = ", /*#__PURE__*/React.createElement("strong", null, "$", adFee.toFixed(2)))), /*#__PURE__*/React.createElement("div", {
    className: "formula-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fr-label"
  }, "\u9000\u8D27\u6210\u672C"), /*#__PURE__*/React.createElement("span", {
    className: "fr-eq"
  }, "="), /*#__PURE__*/React.createElement("span", {
    className: "fr-expr"
  }, "\u76EE\u6807\u552E\u4EF7 \xD7 \u9000\u8D27\u7387"), /*#__PURE__*/React.createElement("span", {
    className: "fr-calc mono"
  }, "$", targetPrice.toFixed(2), " \xD7 ", returnRate, "% = ", /*#__PURE__*/React.createElement("strong", null, "$", returnCost.toFixed(2)))), /*#__PURE__*/React.createElement("div", {
    className: "formula-row highlight strong"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fr-label"
  }, "\u51C0\u5229\u6DA6 ($)"), /*#__PURE__*/React.createElement("span", {
    className: "fr-eq"
  }, "="), /*#__PURE__*/React.createElement("span", {
    className: "fr-expr"
  }, "\u6BDB\u5229\u6DA6 \u2212 \u5E73\u53F0\u4F63\u91D1 \u2212 \u5E7F\u544A\u8D39 \u2212 \u9000\u8D27\u6210\u672C \u2212 \u5176\u4ED6\u8D39\u7528"), /*#__PURE__*/React.createElement("span", {
    className: "fr-calc mono"
  }, "$", grossProfit.toFixed(2), " \u2212 $", referralFee.toFixed(2), " \u2212 $", adFee.toFixed(2), " \u2212 $", returnCost.toFixed(2), " \u2212 $", otherUsd.toFixed(2), " = ", /*#__PURE__*/React.createElement("strong", {
    className: marginCls
  }, "$", netProfit.toFixed(2)))), /*#__PURE__*/React.createElement("div", {
    className: "formula-row highlight strong"
  }, /*#__PURE__*/React.createElement("span", {
    className: "fr-label"
  }, "\u51C0\u5229\u7387"), /*#__PURE__*/React.createElement("span", {
    className: "fr-eq"
  }, "="), /*#__PURE__*/React.createElement("span", {
    className: "fr-expr"
  }, "\u51C0\u5229\u6DA6 \xF7 \u76EE\u6807\u552E\u4EF7 \xD7 100%"), /*#__PURE__*/React.createElement("span", {
    className: "fr-calc mono"
  }, "$", netProfit.toFixed(2), " \xF7 $", targetPrice.toFixed(2), " \xD7 100% = ", /*#__PURE__*/React.createElement("strong", {
    className: marginCls
  }, margin.toFixed(1), "%"))))));
}

// ============ BOM ============
const BOM_CATS = ['面料/布料', '电机/马达', '电源/电池', '开关/控制', 'LED/灯珠', '模具/外壳', '包装材料', '认证费', '物流/运费', '其他'];
function BomCard({
  p
}) {
  const {
    updateStage
  } = useProducts();
  const stage = STAGES[3];
  const bom = p.stages.bom || {
    items: []
  };
  const items = bom.items || [];
  const updateItem = (id, patch) => {
    const next = items.map(i => i.id === id ? {
      ...i,
      ...patch
    } : i);
    updateStage(p.id, 'bom', {
      items: next
    });
  };
  const removeItem = id => updateStage(p.id, 'bom', {
    items: items.filter(i => i.id !== id)
  });
  const addItem = () => updateStage(p.id, 'bom', {
    items: [...items, {
      id: window.uid(),
      name: '',
      spec: '',
      cat: '其他',
      qty: 1,
      unitCost: 0
    }]
  });
  const total = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unitCost) || 0), 0);
  const cogs = Number(p.stages.profit.cogs) || total;
  const coverage = cogs > 0 ? Math.min(100, total / cogs * 100) : 0;
  const catMap = {};
  items.forEach(i => {
    catMap[i.cat] = (catMap[i.cat] || 0) + (Number(i.qty) || 0) * (Number(i.unitCost) || 0);
  });
  const catEntries = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
  const maxCat = catEntries[0]?.[1] || 1;
  const catColors = {
    '面料/布料': '#a855f7',
    '电机/马达': '#ec4899',
    '电源/电池': '#f59e0b',
    '开关/控制': '#3b82f6',
    'LED/灯珠': '#06b6d4',
    '模具/外壳': '#10b981',
    '包装材料': '#84cc16',
    '认证费': '#6366f1',
    '物流/运费': '#0ea5e9',
    '其他': '#64748b'
  };

  // Build pie segments for donut (per-category)
  const cx = 80,
    cy = 80,
    r = 60,
    sw = 22;
  const C = 2 * Math.PI * r;
  let acc = 0;
  const segments = catEntries.map(([cat, amt]) => {
    const frac = total > 0 ? amt / total : 0;
    // scale by coverage so unfilled portion remains visible
    const visFrac = frac * (coverage / 100);
    const len = C * visFrac;
    const seg = {
      cat,
      amt,
      frac,
      color: catColors[cat] || stage.color,
      dashOffset: -acc,
      dashLen: len
    };
    acc += len;
    return seg;
  });
  return /*#__PURE__*/React.createElement(StageCard, {
    stage: stage,
    productId: p.id,
    stageKey: "bom",
    stageData: bom,
    extraHeader: /*#__PURE__*/React.createElement("span", {
      className: "bom-cov-badge mono"
    }, coverage.toFixed(0), "% \u8986\u76D6 \xB7 \xA5", total.toFixed(2))
  }, /*#__PURE__*/React.createElement("div", {
    className: "bom-section"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("table", {
    className: "bom-table editable"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: '22%'
    }
  }, "\u7EC4\u4EF6\u540D\u79F0"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '20%'
    }
  }, "\u89C4\u683C / \u578B\u53F7"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '18%'
    }
  }, "\u5206\u7C7B"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right',
      width: '10%'
    }
  }, "\u7528\u91CF"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right',
      width: '12%'
    }
  }, "\u5355\u4EF7(\xA5)"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right',
      width: '12%'
    }
  }, "\u5C0F\u8BA1(\xA5)"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '4%'
    }
  }))), /*#__PURE__*/React.createElement("tbody", null, items.map(i => /*#__PURE__*/React.createElement("tr", {
    key: i.id
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    className: "cell",
    value: i.name,
    onChange: e => updateItem(i.id, {
      name: e.target.value
    }),
    placeholder: "\u7EC4\u4EF6\u540D\u79F0"
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    className: "cell",
    value: i.spec,
    onChange: e => updateItem(i.id, {
      spec: e.target.value
    }),
    placeholder: "\u89C4\u683C"
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("select", {
    className: "cell",
    value: i.cat,
    onChange: e => updateItem(i.id, {
      cat: e.target.value
    })
  }, BOM_CATS.map(c => /*#__PURE__*/React.createElement("option", {
    key: c,
    value: c
  }, c)))), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, /*#__PURE__*/React.createElement("input", {
    className: "cell mono",
    type: "number",
    step: "1",
    value: i.qty,
    onChange: e => updateItem(i.id, {
      qty: Number(e.target.value)
    })
  })), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, /*#__PURE__*/React.createElement("input", {
    className: "cell mono",
    type: "number",
    step: "0.01",
    value: i.unitCost,
    onChange: e => updateItem(i.id, {
      unitCost: Number(e.target.value)
    })
  })), /*#__PURE__*/React.createElement("td", {
    className: "num",
    style: {
      color: 'var(--ink)'
    }
  }, "\xA5", (i.qty * i.unitCost).toFixed(2)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("button", {
    className: "row-del",
    onClick: () => removeItem(i.id)
  }, "\u2715")))), /*#__PURE__*/React.createElement("tr", {
    className: "total"
  }, /*#__PURE__*/React.createElement("td", {
    colSpan: 5
  }, "BOM \u5408\u8BA1 \xB7 ", items.length, " \u9879"), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, "\xA5", total.toFixed(2)), /*#__PURE__*/React.createElement("td", null)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u7EC4\u4EF6",
    onClick: addItem
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "BOM \u5907\u6CE8",
    multi: true,
    wide: true,
    value: bom.notes,
    onChange: v => updateStage(p.id, 'bom', {
      notes: v
    })
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "bom-chart-wrap"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bom-chart-title"
  }, /*#__PURE__*/React.createElement("span", null, "BOM \u8986\u76D6\u7387"), /*#__PURE__*/React.createElement("span", {
    className: "cov"
  }, coverage.toFixed(0), "% \xB7 \xA5", total.toFixed(2), " / \xA5", cogs.toFixed(2))), /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 160 160",
    style: {
      width: '100%',
      maxWidth: 200,
      display: 'block',
      margin: '0 auto'
    }
  }, /*#__PURE__*/React.createElement("circle", {
    cx: cx,
    cy: cy,
    r: r,
    fill: "none",
    stroke: "var(--border)",
    strokeWidth: sw
  }), segments.map((s, i) => /*#__PURE__*/React.createElement("circle", {
    key: i,
    cx: cx,
    cy: cy,
    r: r,
    fill: "none",
    stroke: s.color,
    strokeWidth: sw,
    strokeDasharray: `${s.dashLen} ${C - s.dashLen}`,
    strokeDashoffset: s.dashOffset,
    transform: `rotate(-90 ${cx} ${cy})`,
    strokeLinecap: "butt"
  }, /*#__PURE__*/React.createElement("title", null, s.cat, ": $", s.amt.toFixed(2), " (", (s.frac * 100).toFixed(1), "%)"))), /*#__PURE__*/React.createElement("text", {
    x: cx,
    y: cy - 4,
    textAnchor: "middle",
    style: {
      fontSize: 22,
      fontWeight: 700,
      fill: 'var(--ink)',
      fontFamily: 'var(--font-mono)'
    }
  }, coverage.toFixed(0), "%"), /*#__PURE__*/React.createElement("text", {
    x: cx,
    y: cy + 14,
    textAnchor: "middle",
    style: {
      fontSize: 9,
      fill: 'var(--ink-4)',
      letterSpacing: 0.5
    }
  }, "\u5DF2\u62C6\u89E3")), /*#__PURE__*/React.createElement("div", {
    className: "bom-bars"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10.5,
      color: 'var(--ink-4)',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      fontWeight: 600,
      marginBottom: 4
    }
  }, "\u6309\u5206\u7C7B\u6C47\u603B"), catEntries.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--ink-4)',
      padding: '8px 0'
    }
  }, "\u6682\u65E0\u6570\u636E"), catEntries.map(([cat, amt]) => {
    const pct = total > 0 ? amt / total * 100 : 0;
    return /*#__PURE__*/React.createElement("div", {
      key: cat,
      className: "bom-bar-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "bom-bar-name"
    }, /*#__PURE__*/React.createElement("span", {
      className: "bom-bar-sw",
      style: {
        background: catColors[cat] || stage.color
      }
    }), cat), /*#__PURE__*/React.createElement("span", {
      className: "bom-bar-track"
    }, /*#__PURE__*/React.createElement("span", {
      className: "bom-bar-fill",
      style: {
        width: amt / maxCat * 100 + '%',
        background: catColors[cat] || stage.color
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "bom-bar-val"
    }, "\xA5", amt.toFixed(2)), /*#__PURE__*/React.createElement("span", {
      className: "bom-bar-pct"
    }, pct.toFixed(0), "%"));
  }))), items.length > 0 && /*#__PURE__*/React.createElement(SensitivityPanel, {
    items: items,
    profit: p.stages.profit,
    fxRate: p.fxRate
  }))));
}
window.ProductList = ProductList;
window.TabEval = TabEval;
window.BOM_CATS = BOM_CATS;

// ============ Sensitivity Panel (interactive what-if) ============
function SensitivityPanel({
  items,
  profit,
  fxRate
}) {
  // Top 5 by cost
  const topItems = React.useMemo(() => items.slice().sort((a, b) => b.qty * b.unitCost - a.qty * a.unitCost).slice(0, 5), [items]);
  const [adjust, setAdjust] = React.useState(() => {
    const init = {};
    topItems.forEach(i => init[i.id] = 0); // -50 ~ +50
    return init;
  });
  React.useEffect(() => {
    setAdjust(prev => {
      const next = {
        ...prev
      };
      topItems.forEach(i => {
        if (next[i.id] == null) next[i.id] = 0;
      });
      return next;
    });
  }, [topItems]);
  const fx = Number(fxRate) || window.DEFAULT_FX || 7.20;
  const baseTotal = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unitCost) || 0), 0); // CNY
  const topMap = new Map(topItems.map(i => [i.id, i]));
  const adjustedTotal = items.reduce((s, i) => {
    const base = (Number(i.qty) || 0) * (Number(i.unitCost) || 0);
    if (topMap.has(i.id)) {
      const pct = adjust[i.id] || 0;
      return s + base * (1 + pct / 100);
    }
    return s + base;
  }, 0);
  const delta = adjustedTotal - baseTotal;

  // Profit recalc: use original profit, replace cogs (CNY) with adjustedTotal
  const targetPrice = Number(profit.targetPrice) || 0;
  const baseCogsCny = Number(profit.cogs) || baseTotal;
  const adjCogsCny = adjustedTotal;
  const baseCogsUsd = baseCogsCny / fx; // 不含税，参与计算
  const adjCogsUsd = adjCogsCny / fx; // 不含税，参与计算
  const shippingUsd = (Number(profit.shipping) || 0) / fx;
  const otherUsd = (Number(profit.otherCost) || 0) / fx;
  const fbaFee = Number(profit.fbaFee) || 0;
  const referralFee = targetPrice * ((Number(profit.referralPct) || 0) / 100);
  const adFee = targetPrice * ((Number(profit.adPct) || 0) / 100);
  const returnRate = (Number(profit.returnRate) || 0) / 100;
  const baseGross = targetPrice - fbaFee - shippingUsd - baseCogsUsd;
  const adjGross = targetPrice - fbaFee - shippingUsd - adjCogsUsd;
  const baseReturnCost = returnRate * targetPrice; // 退货成本 = 售价 × 退货率
  const adjReturnCost = returnRate * targetPrice; // 退货成本与成本无关，两种场景相同
  const baseNet = baseGross - referralFee - adFee - baseReturnCost - otherUsd;
  const adjNet = adjGross - referralFee - adFee - adjReturnCost - otherUsd;
  const netDelta = adjNet - baseNet;
  const baseMargin = targetPrice ? baseNet / targetPrice * 100 : 0;
  const adjMargin = targetPrice ? adjNet / targetPrice * 100 : 0;
  const resetAll = () => {
    const z = {};
    topItems.forEach(i => z[i.id] = 0);
    setAdjust(z);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "sensitivity"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sensitivity-hdr"
  }, /*#__PURE__*/React.createElement("span", null, "\u6210\u672C\u654F\u611F\u6027\u5206\u6790 \xB7 Top ", topItems.length), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--ink-4)',
      fontSize: 11,
      fontFamily: 'var(--font-mono)'
    }
  }, "\u62D6\u52A8 \xB150%"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: resetAll
  }, "\u91CD\u7F6E"))), /*#__PURE__*/React.createElement("div", {
    className: "sens-table-hdr"
  }, /*#__PURE__*/React.createElement("span", null, "\u7EC4\u4EF6"), /*#__PURE__*/React.createElement("span", null, "\u8C03\u6574"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: 'right'
    }
  }, "\u539F\u59CB(\xA5)"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: 'right'
    }
  }, "\u8C03\u6574\u540E(\xA5)")), topItems.map(i => {
    const pct = adjust[i.id] || 0;
    const base = i.qty * i.unitCost;
    const adj = base * (1 + pct / 100);
    return /*#__PURE__*/React.createElement("div", {
      key: i.id,
      className: "sens-row-v2"
    }, /*#__PURE__*/React.createElement("span", {
      className: "name",
      title: i.name
    }, i.name), /*#__PURE__*/React.createElement("div", {
      className: "sens-control"
    }, /*#__PURE__*/React.createElement("input", {
      type: "range",
      min: -50,
      max: 50,
      step: 1,
      value: pct,
      onChange: e => setAdjust(prev => ({
        ...prev,
        [i.id]: Number(e.target.value)
      }))
    }), /*#__PURE__*/React.createElement("span", {
      className: "pct mono" + (pct > 0 ? ' up' : pct < 0 ? ' down' : '')
    }, pct > 0 ? '+' : '', pct, "%")), /*#__PURE__*/React.createElement("span", {
      className: "base-val mono"
    }, "\xA5", base.toFixed(2)), /*#__PURE__*/React.createElement("span", {
      className: "adj-val mono" + (pct > 0 ? ' up' : pct < 0 ? ' down' : '')
    }, "\xA5", adj.toFixed(2)));
  }), /*#__PURE__*/React.createElement("div", {
    className: "sens-summary"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sens-summary-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "BOM \u5408\u8BA1"), /*#__PURE__*/React.createElement("span", {
    className: "base mono"
  }, "\xA5", baseTotal.toFixed(2)), /*#__PURE__*/React.createElement("span", {
    className: "arrow"
  }, "\u2192"), /*#__PURE__*/React.createElement("span", {
    className: "adj mono " + (delta >= 0 ? 'down' : 'up')
  }, "\xA5", adjustedTotal.toFixed(2)), /*#__PURE__*/React.createElement("span", {
    className: "delta mono " + (delta >= 0 ? 'down' : 'up')
  }, delta >= 0 ? '+' : '', "\xA5", delta.toFixed(2))), targetPrice > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "sens-summary-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "\u51C0\u5229\u6DA6 / \u4EF6"), /*#__PURE__*/React.createElement("span", {
    className: "base mono"
  }, "$", baseNet.toFixed(2)), /*#__PURE__*/React.createElement("span", {
    className: "arrow"
  }, "\u2192"), /*#__PURE__*/React.createElement("span", {
    className: "adj mono " + (netDelta >= 0 ? 'up' : 'down')
  }, "$", adjNet.toFixed(2)), /*#__PURE__*/React.createElement("span", {
    className: "delta mono " + (netDelta >= 0 ? 'up' : 'down')
  }, netDelta >= 0 ? '+' : '', "$", netDelta.toFixed(2))), /*#__PURE__*/React.createElement("div", {
    className: "sens-summary-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "\u51C0\u5229\u7387"), /*#__PURE__*/React.createElement("span", {
    className: "base mono"
  }, baseMargin.toFixed(1), "%"), /*#__PURE__*/React.createElement("span", {
    className: "arrow"
  }, "\u2192"), /*#__PURE__*/React.createElement("span", {
    className: "adj mono " + (adjMargin >= baseMargin ? 'up' : 'down')
  }, adjMargin.toFixed(1), "%"), /*#__PURE__*/React.createElement("span", {
    className: "delta mono " + (adjMargin >= baseMargin ? 'up' : 'down')
  }, adjMargin - baseMargin >= 0 ? '+' : '', (adjMargin - baseMargin).toFixed(1), "pp")))));
}

// ===== New product modal =====
function NewProductModal({
  open,
  onClose,
  onCreate
}) {
  const [form, setForm] = React.useState({
    name: '',
    sku: '',
    category: '',
    lead: '',
    source: '关键词工具 / Helium 10',
    market: '美国 US',
    reason: ''
  });
  React.useEffect(() => {
    if (open) setForm({
      name: '',
      sku: '',
      category: '',
      lead: '',
      source: '关键词工具 / Helium 10',
      market: '美国 US',
      reason: ''
    });
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const handler = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
  if (!open) return null;
  const valid = form.name.trim() && form.sku.trim();
  const submit = () => {
    if (!valid) return;
    onCreate({
      ...form,
      name: form.name.trim(),
      sku: form.sku.trim(),
      category: form.category.trim() || '未分类'
    });
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-hdr"
  }, /*#__PURE__*/React.createElement("span", {
    className: "modal-title"
  }, "+ \u65B0\u5EFA\u4EA7\u54C1"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onClose
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "modal-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-2"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u4EA7\u54C1\u540D\u79F0 *",
    value: form.name,
    onChange: v => setForm({
      ...form,
      name: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "SKU *",
    mono: true,
    value: form.sku,
    onChange: v => setForm({
      ...form,
      sku: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u54C1\u7C7B (\u53EF\u81EA\u5B9A\u4E49)",
    value: form.category,
    options: ['小家电', '宠物用品', '美妆', '户外', '厨具', '汽车', '3C 配件', '家居', '母婴', '其他...'],
    onChange: v => setForm({
      ...form,
      category: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u8D1F\u8D23\u4EBA",
    value: form.lead,
    onChange: v => setForm({
      ...form,
      lead: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9009\u54C1\u6765\u6E90",
    value: form.source,
    options: ['关键词工具 / Helium 10', '卖家精灵', 'TikTok 爆款', '品类雷达', '线下展会', '其他'],
    onChange: v => setForm({
      ...form,
      source: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u76EE\u6807\u5E02\u573A",
    value: form.market,
    options: ['美国 US', '英国 UK', '德国 DE', '日本 JP', '加拿大 CA', '澳大利亚 AU'],
    onChange: v => setForm({
      ...form,
      market: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u7ACB\u9879\u7406\u7531",
    wide: true,
    multi: true,
    value: form.reason,
    onChange: v => setForm({
      ...form,
      reason: v
    })
  }))), /*#__PURE__*/React.createElement("div", {
    className: "modal-ftr"
  }, /*#__PURE__*/React.createElement("span", {
    className: "modal-hint"
  }, valid ? '回车提交' : '产品名称与 SKU 必填'), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: onClose
  }, "\u53D6\u6D88"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-primary",
    disabled: !valid,
    onClick: submit
  }, "\u521B\u5EFA\u4EA7\u54C1")))));
}
window.NewProductModal = NewProductModal;