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

function TableView({ onSelectProduct, filter }) {
  // 直接订阅 context，确保编辑后立即同步，不依赖父组件 prop 传递
  const { products: allProducts } = useProducts();
  const products = filter && filter !== 'all'
    ? allProducts.filter(p => p.status === filter)
    : allProducts;

  const [sortKey, setSortKey] = React.useState('createdAt');
  const [sortDir, setSortDir] = React.useState('desc');

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

  return (
    <div style={{padding: '22px 28px 60px', overflowY:'auto', height:'100%'}}>
      <div className="dtable-wrap">
        <div className="dtable-toolbar">
          <span style={{fontWeight:600}}>21 列对比</span>
          <span className="count">· {rows.length} 个产品 · 按{getColLabel(sortKey)}{sortDir === 'asc' ? ' 升序' : ' 降序'}</span>
          <span style={{marginLeft:'auto', display:'flex', gap:6}}>
            <button className="btn btn-sm">列设置</button>
            <button className="btn btn-sm">导出 CSV</button>
          </span>
        </div>
        <div className="dtable-scroll">
          <table className="dtable">
            <thead>
              <tr>
                <th colSpan={7} className="group group-sticky">产品信息</th>
                <th colSpan={2} className="group">立项评估</th>
                <th colSpan={1} className="group">竞品</th>
                <th colSpan={6} className="group">利润测算</th>
                <th colSpan={2} className="group">供应商/打样</th>
                <th colSpan={1} className="group">出货</th>
                <th colSpan={2} className="group">上架/返单</th>
              </tr>
              <tr>
                <SortTh k="name" label="产品名称 🔒" sticky />
                <SortTh k="sku" label="SKU" />
                <SortTh k="status" label="状态" />
                <SortTh k="progress" label="进度" num />
                <SortTh k="createdAt" label="立项日期" />
                <SortTh k="lead" label="负责人" />
                <SortTh k="category" label="品类" />

                <SortTh k="source" label="选品来源" />
                <SortTh k="market" label="目标市场" />

                <SortTh k="compPrice" label="竞品均价($)" num />

                <SortTh k="targetPrice" label="目标售价($)" num />
                <SortTh k="cogs" label="产品成本(¥)" num />
                <SortTh k="bomTotal" label="BOM合计(¥)" num />
                <SortTh k="netProfit" label="毛利润($)" num />
                <SortTh k="margin" label="净利率" num />
                <SortTh k="decision" label="决策" />

                <SortTh k="supCount" label="供应商数" num />
                <SortTh k="sampleRounds" label="打样轮次" num />

                <SortTh k="expectedShip" label="预计出货" />

                <SortTh k="launchDate" label="上架日期" />
                <SortTh k="reorderCount" label="返单次数" num />
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const m = calcProfit(p);
                const pr = p.stages.profit;
                return (
                  <tr key={p.id} onClick={() => onSelectProduct(p.id)} style={{cursor:'pointer'}}>
                    <td className="sticky pname">
                      <span className="lock">🔒</span>
                      {p.name}
                    </td>
                    <td className="num" style={{textAlign:'left', color:'var(--ink-3)'}}>{p.sku}</td>
                    <td><span className={`badge badge-${p.status}`}>{STATUS_LABELS[p.status].label}</span></td>
                    <td className="num gcol">
                      <span className="tbar"><span className="tbar-f" style={{width: p.progress + '%'}}></span></span>
                      {p.progress}%
                    </td>
                    <td className="num" style={{textAlign:'left'}}>{p.createdAt}</td>
                    <td>{p.lead}</td>
                    <td style={{color:'var(--ink-3)', borderRight:'1px solid var(--border)'}}>{p.category}</td>

                    <td style={{color:'var(--ink-3)'}}>{p.stages.initiation.source || '—'}</td>
                    <td style={{color:'var(--ink-3)', borderRight:'1px solid var(--border)'}}>{p.stages.initiation.market || '—'}</td>

                    <td className="num">{p.stages.research.avgPrice ? `$${p.stages.research.avgPrice.toFixed(2)}` : '—'}</td>

                    <td className="num">{pr.targetPrice ? `$${Number(pr.targetPrice).toFixed(2)}` : '—'}</td>
                    <td className="num">{pr.cogs ? `¥${Number(pr.cogs).toFixed(2)}` : '—'}</td>
                    <td className="num">{p.stages.bom.items?.length ? `¥${(p.stages.bom.items||[]).reduce((s,i)=>s+i.qty*i.unitCost,0).toFixed(2)}` : '—'}</td>
                    <td className="num">{m ? `$${m.net.toFixed(2)}` : '—'}</td>
                    <td className={"num " + (m ? marginClass(m.margin) : '')}>{m ? `${m.margin.toFixed(1)}%` : '—'}</td>
                    <td style={{borderRight:'1px solid var(--border)'}}>
                      {pr.decision === 'pass' && <span className="decision-pill pass">✓ 通过</span>}
                      {pr.decision === 'hold' && <span className="decision-pill hold">⏸ 暂缓</span>}
                      {pr.decision === 'reject' && <span className="decision-pill reject">✗ 否决</span>}
                      {!pr.decision && '—'}
                    </td>

                    <td className="num">{(p.stages.supplier.suppliers || []).length || '—'}</td>
                    <td className="num" style={{borderRight:'1px solid var(--border)'}}>{(p.stages.sampling.rounds || []).length || '—'}</td>

                    <td className="num" style={{textAlign:'left', borderRight:'1px solid var(--border)'}}>{firstExpectedShip(p) || p.stages.shipment.endDate || '—'}</td>

                    <td className="num" style={{textAlign:'left'}}>{p.stages.listing.launchDate || p.stages.listing.endDate || '—'}</td>
                    <td className="num">{(p.stages.reorder.records || []).length || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
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
    case 'bomTotal': return (p.stages.bom.items||[]).reduce((s,i)=>s+i.qty*i.unitCost,0) || null;
    case 'netProfit': return m?.net;
    case 'margin': return m?.margin;
    case 'decision': return pr.decision;
    case 'supCount': return (p.stages.supplier.suppliers || []).length;
    case 'sampleRounds': return (p.stages.sampling.rounds || []).length;
    case 'expectedShip': return firstExpectedShip(p) || p.stages.shipment.endDate;
    case 'launchDate': return p.stages.listing.launchDate || p.stages.listing.endDate;
    case 'reorderCount': return (p.stages.reorder.records || []).length;
    default: return null;
  }
}
function getColLabel(k) {
  const labels = { createdAt:'立项日期', name:'产品名称', progress:'进度', margin:'净利率', targetPrice:'目标售价' };
  return labels[k] || k;
}

window.TableView = TableView;
