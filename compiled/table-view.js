/* eslint-disable no-undef */
// Data Table view - 22 columns

function firstExpectedShip(p) {
  const batches = p.stages.production.batches || [];
  for (const b of batches) if (b.expectedShip) return b.expectedShip;
  return null;
}

// 使用 data.jsx 中的公共 calcProfit，保持与 list-view 计算逻辑一致

function marginClass(m) {
  if (m == null) return '';
  if (m >= 20) return 'margin-good';
  if (m >= 10) return 'margin-warn';
  if (m < 0) return 'margin-bad';
  return '';
}
function TableView({
  onSelectProduct,
  filter
}) {
  // 直接订阅 context，确保编辑后立即同步，不依赖父组件 prop 传递
  const {
    products: allProducts
  } = useProducts();
  const products = filter && filter !== 'all' ? allProducts.filter(p => p.status === filter) : allProducts;
  const [sortKey, setSortKey] = React.useState('createdAt');
  const [sortDir, setSortDir] = React.useState('desc');
  const [expandedRows, setExpandedRows] = React.useState(new Set());
  const toggleExpand = id => setExpandedRows(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const rows = [...products].sort((a, b) => {
    const av = getColVal(a, sortKey);
    const bv = getColVal(b, sortKey);
    const cmp = av == null ? 1 : bv == null ? -1 : av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });
  function clickSort(k) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');else {
      setSortKey(k);
      setSortDir('asc');
    }
  }
  function SortTh({
    k,
    label,
    num,
    sticky
  }) {
    const isS = sortKey === k;
    return /*#__PURE__*/React.createElement("th", {
      onClick: () => clickSort(k),
      className: [isS ? 'sorted' : '', sticky ? 'sticky' : ''].join(' '),
      style: num ? {
        textAlign: 'right'
      } : {}
    }, label, /*#__PURE__*/React.createElement("span", {
      className: "sort"
    }, isS ? sortDir === 'asc' ? '▲' : '▼' : '↕'));
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '22px 28px 60px',
      overflowY: 'auto',
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dtable-wrap"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dtable-toolbar"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600
    }
  }, "21 \u5217\u5BF9\u6BD4"), /*#__PURE__*/React.createElement("span", {
    className: "count"
  }, "\xB7 ", rows.length, " \u4E2A\u4EA7\u54C1 \xB7 \u6309", getColLabel(sortKey), sortDir === 'asc' ? ' 升序' : ' 降序'), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm"
  }, "\u5217\u8BBE\u7F6E"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm"
  }, "\u5BFC\u51FA CSV"))), /*#__PURE__*/React.createElement("div", {
    className: "dtable-scroll"
  }, /*#__PURE__*/React.createElement("table", {
    className: "dtable"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    colSpan: 7,
    className: "group group-sticky"
  }, "\u4EA7\u54C1\u4FE1\u606F"), /*#__PURE__*/React.createElement("th", {
    colSpan: 2,
    className: "group"
  }, "\u7ACB\u9879\u8BC4\u4F30"), /*#__PURE__*/React.createElement("th", {
    colSpan: 1,
    className: "group"
  }, "\u7ADE\u54C1"), /*#__PURE__*/React.createElement("th", {
    colSpan: 6,
    className: "group"
  }, "\u5229\u6DA6\u6D4B\u7B97"), /*#__PURE__*/React.createElement("th", {
    colSpan: 2,
    className: "group"
  }, "\u4F9B\u5E94\u5546/\u6253\u6837"), /*#__PURE__*/React.createElement("th", {
    colSpan: 1,
    className: "group"
  }, "\u51FA\u8D27"), /*#__PURE__*/React.createElement("th", {
    colSpan: 2,
    className: "group"
  }, "\u4E0A\u67B6/\u8FD4\u5355")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement(SortTh, {
    k: "name",
    label: "\u4EA7\u54C1\u540D\u79F0 \uD83D\uDD12",
    sticky: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "sku",
    label: "SKU"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "status",
    label: "\u72B6\u6001"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "progress",
    label: "\u8FDB\u5EA6",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "createdAt",
    label: "\u7ACB\u9879\u65E5\u671F"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "lead",
    label: "\u8D1F\u8D23\u4EBA"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "category",
    label: "\u54C1\u7C7B"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "source",
    label: "\u9009\u54C1\u6765\u6E90"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "market",
    label: "\u76EE\u6807\u5E02\u573A"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "compPrice",
    label: "\u7ADE\u54C1\u5747\u4EF7($)",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "targetPrice",
    label: "\u76EE\u6807\u552E\u4EF7($)",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "cogs",
    label: "\u4EA7\u54C1\u6210\u672C(\xA5)",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "bomTotal",
    label: "BOM\u5408\u8BA1(\xA5)",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "netProfit",
    label: "\u6BDB\u5229\u6DA6($)",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "margin",
    label: "\u51C0\u5229\u7387",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "decision",
    label: "\u51B3\u7B56"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "supCount",
    label: "\u4F9B\u5E94\u5546\u6570",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "sampleRounds",
    label: "\u6253\u6837\u8F6E\u6B21",
    num: true
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "expectedShip",
    label: "\u9884\u8BA1\u51FA\u8D27"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "launchDate",
    label: "\u4E0A\u67B6\u65E5\u671F"
  }), /*#__PURE__*/React.createElement(SortTh, {
    k: "reorderCount",
    label: "\u8FD4\u5355\u6B21\u6570",
    num: true
  }))), /*#__PURE__*/React.createElement("tbody", null, rows.map(p => {
    const m = calcProfit(p);
    const pr = p.stages.profit;
    const hasV = (p.variants || []).length > 0;
    const isExp = expandedRows.has(p.id);
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: p.id
    }, /*#__PURE__*/React.createElement("tr", {
      onClick: () => onSelectProduct(p.id),
      style: {
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("td", {
      className: "sticky pname"
    }, hasV && /*#__PURE__*/React.createElement("button", {
      className: "variant-expand-btn",
      title: isExp ? '收起变体' : '展开变体',
      onClick: e => {
        e.stopPropagation();
        toggleExpand(p.id);
      }
    }, isExp ? '▾' : '▸'), /*#__PURE__*/React.createElement("span", {
      className: "lock"
    }, "\uD83D\uDD12"), p.name, hasV && /*#__PURE__*/React.createElement("span", {
      className: "table-variant-badge"
    }, p.variants.length, " SKU")), /*#__PURE__*/React.createElement("td", {
      className: "num",
      style: {
        textAlign: 'left',
        color: 'var(--ink-3)'
      }
    }, p.sku), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
      className: `badge badge-${p.status}`
    }, STATUS_LABELS[p.status].label)), /*#__PURE__*/React.createElement("td", {
      className: "num gcol"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tbar"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tbar-f",
      style: {
        width: p.progress + '%'
      }
    })), p.progress, "%"), /*#__PURE__*/React.createElement("td", {
      className: "num",
      style: {
        textAlign: 'left'
      }
    }, p.createdAt), /*#__PURE__*/React.createElement("td", null, p.lead), /*#__PURE__*/React.createElement("td", {
      style: {
        color: 'var(--ink-3)',
        borderRight: '1px solid var(--border)'
      }
    }, p.category), /*#__PURE__*/React.createElement("td", {
      style: {
        color: 'var(--ink-3)'
      }
    }, p.stages.initiation.source || '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        color: 'var(--ink-3)',
        borderRight: '1px solid var(--border)'
      }
    }, p.stages.initiation.market || '—'), /*#__PURE__*/React.createElement("td", {
      className: "num"
    }, p.stages.research.avgPrice ? `$${p.stages.research.avgPrice.toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
      className: "num"
    }, pr.targetPrice ? `$${Number(pr.targetPrice).toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
      className: "num"
    }, pr.cogs ? `¥${Number(pr.cogs).toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
      className: "num"
    }, p.stages.bom.items?.length ? `¥${(p.stages.bom.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unitCost) || 0), 0).toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
      className: "num"
    }, m ? `$${m.net.toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
      className: "num " + (m ? marginClass(m.margin) : '')
    }, m ? `${m.margin.toFixed(1)}%` : '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        borderRight: '1px solid var(--border)'
      }
    }, pr.decision === 'pass' && /*#__PURE__*/React.createElement("span", {
      className: "decision-pill pass"
    }, "\u2713 \u901A\u8FC7"), pr.decision === 'hold' && /*#__PURE__*/React.createElement("span", {
      className: "decision-pill hold"
    }, "\u23F8 \u6682\u7F13"), pr.decision === 'reject' && /*#__PURE__*/React.createElement("span", {
      className: "decision-pill reject"
    }, "\u2717 \u5426\u51B3"), !pr.decision && '—'), /*#__PURE__*/React.createElement("td", {
      className: "num"
    }, (p.stages.supplier.suppliers || []).length || '—'), /*#__PURE__*/React.createElement("td", {
      className: "num",
      style: {
        borderRight: '1px solid var(--border)'
      }
    }, (p.stages.sampling.rounds || []).length || '—'), /*#__PURE__*/React.createElement("td", {
      className: "num",
      style: {
        textAlign: 'left',
        borderRight: '1px solid var(--border)'
      }
    }, firstExpectedShip(p) || p.stages.shipment.endDate || '—'), /*#__PURE__*/React.createElement("td", {
      className: "num",
      style: {
        textAlign: 'left'
      }
    }, p.stages.listing.launchDate || p.stages.listing.endDate || '—'), /*#__PURE__*/React.createElement("td", {
      className: "num"
    }, (p.stages.reorder.records || []).length || '—')), hasV && isExp && (p.variants || []).map((v, vi) => {
      const vm = calcVariantProfit(v, p.fxRate);
      const vpr = v.stages?.profit || {};
      const vBomTotal = (v.stages?.bom?.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unitCost) || 0), 0);
      const vProgress = _variantProgress(v);
      return /*#__PURE__*/React.createElement("tr", {
        key: v.id,
        className: "variant-row",
        onClick: () => onSelectProduct(p.id),
        style: {
          cursor: 'pointer'
        }
      }, /*#__PURE__*/React.createElement("td", {
        className: "sticky pname variant-row-name"
      }, /*#__PURE__*/React.createElement("span", {
        className: "variant-row-prefix"
      }, "\u2514"), /*#__PURE__*/React.createElement("span", null, v.name || v.colorOrSize || v.sku || 'SKU ' + (vi + 1)), v.sku && /*#__PURE__*/React.createElement("span", {
        className: "variant-row-sku mono"
      }, v.sku)), /*#__PURE__*/React.createElement("td", {
        className: "num",
        style: {
          textAlign: 'left',
          color: 'var(--ink-4)',
          fontSize: 11
        }
      }, v.sku || '—'), /*#__PURE__*/React.createElement("td", null, "\u2014"), /*#__PURE__*/React.createElement("td", {
        className: "num gcol"
      }, /*#__PURE__*/React.createElement("span", {
        className: "tbar"
      }, /*#__PURE__*/React.createElement("span", {
        className: "tbar-f",
        style: {
          width: vProgress + '%',
          background: 'var(--blue)'
        }
      })), vProgress, "%"), /*#__PURE__*/React.createElement("td", null, "\u2014"), /*#__PURE__*/React.createElement("td", null, "\u2014"), /*#__PURE__*/React.createElement("td", {
        style: {
          borderRight: '1px solid var(--border)'
        }
      }, "\u2014"), /*#__PURE__*/React.createElement("td", null, "\u2014"), /*#__PURE__*/React.createElement("td", {
        style: {
          borderRight: '1px solid var(--border)'
        }
      }, "\u2014"), /*#__PURE__*/React.createElement("td", null, "\u2014"), /*#__PURE__*/React.createElement("td", {
        className: "num"
      }, vpr.targetPrice ? `$${Number(vpr.targetPrice).toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
        className: "num"
      }, vpr.cogs ? `¥${Number(vpr.cogs).toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
        className: "num"
      }, vBomTotal ? `¥${vBomTotal.toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
        className: "num"
      }, vm ? `$${vm.net.toFixed(2)}` : '—'), /*#__PURE__*/React.createElement("td", {
        className: "num " + (vm ? marginClass(vm.margin) : '')
      }, vm ? `${vm.margin.toFixed(1)}%` : '—'), /*#__PURE__*/React.createElement("td", {
        style: {
          borderRight: '1px solid var(--border)'
        }
      }, vpr.decision === 'pass' && /*#__PURE__*/React.createElement("span", {
        className: "decision-pill pass"
      }, "\u2713 \u901A\u8FC7"), vpr.decision === 'hold' && /*#__PURE__*/React.createElement("span", {
        className: "decision-pill hold"
      }, "\u23F8 \u6682\u7F13"), vpr.decision === 'reject' && /*#__PURE__*/React.createElement("span", {
        className: "decision-pill reject"
      }, "\u2717 \u5426\u51B3"), !vpr.decision && '—'), /*#__PURE__*/React.createElement("td", null, "\u2014"), /*#__PURE__*/React.createElement("td", {
        className: "num",
        style: {
          borderRight: '1px solid var(--border)'
        }
      }, (v.stages?.sampling?.rounds || []).length || '—'), /*#__PURE__*/React.createElement("td", null, "\u2014"), /*#__PURE__*/React.createElement("td", {
        className: "num",
        style: {
          textAlign: 'left'
        }
      }, v.stages?.listing?.launchDate || '—'), /*#__PURE__*/React.createElement("td", null, "\u2014"));
    }));
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      display: 'flex',
      gap: 18,
      fontSize: 11,
      color: 'var(--ink-4)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\u51C0\u5229\u7387\u989C\u8272\uFF1A", /*#__PURE__*/React.createElement("span", {
    className: "margin-good"
  }, "\u226520% \u5065\u5EB7"), " \xB7 ", /*#__PURE__*/React.createElement("span", {
    className: "margin-warn"
  }, "10-20% \u53EF\u63A5\u53D7"), " \xB7 ", /*#__PURE__*/React.createElement("span", {
    className: "margin-bad"
  }, "<0% \u4E8F\u635F")), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto'
    }
  }, "\u70B9\u51FB\u5217\u5934\u6392\u5E8F \xB7 \u70B9\u51FB\u884C\u6253\u5F00\u4EA7\u54C1\u8BE6\u60C5")));
}
function getColVal(p, k) {
  const pr = p.stages.profit;
  const m = calcProfit(p);
  switch (k) {
    case 'name':
      return p.name;
    case 'sku':
      return p.sku;
    case 'status':
      return p.status;
    case 'progress':
      return p.progress;
    case 'createdAt':
      return p.createdAt;
    case 'lead':
      return p.lead;
    case 'category':
      return p.category;
    case 'source':
      return p.stages.initiation.source;
    case 'market':
      return p.stages.initiation.market;
    case 'compPrice':
      return p.stages.research.avgPrice;
    case 'targetPrice':
      return pr.targetPrice;
    case 'cogs':
      return pr.cogs;
    case 'bomTotal':
      return (p.stages.bom.items || []).reduce((s, i) => s + i.qty * i.unitCost, 0) || null;
    case 'netProfit':
      return m?.net;
    case 'margin':
      return m?.margin;
    case 'decision':
      return pr.decision;
    case 'supCount':
      return (p.stages.supplier.suppliers || []).length;
    case 'sampleRounds':
      return (p.stages.sampling.rounds || []).length;
    case 'expectedShip':
      return firstExpectedShip(p) || p.stages.shipment.endDate;
    case 'launchDate':
      return p.stages.listing.launchDate || p.stages.listing.endDate;
    case 'reorderCount':
      return (p.stages.reorder.records || []).length;
    default:
      return null;
  }
}
function getColLabel(k) {
  const labels = {
    createdAt: '立项日期',
    name: '产品名称',
    progress: '进度',
    margin: '净利率',
    targetPrice: '目标售价'
  };
  return labels[k] || k;
}
window.TableView = TableView;