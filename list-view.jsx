/* eslint-disable no-undef */
// Product list + detail panel — fully editable

function ProductList({ products, activeId, setActiveId }) {
  const [search, setSearch] = React.useState('');
  const filtered = products.filter(p =>
    !search ||
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.sku.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="plist">
      <div className="plist-search">
        <div className="plist-search-wrap">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索产品名称或 SKU…" />
        </div>
      </div>
      <div>
        {filtered.map(p => {
          const stage = STAGES.find(s => s.key === p.currentStage);
          return (
            <div key={p.id} className="pcard"
              data-active={p.id === activeId}
              onClick={() => setActiveId(p.id)}>
              <div className="pcard-row1">
                <span className="pcard-name">{p.name}</span>
                <span className={`badge badge-${p.status}`}>{STATUS_LABELS[p.status].label}</span>
              </div>
              <div className="pcard-row2">
                <span className="pcard-sku mono">{p.sku}</span>
                <span>·</span>
                <span>{p.category}</span>
              </div>
              <div className="pcard-bar">
                <div className="pcard-bar-fill" style={{width: p.progress + '%'}}></div>
              </div>
              <div className="pcard-row3">
                <span className="pcard-stage">
                  <span className="dot" style={{background: stage?.color}}></span>
                  <span>{stage?.name}</span>
                </span>
                <span className="pcard-pct">{p.progress}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ TAB: 立项评估 ============
function TabEval({ p }) {
  const { updateStage, update } = useProducts();
  const set = (key, patch) => updateStage(p.id, key, patch);
  const init = p.stages.initiation;
  const research = p.stages.research;
  const profit = p.stages.profit;

  return (
    <>
      <StageCard stage={STAGES[0]} productId={p.id} stageKey="initiation" stageData={init}>
        <div className="fieldgrid cols-3">
          <EditField label="负责人" value={p.lead ?? init.lead} onChange={v => {
            set('initiation', { lead:v });
            update(p.id, prev => ({ ...prev, lead: v }));
          }} />
          <EditField label="目标市场" value={init.market}
            options={['美国 US','英国 UK','德国 DE','日本 JP','加拿大 CA','澳大利亚 AU']}
            onChange={v => set('initiation', { market:v })} />
          <EditField label="选品来源" value={init.source}
            options={['关键词工具 / Helium 10','卖家精灵','TikTok 爆款','品类雷达','线下展会','其他']}
            onChange={v => set('initiation', { source:v })} />
          <EditField label="品类" value={p.category}
            placeholder="自定义品类，例如：家居 / 装饰"
            onChange={v => update(p.id, prev => ({ ...prev, category: v }))} />
          <EditField label="SKU" mono value={p.sku}
            onChange={v => update(p.id, prev => ({ ...prev, sku: v }))} />
          <EditField label="立项日期" type="date" mono value={p.createdAt}
            onChange={v => update(p.id, prev => ({ ...prev, createdAt: v }))} />
        </div>
        <div style={{marginTop:12}}>
          <EditField label="立项理由" wide multi value={init.reason}
            onChange={v => set('initiation', { reason:v })} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[1]} productId={p.id} stageKey="research" stageData={research}>
        <div className="kpi-strip">
          <div className="kpi"><div className="l">月销总量</div><div className="v">{research.monthSales?.toLocaleString() || '—'}</div><div className="s">Top10 累计</div></div>
          <div className="kpi"><div className="l">竞品数</div><div className="v">{research.competitorCount || '—'}</div></div>
          <div className="kpi"><div className="l">均价</div><div className="v">${research.avgPrice ?? '—'}</div></div>
          <div className="kpi"><div className="l">均评分</div><div className="v">{research.avgRating ?? '—'} ★</div><div className="s">机会评级 {research.opportunity || '—'}</div></div>
        </div>
        <div className="fieldgrid cols-3">
          <EditField label="月销总量" type="number" mono value={research.monthSales}
            onChange={v => set('research', { monthSales:v })} />
          <EditField label="竞品数" type="number" mono value={research.competitorCount}
            onChange={v => set('research', { competitorCount:v })} />
          <EditField label="均价 (USD)" type="number" mono prefix="$" value={research.avgPrice}
            onChange={v => set('research', { avgPrice:v })} />
          <EditField label="Top ASIN" mono value={research.topAsin}
            onChange={v => set('research', { topAsin:v })} />
          <EditField label="均评分" type="number" mono value={research.avgRating}
            onChange={v => set('research', { avgRating:v })} />
          <EditField label="机会评级" value={research.opportunity}
            options={['A','B','C','D']}
            onChange={v => set('research', { opportunity:v })} />
        </div>
        <div style={{marginTop:12}}>
          <EditField label="痛点关键词" wide multi value={research.painPoints}
            onChange={v => set('research', { painPoints:v })} />
        </div>
      </StageCard>

      <ProfitCard p={p} />
      <BomCard p={p} />
    </>
  );
}

// ============ Profit (with tax on product cost, return rate, dual currency) ============
function ProfitCard({ p }) {
  const { updateStage, update } = useProducts();
  const pr = p.stages.profit;
  const fx = Number(p.fxRate) || window.DEFAULT_FX || 7.20;
  const set = (patch) => updateStage(p.id, 'profit', patch);

  // Inputs
  const targetPrice = Number(pr.targetPrice) || 0;           // USD
  const taxRate = Number(pr.taxRate ?? 0);                   // %
  const cogsCny = Number(pr.cogs) || 0;                      // CNY (pre-tax)
  const shippingCny = Number(pr.shipping) || 0;              // CNY
  const otherCny = Number(pr.otherCost) || 0;                // CNY
  const fbaFee = Number(pr.fbaFee) || 0;                     // USD
  const referralPct = Number(pr.referralPct) || 0;           // %
  const adPct = Number(pr.adPct) || 0;                       // %
  const returnRate = Number(pr.returnRate ?? 0);             // %

  // Derived
  const cogsUsd = fx > 0 ? cogsCny / fx : 0;                  // USD 不含税（参与计算）
  const cogsInclCny = cogsCny * (1 + taxRate/100);             // CNY 含税（仅展示）
  const cogsInclUsd = fx > 0 ? cogsInclCny / fx : 0;           // USD 含税（仅展示）
  const shippingUsd = fx > 0 ? shippingCny / fx : 0;
  const otherUsd = fx > 0 ? otherCny / fx : 0;

  const referralFee = targetPrice * referralPct / 100;
  const adFee = targetPrice * adPct / 100;
  const returnCost = targetPrice * (returnRate / 100);          // 退货成本 = 售价 × 退货率

  // 毛利润 = 目标售价 - FBA费用 - 头程运费 - 不含税产品成本
  const grossProfit = targetPrice - fbaFee - shippingUsd - cogsUsd;
  // 净利润 = 毛利润 - 平台佣金 - 广告费 - 退货成本 - 其他费用
  const netProfit = grossProfit - referralFee - adFee - returnCost - otherUsd;
  const margin = targetPrice ? (netProfit / targetPrice * 100) : 0;
  const marginCls = margin >= 20 ? 'green' : margin >= 10 ? 'orange' : 'red';

  return (
    <StageCard stage={STAGES[2]} productId={p.id} stageKey="profit" stageData={pr}
      extraHeader={
        <span className={`decision-pill ${pr.decision || 'hold'}`} style={{marginLeft: 6}}>
          {pr.decision === 'pass' ? '✓ 通过立项' : pr.decision === 'hold' ? '⏸ 暂缓观察' : pr.decision === 'reject' ? '✗ 否决' : '— 待决策'}
        </span>
      }>
      {/* FX rate bar */}
      <div className="currency-bar">
        <span className="cb-label">汇率</span>
        <div className="cb-fx-input">
          <span className="cb-prefix">¥</span>
          <input className="cb-input mono" type="number" step="0.01"
            value={fx}
            onChange={e => update(p.id, prev => ({ ...prev, fxRate: Number(e.target.value) }))} />
          <span className="cb-suffix">= $1</span>
        </div>
        <span className="cb-hint">¥ 用于产品成本/头程/其他费用 · $ 用于售价/FBA/毛净利</span>
      </div>

      <div className="kpi-strip cols-5">
        <div className="kpi"><div className="l">目标售价 ($)</div><div className="v">${targetPrice.toFixed(2)}</div></div>
        <div className="kpi"><div className="l">不含税产品成本</div><div className="v">¥{cogsCny.toFixed(2)}</div><div className="s">≈ ${cogsUsd.toFixed(2)}</div></div>
        <div className="kpi"><div className="l">毛利润 ($)</div><div className="v">${grossProfit.toFixed(2)}</div></div>
        <div className="kpi"><div className="l">净利润 ($)</div><div className={`v ${marginCls}`}>${netProfit.toFixed(2)}</div></div>
        <div className="kpi"><div className="l">净利率</div><div className={`v ${marginCls}`}>{margin.toFixed(1)}%</div><div className="s">{margin >= 20 ? '健康' : margin >= 10 ? '可接受' : '风险'}</div></div>
      </div>

      <div className="fieldgrid cols-4">
        <EditField label="目标售价 ($)" type="number" mono prefix="$" value={pr.targetPrice}
          onChange={v => set({ targetPrice:v })} />
        <EditField label="产品成本 (¥)" type="number" mono prefix="¥" value={pr.cogs}
          onChange={v => set({ cogs:v })} />
        <EditField label="税点 (%)" type="number" mono suffix="%" value={pr.taxRate}
          onChange={v => set({ taxRate:v })} />
        <div className="field-static">
          <div className="field-static-label">含税产品成本 (¥) <span style={{color:'var(--ink-4)',fontWeight:400,fontSize:10}}>仅展示</span></div>
          <div className="field-static-value mono">¥{cogsInclCny.toFixed(2)} <span style={{color:'var(--ink-4)',fontSize:10.5}}>≈ ${cogsInclUsd.toFixed(2)}</span></div>
        </div>
        <EditField label="头程运费 (¥)" type="number" mono prefix="¥" value={pr.shipping}
          onChange={v => set({ shipping:v })} />
        <EditField label="FBA 费用 ($)" type="number" mono prefix="$" value={pr.fbaFee}
          onChange={v => set({ fbaFee:v })} />
        <EditField label="其他费用 (¥)" type="number" mono prefix="¥" value={pr.otherCost}
          onChange={v => set({ otherCost:v })} />
        <EditField label="退货率 (%)" type="number" mono suffix="%" value={pr.returnRate}
          onChange={v => set({ returnRate:v })} />
        <EditField label="平台佣金 (%)" type="number" mono suffix="%" value={pr.referralPct}
          onChange={v => set({ referralPct:v })} />
        <EditField label="广告预算 (%)" type="number" mono suffix="%" value={pr.adPct}
          onChange={v => set({ adPct:v })} />
        <EditField label="立项决策" value={pr.decision}
          options={[{value:'pass',label:'通过立项'},{value:'hold',label:'暂缓观察'},{value:'reject',label:'否决'}]}
          onChange={v => set({ decision:v })} />
        <EditField label="决策日期" type="date" mono value={pr.endDate}
          onChange={v => updateStage(p.id, 'profit', { endDate:v })} />
        <EditField label="决策备注" wide value={pr.decisionNote}
          onChange={v => set({ decisionNote:v })} />
      </div>

      {/* BOM sync */}
      <div style={{marginTop:12, padding:'10px 12px', background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:6, fontSize:11.5, color:'var(--ink-3)', display:'flex', alignItems:'center', gap:10}}>
        <span>💡 BOM 参考成本 (¥): <strong className="mono" style={{color:'var(--ink)'}}>¥{(p.stages.bom.items||[]).reduce((s,i)=>s+i.qty*i.unitCost,0).toFixed(2)}</strong></span>
        <button className="btn btn-sm" onClick={() => {
          const total = (p.stages.bom.items||[]).reduce((s,i)=>s+i.qty*i.unitCost,0);
          set({ cogs: +total.toFixed(2) });
        }}>🔄 同步到产品成本</button>
      </div>

      {/* Formula block */}
      <div className="formula-block">
        <div className="formula-hdr">
          <span>📐 计算公式</span>
          <span className="formula-fx mono">¥{fx.toFixed(2)} = $1</span>
        </div>
        <div className="formula-rows">
          <div className="formula-row">
            <span className="fr-label">含税产品成本</span>
            <span className="fr-eq">=</span>
            <span className="fr-expr">产品成本 × (1 + 税点)</span>
            <span className="fr-calc mono">¥{cogsCny.toFixed(2)} × (1 + {taxRate}%) = <strong>¥{cogsInclCny.toFixed(2)}</strong> ≈ ${cogsInclUsd.toFixed(2)}</span>
          </div>
          <div className="formula-row highlight strong">
            <span className="fr-label">毛利润 ($)</span>
            <span className="fr-eq">=</span>
            <span className="fr-expr">目标售价 − FBA费用 − 头程运费 − 产品成本(不含税)</span>
            <span className="fr-calc mono">
              ${targetPrice.toFixed(2)} − ${fbaFee.toFixed(2)} − ${shippingUsd.toFixed(2)} − ${cogsUsd.toFixed(2)} = <strong className={grossProfit >= 0 ? 'green' : 'red'}>${grossProfit.toFixed(2)}</strong>
            </span>
          </div>
          <div className="formula-row">
            <span className="fr-label">平台佣金</span>
            <span className="fr-eq">=</span>
            <span className="fr-expr">目标售价 × 佣金%</span>
            <span className="fr-calc mono">${targetPrice.toFixed(2)} × {referralPct}% = <strong>${referralFee.toFixed(2)}</strong></span>
          </div>
          <div className="formula-row">
            <span className="fr-label">广告费</span>
            <span className="fr-eq">=</span>
            <span className="fr-expr">目标售价 × 广告预算%</span>
            <span className="fr-calc mono">${targetPrice.toFixed(2)} × {adPct}% = <strong>${adFee.toFixed(2)}</strong></span>
          </div>
          <div className="formula-row">
            <span className="fr-label">退货成本</span>
            <span className="fr-eq">=</span>
            <span className="fr-expr">目标售价 × 退货率</span>
            <span className="fr-calc mono">${targetPrice.toFixed(2)} × {returnRate}% = <strong>${returnCost.toFixed(2)}</strong></span>
          </div>
          <div className="formula-row highlight strong">
            <span className="fr-label">净利润 ($)</span>
            <span className="fr-eq">=</span>
            <span className="fr-expr">毛利润 − 平台佣金 − 广告费 − 退货成本 − 其他费用</span>
            <span className="fr-calc mono">
              ${grossProfit.toFixed(2)} − ${referralFee.toFixed(2)} − ${adFee.toFixed(2)} − ${returnCost.toFixed(2)} − ${otherUsd.toFixed(2)} = <strong className={marginCls}>${netProfit.toFixed(2)}</strong>
            </span>
          </div>
          <div className="formula-row highlight strong">
            <span className="fr-label">净利率</span>
            <span className="fr-eq">=</span>
            <span className="fr-expr">净利润 ÷ 目标售价 × 100%</span>
            <span className="fr-calc mono">${netProfit.toFixed(2)} ÷ ${targetPrice.toFixed(2)} × 100% = <strong className={marginCls}>{margin.toFixed(1)}%</strong></span>
          </div>
        </div>
      </div>
    </StageCard>
  );
}

// ============ BOM ============
const BOM_CATS = ['面料/布料','电机/马达','电源/电池','开关/控制','LED/灯珠','模具/外壳','包装材料','认证费','物流/运费','其他'];

function BomCard({ p }) {
  const { updateStage } = useProducts();
  const stage = STAGES[3];
  const bom = p.stages.bom || { items:[] };
  const items = bom.items || [];

  const updateItem = (id, patch) => {
    const next = items.map(i => i.id === id ? { ...i, ...patch } : i);
    updateStage(p.id, 'bom', { items: next });
  };
  const removeItem = (id) => updateStage(p.id, 'bom', { items: items.filter(i => i.id !== id) });
  const addItem = () => updateStage(p.id, 'bom', {
    items: [...items, { id: window.uid(), name:'', spec:'', cat:'其他', qty:1, unitCost:0 }]
  });

  const total = items.reduce((s, i) => s + (Number(i.qty)||0) * (Number(i.unitCost)||0), 0);
  const cogs = Number(p.stages.profit.cogs) || total;
  const coverage = cogs > 0 ? Math.min(100, total / cogs * 100) : 0;

  const catMap = {};
  items.forEach(i => {
    catMap[i.cat] = (catMap[i.cat] || 0) + (Number(i.qty)||0) * (Number(i.unitCost)||0);
  });
  const catEntries = Object.entries(catMap).sort((a,b) => b[1]-a[1]);
  const maxCat = catEntries[0]?.[1] || 1;
  const catColors = { '面料/布料':'#a855f7','电机/马达':'#ec4899','电源/电池':'#f59e0b','开关/控制':'#3b82f6','LED/灯珠':'#06b6d4','模具/外壳':'#10b981','包装材料':'#84cc16','认证费':'#6366f1','物流/运费':'#0ea5e9','其他':'#64748b' };

  // Build pie segments for donut (per-category)
  const cx = 80, cy = 80, r = 60, sw = 22;
  const C = 2 * Math.PI * r;
  let acc = 0;
  const segments = catEntries.map(([cat, amt]) => {
    const frac = total > 0 ? amt / total : 0;
    // scale by coverage so unfilled portion remains visible
    const visFrac = frac * (coverage / 100);
    const len = C * visFrac;
    const seg = { cat, amt, frac, color: catColors[cat] || stage.color, dashOffset: -acc, dashLen: len };
    acc += len;
    return seg;
  });

  return (
    <StageCard stage={stage} productId={p.id} stageKey="bom" stageData={bom}
      extraHeader={<span className="bom-cov-badge mono">{coverage.toFixed(0)}% 覆盖 · ¥{total.toFixed(2)}</span>}>
      <div className="bom-section">
        <div>
          <table className="bom-table editable">
            <thead>
              <tr>
                <th style={{width:'22%'}}>组件名称</th>
                <th style={{width:'20%'}}>规格 / 型号</th>
                <th style={{width:'18%'}}>分类</th>
                <th style={{textAlign:'right', width:'10%'}}>用量</th>
                <th style={{textAlign:'right', width:'12%'}}>单价(¥)</th>
                <th style={{textAlign:'right', width:'12%'}}>小计(¥)</th>
                <th style={{width:'4%'}}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(i => (
                <tr key={i.id}>
                  <td><input className="cell" value={i.name} onChange={e => updateItem(i.id, { name:e.target.value })} placeholder="组件名称" /></td>
                  <td><input className="cell" value={i.spec} onChange={e => updateItem(i.id, { spec:e.target.value })} placeholder="规格" /></td>
                  <td>
                    <select className="cell" value={i.cat} onChange={e => updateItem(i.id, { cat:e.target.value })}>
                      {BOM_CATS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className="num"><input className="cell mono" type="number" step="1" value={i.qty} onChange={e => updateItem(i.id, { qty: Number(e.target.value) })} /></td>
                  <td className="num"><input className="cell mono" type="number" step="0.01" value={i.unitCost} onChange={e => updateItem(i.id, { unitCost: Number(e.target.value) })} /></td>
                  <td className="num" style={{color:'var(--ink)'}}>¥{(i.qty*i.unitCost).toFixed(2)}</td>
                  <td><button className="row-del" onClick={() => removeItem(i.id)}>✕</button></td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={5}>BOM 合计 · {items.length} 项</td>
                <td className="num">¥{total.toFixed(2)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
          <div style={{marginTop:10}}>
            <AddRecordButton label="添加组件" onClick={addItem} />
          </div>
          <div style={{marginTop:12}}>
            <EditField label="BOM 备注" multi wide value={bom.notes}
              onChange={v => updateStage(p.id, 'bom', { notes:v })} />
          </div>
        </div>
        <div>
          <div className="bom-chart-wrap">
            <div className="bom-chart-title">
              <span>BOM 覆盖率</span>
              <span className="cov">{coverage.toFixed(0)}% · ¥{total.toFixed(2)} / ¥{cogs.toFixed(2)}</span>
            </div>
            <svg viewBox="0 0 160 160" style={{width:'100%', maxWidth:200, display:'block', margin:'0 auto'}}>
              <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={sw} />
              {segments.map((s, i) => (
                <circle key={i} cx={cx} cy={cy} r={r} fill="none"
                  stroke={s.color} strokeWidth={sw}
                  strokeDasharray={`${s.dashLen} ${C - s.dashLen}`}
                  strokeDashoffset={s.dashOffset}
                  transform={`rotate(-90 ${cx} ${cy})`}
                  strokeLinecap="butt">
                  <title>{s.cat}: ${s.amt.toFixed(2)} ({(s.frac*100).toFixed(1)}%)</title>
                </circle>
              ))}
              <text x={cx} y={cy-4} textAnchor="middle" style={{fontSize:22,fontWeight:700,fill:'var(--ink)',fontFamily:'var(--font-mono)'}}>{coverage.toFixed(0)}%</text>
              <text x={cx} y={cy+14} textAnchor="middle" style={{fontSize:9,fill:'var(--ink-4)',letterSpacing:0.5}}>已拆解</text>
            </svg>
            <div className="bom-bars">
              <div style={{fontSize:10.5, color:'var(--ink-4)', textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:4}}>按分类汇总</div>
              {catEntries.length === 0 && <div style={{fontSize:11,color:'var(--ink-4)',padding:'8px 0'}}>暂无数据</div>}
              {catEntries.map(([cat, amt]) => {
                const pct = total > 0 ? (amt/total*100) : 0;
                return (
                  <div key={cat} className="bom-bar-row">
                    <span className="bom-bar-name">
                      <span className="bom-bar-sw" style={{background: catColors[cat] || stage.color}}></span>
                      {cat}
                    </span>
                    <span className="bom-bar-track">
                      <span className="bom-bar-fill" style={{width: (amt/maxCat*100)+'%', background: catColors[cat] || stage.color}}></span>
                    </span>
                    <span className="bom-bar-val">¥{amt.toFixed(2)}</span>
                    <span className="bom-bar-pct">{pct.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          {items.length > 0 && (
            <SensitivityPanel items={items} profit={p.stages.profit} fxRate={p.fxRate} />
          )}
        </div>
      </div>
    </StageCard>
  );
}

window.ProductList = ProductList;
window.TabEval = TabEval;
window.BOM_CATS = BOM_CATS;

// ============ Sensitivity Panel (interactive what-if) ============
function SensitivityPanel({ items, profit, fxRate }) {
  // Top 5 by cost
  const topItems = React.useMemo(() => (
    items.slice().sort((a,b) => b.qty*b.unitCost - a.qty*a.unitCost).slice(0, 5)
  ), [items]);

  const [adjust, setAdjust] = React.useState(() => {
    const init = {};
    topItems.forEach(i => init[i.id] = 0); // -50 ~ +50
    return init;
  });
  React.useEffect(() => {
    setAdjust(prev => {
      const next = { ...prev };
      topItems.forEach(i => { if (next[i.id] == null) next[i.id] = 0; });
      return next;
    });
  }, [topItems]);

  const fx = Number(fxRate) || window.DEFAULT_FX || 7.20;
  const baseTotal = items.reduce((s, i) => s + (Number(i.qty)||0) * (Number(i.unitCost)||0), 0); // CNY
  const topMap = new Map(topItems.map(i => [i.id, i]));
  const adjustedTotal = items.reduce((s, i) => {
    const base = (Number(i.qty)||0) * (Number(i.unitCost)||0);
    if (topMap.has(i.id)) {
      const pct = adjust[i.id] || 0;
      return s + base * (1 + pct/100);
    }
    return s + base;
  }, 0);
  const delta = adjustedTotal - baseTotal;

  // Profit recalc: use original profit, replace cogs (CNY) with adjustedTotal
  const targetPrice = Number(profit.targetPrice) || 0;
  const baseCogsCny = Number(profit.cogs) || baseTotal;
  const adjCogsCny = adjustedTotal;
  const baseCogsUsd = baseCogsCny / fx;   // 不含税，参与计算
  const adjCogsUsd = adjCogsCny / fx;     // 不含税，参与计算
  const shippingUsd = (Number(profit.shipping)||0) / fx;
  const otherUsd = (Number(profit.otherCost)||0) / fx;
  const fbaFee = Number(profit.fbaFee) || 0;
  const referralFee = targetPrice * ((Number(profit.referralPct)||0)/100);
  const adFee = targetPrice * ((Number(profit.adPct)||0)/100);
  const returnRate = (Number(profit.returnRate)||0)/100;

  const baseGross = targetPrice - fbaFee - shippingUsd - baseCogsUsd;
  const adjGross = targetPrice - fbaFee - shippingUsd - adjCogsUsd;
  const baseReturnCost = returnRate * targetPrice;  // 退货成本 = 售价 × 退货率
  const adjReturnCost  = returnRate * targetPrice;  // 退货成本与成本无关，两种场景相同
  const baseNet = baseGross - referralFee - adFee - baseReturnCost - otherUsd;
  const adjNet = adjGross - referralFee - adFee - adjReturnCost - otherUsd;
  const netDelta = adjNet - baseNet;
  const baseMargin = targetPrice ? baseNet/targetPrice*100 : 0;
  const adjMargin = targetPrice ? adjNet/targetPrice*100 : 0;

  const resetAll = () => {
    const z = {};
    topItems.forEach(i => z[i.id] = 0);
    setAdjust(z);
  };

  return (
    <div className="sensitivity">
      <div className="sensitivity-hdr">
        <span>成本敏感性分析 · Top {topItems.length}</span>
        <span style={{marginLeft:'auto', display:'flex', gap:8, alignItems:'center'}}>
          <span style={{color:'var(--ink-4)',fontSize:11,fontFamily:'var(--font-mono)'}}>拖动 ±50%</span>
          <button className="btn btn-sm" onClick={resetAll}>重置</button>
        </span>
      </div>
      <div className="sens-table-hdr">
        <span>组件</span>
        <span>调整</span>
        <span style={{textAlign:'right'}}>原始(¥)</span>
        <span style={{textAlign:'right'}}>调整后(¥)</span>
      </div>
      {topItems.map(i => {
        const pct = adjust[i.id] || 0;
        const base = i.qty * i.unitCost;
        const adj = base * (1 + pct/100);
        return (
          <div key={i.id} className="sens-row-v2">
            <span className="name" title={i.name}>{i.name}</span>
            <div className="sens-control">
              <input type="range" min={-50} max={50} step={1} value={pct}
                onChange={e => setAdjust(prev => ({ ...prev, [i.id]: Number(e.target.value) }))} />
              <span className={"pct mono" + (pct > 0 ? ' up' : pct < 0 ? ' down' : '')}>
                {pct > 0 ? '+' : ''}{pct}%
              </span>
            </div>
            <span className="base-val mono">¥{base.toFixed(2)}</span>
            <span className={"adj-val mono" + (pct > 0 ? ' up' : pct < 0 ? ' down' : '')}>
              ¥{adj.toFixed(2)}
            </span>
          </div>
        );
      })}

      <div className="sens-summary">
        <div className="sens-summary-row">
          <span className="lbl">BOM 合计</span>
          <span className="base mono">¥{baseTotal.toFixed(2)}</span>
          <span className="arrow">→</span>
          <span className={"adj mono " + (delta >= 0 ? 'down' : 'up')}>¥{adjustedTotal.toFixed(2)}</span>
          <span className={"delta mono " + (delta >= 0 ? 'down' : 'up')}>
            {delta >= 0 ? '+' : ''}¥{delta.toFixed(2)}
          </span>
        </div>
        {targetPrice > 0 && (
          <>
            <div className="sens-summary-row">
              <span className="lbl">净利润 / 件</span>
              <span className="base mono">${baseNet.toFixed(2)}</span>
              <span className="arrow">→</span>
              <span className={"adj mono " + (netDelta >= 0 ? 'up' : 'down')}>${adjNet.toFixed(2)}</span>
              <span className={"delta mono " + (netDelta >= 0 ? 'up' : 'down')}>
                {netDelta >= 0 ? '+' : ''}${netDelta.toFixed(2)}
              </span>
            </div>
            <div className="sens-summary-row">
              <span className="lbl">净利率</span>
              <span className="base mono">{baseMargin.toFixed(1)}%</span>
              <span className="arrow">→</span>
              <span className={"adj mono " + (adjMargin >= baseMargin ? 'up' : 'down')}>{adjMargin.toFixed(1)}%</span>
              <span className={"delta mono " + (adjMargin >= baseMargin ? 'up' : 'down')}>
                {adjMargin - baseMargin >= 0 ? '+' : ''}{(adjMargin - baseMargin).toFixed(1)}pp
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ===== New product modal =====
function NewProductModal({ open, onClose, onCreate }) {
  const [form, setForm] = React.useState({ name:'', sku:'', category:'', lead:'', source:'关键词工具 / Helium 10', market:'美国 US', reason:'' });
  React.useEffect(() => {
    if (open) setForm({ name:'', sku:'', category:'', lead:'', source:'关键词工具 / Helium 10', market:'美国 US', reason:'' });
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
  if (!open) return null;

  const valid = form.name.trim() && form.sku.trim();
  const submit = () => {
    if (!valid) return;
    onCreate({ ...form, name: form.name.trim(), sku: form.sku.trim(), category: form.category.trim() || '未分类' });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">
          <span className="modal-title">+ 新建产品</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="fieldgrid cols-2">
            <EditField label="产品名称 *" value={form.name} onChange={v => setForm({...form, name:v})} />
            <EditField label="SKU *" mono value={form.sku} onChange={v => setForm({...form, sku:v})} />
            <EditField label="品类 (可自定义)" value={form.category}
              options={['小家电','宠物用品','美妆','户外','厨具','汽车','3C 配件','家居','母婴','其他...']}
              onChange={v => setForm({...form, category:v})} />
            <EditField label="负责人" value={form.lead} onChange={v => setForm({...form, lead:v})} />
            <EditField label="选品来源" value={form.source}
              options={['关键词工具 / Helium 10','卖家精灵','TikTok 爆款','品类雷达','线下展会','其他']}
              onChange={v => setForm({...form, source:v})} />
            <EditField label="目标市场" value={form.market}
              options={['美国 US','英国 UK','德国 DE','日本 JP','加拿大 CA','澳大利亚 AU']}
              onChange={v => setForm({...form, market:v})} />
            <EditField label="立项理由" wide multi value={form.reason} onChange={v => setForm({...form, reason:v})} />
          </div>
        </div>
        <div className="modal-ftr">
          <span className="modal-hint">{valid ? '回车提交' : '产品名称与 SKU 必填'}</span>
          <div style={{display:'flex', gap:8}}>
            <button className="btn btn-sm" onClick={onClose}>取消</button>
            <button className="btn btn-sm btn-primary" disabled={!valid} onClick={submit}>创建产品</button>
          </div>
        </div>
      </div>
    </div>
  );
}

window.NewProductModal = NewProductModal;
