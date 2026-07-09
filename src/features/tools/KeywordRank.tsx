import React from 'react';

const AUTH_TOKEN_KEY = 'fba-auth-v1';
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem(AUTH_TOKEN_KEY) || '';
  return t ? { Authorization: 'Bearer ' + t } : {};
}

const MARKETPLACES = [
  { code: 'US', label: '🇺🇸 美国' }, { code: 'UK', label: '🇬🇧 英国' },
  { code: 'DE', label: '🇩🇪 德国' }, { code: 'FR', label: '🇫🇷 法国' },
  { code: 'IT', label: '🇮🇹 意大利' }, { code: 'ES', label: '🇪🇸 西班牙' },
  { code: 'CA', label: '🇨🇦 加拿大' }, { code: 'JP', label: '🇯🇵 日本' },
  { code: 'MX', label: '🇲🇽 墨西哥' }, { code: 'AU', label: '🇦🇺 澳大利亚' },
];
const SCHEDULE_SLOTS = [0, 6, 12, 18];

// 趋势图两条线的颜色：复用全局 --blue/--orange token（而非各写各的十六进制），
// 已用 dataviz 色板校验器在浅色/深色两个 surface 下验证过对比度和色盲安全性。
const COLOR_ORGANIC = 'var(--blue)';
const COLOR_SPONSORED = 'var(--orange)';

// 单调三次样条（Fritsch–Carlson 方法）：把一串点连成平滑曲线，但曲线在每个数据点上
// 严格过点、且相邻两点之间绝不会“过冲”到局部最大/最小值之外——比直接三次/Catmull-Rom
// 样条更保守，但对排名这种“差一名都算数”的数据更诚实，不会画出实际没出现过的极值。
function monotonePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;

  const dx: number[] = [], slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  // 限制切线斜率，避免相邻两点间曲线鼓出到数据范围之外
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) { const t = 3 / h; m[i] = t * a * slope[i]; m[i + 1] = t * b * slope[i]; }
  }

  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const cp1x = pts[i].x + dx[i] / 3, cp1y = pts[i].y + m[i] * dx[i] / 3;
    const cp2x = pts[i + 1].x - dx[i] / 3, cp2y = pts[i + 1].y - m[i + 1] * dx[i] / 3;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

interface RankTask {
  id: string; asin: string; marketplace: string; name: string;
  keywords: string[]; keywordNotes: Record<string, string>;
  schedule: number[]; enabled: boolean;
  createdAt?: string; lastRunAt?: string | null;
}
interface Snapshot {
  id: number; keyword: string; capturedAt: string;
  organicRank: number | null; organicPage: number | null;
  sponsored: { page: number; slot: number }[];
  status: string; error: string | null;
}

// ---- API ----
async function apiGetTasks(): Promise<RankTask[]> {
  const r = await fetch('/api/rank/tasks', { headers: authHeaders() });
  if (!r.ok) throw new Error('加载任务失败');
  return (await r.json()).tasks || [];
}
async function apiSaveTask(t: Partial<RankTask>): Promise<RankTask> {
  const r = await fetch('/api/rank/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(t),
  });
  if (!r.ok) throw new Error('保存失败');
  return (await r.json()).task;
}
async function apiDeleteTask(id: string): Promise<void> {
  await fetch('/api/rank/tasks?id=' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
}
async function apiDeleteKeyword(taskId: string, keyword: string): Promise<void> {
  await fetch(`/api/rank/keyword?taskId=${encodeURIComponent(taskId)}&keyword=${encodeURIComponent(keyword)}`,
    { method: 'DELETE', headers: authHeaders() });
}
async function apiRunTask(taskId: string): Promise<void> {
  const r = await fetch('/api/rank/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ taskId }),
  });
  if (!r.ok) throw new Error('采集失败');
}
async function apiGetHistory(taskId: string): Promise<Snapshot[]> {
  const r = await fetch('/api/rank/history?taskId=' + encodeURIComponent(taskId), { headers: authHeaders() });
  if (!r.ok) throw new Error('加载历史失败');
  return (await r.json()).snapshots || [];
}

