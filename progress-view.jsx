/* eslint-disable no-undef */
// Progress Overview: KPIs + Gantt timeline (all products) + Calendar heatmap (single product)

function ProgressKPIs({ products }) {
  const total = products.length;
  const active = products.filter(p => p.status === 'active').length;
  const done = products.filter(p => p.status === 'done').length;
  const hold = products.filter(p => p.status === 'hold').length;
  const { monthDone, due30, overdue } = computeStats(products);

  const kpis = [
    { l: '总产品', v: total, c: '' },
    { l: '进行中', v: active, c: 'green' },
    { l: '已完成', v: done, c: '' },
    { l: '已暂停', v: hold, c: 'orange' },
    { l: '本月完成', v: monthDone, c: '' },
    { l: '30天到期', v: due30, c: '' },
    { l: '已逾期', v: overdue, c: 'red' },
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

const MO_LABELS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function GanttAll({ products, onSelectProduct }) {
  const [zoom, setZoom] = React.useState('month');
  const [tooltip, setTooltip] = React.useState(null);

  // Dynamic today (no hardcoding)
  const now = React.useMemo(() => {
    const d = new Date(); d.setHours(0,0,0,0); return d;
  }, []);
  const todayStr = now.toISOString().slice(0,10);

  // Collect all meaningful dates from all products to determine range
  const { minMs, maxMs } = React.useMemo(() => {
    const ms = [now.getTime()];
    products.forEach(p => {
      if (p.createdAt) ms.push(new Date(p.createdAt + 'T00:00:00').getTime());
      STAGES.forEach(s => {
        const sd = p.stages[s.key];
        if (!sd) return;
        if (sd.startDate) ms.push(new Date(sd.startDate + 'T00:00:00').getTime());
        if (sd.endDate)   ms.push(new Date(sd.endDate   + 'T00:00:00').getTime());
      });
      (p.stages.production?.batches || []).forEach(b => {
        if (b.expectedShip) ms.push(new Date(b.expectedShip + 'T00:00:00').getTime());
      });
    });
    return { minMs: Math.min(...ms), maxMs: Math.max(...ms) };
  }, [products, now]);

  // Build axis units and date range based on zoom
  const { start, end, axisUnits } = React.useMemo(() => {
    let s, e, units = [];

    if (zoom === 'week') {
      // Show 8 weeks before → 16 weeks after today
      s = new Date(now); s.setDate(s.getDate() - 56);
      const dow = (s.getDay() + 6) % 7; s.setDate(s.getDate() - dow); // snap to Monday
      e = new Date(now); e.setDate(e.getDate() + 112);
      let cur = new Date(s);
      let idx = 0;
      while (cur < e) {
        // Only label every 2nd week to avoid crowding
        units.push({ label: idx % 2 === 0 ? `${cur.getMonth()+1}/${cur.getDate()}` : '', ms: cur.getTime() });
        cur = new Date(cur); cur.setDate(cur.getDate() + 7); idx++;
      }
    } else if (zoom === 'quarter') {
      // Quarter boundaries covering all data
      s = new Date(minMs); s.setDate(1); s.setMonth(Math.floor(s.getMonth()/3)*3); s.setHours(0,0,0,0);
      e = new Date(maxMs); e.setDate(1); e.setMonth(Math.floor(e.getMonth()/3)*3+3); e.setHours(0,0,0,0);
      // At least 4 quarters
      if (e - s < 365 * 24 * 3600 * 1000) { e = new Date(s); e.setFullYear(e.getFullYear() + 1); }
      let cur = new Date(s);
      while (cur < e) {
        const q = Math.floor(cur.getMonth()/3) + 1;
        units.push({ label: `${cur.getFullYear()} Q${q}`, ms: cur.getTime() });
        cur = new Date(cur); cur.setMonth(cur.getMonth() + 3);
      }
    } else {
      // month: cover all data + 1 month padding each side
      s = new Date(minMs); s.setDate(1); s.setMonth(s.getMonth()-1); s.setHours(0,0,0,0);
      e = new Date(maxMs); e.setDate(1); e.setMonth(e.getMonth()+2); e.setHours(0,0,0,0);
      let cur = new Date(s);
      while (cur < e) {
        units.push({ label: `${MO_LABELS[cur.getMonth()]} ${String(cur.getFullYear()).slice(2)}`, ms: cur.getTime() });
        cur = new Date(cur); cur.setMonth(cur.getMonth()+1);
      }
    }
    return { start: s, end: e, axisUnits: units };
  }, [zoom, minMs, maxMs, now]);

  const totalMs = end.getTime() - start.getTime();
  const pct = (dateStr) => Math.max(0, Math.min(100, (new Date(dateStr + 'T00:00:00').getTime() - start.getTime()) / totalMs * 100));
  const todayPct = Math.max(0, Math.min(100, (now.getTime() - start.getTime()) / totalMs * 100));

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
            {products.map(p => (
              <div key={p.id} className="gantt-label" onClick={() => onSelectProduct(p.id)} style={{cursor:'pointer'}}>
                <span className={`badge badge-${p.status}`} style={{padding:'1px 5px', fontSize:9}}></span>
                <span className="pn">{p.name}</span>
              </div>
            ))}
          </div>
          <div className="gantt-canvas">
            {/* Axis: absolutely-positioned labels so they align with segment bars */}
            <div className="gantt-axis" style={{position:'relative', overflow:'hidden'}}>
              {axisUnits.map((unit, i) => {
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
              const segs = [];
              let prevDate = p.createdAt;
              const hasV = (p.variants || []).length > 0;

              // For a stage key, return effective stage data.
              // Variant-level stages on multi-SKU products are aggregated from variants.
              function effectiveSd(stageKey) {
                const baseSd = p.stages[stageKey];
                if (!hasV || !VARIANT_STAGE_KEYS.includes(stageKey)) return baseSd;

                const vStages = (p.variants || []).map(v => v.stages?.[stageKey]).filter(Boolean);
                if (vStages.length === 0) return baseSd;

                const allDone = vStages.every(vs => vs.status === 'done');
                const anyProgress = vStages.some(vs => vs.status === 'done' || vs.status === 'active');

                const starts = vStages.map(vs => vs.startDate).filter(Boolean).sort();
                const ends   = vStages.map(vs => vs.endDate || vs.doneDate).filter(Boolean).sort();

                if (allDone && ends.length) {
                  return { status: 'done', startDate: starts[0] || baseSd?.startDate || null, endDate: ends[ends.length - 1] };
                }
                if (anyProgress) {
                  return { status: 'active', startDate: starts[0] || baseSd?.startDate || null, endDate: baseSd?.endDate || null };
                }
                // All idle/hold — fall back to product-level for hold case
                return baseSd;
              }

              STAGES.forEach(s => {
                const sd = effectiveSd(s.key);
                if (!sd) return;
                const stageEnd = sd.endDate || sd.doneDate;
                if (sd.status === 'done' && stageEnd) {
                  const segStart = sd.startDate || prevDate;
                  segs.push({ color: s.color, name: s.name, short: s.short, start: segStart, end: stageEnd, status: '已完成' });
                  prevDate = stageEnd;
                } else if (sd.status === 'active') {
                  const segStart = sd.startDate || prevDate;
                  let plannedEnd = sd.endDate;
                  if (!plannedEnd && s.key === 'production') {
                    const batch = (p.stages.production?.batches || []).find(b => b.expectedShip);
                    if (batch) plannedEnd = batch.expectedShip;
                  }
                  const started = segStart && segStart < todayStr;
                  const futurePlan = plannedEnd && plannedEnd > todayStr;
                  if (started && futurePlan) {
                    // Split: solid elapsed portion + striped future portion
                    segs.push({ color: s.color, name: s.name, short: s.short, start: segStart, end: todayStr, current: true, planned: false, status: '进行中' });
                    segs.push({ color: s.color, name: s.name, short: s.short, start: todayStr, end: plannedEnd, current: true, planned: true, status: '计划中' });
                  } else {
                    const segEnd = futurePlan ? plannedEnd : todayStr;
                    segs.push({ color: s.color, name: s.name, short: s.short, start: segStart || todayStr, end: segEnd, current: true, planned: !started, status: started ? '进行中' : '计划中' });
                  }
                  prevDate = plannedEnd || todayStr;
                } else if (sd.status === 'hold' && (sd.startDate || prevDate)) {
                  const segStart = sd.startDate || prevDate;
                  segs.push({ color: '#9333ea', name: s.name, short: s.short + '⏸', start: segStart, end: sd.endDate || todayStr, status: '已暂停' });
                }
              });
              return (
                <div key={p.id} className="gantt-row">
                  {segs.map((seg, i) => {
                    const l = pct(seg.start);
                    const r = pct(seg.end);
                    const w = r - l;
                    if (w < 0) return null;  // skip inverted/invalid segments
                    const days = Math.round((new Date(seg.end+'T00:00:00') - new Date(seg.start+'T00:00:00')) / 86400000);
                    return (
                      <div key={i}
                        className={"gantt-seg" + (seg.current ? ' current' : '')}
                        style={{
                          left: l + '%',
                          width: w + '%',
                          background: seg.color,
                          opacity: seg.planned ? 0.6 : 1,
                          backgroundImage: seg.planned
                            ? 'repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(255,255,255,0.3) 4px,rgba(255,255,255,0.3) 8px)'
                            : 'none',
                        }}
                        onMouseEnter={e => setTooltip({ name: seg.name, status: seg.status, period: seg.start + ' → ' + seg.end, days, x: e.clientX, y: e.clientY })}
                        onMouseMove={e => setTooltip(t => t ? {...t, x: e.clientX, y: e.clientY} : null)}
                        onMouseLeave={() => setTooltip(null)}>
                        {w > 4 ? seg.short : ''}
                      </div>
                    );
                  })}
                </div>
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

// ===== Calendar Heatmap (macOS style) for a single product =====
function CalendarHeatmap({ product }) {
  const [year, setYear] = React.useState(2026);
  const [zoom, setZoom] = React.useState(1);

  // Build a map of date -> stage events for this product
  const events = {}; // 'YYYY-MM-DD' -> [{stage, color}]
  STAGES.forEach(s => {
    const sd = product.stages[s.key];
    if (!sd) return;
    const end = sd.endDate || sd.doneDate;
    if (end && sd.status === 'done') {
      if (!events[end]) events[end] = [];
      events[end].push({ key: s.key, name: s.name, color: s.color });
    }
    if (sd.startDate && sd.startDate !== end) {
      if (!events[sd.startDate]) events[sd.startDate] = [];
      events[sd.startDate].push({ key: s.key, name: s.name + ' · 开始', color: s.color });
    }
  });

  // Build bridge fills: between consecutive milestones, fill days with a 30% color of next stage
  const milestones = Object.keys(events).sort();
  const bridge = {}; // date -> color
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

  function renderMonth(monthIdx) {
    const first = new Date(year, monthIdx, 1);
    const last = new Date(year, monthIdx + 1, 0);
    const firstDow = (first.getDay() + 6) % 7; // Monday=0
    const daysInMonth = last.getDate();

    // Find dominant color for the month (most events)
    const monthEvents = Object.keys(events).filter(k => k.startsWith(`${year}-${String(monthIdx+1).padStart(2,'0')}`));
    let domColor = 'var(--border)';
    if (monthEvents.length > 0) {
      const counts = {};
      monthEvents.forEach(k => {
        events[k].forEach(e => counts[e.color] = (counts[e.color] || 0) + 1);
      });
      domColor = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
    }

    const cells = [];
    // Day-of-week headers
    dowNames.forEach((d, i) => cells.push(<div key={`h${i}`} className="cal-dow">{d}</div>));
    // Empty leading
    for (let i = 0; i < firstDow; i++) cells.push(<div key={`e${i}`} className="cal-day empty"></div>);
    // Days
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(monthIdx+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const ev = events[dateStr];
      const br = bridge[dateStr];
      const isToday = dateStr === todayDateStr;
      let cls = 'cal-day';
      let style = {};
      if (ev) {
        cls += ' fill';
        style.background = ev[0].color;
      } else if (br) {
        cls += ' bridge';
        style.background = br;
        style.opacity = 0.18;
      }
      if (isToday) cls += ' today';
      cells.push(
        <div key={`d${d}`} className={cls} style={style} title={ev ? ev.map(e=>e.name).join(', ') : dateStr}>
          {d}
          {ev && ev.length > 1 && (
            <div className="cal-day-dots">
              {ev.slice(0,4).map((e,i) => <span key={i} className="d" style={{background: 'rgba(255,255,255,0.9)'}}></span>)}
            </div>
          )}
        </div>
      );
    }
    // Build event count for month header
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

  // stage legend (only stages this product has touched)
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

function ProgressView({ products, focusId, setFocusId }) {
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
          <GanttAll products={[focused]} onSelectProduct={()=>{}} />
          <div style={{height: 18}}></div>
          <CalendarHeatmap product={focused} />
        </>
      )}
    </div>
  );
}

window.ProgressView = ProgressView;
