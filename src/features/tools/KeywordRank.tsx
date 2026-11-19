import React from 'react';
import { createPortal } from 'react-dom';
import { DateCalendar } from './DateCalendar';
import {
  TIME_MIN, TIME_MAX, TIME_WINDOW_HINT, PRESET_TIMES, QUICK_HOURS,
  inTimeWindow, clampTime, firstOutOfWindow,
} from './timeWindow';

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

/** SIF ABA 周趋势（全部来自本地缓存，零额度消耗） */
interface KwTrend {
  dates: string[]; volumes: (number | null)[]; ranks: (number | null)[];
  clickShares: (number | null)[]; conversionShares: (number | null)[];
  latest: { date?: string; volume?: number; rank?: number; top_asins?: string[] };
  latestDate?: string | null; fetchedAt?: string | null;
  rankLast?: number | null; rankPrev?: number | null;
  rankRecent?: (number | null)[]; volumeLast?: number | null;
}
interface Snapshot {
  id: number; keyword: string; capturedAt: string;
  organicRank: number | null; organicPage: number | null;
  sponsored: { page: number; slot: number }[];
  status: string; error: string | null;
  /** 这次一共扫了多少个自然位（status=not_ranked 时用来说明「扫完 N 位没找到」） */
  organicScanned?: number | null;
  /** http = HTTP 直出；cdp = 被拦后浏览器兜底成功；cdp_failed = 兜底也失败 */
  via?: string | null;
}

/**
 * 这次采集有没有得出「有效结论」。
 *
 * 三种结果必须分开（原来都塞进 not_found 一个值，用户看不出是网络问题还是排名掉了）：
 *   · ok         找到了排名
 *   · not_ranked 页面正常、也解析到商品，只是前几页里没有这个 ASIN（**有效结论**）
 *   · 其余       failed / blocked / error —— 页面没抓到，属于**采集失败**
 * 老数据里 not_found + error 为空，等价于 not_ranked（早期版本没区分）。
 */
function isSuccessLike(s: Snapshot | null | undefined): boolean {
  if (!s) return false;
  if (s.status === 'ok' || s.status === 'not_ranked') return true;
  return s.status === 'not_found' && !s.error;
}
function isRealFailure(s: Snapshot | null | undefined): boolean {
  return !!s && !isSuccessLike(s);
}

// ---- API ----
async function apiKeywordTrendBatch(keywords: string[], country = 'US'):
  Promise<{ trends: Record<string, KwTrend>; missing: string[] }> {
  const r = await fetch(`/api/rank/keyword-trend-batch?keywords=${encodeURIComponent(keywords.join(','))}`
    + `&country=${encodeURIComponent(country)}&weeks=104`, { headers: authHeaders() });
  if (!r.ok) throw new Error('ABA 趋势加载失败');
  const j = await r.json();
  return { trends: j.trends || {}, missing: j.missing || [] };
}

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
  /** 风控冷却剩余秒数（>0 = 自动采集被暂停，手动仍可点） */
  cooldown?: number;
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
  latest: Snapshot | null;      // 最近一次**拿到排名**
  prev: Snapshot | null;
  last5: Snapshot[];
  lastResult: Snapshot | null;  // 最近一次**有效结论**（拿到排名 / 扫完没找到）
  lastAttempt: Snapshot | null; // 最近一次尝试（含失败）
}

function buildRows(keywords: string[], snapshots: Snapshot[]): KwRow[] {
  const byKw: Record<string, Snapshot[]> = {};
  for (const s of snapshots) (byKw[s.keyword] = byKw[s.keyword] || []).push(s);
  const cut5 = new Date(Date.now() - 5 * 86400000).toISOString();
  return keywords.map(kw => {
    const snaps = (byKw[kw] || []).slice().sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const ok = snaps.filter(s => s.status === 'ok');
    const valid = snaps.filter(isSuccessLike);
    return {
      keyword: kw,
      latest: ok[ok.length - 1] || null,
      prev:   ok[ok.length - 2] || null,
      last5:  snaps.filter(s => s.capturedAt >= cut5),
      lastResult: valid[valid.length - 1] || null,
      lastAttempt: snaps[snaps.length - 1] || null,
    };
  });
}

/** 采集失败的具体原因（短标签，直接显示在单元格里） */
function failShort(s: Snapshot | null): string {
  if (!s) return '';
  const e = String(s.error || '');
  if (e.startsWith('no_results')) return '页面没返回商品列表';
  if (s.status === 'blocked' || e.startsWith('blocked')) return '被 Amazon 拦截';
  if (e.startsWith('neterr')) return '网络请求失败';
  if (e.startsWith('http_')) return `HTTP ${e.slice(5)}`;
  if (e === 'fetch_exc' || s.status === 'error') return '抓取出错';
  return '采集失败';
}