// ---- Utilities ----
function fmtDateTime(iso: string): string {
  const m = iso.match(/\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}
function fmtDateFull(iso: string): string {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}
function toDateInput(iso: string): string { return iso.slice(0, 10); }
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function rankColor(r: number | null): string {
  if (r == null) return 'var(--ink-4)';
  if (r <= 10) return 'var(--green, #16a34a)';
  if (r <= 30) return '#d97706';
  return 'var(--red, #dc2626)';
}
function mkLabel(code: string) {
  return (MARKETPLACES.find(m => m.code === code) || { label: code }).label;
}

// Per-keyword computed row
interface KwRow { keyword: string; latest: Snapshot | null; prev: Snapshot | null; last5: Snapshot[]; }

function buildRows(keywords: string[], snapshots: Snapshot[]): KwRow[] {
  const byKw: Record<string, Snapshot[]> = {};
  for (const s of snapshots) (byKw[s.keyword] = byKw[s.keyword] || []).push(s);
  const cut5 = new Date(Date.now() - 5 * 86400000).toISOString();
  return keywords.map(kw => {
    const snaps = (byKw[kw] || []).slice().sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const ok = snaps.filter(s => s.status === 'ok');
    return {
      keyword: kw,
      latest: ok[ok.length - 1] || null,
      prev:   ok[ok.length - 2] || null,
      last5:  snaps.filter(s => s.capturedAt >= cut5),
    };
  });
}

// ---- Sparkline (80×28 SVG) ----
function Sparkline({ snaps }: { snaps: Snapshot[] }) {
  const W = 80, H = 28, PAD = 2;
  const organic  = snaps.map(s => s.organicRank);
  const sponsored = snaps.map(s => s.sponsored?.length ? s.sponsored[0].slot : null);
  const allV = [...organic, ...sponsored].filter((v): v is number => v !== null);
  if (!allV.length) return <span className="kr-spark-empty">—</span>;

  const minV = Math.max(1, Math.min(...allV) - 1);
  const maxV = Math.max(...allV) + 1;
  const n = snaps.length;

  // 单点时居中，多点时按比例分布
  const toX = (i: number) => PAD + (n > 1 ? i / (n - 1) : 0.5) * (W - PAD * 2);
  const toY = (v: number) => PAD + ((v - minV) / (maxV - minV)) * (H - PAD * 2);

  // 同主图表：跳过 null 直接连到下一个有值的点，不在缺口处断线；用平滑曲线代替折线
  function lines(pts: (number | null)[], color: string) {
    const validIdx = pts.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0);
    if (validIdx.length < 2) return null;
    const d = monotonePath(validIdx.map(i => ({ x: toX(i), y: toY(pts[i]!) })));
    return <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />;
  }

  // 始终渲染散点，确保孤立数据点可见
  function dots(pts: (number | null)[], color: string) {
    return pts.map((v, i) => v !== null
      ? <circle key={i} cx={toX(i)} cy={toY(v)} r="2" fill={color} />
      : null);
  }

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      {lines(organic, COLOR_ORGANIC)}
      {lines(sponsored, COLOR_SPONSORED)}
      {dots(organic, COLOR_ORGANIC)}
      {dots(sponsored, COLOR_SPONSORED)}
    </svg>
  );
}

// ---- RankCell ----
function RankCell({ snap, prevSnap, type }: { snap: Snapshot | null; prevSnap: Snapshot | null; type: 'organic' | 'sponsored' }) {
  const getCur = (s: Snapshot | null) => {
    if (!s || s.status !== 'ok') return null;
    return type === 'organic' ? s.organicRank : (s.sponsored?.length ? s.sponsored[0].slot : null);
  };
  const cur = getCur(snap); const pre = getCur(prevSnap);
  const diff = (cur != null && pre != null) ? cur - pre : null;
  const pageInfo = type === 'organic' && snap?.organicPage && cur != null
    ? `第${snap.organicPage}页第${cur}名` : null;

  return (
    <div className="kr-rank-cell">
      <div className="kr-rank-main">
        <span className="kr-rank-num" style={{ color: rankColor(cur) }}>
          {cur ?? '—'}
        </span>
        {diff !== null && diff < 0 && <span className="kr-arrow kr-arrow-up">↑{Math.abs(diff)}</span>}
        {diff !== null && diff > 0 && <span className="kr-arrow kr-arrow-down">↓{diff}</span>}
      </div>
      {pageInfo && <div className="kr-rank-page">{pageInfo}</div>}
    </div>
  );
}

