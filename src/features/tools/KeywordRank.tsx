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
  /** 定时档位 "HH:MM"（后端已归一化，老的整数小时也会转成 "06:00"） */
  schedule: string[]; enabled: boolean;
  /** 定时按哪个时区解释：Asia/Shanghai（默认）/ America/New_York / America/Los_Angeles */
  timezone: string;
  createdAt?: string; lastRunAt?: string | null;
}
interface TzOption { id: string; label: string; short: string }
interface Snapshot {
  id: number; keyword: string; capturedAt: string;
  organicRank: number | null; organicPage: number | null;
  sponsored: { page: number; slot: number }[];
  status: string; error: string | null;
}

// ---- API ----
async function apiGetTasks(): Promise<{ tasks: RankTask[]; timezones: TzOption[] }> {
  const r = await fetch('/api/rank/tasks', { headers: authHeaders() });
  if (!r.ok) throw new Error('加载任务失败');
  const j = await r.json();
  return { tasks: j.tasks || [], timezones: j.timezones || [] };
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
interface QueueItem {
  taskId: string; name: string; keyword: string | null; words: number;
  source: string; submittedAt: string;
}
interface QueueInfo {
  queued?: boolean; duplicate?: boolean;
  waiting: number;
  running: QueueItem | null;
  items: QueueItem[];
}

/** 立即采集 = 入队（后端全局只有一个 worker，串行抓，不会并发撞 Amazon）
 *  ⚠️ 路径是 /api/rank/task-run：/api/rank/run 属于「排名监测」那个模块，
 *  两边同名过、后注册的会覆盖前者（点了报「id 或 value 至少填一个」）。 */
async function apiRunTask(taskId: string, keyword?: string): Promise<QueueInfo> {
  const r = await fetch('/api/rank/task-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(keyword ? { taskId, keyword } : { taskId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || '提交采集失败');
  return j as QueueInfo;
}
async function apiGetQueue(): Promise<QueueInfo> {
  const r = await fetch('/api/rank/queue', { headers: authHeaders() });
  if (!r.ok) return { waiting: 0, running: null, items: [] };
  return await r.json();
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
interface KwRow {
  keyword: string;
  latest: Snapshot | null;      // 最近一次**成功**抓到排名
  prev: Snapshot | null;
  last5: Snapshot[];
  lastAttempt: Snapshot | null; // 最近一次尝试（不管成败）——用来显示「采集失败」
}

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
      lastAttempt: snaps[snaps.length - 1] || null,
    };
  });
}