/** 悬停时的完整说明 */
function failReason(s: Snapshot | null): string {
  if (!s) return '';
  const e = String(s.error || '');
  if (e.startsWith('no_results')) {
    return '页面打开了，但里面没有商品列表（多为 Amazon 反爬临时拦截）。'
         + '已自动换指纹重试 3 次仍空，过一会儿再采一次通常就好。';
  }
  if (s.status === 'blocked' || e.startsWith('blocked')) {
    return '被 Amazon 验证码/风控拦住，页面没有正常打开。已换指纹重试 3 次，建议过几小时再采。';
  }
  if (e.startsWith('neterr')) {
    return `网络请求失败（${e.slice(7)}），检查本机网络或代理后重试。`;
  }
  if (e.startsWith('http_')) {
    return `Amazon 返回 HTTP ${e.slice(5)}。5xx 多为临时故障，4xx 需检查站点/关键词。`;
  }
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
  // 页面正常抓到了、但前几页没有这个 ASIN —— 这是结论，不是「没数据」
  const scanned = snap?.organicScanned;
  const noRank = !!snap && isSuccessLike(snap) && cur == null && type === 'organic';

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
      {!pageInfo && noRank && (
        <div className="kr-rank-page kr-rank-none"
          title={scanned ? `扫完 ${scanned} 个自然位都没有这个 ASIN（页面本身是正常的）`
                         : '前 3 页没有找到这个 ASIN（页面本身是正常的）'}>
          前3页未找到
        </div>
      )}
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
  const [start, setStart]         = React.useState(daysAgo(6));   // 含今天共 7 天
  const [end, setEnd]             = React.useState(toDateInput(new Date().toISOString()));

  const filtered = React.useMemo(() => {
    const s0 = start + 'T00:00:00', s1 = end + 'T23:59:59';
    return snapshots
      .filter(s => s.keyword === kw && s.capturedAt >= s0 && s.capturedAt <= s1)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }, [snapshots, kw, start, end]);

  /** 这个词一共有多少天数据 —— 快捷档位超过它就没有意义（点了看着像没反应） */
  const dataDays = React.useMemo(() => {
    const set = new Set(snapshots.filter(s => s.keyword === kw).map(s => s.capturedAt.slice(0, 10)));
    return set.size;
  }, [snapshots, kw]);

  function preset(d: number) {
    // ⚠️ 要减 1：daysAgo(7) 是 7 天前那一天，算上今天共 8 天。
    // 原来写 daysAgo(7)，在「数据刚好 8 天」时等于全部，用户点「近7天」看不出任何变化。
    setStart(daysAgo(d - 1));
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
              <button key={d} className="btn btn-sm" onClick={() => preset(d)}
                disabled={dataDays > 0 && d > dataDays}
                title={dataDays > 0 && d > dataDays
                  ? `这个词只有 ${dataDays} 天数据，选它会显示全部`
                  : `显示最近 ${d} 天`}>
                近{d}天
              </button>
            ))}
            {dataDays > 0 && (
              <span className="kr-muted" style={{ alignSelf: 'center' }}>
                共 {dataDays} 天数据
              </span>
            )}
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
    // 默认档位必须在 08:30~21:00 内（凌晨是本机网络故障窗口），见 timeWindow.ts
    task?.schedule?.length ? task.schedule : ['09:00', '15:00', '20:00']);
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
    // 默认给窗口内第一个没用过的整点（08:30~21:00，越界时段禁止）
    const used = new Set(schedule);
    let next = TIME_MIN;
    for (const h of QUICK_HOURS) {
      const s = `${String(h).padStart(2, '0')}:00`;
      if (!used.has(s)) { next = s; break; }
    }
    if (used.has(next)) next = TIME_MIN;
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
    const bad = firstOutOfWindow(slots);
    if (bad) { setErr(`${bad} 超出允许时段。${TIME_WINDOW_HINT}`); return; }
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
                    min={TIME_MIN} max={TIME_MAX}
                    data-invalid={!!t && !inTimeWindow(t)}
                    title={TIME_WINDOW_HINT}
                    onChange={e => setSlotAt(i, e.target.value)} />
                  <button type="button" className="kr-time-del" title="删除这个时间点"
                    onClick={() => removeSlot(i)}>✕</button>
                </span>
              ))}
              <button type="button" className="btn btn-sm" onClick={addSlot}>+ 添加时间</button>
            </div>
            <div className="kr-slots kr-slots-quick">
              <span className="kr-muted">快捷：</span>
              {QUICK_HOURS.map(h => {
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

// ---- ABA 趋势：缩略图 + 完整弹窗 ----
const TREND_W = 620, TREND_H = 120, TREND_PAD = 8;

type Peer = { label: string; values: (number | null)[]; format: (v: number) => string };

const F_INT = (v: number) => (v == null ? '—' : `#${Math.round(v).toLocaleString()}`);
const F_NUM = (v: number) => (v == null ? '—' : Math.round(v).toLocaleString());
const F_PCT = (v: number) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

/** 通用折线：小值画在上方（ABA 排名数字越小越靠前）；悬浮显示该周全部指标 */
function TrendLine({ values, dates, color, label, format, invert = false, peers = [] }: {
  values: (number | null)[]; dates?: string[]; color: string; label: string;
  format: (v: number) => string; invert?: boolean; peers?: Peer[];
}) {
  const [hi, setHi] = React.useState<number | null>(null);
  const pts = values.map((v, i) => ({ v, i })).filter(x => x.v != null) as { v: number; i: number }[];
  if (pts.length < 2) return <div className="kr-tl-empty">{label}：该区间数据不足</div>;
  const vs = pts.map(x => x.v);
  const min = Math.min(...vs), max = Math.max(...vs), span = Math.max(1e-9, max - min);
  const toX = (i: number) => TREND_PAD + (i / Math.max(1, values.length - 1)) * (TREND_W - TREND_PAD * 2);
  const toY = (v: number) => TREND_PAD +
    ((invert ? (max - v) : (v - min)) / span) * (TREND_H - TREND_PAD * 2);
  const d = pts.map((x, k) => `${k ? 'L' : 'M'}${toX(x.i).toFixed(1)},${toY(x.v).toFixed(1)}`).join(' ');
  const first = pts[0], last = pts[pts.length - 1];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * TREND_W;
    const i = Math.round(((x - TREND_PAD) / (TREND_W - TREND_PAD * 2)) * (values.length - 1));
    setHi(Math.max(0, Math.min(values.length - 1, i)));
  };
  const hoverVal = hi != null ? values[hi] : null;
  const prevVal = hi != null && hi > 0 ? values[hi - 1] : null;
  const delta = (hoverVal != null && prevVal != null) ? hoverVal - prevVal : null;

  return (
    <div className="kr-tl">
      <div className="kr-tl-head"><span>{label}</span>
        <span className="kr-tl-cur" style={{ color }}>
          {hi != null && hoverVal != null ? format(hoverVal) : format(last.v)}
        </span></div>
      <div className="kr-tl-canvas">
        <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} width="100%" height={TREND_H}
          preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
          <path d={d} fill="none" stroke={color} strokeWidth="1.6"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {hi != null && hoverVal != null &&
            <line x1={toX(hi)} x2={toX(hi)} y1={0} y2={TREND_H}
              stroke="var(--ink-4)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
          {hi != null && hoverVal != null &&
            <circle cx={toX(hi)} cy={toY(hoverVal)} r="3.4" fill={color} />}
          <circle cx={toX(last.i)} cy={toY(last.v)} r="2.6" fill={color} />
        </svg>
        {hi != null && hoverVal != null && (() => {
          // 靠边时改成左/右对齐，别让 -50% 把 tooltip 推出容器（最左点会溢出一半）
          const ratio = hi / Math.max(1, values.length - 1);
          const shift = ratio < 0.16 ? 'translateX(0)'
            : ratio > 0.84 ? 'translateX(-100%)' : 'translateX(-50%)';
          const nudge = ratio < 0.16 ? 6 : ratio > 0.84 ? -6 : 0;
          return (
          <div className="kr-tl-tip"
            style={{ left: `calc(${ratio * 100}% + ${nudge}px)`, transform: shift }}>
            <div className="kr-tl-tip-date">{dates?.[hi] || `第 ${hi + 1} 周`}</div>
            <div className="kr-tl-tip-row"><b>{label.split('（')[0]}</b><span>{format(hoverVal)}</span></div>
            {delta != null && delta !== 0 &&
              <div className="kr-tl-tip-delta">较上周 {delta > 0 ? '+' : ''}{format(Math.abs(delta))}</div>}
            {peers.map(pr => pr.values[hi] != null &&
              <div className="kr-tl-tip-row" key={pr.label}><span>{pr.label}</span>
                <span>{pr.format(pr.values[hi]!)}</span></div>)}
          </div>
          );
        })()}
      </div>
      <div className="kr-tl-foot"><span>{format(first.v)}</span><span>{pts.length} 周</span></div>
    </div>
  );
}

/** 列表里的近 1 个月排名缩略图：悬浮用 portal 显示详情（表格会裁剪绝对定位） */
function RankSpark({ trend }: { trend?: KwTrend }) {
  const srcRanks = trend?.rankRecent || [];
  const valid = srcRanks.map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v != null && x.v > 0);
  const vs = valid.map(x => x.v);
  const [hv, setHv] = React.useState<{ x: number; y: number; i: number } | null>(null);
  const allDates = trend?.dates || [];
  const allRanks = trend?.ranks || [];
  const allVols = trend?.volumes || [];
  const offset = Math.max(0, allRanks.length - srcRanks.length);

  if (vs.length < 2) return <span className="kr-spark-empty">—</span>;
  const W = 76, H = 24, PAD = 2;
  const min = Math.min(...vs), max = Math.max(...vs), span = Math.max(1, max - min);
  const toX = (k: number) => PAD + (k / (valid.length - 1)) * (W - PAD * 2);
  const toY = (v: number) => PAD + ((v - min) / span) * (H - PAD * 2);
  const d = valid.map((x, k) => `${k ? 'L' : 'M'}${toX(k).toFixed(1)},${toY(x.v).toFixed(1)}`).join(' ');

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(vs.length - 1,
      Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * (vs.length - 1))));
    setHv({
      x: Math.min(e.clientX + 14, window.innerWidth - 200),
      y: Math.min(e.clientY + 14, window.innerHeight - 130), i,
    });
  };
  const gi = hv ? offset + (valid[hv.i]?.i ?? hv.i) : 0;
  const rank = allRanks[gi], prev = gi > 0 ? allRanks[gi - 1] : null;
  const delta = (rank != null && prev != null) ? rank - prev : null;

  return <>
    <svg width={W} height={H} style={{ display: 'block' }} onMouseMove={onMove}
      onMouseLeave={() => setHv(null)}>
      <path d={d} fill="none" stroke="var(--orange)" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />
      {hv && <circle cx={toX(hv.i)} cy={toY(vs[hv.i])} r="3" fill="var(--orange)" />}
    </svg>
    {hv && createPortal(
      <div className="kr-spark-tip" style={{ left: hv.x, top: hv.y }}>
        <div className="kr-tl-tip-date">{allDates[gi] || '—'}（ABA 周）</div>
        <div className="kr-tl-tip-row"><b>ABA 排名</b><span>{rank != null ? F_INT(rank) : '—'}</span></div>
        {delta != null && delta !== 0 &&
          <div className={'kr-tl-tip-delta ' + (delta < 0 ? 'good' : 'bad')}>
            {delta < 0 ? `较上周前进 ${Math.abs(delta)} 位 ↑` : `较上周后退 ${delta} 位 ↓`}
          </div>}
        <div className="kr-tl-tip-row"><span>周搜索量</span>
          <span>{allVols[gi] != null ? F_NUM(allVols[gi]!) : '—'}</span></div>
      </div>, document.body)}
  </>;
}

