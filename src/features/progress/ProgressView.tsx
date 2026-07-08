import React from 'react';
import { STAGES, VARIANT_STAGE_KEYS, STATUS_LABELS } from '../../data/constants';
// import { computeStats } from '../../data/calc';
import type { Product } from '../../data/types';

const MO_LABELS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function ProgressKPIs({ products }: { products: Product[] }) {
  const total = products.length;
  const active = products.filter(p => p.status === 'active').length;
  const done = products.filter(p => p.status === 'done').length;
  const hold = products.filter(p => p.status === 'hold').length;
  // const { monthDone, due30, overdue } = computeStats(products);

  const kpis = [
    { l: '总产品', v: total, c: '' },
    { l: '开发中', v: active, c: 'green' },
    { l: '已上架', v: done, c: '' },
    { l: '已暂停', v: hold, c: 'orange' },
    // { l: '本月完成', v: monthDone, c: '' },
    // { l: '30天到期', v: due30, c: '' },
    // { l: '已逾期', v: overdue, c: 'red' },
  ];
  return (
    <div className="overview-kpis">
      {kpis.map((k, i) => (
        <div key={i} className="kpi">
          <div className="l">{k.l}</div>
          <div className={`v ${k.c}`}>{k.v}</div>
        </div>
      ))}
    </div>
  );
}

