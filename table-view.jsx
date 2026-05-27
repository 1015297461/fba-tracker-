/* eslint-disable no-undef */
// Data Table view — column-configurable + Excel export

function lastExpectedShip(p) {
  const batches = p.stages.production.batches || [];
  for (let i = batches.length - 1; i >= 0; i--) {
    if (batches[i].expectedShip) return batches[i].expectedShip;
  }
  return null;
}

function calcOrderTotal(p) {
  const hasV = (p.variants || []).length > 0;
  return (p.stages.production?.batches || []).reduce((sum, b) => {
    const skuSub = hasV && (b.items||[]).length > 0
      ? (b.items||[]).reduce((s,i) => s+(Number(i.qty)||0)*(Number(i.unitPrice)||0), 0)
      : (Number(b.qty)||0)*(Number(b.unitPrice)||0);
    const extraSub = (b.extraCosts||[]).reduce((s,c) => s+(Number(c.qty)||0)*(Number(c.unitPrice)||0), 0);
    return sum + skuSub + extraSub;
  }, 0);
}

function marginClass(m) {
  if (m == null) return '';
  if (m >= 20) return 'margin-good';
  if (m >= 10) return 'margin-warn';
  if (m < 0) return 'margin-bad';
  return '';
}

const COL_DEFS = [
  { k:'name',         label:'产品名称 🔒', group:'产品信息',   sticky:true, alwaysVisible:true },
  { k:'sku',          label:'SKU',          group:'产品信息' },
  { k:'status',       label:'状态',         group:'产品信息' },
  { k:'progress',     label:'进度',         group:'产品信息',   num:true },
  { k:'createdAt',    label:'立项日期',     group:'产品信息' },
  { k:'lead',         label:'负责人',       group:'产品信息' },
  { k:'category',     label:'品类',         group:'产品信息' },
  { k:'source',       label:'选品来源',     group:'立项评估' },
  { k:'market',       label:'目标市场',     group:'立项评估' },
  { k:'compPrice',    label:'竞品均价($)',  group:'竞品',        num:true },
  { k:'targetPrice',  label:'目标售价($)',  group:'利润测算',    num:true },
  { k:'cogs',         label:'产品成本(¥)', group:'利润测算',    num:true },
  { k:'bomTotal',     label:'BOM合计(¥)',  group:'利润测算',    num:true },
  { k:'netProfit',    label:'毛利润($)',    group:'利润测算',    num:true },
  { k:'margin',       label:'净利率',       group:'利润测算',    num:true },
  { k:'decision',     label:'决策',         group:'利润测算' },
  { k:'supCount',     label:'供应商数',     group:'供应商/打样', num:true },
  { k:'sampleRounds', label:'打样轮次',    group:'供应商/打样', num:true },
  { k:'expectedShip', label:'预计出货',    group:'生产出货' },
  { k:'orderTotal',   label:'订单总额(¥)', group:'生产出货',    num:true },
  { k:'launchDate',   label:'上架日期',    group:'上架' },
];
const GROUP_ORDER = ['产品信息','立项评估','竞品','利润测算','供应商/打样','生产出货','上架'];

const COL_VIS_KEY = 'fba-table-col-vis-v1';
function loadColVis() {
  try {
    const raw = localStorage.getItem(COL_VIS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const def = {};
      COL_DEFS.forEach(c => { def[c.k] = saved[c.k] !== undefined ? saved[c.k] : true; });
      return def;
    }
  } catch(e) {}
  const def = {};
  COL_DEFS.forEach(c => { def[c.k] = true; });
  return def;
}