function KwTrendModal({ keyword, trend, onClose }: {
  keyword: string; trend: KwTrend | null; onClose: () => void;
}) {
  const dates = trend?.dates || [];
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [preset, setPreset] = React.useState(0);

  // 切换关键词时重置为全区间
  React.useEffect(() => {
    setFrom(dates[0] || '');
    setTo(dates[dates.length - 1] || '');
    setPreset(0);
  }, [keyword, dates.length]);

  const i0 = Math.max(0, dates.indexOf(from));
  const iTo = dates.indexOf(to);
  const i1 = iTo < 0 ? dates.length - 1 : iTo;
  const cut = (arr: (number | null)[] | undefined) => (arr || []).slice(i0, i1 + 1);
  const viewDates = dates.slice(i0, i1 + 1);
  const ranks = cut(trend?.ranks), volumes = cut(trend?.volumes);
  const clicks = cut(trend?.clickShares), conv = cut(trend?.conversionShares);
  const span = Math.max(0, i1 - i0 + 1);

  const applyPreset = (n: number) => {
    if (!dates.length) return;
    setFrom(dates[Math.max(0, dates.length - n)] || dates[0]);
    setTo(dates[dates.length - 1]);
    setPreset(n);
  };
  const peers: Peer[] = [
    { label: '周搜索量', values: volumes, format: F_NUM },
    { label: 'Top3 点击', values: clicks, format: F_PCT },
    { label: 'Top3 转化', values: conv, format: F_PCT },
    { label: 'ABA 排名', values: ranks, format: F_INT },
  ];
  const topAsins = trend?.latest?.top_asins || [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="kr-trend-modal" onClick={e => e.stopPropagation()}>
        <div className="kr-trend-head">
          <div><b>{keyword}</b><span className="kr-trend-sub">SIF · ABA 官方周数据 · 关键词趋势</span></div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="kr-trend-body">
          {!trend || !dates.length
            ? <div className="kr-empty">该词暂无 ABA 数据，首次同步后自动出现。</div>
            : <>
              <div className="kr-trend-filter">
                <span className="kr-trend-fl">时间</span>
                <DateCalendar value={from} dates={dates}
                  onChange={d => { setFrom(d); setPreset(0); if (d > to) setTo(d); }} />
                <span className="rk-range-arrow">→</span>
                <DateCalendar value={to} dates={dates}
                  onChange={d => { setTo(d); setPreset(0); if (d < from) setFrom(d); }} />
                <div className="kr-trend-presets">
                  {[26, 52, 104].map(n =>
                    <button key={n} className={'kr-ghost-btn' + (preset === n ? ' on' : '')}
                      onClick={() => applyPreset(n)}>{n} 周</button>)}
                </div>
                <span className="kr-trend-count">{span} 周</span>
              </div>
              <div className="kr-trend-meta">
                数据截止 <b>{trend.latestDate || '—'}</b> · 当前区间 {viewDates[0] || '—'} ~ {viewDates[viewDates.length - 1] || '—'}
                {trend.fetchedAt && <> · 缓存于 {trend.fetchedAt.slice(0, 16).replace('T', ' ')}</>}
              </div>
              <TrendLine values={ranks} dates={viewDates} color="var(--orange)"
                label="ABA 排名（越小越靠前，线靠上=变好）" format={F_INT}
                peers={peers.filter(p => p.label !== 'ABA 排名')} />
              <TrendLine values={volumes} dates={viewDates} color="var(--blue)"
                label="周搜索量" format={F_NUM} invert
                peers={peers.filter(p => p.label !== '周搜索量')} />
              <div className="kr-trend-grid">
                <TrendLine values={clicks} dates={viewDates} color="var(--purple, #a78bfa)"
                  label="Top3 点击集中度" format={F_PCT} invert
                  peers={peers.filter(p => p.label !== 'Top3 点击')} />
                <TrendLine values={conv} dates={viewDates} color="var(--green)"
                  label="Top3 转化集中度" format={F_PCT} invert
                  peers={peers.filter(p => p.label !== 'Top3 转化')} />
              </div>
              <div className="kr-trend-top3">
                <span>最新周 Top3 ASIN</span>
                {topAsins.length ? topAsins.map(a => <code key={a}>{a}</code>) : <em>无数据</em>}
              </div>
              <div className="kr-trend-note">
                ABA 周报有 2~3 周发布滞后；排名为全部搜索词中的名次，数字越小越热门。
                悬浮曲线可看该周全部指标；日历只列出有数据的周。本页数据来自本地缓存
                （每周自动刷新），不消耗 SIF 额度。
              </div>
            </>}
        </div>
      </div>
    </div>
  );
}

