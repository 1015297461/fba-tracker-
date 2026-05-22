/* eslint-disable no-undef */
// Progress Overview: KPIs + Gantt timeline (all products) + Calendar heatmap (single product)

function ProgressKPIs({ products }) {
  const total = products.length;
  const active = products.filter(p => p.status === 'active').length;
  const done = products.filter(p => p.status === 'done').length;
  const hold = products.filter(p => p.status === 'hold').length;
  const monthDone = 2;
  const due30 = 4;
  const overdue = 1;

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

// Convert a YYYY-MM-DD to month-fractional position within a range
function dPos(dateStr, start, end) {
  const d = new Date(dateStr + 'T00:00:00').getTime();
  const s = start.getTime();
  const e = end.getTime();
  return Math.max(0, Math.min(100, (d - s) / (e - s) * 100));
}

function GanttAll({ products, onSelectProduct }) {
  const [zoom, setZoom] = React.useState('month');
  const start = new Date('2025-09-01T00:00:00');
  const end = new Date('2026-08-01T00:00:00');
  const months = [];
  let cur = new Date(start);
  while (cur < end) {
    months.push({ y: cur.getFullYear(), m: cur.getMonth() });
    cur.setMonth(cur.getMonth() + 1);
  }
  const today = new Date('2026-05-22T00:00:00');
  const todayPos = dPos('2026-05-22', start, end);

  return (
    <div className="gantt-wrap">
      <div className="gantt-hdr">
        <span className="gantt-title">全部产品时间线</span>
        <span style={{color:'var(--ink-4)', fontSize:11}}>{products.length} 个产品 · {start.toISOString().slice(0,7)} → {end.toISOString().slice(0,7)}</span>
        <div className="gantt-zoom">
          {['week','month','quarter'].map(z => (
            <button key={z} data-active={zoom === z} onClick={() => setZoom(z)}>
              {z === 'week' ? '周' : z === 'month' ? '月' : '季'}
            </button>
          ))}
          <button>📍 今天</button>
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
            <div className="gantt-axis">
              {months.map((m, i) => (
                <div key={i} className="gantt-month">
                  {['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][m.m]} {String(m.y).slice(2)}
                </div>
              ))}
            </div>
            {products.map(p => {
              // Build segments from stages with endDate (status===done) or active stages
              const segs = [];
              let prevDate = p.createdAt;
              STAGES.forEach(s => {
                const sd = p.stages[s.key];
                if (!sd) return;
                const endDate = sd.endDate || sd.doneDate;
                if (sd.status === 'done' && endDate) {
                  const startDate = sd.startDate || prevDate;
                  segs.push({ key: s.key, color: s.color, name: s.short, start: startDate, end: endDate });
                  prevDate = endDate;
                } else if (sd.status === 'active') {
                  const startDate = sd.startDate || prevDate;
                  segs.push({ key: s.key, color: s.color, name: s.short, start: startDate, end: '2026-05-22', current: true });
                  prevDate = '2026-05-22';
                } else if (sd.status === 'hold' && (sd.startDate || prevDate)) {
                  const startDate = sd.startDate || prevDate;
                  segs.push({ key: s.key, color: '#9333ea', name: s.short + '⏸', start: startDate, end: sd.endDate || '2026-05-22' });
                }
              });
              return (
                <div key={p.id} className="gantt-row">
                  {segs.map((seg, i) => {
                    const l = dPos(seg.start, start, end);
                    const r = dPos(seg.end, start, end);
                    const w = r - l;
                    if (w < 0.5) return null;
                    return (
                      <div key={i} className={"gantt-seg" + (seg.current ? ' current' : '')}
                        style={{
                          left: l + '%',
                          width: w + '%',
                          background: seg.color,
                        }}
                        title={`${seg.name}: ${seg.start} → ${seg.end}`}>
                        {w > 4 ? seg.name : ''}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <div className="gantt-today" style={{left: todayPos + '%'}}></div>
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
      </div>
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

  const today = new Date('2026-05-22T00:00:00');

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
      const isToday = dateStr === '2026-05-22';
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
          <span>今天 (5/22)</span>
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