/** 把采集失败的原因翻成人话（后端存的是 err 代码，_x3 表示换指纹重试 3 次仍失败） */
function failReason(s: Snapshot | null): string {
  if (!s) return '';
  const e = String(s.error || '');
  if (s.status === 'blocked' || e.startsWith('blocked')) {
    return '被 Amazon 拦截（已换指纹重试 3 次），过一会儿再采';
  }
  if (e.startsWith('no_results')) {
    return '搜索页返回空结果（已换指纹重试 3 次仍空，多为反爬临时拦截），过一会儿点「采集」重试';
  }
  if (e.startsWith('http_')) return `HTTP ${e.slice(5)}`;
  if (e.startsWith('neterr')) return '网络错误';
  if (e) return e;
  return s.status === 'ok' ? '' : `状态 ${s.status}`;
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
const FALLBACK_TZ: TzOption[] = [
  { id: 'Asia/Shanghai', label: '中国时间（北京）', short: '中国' },
  { id: 'America/New_York', label: '美国东部时间（纽约）', short: '美东' },
  { id: 'America/Los_Angeles', label: '美国西部时间（洛杉矶）', short: '美西' },
];

function TaskModal({ task, timezones, onClose, onSaved }: {
  task: RankTask | null; timezones: TzOption[];
  onClose: () => void; onSaved: (t: RankTask) => void;
}) {
  const tzList = timezones.length ? timezones : FALLBACK_TZ;
  const [name, setName]           = React.useState(task?.name || '');
  const [asin, setAsin]           = React.useState(task?.asin || '');
  const [marketplace, setMkt]     = React.useState(task?.marketplace || 'US');
  const [kwText, setKwText]       = React.useState((task?.keywords || []).join('\n'));
  const [schedule, setSchedule]   = React.useState<string[]>(
    task?.schedule?.length ? task.schedule : ['00:00', '06:00', '12:00', '18:00']);
  const [timezone, setTimezone]   = React.useState(task?.timezone || 'Asia/Shanghai');
  const [enabled, setEnabled]     = React.useState(task?.enabled ?? true);
  const [saving, setSaving]       = React.useState(false);
  const [err, setErr]             = React.useState('');

  // 时间点编辑：**不要**在 onchange 里排序，也不要拿「值」当 key ——
  // 值一变 key 就变 → React 重建 input → 焦点丢失，表现为「时间根本改不了」。
  // 排序交给后端（db._norm_schedule），前端只保证不丢焦点。
  function setSlotAt(i: number, v: string) {
    setSchedule(s => s.map((x, idx) => (idx === i ? v : x)));
  }
  function removeSlot(i: number) { setSchedule(s => s.filter((_, idx) => idx !== i)); }
  function addSlot() {
    // 默认加一个「下一个整点」，没有就 08:00，用户再改
    const used = new Set(schedule);
    let next = '08:00';
    for (let h = 0; h < 24; h++) {
      const s = `${String(h).padStart(2, '0')}:00`;
      if (!used.has(s)) { next = s; break; }
    }
    setSchedule(s => [...s, next]);     // 追加到末尾，不重排（否则新加的行会跳走）
  }
  /** 快捷档：点一下加入/移除「HH:00」 */
  function toggleHour(h: number) {
    const s = `${String(h).padStart(2, '0')}:00`;
    setSchedule(cur => (cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s]));
  }
  async function save() {
    const keywords = kwText.split('\n').map(s => s.trim()).filter(Boolean);
    // 清掉空/不合法的时间点（time 输入框被清空时值是 ""）
    const slots = schedule.map(s => s.trim()).filter(s => /^\d{2}:\d{2}$/.test(s));
    if (!asin.trim()) { setErr('请填写 ASIN'); return; }
    if (!keywords.length) { setErr('请至少填写一个关键词'); return; }
    if (enabled && !slots.length) { setErr('启用定时采集时至少要有一个时间点'); return; }
    setSaving(true); setErr('');
    try {
      const saved = await apiSaveTask({
        id: task?.id, name: name.trim(), asin: asin.trim().toUpperCase(),
        marketplace, keywords, keywordNotes: task?.keywordNotes || {}, schedule: slots,
        timezone, enabled,
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
            <span className="kr-field-label">定时采集（每天，按下面的时区）</span>
            <div className="kr-schedule">
              {schedule.length === 0 && <span className="kr-muted">还没有时间点</span>}
              {schedule.map((t, i) => (
                // key 只用索引：拿时间值当 key 会在每次输入后重建 input（焦点丢失）
                <span className="kr-time-item" key={i}>
                  <input type="time" value={t} step={60}
                    onChange={e => setSlotAt(i, e.target.value)} />
                  <button type="button" className="kr-time-del" title="删除这个时间点"
                    onClick={() => removeSlot(i)}>✕</button>
                </span>
              ))}
              <button type="button" className="btn btn-sm" onClick={addSlot}>+ 添加时间</button>
            </div>
            <div className="kr-slots kr-slots-quick">
              <span className="kr-muted">快捷：</span>
              {[0, 6, 12, 18].map(h => {
                const s = `${String(h).padStart(2, '0')}:00`;
                return (
                  <button key={h} type="button" className="kr-slot"
                    data-on={schedule.includes(s)} onClick={() => toggleHour(h)}>
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          <label>时区
            <select value={timezone} onChange={e => setTimezone(e.target.value)}>
              {tzList.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <div className="kr-hint">
            例：选「美东」+ 09:00，就是纽约时间每天 9 点采集（＝北京时间 21:00 或 22:00，随夏令时变化）。
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
  const [loadErr, setErr]   = React.useState('');

  const [timezones, setTimezones] = React.useState<TzOption[]>([]);
  // 采集队列（后端全局串行）：用来显示「排队中 / 正在采集」和自动刷新
  const [queue, setQueue] = React.useState<QueueInfo>({ waiting: 0, running: null, items: [] });
  const [runMsg, setRunMsg] = React.useState('');
  const activeRef = React.useRef<string | null>(null);

  const active = tasks.find(t => t.id === activeId) || null;
  const rows   = active ? buildRows(active.keywords, snaps) : [];
  const tzShort = (id?: string) =>
    (timezones.find(t => t.id === (id || 'Asia/Shanghai'))?.short || '中国');

  /** 这个任务（或它的某个词）是否已在队列/正在跑 */
  const inQueue = (taskId: string, kw?: string) => {
    const match = (j: QueueItem | null) => !!j && j.taskId === taskId
      && (!kw || !j.keyword || j.keyword === kw);   // keyword=null 表示整任务，包含所有词
    if (match(queue.running)) return true;
    return queue.items.some(j => match(j));
  };
  const taskBusy = (taskId: string) => inQueue(taskId);
  const queueLen = queue.waiting + (queue.running ? 1 : 0);

  async function reloadTasks(sel?: string) {
    try {
      const { tasks: list, timezones: tzs } = await apiGetTasks();
      setTasks(list); setTimezones(tzs); setErr('');
      setAId(sel || activeId || (list[0]?.id ?? null));
    } catch (e: any) { setErr(e.message || '加载失败'); }
  }
  async function reloadSnaps(id: string) {
    try { setSnaps(await apiGetHistory(id)); } catch { setSnaps([]); }
  }
  async function refreshQueue() {
    try { setQueue(await apiGetQueue()); } catch { /* 忽略瞬时失败 */ }
  }

  React.useEffect(() => { reloadTasks(); }, []);
  React.useEffect(() => { if (activeId) reloadSnaps(activeId); else setSnaps([]); }, [activeId]);
  React.useEffect(() => { activeRef.current = activeId; }, [activeId]);

  // 队列轮询：有任务在跑时 3 秒一次，空闲时 12 秒一次
  React.useEffect(() => {
    refreshQueue();
    const id = window.setInterval(refreshQueue, queueLen > 0 ? 3000 : 12000);
    return () => window.clearInterval(id);
  }, [queueLen > 0]);

  // 队列从「有」变成「空」→ 说明刚跑完，刷新当前任务的数据
  const prevLen = React.useRef(0);
  React.useEffect(() => {
    if (prevLen.current > 0 && queueLen === 0) {
      const id = activeRef.current;
      if (id) { reloadSnaps(id); reloadTasks(id); }
      setRunMsg(m => (m ? '采集完成' : m));
      window.setTimeout(() => setRunMsg(''), 4000);
    }
    prevLen.current = queueLen;
  }, [queueLen]);

  const queueTip = (r: QueueInfo) =>
    r.duplicate ? '这个已经在队列里了'
      : `已排队${r.waiting > 0 ? `（前面还有 ${r.waiting} 个）` : ''}，跑完自动刷新`;

  /** 立即采集整个任务：入队即可，不用等（后端串行执行） */
  async function runNow() {
    if (!active) return;
    try { setRunMsg(queueTip(await apiRunTask(active.id))); await refreshQueue(); }
    catch (e: any) { setRunMsg(e.message || '提交失败'); }
  }
  /** 只采一个词（表格每行的「采集」按钮） */
  async function runOne(kw: string) {
    if (!active) return;
    try { setRunMsg(queueTip(await apiRunTask(active.id, kw))); await refreshQueue(); }
    catch (e: any) { setRunMsg(e.message || '提交失败'); }
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
                  · 定时 <b>{tzShort(active.timezone)}</b> {active.schedule.join(' / ') || '无'}
                  {active.lastRunAt && <> · 上次采集 {fmtDateTime(active.lastRunAt)}</>}
                </div>
                {/* 采集队列：所有采集（定时 + 手动）串行，这里显示进度 */}
                {(queueLen > 0 || runMsg) && (
                  <div className="kr-queue-bar">
                    {queue.running && (
                      <span>正在采集「{queue.running.name}」
                        {queue.running.keyword ? ` · ${queue.running.keyword}` : ` · ${queue.running.words} 词`}
                      </span>
                    )}
                    {queue.waiting > 0 && (
                      <span className="kr-queue-wait">还有 {queue.waiting} 个在排队</span>
                    )}
                    {runMsg && <span className="kr-queue-msg">{runMsg}</span>}
                  </div>
                )}
              </div>
              <div className="kr-detail-actions">
                <button className="btn btn-sm" onClick={() => setModal({ open: true, task: active })}>编辑</button>
                <button className="btn btn-sm kr-del" onClick={() => removeTask(active)}>删除任务</button>
                <button className="btn btn-primary btn-sm" onClick={runNow}
                  disabled={taskBusy(active.id)}>
                  {taskBusy(active.id) ? '排队中…' : '⟳ 立即采集'}
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
                          {row.lastAttempt && row.lastAttempt.status !== 'ok'
                            && (!row.latest || row.lastAttempt.capturedAt > row.latest.capturedAt) && (
                            <span className="kr-fail"
                              title={`最近一次采集（${fmtDateTime(row.lastAttempt.capturedAt)}）失败：${failReason(row.lastAttempt)}`}>
                              最近一次失败
                            </span>
                          )}
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
                          <button className="btn btn-sm" disabled={inQueue(active.id, row.keyword)}
                            title="只采集这一个关键词（后端串行执行，不会和别的采集撞车）"
                            onClick={() => runOne(row.keyword)}>
                            {inQueue(active.id, row.keyword) ? '排队中…' : '采集'}
                          </button>
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
        <TaskModal task={modal.task} timezones={timezones}
          onClose={() => setModal({ open: false, task: null })}
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