function GanttAll({ products, onSelectProduct }: { products: Product[]; onSelectProduct: (id: string) => void }) {
  const [zoom, setZoom] = React.useState('month');
  const [tooltip, setTooltip] = React.useState<any>(null);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => setExpandedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const now = React.useMemo(() => {
    const d = new Date(); d.setHours(0,0,0,0); return d;
  }, []); // intentionally computed once on mount — live "today" uses Date.now() below
  const todayStr = new Date().toISOString().slice(0,10); // always fresh for active/planned comparisons

  const { minMs, maxMs } = React.useMemo(() => {
    const ms = [Date.now()]; // always include real today, not stale `now`
    products.forEach(p => {
      if (p.createdAt) ms.push(new Date(p.createdAt + 'T00:00:00').getTime());
      STAGES.forEach(s => {
        const sd = p.stages[s.key];
        if (!sd) return;
        if (sd.startDate) ms.push(new Date(sd.startDate + 'T00:00:00').getTime());
        if (sd.endDate)   ms.push(new Date(sd.endDate   + 'T00:00:00').getTime());
      });
      (p.stages.production?.batches || []).forEach((b: any) => {
        if (b.expectedShip) ms.push(new Date(b.expectedShip + 'T00:00:00').getTime());
      });
    });
    return { minMs: Math.min(...ms), maxMs: Math.max(...ms) };
  }, [products, now]);

  const { start, end, axisUnits } = React.useMemo(() => {
    let s: Date, e: Date, units: any[] = [];

    if (zoom === 'week') {
      const today = Date.now();
      s = new Date(today); s.setDate(s.getDate() - 56);
      const dow = (s.getDay() + 6) % 7; s.setDate(s.getDate() - dow);
      e = new Date(today); e.setDate(e.getDate() + 112);
      let cur = new Date(s);
      let idx = 0;
      while (cur < e) {
        units.push({ label: idx % 2 === 0 ? `${cur.getMonth()+1}/${cur.getDate()}` : '', ms: cur.getTime() });
        cur = new Date(cur); cur.setDate(cur.getDate() + 7); idx++;
      }
    } else if (zoom === 'quarter') {
      s = new Date(minMs); s.setDate(1); s.setMonth(Math.floor(s.getMonth()/3)*3); s.setHours(0,0,0,0);
      e = new Date(maxMs); e.setDate(1); e.setMonth(Math.floor(e.getMonth()/3)*3+3); e.setHours(0,0,0,0);
      if (e.getTime() - s.getTime() < 365 * 24 * 3600 * 1000) { e = new Date(s); e.setFullYear(e.getFullYear() + 1); }
      let cur = new Date(s);
      while (cur < e) {
        const q = Math.floor(cur.getMonth()/3) + 1;
        units.push({ label: `${cur.getFullYear()} Q${q}`, ms: cur.getTime() });
        cur = new Date(cur); cur.setMonth(cur.getMonth() + 3);
      }
    } else {
      s = new Date(minMs); s.setDate(1); s.setMonth(s.getMonth()-1); s.setHours(0,0,0,0);
      e = new Date(maxMs); e.setDate(1); e.setMonth(e.getMonth()+2); e.setHours(0,0,0,0);
      let cur = new Date(s);
      while (cur < e) {
        units.push({ label: `${MO_LABELS[cur.getMonth()]} ${String(cur.getFullYear()).slice(2)}`, ms: cur.getTime() });
        cur = new Date(cur); cur.setMonth(cur.getMonth()+1);
      }
    }
    return { start: s, end: e, axisUnits: units };
  }, [zoom, minMs, maxMs]);

  const totalMs = end.getTime() - start.getTime();
  const pct = (dateStr: string) => Math.max(0, Math.min(100, (new Date(dateStr + 'T00:00:00').getTime() - start.getTime()) / totalMs * 100));
  const todayPct = Math.max(0, Math.min(100, (Date.now() - start.getTime()) / totalMs * 100));

  return (
    <div className="gantt-wrap">
      <div className="gantt-hdr">
        <span className="gantt-title">全部产品时间线</span>
        <span style={{color:'var(--ink-4)', fontSize:11}}>
          {products.length} 个产品 · {start.toISOString().slice(0,7)} → {end.toISOString().slice(0,7)}
        </span>
        <div className="gantt-zoom">
          {['week','month','quarter'].map(z => (
            <button key={z} data-active={zoom === z} onClick={() => setZoom(z)}>
              {z === 'week' ? '周' : z === 'month' ? '月' : '季'}
            </button>
          ))}
          <button onClick={() => {}}>📍 今天</button>
        </div>
      </div>
      <div className="gantt-body">
        <div className="gantt-grid">
          <div className="gantt-labels">
            <div className="gantt-axis" style={{padding:'8px 14px', fontSize:10.5, color:'var(--ink-4)', textTransform:'uppercase', letterSpacing:'0.04em'}}>产品</div>
            {products.map(p => {
              const isExpanded = expandedIds.has(p.id);
              const activeStages = STAGES.filter(s => {
                const sd = p.stages[s.key];
                if (!sd) return false;
                return sd.status === 'done' || sd.status === 'active' || sd.status === 'hold' || sd.startDate || sd.endDate;
              });
              return (
                <React.Fragment key={p.id}>
                  <div className="gantt-label" onClick={() => onSelectProduct(p.id)} style={{cursor:'pointer'}}>
                    <button className="gantt-expand-btn" onClick={e => { e.stopPropagation(); toggleExpand(p.id); }}>
                      {isExpanded ? '▼' : '▶'}
                    </button>
                    <span className={`badge badge-${p.status}`} style={{padding:'1px 5px', fontSize:9}}></span>
                    <span className="pn">{p.name}</span>
                    {(p.variants||[]).length > 0 && (
                      <span className="gantt-variant-n">{(p.variants||[]).length} SKU</span>
                    )}
                  </div>
                  {isExpanded && activeStages.map(s => (
                    <div key={s.key} className="gantt-sub-label">
                      <span className="gantt-sub-dot" style={{background: s.color}}></span>
                      <span>{s.name}</span>
                    </div>
                  ))}
                </React.Fragment>
              );
            })}
          </div>
          <div className="gantt-canvas">
            <div className="gantt-axis" style={{position:'relative', overflow:'hidden'}}>
              {axisUnits.map((unit: any, i: number) => {
                const nextMs = i + 1 < axisUnits.length ? axisUnits[i+1].ms : end.getTime();
                const left = Math.max(0, (unit.ms - start.getTime()) / totalMs * 100);
                const width = Math.max(0, (nextMs - unit.ms) / totalMs * 100);
                return (
                  <div key={i} className="gantt-month"
                    style={{position:'absolute', left: left+'%', width: width+'%', boxSizing:'border-box'}}>
                    {unit.label}
                  </div>
                );
              })}
            </div>

            {products.map(p => {
              const isExpanded = expandedIds.has(p.id);
              const hasV = (p.variants || []).length > 0;

              function effectiveSd(stageKey: string) {
                const baseSd = p.stages[stageKey];
                if (!hasV || !VARIANT_STAGE_KEYS.includes(stageKey)) return baseSd;
                const vStages = (p.variants || []).map((v: any) => v.stages?.[stageKey]).filter(Boolean);
                if (vStages.length === 0) return baseSd;
                const allDone = vStages.every((vs: any) => vs.status === 'done');
                const anyProgress = vStages.some((vs: any) => vs.status === 'done' || vs.status === 'active');
                const starts = vStages.map((vs: any) => vs.startDate).filter(Boolean).sort();
                const ends = vStages.map((vs: any) => vs.endDate || vs.doneDate).filter(Boolean).sort();
                if (allDone && ends.length) {
                  return { status: 'done', startDate: starts[0] || baseSd?.startDate || null, endDate: ends[ends.length - 1] };
                }
                if (anyProgress) {
                  return { status: 'active', startDate: starts[0] || baseSd?.startDate || null, endDate: baseSd?.endDate || null };
                }
                return baseSd;
              }

              function buildSeg(stage: any, sd: any, fbStart: string): any | null {
                const stageEnd = sd.endDate || sd.doneDate;
                if (sd.status === 'done' && stageEnd) {
                  return { color: stage.color, name: stage.name, short: stage.short, start: sd.startDate || fbStart, end: stageEnd, status: '已完成' };
                }
                if (sd.status === 'active') {
                  const segStart = sd.startDate || fbStart;
                  let endDate = sd.endDate;
                  if (!endDate && stage.key === 'production') {
                    const batch = (p.stages.production?.batches || []).find((b: any) => b.expectedShip);
                    if (batch) endDate = batch.expectedShip;
                  }
                  const started = segStart && segStart < todayStr;
                  const futurePlan = endDate && endDate > todayStr;
                  if (started && futurePlan) {
                    return { color: stage.color, name: stage.name, short: stage.short, start: segStart, end: endDate, current: true, status: '进行中' };
                  }
                  return { color: stage.color, name: stage.name, short: stage.short, start: segStart || todayStr, end: endDate || todayStr, current: true, planned: !started, status: started ? '进行中' : '计划中' };
                }
                if (sd.status === 'hold') {
                  return { color: '#9333ea', name: stage.name, short: stage.short + '⏸', start: sd.startDate || fbStart, end: sd.endDate || todayStr, status: '已暂停' };
                }
                // idle but has dates: show a thin marker so user can see it needs status change
                if (sd.status === 'idle' && stageEnd) {
                  return { color: stage.color, name: stage.name, short: stage.short, start: sd.startDate || stageEnd, end: stageEnd, idle: true, status: '未开始(仅日期)' };
                }
                if (sd.status === 'idle' && sd.startDate) {
                  return { color: stage.color, name: stage.name, short: stage.short, start: sd.startDate, end: sd.startDate, idle: true, status: '未开始(仅日期)' };
                }
                return null;
              }

              const activeStages = STAGES
                .map(s => ({ stage: s, sd: effectiveSd(s.key) }))
                .filter(({sd}) => sd && (sd.status !== 'idle' || sd.startDate || sd.endDate));

              // Pick segment for product row
              let prodSeg: any = null;
              if (!isExpanded) {
                const best = activeStages.find(({sd}) => sd?.status === 'active')?.stage
                  || activeStages.find(({sd}) => sd?.status === 'hold')?.stage
                  || [...activeStages].reverse().find(({sd}) => sd?.status === 'done')?.stage
                  || activeStages.find(({sd}) => sd?.status === 'idle')?.stage;
                if (best) prodSeg = buildSeg(best, effectiveSd(best.key), p.createdAt);
              } else {
                const allDates: string[] = [];
                activeStages.forEach(({sd}) => {
                  if (sd?.startDate) allDates.push(sd.startDate);
                  const e = sd?.endDate || (sd as any).doneDate;
                  if (e) allDates.push(e);
                });
                if (allDates.length > 0) {
                  allDates.sort();
                  prodSeg = { color: 'var(--ink-3)', name: p.name, short: '', start: allDates[0], end: allDates[allDates.length-1], status: '摘要', summary: true };
                }
              }

              function renderSeg(seg: any) {
                const l = pct(seg.start);
                const r = pct(seg.end);
                let w = r - l;
                if (w < 0) return null;
                if (w < 0.5) w = 0.5;
                const days = Math.round((new Date(seg.end+'T00:00:00').getTime() - new Date(seg.start+'T00:00:00').getTime()) / 86400000);
                return (
                  <div className={"gantt-seg" + (seg.current ? ' current' : '') + (seg.summary ? ' summary' : '') + (seg.idle ? ' idle' : '')}
                    style={{
                      left: l + '%', width: w + '%',
                      background: seg.color,
                      opacity: seg.idle ? 0.35 : seg.summary ? 0.35 : seg.planned ? 0.6 : 1,
                      backgroundImage: seg.idle
                        ? 'repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(255,255,255,0.5) 3px,rgba(255,255,255,0.5) 6px)'
                        : seg.planned
                          ? 'repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(255,255,255,0.3) 4px,rgba(255,255,255,0.3) 8px)'
                          : 'none',
                      height: seg.idle ? 8 : undefined,
                      top: seg.idle ? 15 : undefined,
                    }}
                    onMouseEnter={e => setTooltip({ name: seg.name, status: seg.status, period: seg.start + ' → ' + seg.end, days, x: e.clientX, y: e.clientY })}
                    onMouseMove={e => setTooltip((t: any) => t ? {...t, x: e.clientX, y: e.clientY} : null)}
                    onMouseLeave={() => setTooltip(null)}>
                    {w > 4 && !seg.summary && !seg.idle ? seg.short : ''}
                  </div>
                );
              }

              return (
                <React.Fragment key={p.id}>
                  <div className="gantt-row">
                    {prodSeg && renderSeg(prodSeg)}
                  </div>
                  {isExpanded && activeStages.map(({stage, sd}) => {
                    const seg = buildSeg(stage, sd!, p.createdAt);
                    return (
                      <div key={stage.key} className="gantt-sub-row">
                        {seg && renderSeg(seg)}
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
            <div className="gantt-today" style={{left: todayPct + '%'}}></div>
          </div>
        </div>
      </div>
      <div className="gantt-legend">
        {STAGES.map(s => (
          <span key={s.key} className="item">
            <span className="sw" style={{background: s.color}}></span>
            <span>{s.name}</span>
          </span>
        ))}
        <span className="item" style={{marginLeft:'auto', opacity:0.65}}>
          <span className="sw" style={{background:'var(--ink-3)', backgroundImage:'repeating-linear-gradient(45deg,transparent,transparent 2px,rgba(255,255,255,0.5) 2px,rgba(255,255,255,0.5) 4px)'}}></span>
          <span>计划中</span>
        </span>
      </div>
      {tooltip && (
        <div className="gantt-tip" style={{
          position: 'fixed',
          left: Math.min(tooltip.x + 14, window.innerWidth - 230),
          top: tooltip.y - 76,
          zIndex: 300,
          pointerEvents: 'none',
        }}>
          <div className="gantt-tip-name">{tooltip.name}</div>
          <div className="gantt-tip-status">{tooltip.status}</div>
          <div className="gantt-tip-period">{tooltip.period}</div>
          <div className="gantt-tip-days">{tooltip.days} 天</div>
        </div>
      )}
    </div>
  );
}

function CalendarHeatmap({ product }: { product: Product }) {
  const [year, setYear] = React.useState(2026);
  const [zoom] = React.useState(1);

  const events: Record<string, any[]> = {};
  STAGES.forEach(s => {
    const sd = product.stages[s.key];
    if (!sd) return;
    const end = sd.endDate || (sd as any).doneDate;
    if (end && sd.status === 'done') {
      if (!events[end]) events[end] = [];
      events[end].push({ key: s.key, name: s.name, color: s.color });
    }
    if (sd.startDate && sd.startDate !== end) {
      if (!events[sd.startDate]) events[sd.startDate] = [];
      events[sd.startDate].push({ key: s.key, name: s.name + ' · 开始', color: s.color });
    }
  });

  const milestones = Object.keys(events).sort();
  const bridge: Record<string, string> = {};
  for (let i = 0; i < milestones.length - 1; i++) {
    const a = new Date(milestones[i] + 'T00:00:00');
    const b = new Date(milestones[i+1] + 'T00:00:00');
    const nextColor = events[milestones[i+1]][0].color;
    const d = new Date(a); d.setDate(d.getDate() + 1);
    while (d < b) {
      const k = d.toISOString().slice(0,10);
      bridge[k] = nextColor;
      d.setDate(d.getDate() + 1);
    }
  }

  const today = React.useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  const todayDateStr = today.toISOString().slice(0,10);
  const monthNames = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  const dowNames = ['一','二','三','四','五','六','日'];

  function renderMonth(monthIdx: number) {
    const first = new Date(year, monthIdx, 1);
    const last = new Date(year, monthIdx + 1, 0);
    const firstDow = (first.getDay() + 6) % 7;
    const daysInMonth = last.getDate();
    const monthEvents = Object.keys(events).filter(k => k.startsWith(`${year}-${String(monthIdx+1).padStart(2,'0')}`));
    let domColor = 'var(--border)';
    if (monthEvents.length > 0) {
      const counts: Record<string, number> = {};
      monthEvents.forEach(k => {
        events[k].forEach((e: any) => counts[e.color] = (counts[e.color] || 0) + 1);
      });
      domColor = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
    }
    const cells: React.ReactNode[] = [];
    dowNames.forEach((d, i) => cells.push(<div key={`h${i}`} className="cal-dow">{d}</div>));
    for (let i = 0; i < firstDow; i++) cells.push(<div key={`e${i}`} className="cal-day empty"></div>);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(monthIdx+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const ev = events[dateStr];
      const br = bridge[dateStr];
      const isToday = dateStr === todayDateStr;
      let cls = 'cal-day';
      let style: any = {};
      if (ev) { cls += ' fill'; style.background = ev[0].color; }
      else if (br) { cls += ' bridge'; style.background = br; style.opacity = 0.18; }
      if (isToday) cls += ' today';
      cells.push(
        <div key={`d${d}`} className={cls} style={style} title={ev ? ev.map((e: any) => e.name).join(', ') : dateStr}>
          {d}
          {ev && ev.length > 1 && (
            <div className="cal-day-dots">
              {ev.slice(0,4).map((_: any, i: number) => <span key={i} className="d" style={{background: 'rgba(255,255,255,0.9)'}}></span>)}
            </div>
          )}
        </div>
      );
    }
    return (
      <div key={monthIdx} className="cal-month">
        <div className="cal-month-hdr">
          <span>{monthNames[monthIdx]}</span>
          <span className="dom">{monthEvents.length > 0 ? `${monthEvents.length} 里程碑` : ''}</span>
        </div>
        <div className="cal-month-bar" style={{background: domColor, opacity: monthEvents.length > 0 ? 1 : 0.3}}></div>
        <div className="cal-month-grid">{cells}</div>
      </div>
    );
  }

  const usedStages = STAGES.filter(s => {
    const sd = product.stages[s.key];
    return sd && (sd.status === 'done' || sd.status === 'active' || sd.endDate || sd.startDate);
  });

  return (
    <div className="cal-wrap">
      <div className="cal-hdr">
        <span className="cal-title">📅 年度日历热力图</span>
        <span className="cal-year mono">{year}</span>
        <span style={{color:'var(--ink-4)', fontSize: 11}}>{product.name}</span>
        <div className="cal-controls">
          <button className="btn btn-sm btn-icon" onClick={() => setYear(year-1)}>◀</button>
          <button className="btn btn-sm btn-icon" onClick={() => setYear(year+1)}>▶</button>
          <button className="btn btn-sm btn-icon">−</button>
          <button className="btn btn-sm btn-icon">+</button>
          <span style={{fontSize:10.5, color:'var(--ink-4)', marginLeft:4, fontFamily:'var(--font-mono)'}}>{zoom.toFixed(1)}x</span>
        </div>
      </div>
      <div className="cal-grid">
        {[0,1,2,3,4,5,6,7,8,9,10,11].map(m => renderMonth(m))}
      </div>
      <div className="cal-legend">
        {usedStages.map(s => (
          <span key={s.key} className="item">
            <span className="sw" style={{background: s.color}}></span>
            <span>{s.name}</span>
          </span>
        ))}
        <span className="item" style={{marginLeft:'auto'}}>
          <span className="sw" style={{outline:'1.5px solid var(--ink)', outlineOffset:-1.5, background:'var(--card-bg)'}}></span>
          <span>今天 ({today.getMonth()+1}/{today.getDate()})</span>
        </span>
      </div>
    </div>
  );
}

export function ProgressView({ products, focusId, setFocusId }: {
  products: Product[];
  focusId: string | null;
  setFocusId: (id: string | null) => void;
}) {
  const focused = focusId ? products.find(p => p.id === focusId) : null;
  return (
    <div style={{padding: '22px 28px 60px', overflowY: 'auto', height: '100%'}}>
      <ProgressKPIs products={products} />
      {!focused && (
        <GanttAll products={products} onSelectProduct={setFocusId} />
      )}
      {focused && (
        <>
          <div style={{display:'flex', alignItems:'center', gap:12, marginBottom: 14}}>
            <button className="btn btn-sm" onClick={() => setFocusId(null)}>← 返回全部</button>
            <span style={{fontWeight:600, fontSize:14}}>{focused.name}</span>
            <span className={`badge badge-${focused.status}`}>{STATUS_LABELS[focused.status].label}</span>
            <span style={{marginLeft:'auto', color:'var(--ink-3)', fontSize:12, fontFamily:'var(--font-mono)'}}>进度 {focused.progress}%</span>
          </div>
          <GanttAll products={[focused]} onSelectProduct={() => {}} />
          <div style={{height: 18}}></div>
          <CalendarHeatmap product={focused} />
        </>
      )}
    </div>
  );
}