// ---- NotesCell ----
function NotesCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft]     = React.useState(value);
  React.useEffect(() => { setDraft(value); }, [value]);

  if (!editing) return (
    <span className="kr-notes-display" onClick={() => setEditing(true)}>
      {value || <span className="kr-notes-ph">添加备注</span>}
    </span>
  );
  return (
    <input className="kr-notes-input" value={draft} autoFocus
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { onSave(draft); setEditing(false); }}
      onKeyDown={e => {
        if (e.key === 'Enter')  { onSave(draft); setEditing(false); }
        if (e.key === 'Escape') { setDraft(value); setEditing(false); }
      }} />
  );
}

// ---- LineChart (full SVG chart for detail modal) ----
function LineChart({ snaps, showOrganic, showSponsored }: {
  snaps: Snapshot[]; showOrganic: boolean; showSponsored: boolean;
}) {
  type HovInfo = { svgX: number; cx: number; cy: number; snap: Snapshot } | null;
  const [hov, setHov] = React.useState<HovInfo>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const W = 860, H = 380;
  const PAD = { top: 20, right: 20, bottom: 50, left: 52 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const organic   = snaps.map(s => s.organicRank);
  const sponsored = snaps.map(s => s.sponsored?.length ? s.sponsored[0].slot : null);
  const allV = [...organic, ...sponsored].filter((v): v is number => v !== null);

  if (!snaps.length || !allV.length) {
    return <div className="kr-chart-empty">该时间段内暂无数据</div>;
  }

  const yMin = Math.max(0, Math.min(...allV) - 1);
  const yMax = Math.max(...allV) + 1;
  const times = snaps.map(s => new Date(s.capturedAt).getTime());
  const tMin = times[0], tMax = times[times.length - 1];
  const tRange = tMax > tMin ? tMax - tMin : 0;

  // 单点时水平居中，避免落在左边缘
  const toX = (t: number) => tRange === 0
    ? PAD.left + cW / 2
    : PAD.left + ((t - tMin) / tRange) * cW;
  const toY = (v: number) => PAD.top + ((v - yMin) / (yMax - yMin)) * cH;

  // 跳过 null（当天没抓到排名）直接连到下一个有值的点，而不是在缺口处断线——
  // 排名本来就是按 0/6/12/18 档位定时抓取，某一档没抓到（比如那次掉出前3页）
  // 是常态，断线会把"这几天到底涨了跌了"这条最基本的趋势线切得七零八落。
  // 用单调三次样条画平滑曲线代替直线折线，视觉上更顺滑，同时严格过点、不过冲。
  function buildPaths(pts: (number | null)[], color: string) {
    const validIdx = pts.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0);
    if (validIdx.length < 2) return null;
    const d = monotonePath(validIdx.map(i => ({ x: toX(times[i]), y: toY(pts[i]!) })));
    return <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
  }

  // Y labels
  const yStep = (yMax - yMin) <= 10 ? 1 : (yMax - yMin) <= 20 ? 2 : 5;
  const yLabels: number[] = [];
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) yLabels.push(v);

  // X labels
  const xLabels: { t: number; label: string }[] = [];
  if (tRange === 0) {
    // 单点：直接显示该时间点
    const d = new Date(tMin);
    xLabels.push({
      t: tMin,
      label: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`,
    });
  } else {
    const rangeDays = tRange / 86400000;
    const xStep = rangeDays <= 3 ? 6 * 3600000 : rangeDays <= 14 ? 86400000 : 3 * 86400000;
    for (let t = Math.ceil(tMin / xStep) * xStep; t <= tMax; t += xStep) {
      const d = new Date(t);
      const label = rangeDays <= 3
        ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      xLabels.push({ t, label });
    }
  }

  function onMouseMove(e: React.MouseEvent<SVGRectElement>) {
    if (!svgRef.current || !wrapRef.current) return;
    const sr = svgRef.current.getBoundingClientRect();
    const scale = W / sr.width;
    const mx = (e.clientX - sr.left) * scale;
    const t = tMin + ((mx - PAD.left) / cW) * tRange;
    let best = snaps[0], bd = Infinity;
    for (const s of snaps) {
      const d = Math.abs(new Date(s.capturedAt).getTime() - t);
      if (d < bd) { bd = d; best = s; }
    }
    const wr = wrapRef.current.getBoundingClientRect();
    setHov({ svgX: toX(new Date(best.capturedAt).getTime()), cx: e.clientX - wr.left, cy: e.clientY - wr.top, snap: best });
  }

  const sp = hov?.snap.sponsored?.length ? hov.snap.sponsored[0].slot : null;
  const tipW = 210;
  const tipLeft = hov ? (hov.cx + tipW + 20 > (wrapRef.current?.clientWidth || 800) ? hov.cx - tipW - 10 : hov.cx + 15) : 0;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', flex: 1, minHeight: 0 }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%', display: 'block' }}>
        {/* grid */}
        {yLabels.map(v => (
          <line key={v} x1={PAD.left} y1={toY(v)} x2={W - PAD.right} y2={toY(v)}
            stroke="var(--border)" strokeWidth="1" />
        ))}
        {/* y labels */}
        {yLabels.map(v => (
          <text key={v} x={PAD.left - 6} y={toY(v)} textAnchor="end"
            dominantBaseline="middle" fontSize="11" fill="var(--ink-3)">{v}</text>
        ))}
        {/* x labels */}
        {xLabels.map(({ t, label }) => (
          <text key={t} x={toX(t)} y={H - PAD.bottom + 16} textAnchor="middle"
            fontSize="10" fill="var(--ink-3)">{label}</text>
        ))}
        {/* x axis line */}
        <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom}
          stroke="var(--border)" strokeWidth="1" />
        {/* organic line + dots */}
        {showOrganic && buildPaths(organic, COLOR_ORGANIC)}
        {showOrganic && snaps.map((s, i) => s.organicRank != null && (
          <circle key={i} cx={toX(times[i])} cy={toY(s.organicRank)} r="4"
            fill={COLOR_ORGANIC} stroke="var(--card-bg)" strokeWidth="2" />
        ))}
        {/* sponsored line + dots */}
        {showSponsored && buildPaths(sponsored, COLOR_SPONSORED)}
        {showSponsored && snaps.map((s, i) => {
          const v = s.sponsored?.length ? s.sponsored[0].slot : null;
          return v != null ? (
            <circle key={i} cx={toX(times[i])} cy={toY(v)} r="4"
              fill={COLOR_SPONSORED} stroke="var(--card-bg)" strokeWidth="2" />
          ) : null;
        })}
        {/* crosshair */}
        {hov && (
          <line x1={hov.svgX} y1={PAD.top} x2={hov.svgX} y2={H - PAD.bottom}
            stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="4,3" pointerEvents="none" />
        )}
        {/* mouse overlay */}
        <rect x={PAD.left} y={PAD.top} width={cW} height={cH} fill="transparent"
          style={{ cursor: 'crosshair' }} onMouseMove={onMouseMove} onMouseLeave={() => setHov(null)} />
      </svg>

      {/* HTML tooltip */}
      {hov && (
        <div className="kr-chart-tooltip" style={{ left: tipLeft, top: Math.max(8, hov.cy - 60) }}>
          <div className="kr-tip-time">{fmtDateFull(hov.snap.capturedAt)}</div>
          {showOrganic && (
            <div className="kr-tip-row">
              <span className="kr-tip-dot" style={{ background: COLOR_ORGANIC }} />
              <span className="kr-tip-label">自然排名</span>
              <span className="kr-tip-val">
                {hov.snap.organicRank ?? '—'}
                {hov.snap.organicRank != null && hov.snap.organicPage
                  ? ` (第${hov.snap.organicPage}页第${hov.snap.organicRank}名)` : ''}
              </span>
            </div>
          )}
          {showSponsored && (
            <div className="kr-tip-row">
              <span className="kr-tip-dot" style={{ background: COLOR_SPONSORED }} />
              <span className="kr-tip-label">广告排名</span>
              <span className="kr-tip-val">{sp ?? '—'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- TrendModal (detail popup) ----
function TrendModal({ task, initialKw, snapshots, onClose }: {
  task: RankTask; initialKw: string; snapshots: Snapshot[]; onClose: () => void;
}) {
  const [kw, setKw]               = React.useState(initialKw);
  const [showOrg, setShowOrg]     = React.useState(true);
  const [showSp, setShowSp]       = React.useState(true);
  const [start, setStart]         = React.useState(daysAgo(7));
  const [end, setEnd]             = React.useState(toDateInput(new Date().toISOString()));

  const filtered = React.useMemo(() => {
    const s0 = start + 'T00:00:00', s1 = end + 'T23:59:59';
    return snapshots
      .filter(s => s.keyword === kw && s.capturedAt >= s0 && s.capturedAt <= s1)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }, [snapshots, kw, start, end]);

  function preset(d: number) {
    setStart(daysAgo(d));
    setEnd(toDateInput(new Date().toISOString()));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="kr-trend-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="kr-trend-hdr">
          <span className="kr-trend-title">关键词趋势图</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Controls */}
        <div className="kr-trend-controls">
          <select className="kr-trend-kw-sel" value={kw} onChange={e => setKw(e.target.value)}>
            {task.keywords.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          <div className="kr-date-range">
            <input type="date" value={start} max={end} onChange={e => setStart(e.target.value)} />
            <span className="kr-date-sep">–</span>
            <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} />
          </div>
          <div className="kr-presets">
            {[7, 14, 30].map(d => (
              <button key={d} className="btn btn-sm" onClick={() => preset(d)}>近{d}天</button>
            ))}
          </div>
        </div>

        {/* Legend toggles */}
        <div className="kr-legend-row">
          <button className="kr-legend-btn organic" data-active={showOrg} onClick={() => setShowOrg(v => !v)}>
            <span className="kr-leg-dot" style={{ background: COLOR_ORGANIC }} />自然排名
          </button>
          <button className="kr-legend-btn sponsored" data-active={showSp} onClick={() => setShowSp(v => !v)}>
            <span className="kr-leg-dot" style={{ background: COLOR_SPONSORED }} />广告排名
          </button>
        </div>

        {/* Chart */}
        <div className="kr-chart-area">
          <LineChart snaps={filtered} showOrganic={showOrg} showSponsored={showSp} />
        </div>

        {/* Footer */}
        <div className="kr-chart-footer">
          系统只获取前3页排名记录，第3页之后的排名无法获取到
        </div>
      </div>
    </div>
  );
}

// ---- TaskModal (create / edit) ----
function TaskModal({ task, onClose, onSaved }: {
  task: RankTask | null; onClose: () => void; onSaved: (t: RankTask) => void;
}) {
  const [name, setName]           = React.useState(task?.name || '');
  const [asin, setAsin]           = React.useState(task?.asin || '');
  const [marketplace, setMkt]     = React.useState(task?.marketplace || 'US');
  const [kwText, setKwText]       = React.useState((task?.keywords || []).join('\n'));
  const [schedule, setSchedule]   = React.useState<number[]>(task?.schedule || [...SCHEDULE_SLOTS]);
  const [enabled, setEnabled]     = React.useState(task?.enabled ?? true);
  const [saving, setSaving]       = React.useState(false);
  const [err, setErr]             = React.useState('');

  function toggleSlot(h: number) {
    setSchedule(s => s.includes(h) ? s.filter(x => x !== h) : [...s, h].sort((a, b) => a - b));
  }
  async function save() {
    const keywords = kwText.split('\n').map(s => s.trim()).filter(Boolean);
    if (!asin.trim()) { setErr('请填写 ASIN'); return; }
    if (!keywords.length) { setErr('请至少填写一个关键词'); return; }
    setSaving(true); setErr('');
    try {
      const saved = await apiSaveTask({
        id: task?.id, name: name.trim(), asin: asin.trim().toUpperCase(),
        marketplace, keywords, keywordNotes: task?.keywordNotes || {}, schedule, enabled,
      });
      onSaved(saved);
    } catch (e: any) { setErr(e.message || '保存失败'); setSaving(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal kr-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">
          <span className="modal-title">{task ? '编辑监控任务' : '新建监控任务'}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="kr-form">
          <label>任务名称<input value={name} onChange={e => setName(e.target.value)} placeholder="如：瑜伽垫主推" /></label>
          <div className="kr-form-row">
            <label>ASIN<input value={asin} onChange={e => setAsin(e.target.value)} placeholder="B0XXXXXXXX" maxLength={10} /></label>
            <label>站点
              <select value={marketplace} onChange={e => setMkt(e.target.value)}>
                {MARKETPLACES.map(m => <option key={m.code} value={m.code}>{m.label}</option>)}
              </select>
            </label>
          </div>
          <label>关键词（每行一个）
            <textarea value={kwText} onChange={e => setKwText(e.target.value)} rows={5}
              placeholder={'yoga mat\nexercise mat\nnon slip yoga mat'} />
          </label>
          <div className="kr-field">
            <span className="kr-field-label">定时档位（每天）</span>
            <div className="kr-slots">
              {SCHEDULE_SLOTS.map(h => (
                <button key={h} type="button" className="kr-slot"
                  data-on={schedule.includes(h)} onClick={() => toggleSlot(h)}>
                  {String(h).padStart(2, '0')}:00
                </button>
              ))}
            </div>
          </div>
          <label className="kr-check">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            <span>启用定时采集</span>
          </label>
          {err && <div className="kr-err">{err}</div>}
        </div>
        <div className="kr-modal-actions">
          <button className="btn btn-sm" onClick={onClose}>取消</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Main View ----
export function KeywordRank() {
  const [tasks, setTasks]   = React.useState<RankTask[]>([]);
  const [activeId, setAId]  = React.useState<string | null>(null);
  const [snaps, setSnaps]   = React.useState<Snapshot[]>([]);
  const [modal, setModal]   = React.useState<{ open: boolean; task: RankTask | null }>({ open: false, task: null });
  const [detail, setDetail] = React.useState<{ kw: string } | null>(null);
  const [running, setRun]   = React.useState(false);
  const [loadErr, setErr]   = React.useState('');

  const active = tasks.find(t => t.id === activeId) || null;
  const rows   = active ? buildRows(active.keywords, snaps) : [];

  async function reloadTasks(sel?: string) {
    try {
      const list = await apiGetTasks(); setTasks(list); setErr('');
      setAId(sel || activeId || (list[0]?.id ?? null));
    } catch (e: any) { setErr(e.message || '加载失败'); }
  }
  async function reloadSnaps(id: string) {
    try { setSnaps(await apiGetHistory(id)); } catch { setSnaps([]); }
  }

  React.useEffect(() => { reloadTasks(); }, []);
  React.useEffect(() => { if (activeId) reloadSnaps(activeId); else setSnaps([]); }, [activeId]);

  async function runNow() {
    if (!active) return;
    setRun(true);
    try { await apiRunTask(active.id); await reloadSnaps(active.id); await reloadTasks(active.id); }
    finally { setRun(false); }
  }
  async function removeTask(t: RankTask) {
    if (!confirm(`删除任务「${t.name || t.asin}」及所有历史数据？`)) return;
    await apiDeleteTask(t.id);
    const rest = tasks.filter(x => x.id !== t.id);
    setTasks(rest); setAId(rest[0]?.id ?? null);
  }
  async function removeKeyword(kw: string) {
    if (!active || !confirm(`从任务中移除关键词「${kw}」及其历史数据？`)) return;
    await apiDeleteKeyword(active.id, kw);
    await reloadTasks(active.id);
    await reloadSnaps(active.id);
  }
  async function saveNote(kw: string, note: string) {
    if (!active) return;
    const updated = await apiSaveTask({ ...active, keywordNotes: { ...active.keywordNotes, [kw]: note } });
    setTasks(ts => ts.map(t => t.id === updated.id ? updated : t));
  }

  return (
    <div className="kr-root">
      {/* Left: task list */}
      <div className="kr-list">
        <div className="kr-list-head">
          <span>监控任务</span>
          <button className="btn btn-primary btn-sm" onClick={() => setModal({ open: true, task: null })}>+ 新建</button>
        </div>
        {loadErr && <div className="kr-err">{loadErr}</div>}
        {!tasks.length && !loadErr && <div className="kr-empty">还没有监控任务</div>}
        {tasks.map(t => (
          <button key={t.id} className="kr-task" data-active={t.id === activeId} onClick={() => setAId(t.id)}>
            <div className="kr-task-top">
              <span className="kr-task-name">{t.name || t.asin}</span>
              {!t.enabled && <span className="kr-task-off">停</span>}
            </div>
            <div className="kr-task-sub">
              <span>{mkLabel(t.marketplace)}</span>
              <span className="kr-asin">{t.asin}</span>
              <span>· {t.keywords.length} 词</span>
            </div>
          </button>
        ))}
      </div>

      {/* Right: keyword table */}
      <div className="kr-detail">
        {!active ? (
          <div className="kr-empty kr-empty-lg">选择左侧任务查看关键词排名</div>
        ) : (
          <>
            {/* Detail head */}
            <div className="kr-detail-head">
              <div>
                <div className="kr-detail-title">{active.name || active.asin}</div>
                <div className="kr-detail-meta">
                  {mkLabel(active.marketplace)} · ASIN {active.asin}
                  · 定时 {active.schedule.map(h => String(h).padStart(2, '0') + ':00').join(' / ') || '无'}
                  {active.lastRunAt && <> · 上次采集 {fmtDateTime(active.lastRunAt)}</>}
                </div>
              </div>
              <div className="kr-detail-actions">
                <button className="btn btn-sm" onClick={() => setModal({ open: true, task: active })}>编辑</button>
                <button className="btn btn-sm kr-del" onClick={() => removeTask(active)}>删除任务</button>
                <button className="btn btn-primary btn-sm" onClick={runNow} disabled={running}>
                  {running ? '采集中…' : '⟳ 立即采集'}
                </button>
              </div>
            </div>

            {/* Keyword table */}
            {!rows.length ? (
              <div className="kr-empty" style={{ padding: '24px' }}>暂无关键词，请编辑任务添加。</div>
            ) : (
              <div className="kr-table-wrap">
                <table className="kr-table">
                  <thead>
                    <tr>
                      <th className="kr-col-kw">关键词</th>
                      <th className="kr-col-rank">自然排名</th>
                      <th className="kr-col-rank">广告排名</th>
                      <th className="kr-col-spark">近5天趋势</th>
                      <th className="kr-col-time">更新时间</th>
                      <th className="kr-col-time">开始监控</th>
                      <th className="kr-col-notes">备注</th>
                      <th className="kr-col-ops">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.keyword}>
                        <td className="kr-col-kw">
                          <span className="kr-kw-text" title={row.keyword}>{row.keyword}</span>
                        </td>
                        <td className="kr-col-rank">
                          <RankCell snap={row.latest} prevSnap={row.prev} type="organic" />
                        </td>
                        <td className="kr-col-rank">
                          <RankCell snap={row.latest} prevSnap={row.prev} type="sponsored" />
                        </td>
                        <td className="kr-col-spark">
                          <div className="kr-spark-wrap">
                            <Sparkline snaps={row.last5} />
                          </div>
                        </td>
                        <td className="kr-col-time">
                          {row.latest ? fmtDateTime(row.latest.capturedAt) : '—'}
                        </td>
                        <td className="kr-col-time">
                          {active.createdAt ? fmtDateTime(active.createdAt) : '—'}
                        </td>
                        <td className="kr-col-notes">
                          <NotesCell
                            value={active.keywordNotes?.[row.keyword] || ''}
                            onSave={v => saveNote(row.keyword, v)}
                          />
                        </td>
                        <td className="kr-col-ops">
                          <button className="btn btn-sm"
                            onClick={() => setDetail({ kw: row.keyword })}>详情</button>
                          <button className="btn btn-sm kr-del"
                            onClick={() => removeKeyword(row.keyword)}>删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Task modal */}
      {modal.open && (
        <TaskModal task={modal.task} onClose={() => setModal({ open: false, task: null })}
          onSaved={t => { setModal({ open: false, task: null }); reloadTasks(t.id); }} />
      )}

      {/* Trend detail modal */}
      {detail && active && (
        <TrendModal task={active} initialKw={detail.kw} snapshots={snaps}
          onClose={() => setDetail(null)} />
      )}
    </div>
  );
}