function TableView({ onSelectProduct, filter }) {
  const { products: allProducts } = useProducts();
  const products = filter && filter !== 'all'
    ? allProducts.filter(p => p.status === filter)
    : allProducts;

  const [sortKey, setSortKey] = React.useState('createdAt');
  const [sortDir, setSortDir] = React.useState('desc');
  const [expandedRows, setExpandedRows] = React.useState(new Set());
  const [colVis, setColVis] = React.useState(loadColVis);
  const [showColPanel, setShowColPanel] = React.useState(false);

  const toggleExpand = (id) => setExpandedRows(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleCol = (k) => {
    setColVis(prev => {
      const next = {...prev, [k]: !prev[k]};
      try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(next)); } catch(e) {}
      return next;
    });
  };

  const rows = [...products].sort((a, b) => {
    const av = getColVal(a, sortKey);
    const bv = getColVal(b, sortKey);
    const cmp = (av == null) ? 1 : (bv == null) ? -1 : (av < bv ? -1 : av > bv ? 1 : 0);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function clickSort(k) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('asc'); }
  }

  const visibleCols = COL_DEFS.filter(c => colVis[c.k] !== false);

  function SortTh({ k, label, num, sticky }) {
    const isS = sortKey === k;
    return (
      <th onClick={() => clickSort(k)}
        className={[isS ? 'sorted' : '', sticky ? 'sticky' : ''].join(' ')}
        style={num ? {textAlign:'right'} : {}}>
        {label}
        <span className="sort">{isS ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </th>
    );
  }

  function exportExcel() {
    if (typeof XLSX === 'undefined') {
      alert('Excel 导出库未加载，请检查网络连接后刷新页面。');
      return;
    }
    const headers = visibleCols.map(c => c.label.replace(' 🔒', ''));
    const data = rows.map(p => {
      const m = calcProfit(p);
      const pr = p.stages.profit;
      return visibleCols.map(c => {
        switch(c.k) {
          case 'status': return STATUS_LABELS[p.status]?.label || p.status;
          case 'progress': return p.progress;
          case 'source': return p.stages.initiation.source || '';
          case 'market': return p.stages.initiation.market || '';
          case 'compPrice': return p.stages.research.avgPrice || '';
          case 'targetPrice': return pr.targetPrice ? Number(pr.targetPrice) : '';
          case 'cogs': return pr.cogs ? Number(pr.cogs) : '';
          case 'bomTotal': return +(p.stages.bom.items||[]).reduce((s,i)=>s+(Number(i.qty)||0)*(Number(i.unitCost)||0),0).toFixed(2) || '';
          case 'netProfit': return m ? +m.net.toFixed(2) : '';
          case 'margin': return m ? +m.margin.toFixed(1) : '';
          case 'decision': { const d = pr.decision; return d==='pass'?'通过':d==='hold'?'暂缓':d==='reject'?'否决':''; }
          case 'supCount': return (p.stages.supplier.suppliers||[]).length;
          case 'sampleRounds': return (p.stages.sampling.rounds||[]).length;
          case 'expectedShip': return lastExpectedShip(p) || p.stages.shipment?.endDate || '';
          case 'orderTotal': return +calcOrderTotal(p).toFixed(2) || '';
          case 'launchDate': return p.stages.listing.launchDate || p.stages.listing.endDate || '';
          default: return getColVal(p, c.k) ?? '';
        }
      });
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws['!cols'] = visibleCols.map(c => ({ wch: c.k === 'name' ? 28 : c.num ? 12 : 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '产品列表');
    XLSX.writeFile(wb, 'FBA产品列表_' + new Date().toISOString().slice(0,10) + '.xlsx');
  }

  function renderCell(p, k, m, pr, hasV, isExp) {
    switch(k) {
      case 'name': return (
        <td key="name" className="sticky pname">
          {hasV && (
            <button className="variant-expand-btn" title={isExp ? '收起变体' : '展开变体'}
              onClick={e => { e.stopPropagation(); toggleExpand(p.id); }}>
              {isExp ? '▾' : '▸'}
            </button>
          )}
          <span className="lock">🔒</span>
          {p.name}
          {hasV && <span className="table-variant-badge">{p.variants.length} SKU</span>}
        </td>
      );
      case 'sku': return <td key="sku" className="num" style={{textAlign:'left',color:'var(--ink-3)'}}>{p.sku}</td>;
      case 'status': return <td key="status"><span className={`badge badge-${p.status}`}>{STATUS_LABELS[p.status].label}</span></td>;
      case 'progress': return (
        <td key="progress" className="num gcol">
          <span className="tbar"><span className="tbar-f" style={{width:p.progress+'%'}}></span></span>
          {p.progress}%
        </td>
      );
      case 'createdAt': return <td key="createdAt" className="num" style={{textAlign:'left'}}>{p.createdAt}</td>;
      case 'lead': return <td key="lead">{p.lead}</td>;
      case 'category': return <td key="category" style={{color:'var(--ink-3)',borderRight:'1px solid var(--border)'}}>{p.category}</td>;
      case 'source': return <td key="source" style={{color:'var(--ink-3)'}}>{p.stages.initiation.source||'—'}</td>;
      case 'market': return <td key="market" style={{color:'var(--ink-3)',borderRight:'1px solid var(--border)'}}>{p.stages.initiation.market||'—'}</td>;
      case 'compPrice': return <td key="compPrice" className="num">{p.stages.research.avgPrice?`$${p.stages.research.avgPrice.toFixed(2)}`:'—'}</td>;
      case 'targetPrice': return <td key="targetPrice" className="num">{pr.targetPrice?`$${Number(pr.targetPrice).toFixed(2)}`:'—'}</td>;
      case 'cogs': return <td key="cogs" className="num">{pr.cogs?`¥${Number(pr.cogs).toFixed(2)}`:'—'}</td>;
      case 'bomTotal': {
        const t = (p.stages.bom.items||[]).reduce((s,i)=>s+(Number(i.qty)||0)*(Number(i.unitCost)||0),0);
        return <td key="bomTotal" className="num">{p.stages.bom.items?.length?`¥${t.toFixed(2)}`:'—'}</td>;
      }
      case 'netProfit': return <td key="netProfit" className="num">{m?`$${m.net.toFixed(2)}`:'—'}</td>;
      case 'margin': return <td key="margin" className={"num "+(m?marginClass(m.margin):'')}>{m?`${m.margin.toFixed(1)}%`:'—'}</td>;
      case 'decision': return (
        <td key="decision" style={{borderRight:'1px solid var(--border)'}}>
          {pr.decision==='pass'&&<span className="decision-pill pass">✓ 通过</span>}
          {pr.decision==='hold'&&<span className="decision-pill hold">⏸ 暂缓</span>}
          {pr.decision==='reject'&&<span className="decision-pill reject">✗ 否决</span>}
          {!pr.decision&&'—'}
        </td>
      );
      case 'supCount': return <td key="supCount" className="num">{(p.stages.supplier.suppliers||[]).length||'—'}</td>;
      case 'sampleRounds': return <td key="sampleRounds" className="num" style={{borderRight:'1px solid var(--border)'}}>{(p.stages.sampling.rounds||[]).length||'—'}</td>;
      case 'expectedShip': return <td key="expectedShip" className="num" style={{textAlign:'left'}}>{lastExpectedShip(p)||p.stages.shipment?.endDate||'—'}</td>;
      case 'orderTotal': {
        const ot = calcOrderTotal(p);
        return <td key="orderTotal" className="num" style={{borderRight:'1px solid var(--border)'}}>{ot?`¥${ot.toFixed(0)}`:'—'}</td>;
      }
      case 'launchDate': return <td key="launchDate" className="num" style={{textAlign:'left'}}>{p.stages.listing.launchDate||p.stages.listing.endDate||'—'}</td>;
      default: return <td key={k}>—</td>;
    }
  }

  function renderVariantCell(v, k, vi, p, vm, vpr, vBomTotal) {
    switch(k) {
      case 'name': return (
        <td key="name" className="sticky pname variant-row-name">
          <span className="variant-row-prefix">└</span>
          <span>{v.name||v.colorOrSize||v.sku||'SKU '+(vi+1)}</span>
          {v.sku&&<span className="variant-row-sku mono">{v.sku}</span>}
        </td>
      );
      case 'sku': return <td key="sku" className="num" style={{textAlign:'left',color:'var(--ink-4)',fontSize:11}}>{v.sku||'—'}</td>;
      case 'status': return <td key="status">—</td>;
      case 'progress': return <td key="progress" className="num gcol">{v.colorOrSize&&<span style={{fontSize:11,color:'var(--ink-4)'}}>{v.colorOrSize}</span>}</td>;
      case 'createdAt': return <td key="createdAt">—</td>;
      case 'lead': return <td key="lead">—</td>;
      case 'category': return <td key="category" style={{borderRight:'1px solid var(--border)'}}>—</td>;
      case 'source': return <td key="source">—</td>;
      case 'market': return <td key="market" style={{borderRight:'1px solid var(--border)'}}>—</td>;
      case 'compPrice': return <td key="compPrice">—</td>;
      case 'targetPrice': return <td key="targetPrice" className="num">{vpr.targetPrice?`$${Number(vpr.targetPrice).toFixed(2)}`:'—'}</td>;
      case 'cogs': return <td key="cogs" className="num">{vpr.cogs?`¥${Number(vpr.cogs).toFixed(2)}`:'—'}</td>;
      case 'bomTotal': return <td key="bomTotal" className="num">{vBomTotal?`¥${vBomTotal.toFixed(2)}`:'—'}</td>;
      case 'netProfit': return <td key="netProfit" className="num">{vm?`$${vm.net.toFixed(2)}`:'—'}</td>;
      case 'margin': return <td key="margin" className={"num "+(vm?marginClass(vm.margin):'')}>{vm?`${vm.margin.toFixed(1)}%`:'—'}</td>;
      case 'decision': return (
        <td key="decision" style={{borderRight:'1px solid var(--border)'}}>
          {vpr.decision==='pass'&&<span className="decision-pill pass">✓ 通过</span>}
          {vpr.decision==='hold'&&<span className="decision-pill hold">⏸ 暂缓</span>}
          {vpr.decision==='reject'&&<span className="decision-pill reject">✗ 否决</span>}
          {!vpr.decision&&'—'}
        </td>
      );
      case 'supCount': return <td key="supCount">—</td>;
      case 'sampleRounds': return <td key="sampleRounds" className="num" style={{borderRight:'1px solid var(--border)'}}>{(v.stages?.sampling?.rounds||[]).length||'—'}</td>;
      case 'expectedShip': return <td key="expectedShip">—</td>;
      case 'orderTotal': return <td key="orderTotal" style={{borderRight:'1px solid var(--border)'}}>—</td>;
      case 'launchDate': return <td key="launchDate" className="num" style={{textAlign:'left'}}>{v.stages?.listing?.launchDate||'—'}</td>;
      default: return <td key={k}>—</td>;
    }
  }

  return (
    <div style={{padding:'22px 28px 60px', overflowY:'auto', height:'100%'}}>
      <div className="dtable-wrap">
        <div className="dtable-toolbar">
          <span style={{fontWeight:600}}>{visibleCols.length} 列对比</span>
          <span className="count">· {rows.length} 个产品 · 按{getColLabel(sortKey)}{sortDir==='asc'?' 升序':' 降序'}</span>
          <span style={{marginLeft:'auto', display:'flex', gap:6, position:'relative'}}>
            <button className="btn btn-sm" onClick={() => setShowColPanel(v => !v)}>
              列设置 {showColPanel ? '▲' : '▼'}
            </button>
            <button className="btn btn-sm" onClick={exportExcel}>导出 Excel</button>
            {showColPanel && (
              <div className="col-panel" onClick={e => e.stopPropagation()}>
                <div className="col-panel-title">选择显示列</div>
                {GROUP_ORDER.map(g => {
                  const gCols = COL_DEFS.filter(c => c.group === g);
                  return (
                    <div key={g} className="col-panel-group">
                      <div className="col-panel-group-name">{g}</div>
                      {gCols.map(c => (
                        <label key={c.k} className="col-panel-item">
                          <input type="checkbox"
                            checked={colVis[c.k] !== false}
                            disabled={!!c.alwaysVisible}
                            onChange={() => { if (!c.alwaysVisible) toggleCol(c.k); }} />
                          <span>{c.label.replace(' 🔒','')}</span>
                        </label>
                      ))}
                    </div>
                  );
                })}
                <button className="btn btn-sm" style={{marginTop:8, width:'100%'}}
                  onClick={() => {
                    const all = {};
                    COL_DEFS.forEach(c => { all[c.k] = true; });
                    setColVis(all);
                    try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(all)); } catch(e) {}
                  }}>全部显示</button>
              </div>
            )}
          </span>
        </div>
        <div className="dtable-scroll">
          <table className="dtable">
            <thead>
              <tr>
                {GROUP_ORDER.map(g => {
                  const span = visibleCols.filter(c => c.group === g).length;
                  if (!span) return null;
                  return (
                    <th key={g} colSpan={span}
                      className={g === '产品信息' ? 'group group-sticky' : 'group'}>
                      {g}
                    </th>
                  );
                })}
              </tr>
              <tr>
                {visibleCols.map(c => (
                  <SortTh key={c.k} k={c.k} label={c.label} num={c.num} sticky={c.sticky} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const m = calcProfit(p);
                const pr = p.stages.profit;
                const hasV = (p.variants||[]).length > 0;
                const isExp = expandedRows.has(p.id);
                return (
                  <React.Fragment key={p.id}>
                    <tr onClick={() => onSelectProduct(p.id)} style={{cursor:'pointer'}}>
                      {visibleCols.map(c => renderCell(p, c.k, m, pr, hasV, isExp))}
                    </tr>
                    {hasV && isExp && (p.variants||[]).map((v, vi) => {
                      const vm = calcVariantProfit(v, p.fxRate);
                      const vpr = v.stages?.profit || {};
                      const vBomTotal = (v.stages?.bom?.items||[]).reduce((s,i)=>s+(Number(i.qty)||0)*(Number(i.unitCost)||0),0);
                      return (
                        <tr key={v.id} className="variant-row" onClick={() => onSelectProduct(p.id)} style={{cursor:'pointer'}}>
                          {visibleCols.map(c => renderVariantCell(v, c.k, vi, p, vm, vpr, vBomTotal))}
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {showColPanel && <div style={{position:'fixed',inset:0,zIndex:99}} onClick={() => setShowColPanel(false)} />}
      <div style={{marginTop:14, display:'flex', gap:18, fontSize:11, color:'var(--ink-4)'}}>
        <span>净利率颜色：<span className="margin-good">≥20% 健康</span> · <span className="margin-warn">10-20% 可接受</span> · <span className="margin-bad">&lt;0% 亏损</span></span>
        <span style={{marginLeft:'auto'}}>点击列头排序 · 点击行打开产品详情</span>
      </div>
    </div>
  );
}

function getColVal(p, k) {
  const pr = p.stages.profit;
  const m = calcProfit(p);
  switch(k) {
    case 'name': return p.name;
    case 'sku': return p.sku;
    case 'status': return p.status;
    case 'progress': return p.progress;
    case 'createdAt': return p.createdAt;
    case 'lead': return p.lead;
    case 'category': return p.category;
    case 'source': return p.stages.initiation.source;
    case 'market': return p.stages.initiation.market;
    case 'compPrice': return p.stages.research.avgPrice;
    case 'targetPrice': return pr.targetPrice;
    case 'cogs': return pr.cogs;
    case 'bomTotal': return (p.stages.bom.items||[]).reduce((s,i)=>s+(Number(i.qty)||0)*(Number(i.unitCost)||0),0) || null;
    case 'netProfit': return m?.net;
    case 'margin': return m?.margin;
    case 'decision': return pr.decision;
    case 'supCount': return (p.stages.supplier.suppliers||[]).length;
    case 'sampleRounds': return (p.stages.sampling.rounds||[]).length;
    case 'expectedShip': return lastExpectedShip(p) || p.stages.shipment?.endDate;
    case 'orderTotal': return calcOrderTotal(p) || null;
    case 'launchDate': return p.stages.listing.launchDate || p.stages.listing.endDate;
    default: return null;
  }
}

function getColLabel(k) {
  const labels = {
    createdAt:'立项日期', name:'产品名称', progress:'进度',
    margin:'净利率', targetPrice:'目标售价', orderTotal:'订单总额',
    expectedShip:'预计出货', launchDate:'上架日期',
  };
  return labels[k] || k;
}

window.TableView = TableView;