// ---- Main View ----
export function KeywordRank() {
  const [tasks, setTasks]   = React.useState<RankTask[]>([]);
  // 批量操作：任务多选 + 单任务内词多选（档位属于任务，勾词等价于该任务全部词）
  const [batchMode, setBatchMode] = React.useState(false);
  const [checkedTasks, setCheckedTasks] = React.useState<Set<string>>(new Set());
  const [checkedWords, setCheckedWords] = React.useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = React.useState(false);
  const [batchBusy, setBatchBusy] = React.useState(false);
  const [batchMsg, setBatchMsg] = React.useState('');
  const [bsSlots, setBsSlots] = React.useState<string[]>([]);
  const [bsMode, setBsMode] = React.useState<'replace' | 'add'>('replace');
  const [bsCustom, setBsCustom] = React.useState('');
  const [bsInitial, setBsInitial] = React.useState<string[]>([]);
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

  // ABA 周趋势（SIF 本地缓存）：列表零额度，详情弹窗只读缓存
  const [kwTrends, setKwTrends] = React.useState<Record<string, KwTrend>>({});
  const [trendMissing, setTrendMissing] = React.useState<string[]>([]);
  const [trendKw, setTrendKw] = React.useState<string | null>(null);
  const trendRetry = React.useRef(0);

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

  const targetIds = checkedWords.size > 0 && active
    ? [active.id] : Array.from(checkedTasks);
  const selectedWordCount = tasks.filter(t => targetIds.includes(t.id))
    .reduce((n, t) => n + (t.keywords?.length || 0), 0);

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) =>
    setter(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const batchCall = async (payload: any, okMsg: string): Promise<boolean> => {
    if (!targetIds.length) return false;
    setBatchBusy(true); setBatchMsg('');
    try {
      const r = await fetch('/api/rank/tasks/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ taskIds: targetIds, ...payload }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await reloadTasks();
      setCheckedTasks(new Set()); setCheckedWords(new Set());
      setBatchMsg(okMsg);
      return true;
    } catch (e: any) {
      setBatchMsg(e.message || '操作失败');
      return false;
    } finally { setBatchBusy(false); }
  };

  const openSchedule = () => {
    const first = tasks.find(t => t.id === targetIds[0]);
    const init = first?.schedule ? [...first.schedule] : [];
    setBsInitial(init); setBsSlots(init);
    setBsMode('replace'); setBsCustom(''); setBatchMsg(''); setBatchOpen(true);
  };

  React.useEffect(() => { reloadTasks(); }, []);

  // 切任务时批量读 ABA 趋势缓存；有词缺数据 → 后端后台补，10s 后自动再拉一次
  React.useEffect(() => {
    const kws = active?.keywords || [];
    if (!kws.length) { setKwTrends({}); setTrendMissing([]); return; }
    let alive = true;
    const load = () => apiKeywordTrendBatch(kws, active?.marketplace || 'US')
      .then(d => {
        if (!alive) return;
        setKwTrends(d.trends || {});
        setTrendMissing(d.missing || []);
        if ((d.missing || []).length && trendRetry.current < 1) {
          trendRetry.current += 1;
          window.setTimeout(load, 10000);
        }
      }).catch(() => { /* 不阻断主表格 */ });
    trendRetry.current = 0;
    load();
    return () => { alive = false; };
  }, [active?.id, (active?.keywords || []).join('|')]);
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
          <div className="kr-list-head-ops">
            <button className={'btn btn-sm' + (batchMode ? ' btn-primary' : '')}
              onClick={() => {
                setBatchMode(v => !v);
                setCheckedTasks(new Set()); setCheckedWords(new Set()); setBatchMsg('');
              }}>批量</button>
            <button className="btn btn-primary btn-sm" onClick={() => setModal({ open: true, task: null })}>+ 新建</button>
          </div>
        </div>
        {batchMsg && <div className="kr-batch-flash">{batchMsg}</div>}
        {batchMode && tasks.length > 0 && (
          <label className="kr-all-chk">
            <input type="checkbox"
              checked={checkedTasks.size === tasks.length}
              onChange={e => setCheckedTasks(e.target.checked ? new Set(tasks.map(t => t.id)) : new Set())} />
            全选 {tasks.length} 个任务
          </label>
        )}
        {loadErr && <div className="kr-err">{loadErr}</div>}
        {!tasks.length && !loadErr && <div className="kr-empty">还没有监控任务</div>}
        {tasks.map(t => (
          <div key={t.id} className="kr-task-row">
            {batchMode && (
              <input type="checkbox" className="kr-chk" checked={checkedTasks.has(t.id)}
                onChange={() => toggleSet(setCheckedTasks, t.id)} title="选择任务" />
            )}
            <button className="kr-task" data-active={t.id === activeId} onClick={() => setAId(t.id)}>
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
          </div>
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
                {(queueLen > 0 || runMsg || (queue.cooldown || 0) > 0) && (
                  <div className="kr-queue-bar">
                    {(queue.cooldown || 0) > 0 && (
                      <span className="kr-queue-cool">
                        ⚠️ 被 Amazon 风控拦截，自动采集已暂停（剩 {Math.ceil((queue.cooldown || 0) / 60)} 分钟）
                        · 换网络后可手动点「采集」试试
                      </span>
                    )}
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
                      {batchMode && (
                        <th className="kr-col-chk">
                          <input type="checkbox" title="全选当前任务的词"
                            checked={rows.length > 0 && checkedWords.size === rows.length}
                            onChange={e => setCheckedWords(
                              e.target.checked ? new Set(rows.map(r => r.keyword)) : new Set())} />
                        </th>
                      )}
                      <th className="kr-col-kw">关键词</th>
                      <th className="kr-col-rank">自然排名</th>
                      <th className="kr-col-aba" title="SIF ABA 官方周排名（全部搜索词中的名次，越小越热门）">ABA 排名</th>
                      <th className="kr-col-abatrend" title="近 1 个月 ABA 排名走势；线靠上 = 排名越靠前 = 越好">近1月排名</th>
                      <th className="kr-col-rank">广告排名</th>
                      <th className="kr-col-spark">近5天趋势</th>
                      <th className="kr-col-time">更新时间</th>
                      <th className="kr-col-time">开始监控</th>
                      <th className="kr-col-via" title="这条数据是 HTTP 直出，还是被拦后由常驻浏览器兜底回来的">来源</th>
                      <th className="kr-col-notes">备注</th>
                      <th className="kr-col-ops">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      // 最近一次尝试是「真失败」且比最近一次有效结论更新 → 显示失败原因
                      const lastTry = row.lastAttempt;
                      const lastRes = row.lastResult;
                      const lastIsFail = isRealFailure(lastTry)
                        && (!lastRes || (lastTry as Snapshot).capturedAt > lastRes.capturedAt);
                      // shown = 最近一次「有效结论」（拿到排名 或 扫完没找到），
                      // 不是「最后一次有名次」—— 后者会让掉榜的词看起来「两天没更新」。
                      const shown = lastRes || row.latest;
                      return (
                      <tr key={row.keyword}>
                        {batchMode && (
                          <td className="kr-col-chk">
                            <input type="checkbox" checked={checkedWords.has(row.keyword)}
                              onChange={() => toggleSet(setCheckedWords, row.keyword)} title="选择词" />
                          </td>
                        )}
                        <td className="kr-col-kw">
                          <span className="kr-kw-text" title={row.keyword}>{row.keyword}</span>
                        </td>
                        <td className="kr-col-rank">
                          {/* 没拿到排名时把「有效结论」传进去，才能显示「前3页未找到」 */}
                          {/* 必须用 lastRes（最新结论），不能用 row.latest（最后一次有名次）：
                            否则 ASIN 掉出前 3 页后，这里会一直显示旧的排名数字（踩过：
                            11-17 第 37 名一直挂到 11-19，实际早已 not_ranked）。 */}
                        <RankCell snap={lastRes || row.latest} prevSnap={row.prev} type="organic" />
                        </td>
                        <td className="kr-col-aba">
                          {(() => {
                            const t = kwTrends[row.keyword];
                            if (!t || t.rankLast == null)
                              return <span className="kr-aba-empty"
                                title={trendMissing.includes(row.keyword)
                                  ? '首次同步中，稍后自动出现' : '该词暂无 ABA 数据'}>—</span>;
                            const d = (t.rankPrev != null) ? t.rankLast - t.rankPrev : null;
                            return <button className="kr-aba-link" title={`数据截止 ${t.latestDate || '—'}，点击查看完整趋势`}
                              onClick={() => setTrendKw(row.keyword)}>
                              #{Number(t.rankLast).toLocaleString()}
                              {d != null && d !== 0 &&
                                <span className={d < 0 ? 'kr-aba-up' : 'kr-aba-down'}
                                  title={d < 0 ? `较上周前进 ${Math.abs(d)} 位` : `较上周后退 ${d} 位`}>
                                  {d < 0 ? '↑' : '↓'}
                                </span>}
                            </button>;
                          })()}
                        </td>
                        <td className="kr-col-abatrend">
                          <button className="kr-aba-spark" title="线靠上 = 排名越靠前；点击查看完整趋势"
                            onClick={() => setTrendKw(row.keyword)}>
                            <RankSpark trend={kwTrends[row.keyword]} />
                          </button>
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
                          {lastIsFail ? (
                            <span className="kr-fail"
                              title={`${fmtDateTime((lastTry as Snapshot).capturedAt)} 采集失败：${failReason(lastTry)}`}>
                              {failShort(lastTry)}
                            </span>
                          ) : shown ? (
                            <>
                              {fmtDateTime(shown.capturedAt)}
                              {shown.status !== 'ok' && (
                                <span className="kr-norank"
                                  title={[
                                    lastRes?.organicScanned
                                      ? `扫完 ${lastRes.organicScanned} 个自然位都没有这个 ASIN（页面正常，不是采集失败）`
                                      : '页面正常但前 3 页没有这个 ASIN（不是采集失败）',
                                    row.latest
                                      ? `最后一次有排名：${fmtDateTime(row.latest.capturedAt)}（第 ${row.latest.organicRank} 名）`
                                      : '历史上从未进过前 3 页',
                                  ].join('；')}>
                                  未排名
                                </span>
                              )}
                            </>
                          ) : '—'}
                        </td>
                        <td className="kr-col-time">
                          {active.createdAt ? fmtDateTime(active.createdAt) : '—'}
                        </td>
                        <td className="kr-col-via">
                          {(() => {
                            const vs = (lastIsFail ? lastTry : shown) as Snapshot | undefined;
                            if (!vs) return '—';
                            const v = vs.via || 'http';
                            if (v === 'cdp')
                              return <span className="kr-via kr-via-cdp"
                                title="HTTP 被拦，由常驻无头浏览器兜底成功（旧方案下这会消耗一次额度）">浏览器</span>;
                            if (v === 'cdp_failed')
                              return <span className="kr-via kr-via-fail"
                                title="HTTP 被拦，浏览器兜底也失败">兜底失败</span>;
                            return <span className="kr-via kr-via-http" title="纯 HTTP 直出">HTTP</span>;
                          })()}
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
                      );
                    })}
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

      {/* ABA 关键词完整趋势（只读本地缓存，零 SIF 额度） */}
      {trendKw && (
        <KwTrendModal keyword={trendKw} trend={kwTrends[trendKw] || null}
          onClose={() => setTrendKw(null)} />
      )}

    {/* 批量操作条：任务多选 / 单任务词多选都汇到这里 */}
    {batchMode && targetIds.length > 0 && (
      <div className="kr-batch-bar">
        <div className="kr-batch-info">
          已选 <b>{targetIds.length}</b> 个任务（共 {selectedWordCount} 个词）
          {checkedWords.size > 0 && (
            <span className="kr-batch-note">
              勾了 {checkedWords.size} 个词 · 档位属于任务，设置会作用于该任务全部词
            </span>
          )}
          {batchMsg && <span className="kr-batch-msg">{batchMsg}</span>}
        </div>
        <div className="kr-batch-ops">
          <button className="btn btn-sm" onClick={openSchedule} disabled={batchBusy}>设置采集时间</button>
          <button className="btn btn-sm" disabled={batchBusy}
            onClick={() => batchCall({ action: 'enabled', enabled: true }, '已启用')}>启用</button>
          <button className="btn btn-sm" disabled={batchBusy}
            onClick={() => batchCall({ action: 'enabled', enabled: false }, '已停用')}>停用</button>
          <button className="btn btn-sm btn-primary" disabled={batchBusy}
            onClick={() => batchCall({ action: 'run' }, '已加入采集队列')}>立即采集</button>
          <button className="btn btn-sm" onClick={() => {
            setCheckedTasks(new Set()); setCheckedWords(new Set()); setBatchMsg('');
          }}>取消选择</button>
        </div>
      </div>
    )}

    {/* 批量设置采集时间 */}
    {batchOpen && (
      <div className="modal-backdrop" onClick={() => setBatchOpen(false)}>
        <div className="kr-batch-modal" onClick={e => e.stopPropagation()}>
          <div className="kr-batch-hdr">
            <span>批量设置采集时间</span>
            <button className="modal-close" onClick={() => setBatchOpen(false)}>✕</button>
          </div>
          <div className="kr-batch-body">
            <div className="kr-batch-tip">
              将修改 {targetIds.length} 个任务（共 {selectedWordCount} 个词）· 时区沿用各任务自己的设置
              <br />{TIME_WINDOW_HINT}
            </div>
            <div className="kr-batch-mode">
              <label><input type="radio" checked={bsMode === 'replace'}
                onChange={() => { setBsMode('replace'); setBsSlots(bsInitial); }} /> 替换：用下面的时间点覆盖原有档位</label>
              <label><input type="radio" checked={bsMode === 'add'}
                onChange={() => { setBsMode('add'); setBsSlots([]); }} /> 追加：保留原有档位，只加选中的时间点</label>
            </div>
            <div className="kr-batch-presets">
              {PRESET_TIMES.map(x => (
                <button key={x} type="button" className={'kr-slot-btn' + (bsSlots.includes(x) ? ' on' : '')}
                  onClick={() => setBsSlots(p => p.includes(x) ? p.filter(y => y !== x) : [...p, x])}>{x}</button>
              ))}
            </div>
            <div className="kr-batch-custom">
              <input type="time" value={bsCustom} min={TIME_MIN} max={TIME_MAX}
                title={TIME_WINDOW_HINT}
                onChange={e => setBsCustom(e.target.value)} />
              <button className="btn btn-sm" type="button" onClick={() => {
                const v = bsCustom.trim();
                if (!/^\d{2}:\d{2}$/.test(v)) return;
                if (!inTimeWindow(v)) { setBatchMsg(`${v} 超出允许时段。${TIME_WINDOW_HINT}`); return; }
                if (!bsSlots.includes(v)) setBsSlots(p => [...p, v]);
                setBsCustom('');
              }}>添加自定义</button>
            </div>
            <div className="kr-batch-slots">
              已选时间点：
              {bsSlots.length ? bsSlots.slice().sort().map(x => (
                <span key={x} className={'kr-slot' + (inTimeWindow(x) ? '' : ' kr-slot-bad')}
                  title={inTimeWindow(x) ? '点击移除' : `${TIME_WINDOW_HINT}，点击移除`}
                  onClick={() => setBsSlots(p => p.filter(y => y !== x))}>{x} ✕</span>
              )) : <i>请在上方选择</i>}
            </div>
            {batchMsg && <div className="kr-err">{batchMsg}</div>}
          </div>
          <div className="kr-batch-foot">
            <button className="btn btn-sm" onClick={() => setBatchOpen(false)}>取消</button>
            <button className="btn btn-primary btn-sm" disabled={!bsSlots.length || batchBusy}
              onClick={async () => {
                const bad = firstOutOfWindow(bsSlots);
                if (bad) { setBatchMsg(`${bad} 超出允许时段。${TIME_WINDOW_HINT}`); return; }
                const ok = await batchCall({ action: 'schedule', slots: bsSlots, mode: bsMode },
                  '采集时间已更新');
                if (ok) setBatchOpen(false);
              }}>{batchBusy ? '保存中…' : `应用到 ${targetIds.length} 个任务`}</button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
