import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { marked } from 'marked';

// ===========================================================================
// SIF 爆品关键词监控 v2
// ---------------------------------------------------------------------------
// 双线监控：
//   · 关键词线：每日快照自建日序列（SIF 侧关键词历史只有周/月粒度，日环比是
//     SIF 每日刷新估算值的逐日变化，非官方日搜索量口径 —— 界面已标注）
//   · 爆品线：ops_get_asin_traffic_trend 的真日粒度数据（BSR / 价格 / 近30天销量 /
//     评论 / 自然 vs 广告流量分数逐日入库），SIF 有 T+1~T+2 延迟，取最近有值日
//   · 信号引擎：后端本地算，阈值在「设置」页可改（不消耗 SIF 配额）
//   · 点查层：竞争格局 / 推广可行性 / 采购成本上限等重接口，手动触发不进定时
// 图表全部手写 SVG（与 KeywordRank.tsx 同风格，不引第三方图表库）。
// ===========================================================================

// ---- 类型 ----

interface Task {
  id: string; name: string; direction: string; mode: 'root' | 'keywords';
  roots: string[]; keywords: string[]; asins: string[]; country: string;
  topN: number; quotaLimit: number; asinLimit: number; backfillDays: number;
  autoAsin: boolean; freqType: 'daily' | 'every_n' | 'weekly'; everyNDays: number;
  scheduleWeekday: number; scheduleTime: string | null; enabled: boolean;
  lastRunAt: string | null; lastDailyAt: string | null; lastWeeklyAt: string | null;
  lastStatus: string; lastError: string | null; createdAt: string;
  failCount: number; nextRetryAt: string | null; tripped: boolean;
}

interface KwProfile {
  trendDirection?: string | null; yoyChange?: number | null; demandType?: string | null;
  peakMonth?: number | null; weeksToPeak?: number | null; seasonPosition?: string | null;
  diagnosis?: string | null; adHint?: string | null;
}

interface KwRow {
  keyword: string; runDate: string; searchVolume: number | null; rank: number | null;
  cpc: number | null; cvr: number | null; clickShare: number | null; trafficCost: number | null;
  entrySignal: string; topAsins: string[]; root?: string | null; isNewEntry: boolean;
  dod: number | null; wow: number | null; prevVolume: number | null; rankDod: number | null;
  spark?: (number | null)[]; profile: KwProfile;
}

interface AsinLatest {
  date?: string; price?: number | null; bsr?: number | null; boughtMonth?: number | null;
  reviewNum?: number | null; star?: number | null; sellerNum?: number | null;
  totalScore?: number | null; nfScore?: number | null; adScore?: number | null;
  spScore?: number | null; sbScore?: number | null; sbvScore?: number | null;
  promotion?: string | null; coupon?: string | null;
}

interface AsinRow {
  asin: string; title: string; brand: string; img: string | null; url: string | null;
  price: number | null; star: number | null; ratingNum: number | null; category: string | null;
  weightOz: number | null; dimsIn: Record<string, number>; firstAvailableDay: string | null;
  variationNum: number | null; source: string; sourceRef: any; addedAt: string;
  lastStatDate: string | null; active: boolean; latest: AsinLatest;
  statDate?: string | null; bsrPrev?: number | null; bsrChg?: number | null;
  pricePrev?: number | null; priceChg?: number | null; salesPrev?: number | null;
  salesWow?: number | null; reviewWow?: number | null; nfShare?: number | null;
  onSaleDays?: number | null; statDays?: number;
}

interface Signal {
  id: number; date: string; createdAt: string; taskId: string; direction: string;
  kind: string; severity: 'high' | 'warn' | 'info'; refType: 'keyword' | 'asin';
  refId: string; title: string; detail: any; ack: boolean;
}

interface RunRow {
  id: number; taskId: string; taskName: string; runDate: string; tier: string;
  startedAt: string | null; finishedAt: string | null; status: string; stats: any; error: string | null;
}

interface Thresholds {
  kw_dod_pct: number; kw_wow_pct: number; kw_rank_jump_pct: number; kw_new_entry: number;
  asin_bsr_jump_pct: number; asin_price_drop_pct: number; asin_sales_wow_pct: number;
  asin_review_wow_pct: number; new_product_days: number; new_product_sales: number;
  nf_share_drop_pct: number; min_search_volume: number;
}

interface Defaults {
  topN: number; quotaLimit: number; asinLimit: number; backfillDays: number;
  keepDays: number; country: string;
}

interface Board {
  overview: { tasks: number; keywords: number; asins: number; latestKwDate: string | null; latestAsinDate: string | null; totalCalls: number };
  settings: { thresholds: Thresholds; defaults: Defaults };
  tasks: Task[]; signals: Signal[]; signalCounts: { high: number; warn: number; info: number; total: number };
  taskId: string; task: Task | null; dates: string[]; runs: RunRow[];
  runDate?: string; keywords?: KwRow[]; asins?: AsinRow[]; weeklyDue?: boolean; weeklyInterval?: number;
}

// ---- 常量 ----

const DIR_PRESETS = [
  { key: 'cooling', icon: '🧊', label: '降温冷却', roots: ['cooling', 'cool mat', 'fan', 'ice'], hint: '冷却毯 / 宠物冰垫 / 车载风扇 / 冰丝凉席' },
  { key: 'heating', icon: '🔥', label: '升温保暖', roots: ['heated', 'heating', 'warm', 'thermal'], hint: '加热毯 / 加热穿戴毯 / 暖颈枕 / 加热眼罩' },
  { key: 'gift', icon: '🎁', label: '礼物场景', roots: ['gift', 'gifts for', 'present'], hint: '礼物 / 礼盒 / 节日送礼' },
  { key: 'car', icon: '🚗', label: '车载用品', roots: ['car fan', 'car seat', 'vehicle', 'car vent'], hint: '车载风扇 / 通风坐垫 / 车用收纳' },
  { key: 'custom', icon: '✏️', label: '自定义', roots: [], hint: '自己填词根或关键词' },
];
const DIR_ICON: Record<string, string> = Object.fromEntries(DIR_PRESETS.map(d => [d.key, d.icon]));
const DIR_LABEL: Record<string, string> = Object.fromEntries(DIR_PRESETS.map(d => [d.key, d.label]));

const WEEKDAYS = [
  { v: 1, label: '周一' }, { v: 2, label: '周二' }, { v: 3, label: '周三' },
  { v: 4, label: '周四' }, { v: 5, label: '周五' }, { v: 6, label: '周六' }, { v: 7, label: '周日' },
];
const FREQ_LABEL: Record<string, string> = { daily: '每天', every_n: '每 N 天', weekly: '每周' };

// 信号种类 → 中文名 + 归类（kw=关键词 / asin=爆品）
const SIGNAL_KIND: Record<string, { label: string; group: 'kw' | 'asin' }> = {
  kw_volume_surge: { label: '搜索量激增', group: 'kw' },
  kw_volume_drop: { label: '搜索量下滑', group: 'kw' },
  kw_rank_jump: { label: 'ABA 排名跃升', group: 'kw' },
  kw_new_entry: { label: '新入榜机会词', group: 'kw' },
  asin_bsr_jump: { label: 'BSR 跃升', group: 'asin' },
  asin_price_drop: { label: '价格下调', group: 'asin' },
  asin_sales_surge: { label: '月销增速', group: 'asin' },
  asin_review_surge: { label: '评论增速', group: 'asin' },
  asin_new_hot: { label: '新品黑马', group: 'asin' },
  asin_traffic_shift: { label: '流量结构转变', group: 'asin' },
};

// 设置页字段元数据（阈值 + 默认配额），业务参数全部前端可配
const THRESHOLD_FIELDS: { key: keyof Thresholds; label: string; unit: string; hint: string }[] = [
  { key: 'kw_dod_pct', label: '搜索量日环比', unit: '%', hint: '当日搜索量相对前一日的变化超过该值即报信号（日环比是主判据）' },
  { key: 'kw_wow_pct', label: '搜索量 7 日环比', unit: '%', hint: '日环比未命中时，用 7 天前基线做兜底判断' },
  { key: 'kw_rank_jump_pct', label: 'ABA 排名跃升', unit: '%', hint: '排名数值变小=变好；改善幅度超过该值报信号。注意排名由每周层回填，周内不变则此项不触发' },
  { key: 'kw_new_entry', label: '提示新入榜词', unit: '0/1', hint: '1=首次进入监控视野的机会词也报信号，0=关闭' },
  { key: 'min_search_volume', label: '关键词最低搜索量', unit: '', hint: '低于该搜索量的词不报信号——长尾小词的百分比波动全是噪音' },
  { key: 'asin_bsr_jump_pct', label: 'BSR 跃升', unit: '%', hint: '爆品核心信号：BSR 较上一个数据日改善幅度' },
  { key: 'asin_price_drop_pct', label: '价格下调', unit: '%', hint: '竞品降价内卷 / 清仓甩货预警' },
  { key: 'asin_sales_wow_pct', label: '月销 7 日增速', unit: '%', hint: '近30天销量相对约 7 天前的增速（另设最低 100 单门槛避免小基数误报）' },
  { key: 'asin_review_wow_pct', label: '评论 7 日增速', unit: '%', hint: '评论数增长，起量佐证；涨幅异常高也可能是刷单' },
  { key: 'new_product_days', label: '新品天数上限', unit: '天', hint: '上架天数 ≤ 该值才算新品（配合下面的月销门槛判定黑马）' },
  { key: 'new_product_sales', label: '新品月销门槛', unit: '单', hint: '新品近30天销量达到该值即判定为黑马' },
  { key: 'nf_share_drop_pct', label: '自然流量占比降幅', unit: 'pp', hint: '自然/总流量占比较约 7 天前下降超过该百分点数 = 转靠广告撑量，竞争加剧' },
];

const DEFAULT_FIELDS: { key: keyof Defaults; label: string; hint: string; num: boolean }[] = [
  { key: 'topN', label: '每词根机会词数 topN', hint: 'screen 接口每个词根返回多少机会词。直接决定候选词规模与每周层成本', num: true },
  { key: 'quotaLimit', label: '每任务关键词上限', hint: '每日快照最多记录多少个词（按搜索量降序截断），防配额失控', num: true },
  { key: 'asinLimit', label: 'ASIN 监控池上限', hint: '自动入池的 ASIN 数量上限 —— 每日层调用数≈池内 ASIN 数，这是最有效的成本阀门', num: true },
  { key: 'backfillDays', label: '新 ASIN 回补天数', hint: 'ASIN 首次入池时往前回补多少天的日数据', num: true },
  { key: 'keepDays', label: '数据保留天数', hint: '超过该天数的关键词快照与 ASIN 日数据自动清理', num: true },
  { key: 'country', label: '默认站点', hint: 'US / UK / DE / JP / CA 等', num: false },
];

const TABS = [
  { k: 'board', label: '监控看板' }, { k: 'kw', label: '关键词' }, { k: 'asin', label: '爆品池' },
  { k: 'signal', label: '信号中心' }, { k: 'run', label: '运行记录' }, { k: 'setting', label: '设置' },
];

// ---- API ----

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('fba-auth-v1') || '';
  return t ? { Authorization: 'Bearer ' + t } : {};
}

async function req<T>(path: string, opt: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opt.headers || {}) },
  });
  const d = await r.json().catch(() => ({} as any));
  if (!r.ok) throw new Error((d as any).error || r.statusText);
  return d as T;
}

const api = {
  board: (taskId?: string | null, days = 30, date?: string | null) => {
    const q = new URLSearchParams();
    if (taskId) q.set('taskId', taskId);
    q.set('days', String(days));
    if (date) q.set('date', date);
    return req<Board>('/api/sif/board?' + q.toString());
  },
  saveTask: (body: any) => req<{ task: Task }>('/api/sif/tasks',
    { method: body.id ? 'PUT' : 'POST', body: JSON.stringify(body) }),
  delTask: (id: string) => req('/api/sif/tasks?id=' + encodeURIComponent(id), { method: 'DELETE' }),
  run: (id: string) => req('/api/sif/run', { method: 'POST', body: JSON.stringify({ id }) }),
  kwTrend: (taskId: string, keyword: string, days = 90) =>
    req<{ keyword: string; daily: KwRow[]; profile: { week: string; profile: any } | null }>(
      `/api/sif/kw-trend?taskId=${encodeURIComponent(taskId)}&keyword=${encodeURIComponent(keyword)}&days=${days}`),
  asinTrend: (taskId: string, asin: string, days = 90) =>
    req<{ asin: string; series: AsinLatest[]; profile: AsinRow | null }>(
      `/api/sif/asin-trend?taskId=${encodeURIComponent(taskId)}&asin=${encodeURIComponent(asin)}&days=${days}`),
  universe: (taskId: string) =>
    req<{ keywords: { keyword: string; lastDate: string; peakVolume: number }[] }>('/api/sif/universe?taskId=' + encodeURIComponent(taskId)),
  pool: (taskId: string) => req<{ pool: AsinRow[]; limit: number }>('/api/sif/pool?taskId=' + encodeURIComponent(taskId)),
  poolAdd: (taskId: string, asins: string[]) =>
    req<{ added: number; calls: number; errors: string[] }>('/api/sif/pool/add',
      { method: 'POST', body: JSON.stringify({ taskId, asins }) }),
  poolToggle: (taskId: string, asin: string, active: boolean) =>
    req('/api/sif/pool/toggle', { method: 'POST', body: JSON.stringify({ taskId, asin, active }) }),
  poolRemove: (taskId: string, asin: string) =>
    req('/api/sif/pool/remove', { method: 'POST', body: JSON.stringify({ taskId, asin }) }),
  signalTop: (days = 14, taskId?: string | null) =>
    req<{ items: { refType: string; refId: string; kinds: string[]; severity: string; direction: string }[] }>(
      `/api/sif/signal-top?days=${days}` + (taskId ? '&taskId=' + encodeURIComponent(taskId) : '')),
  ackSignal: (id: number, ack: boolean) =>
    req('/api/sif/signals/ack', { method: 'POST', body: JSON.stringify({ id, ack }) }),
  saveSettings: (section: 'thresholds' | 'defaults', values: any) =>
    req<{ thresholds: Thresholds; defaults: Defaults }>('/api/sif/settings',
      { method: 'PUT', body: JSON.stringify({ section, values }) }),
  preview: (root: string, topN: number, withCompetitors: boolean) =>
    req<{ root: string; keywords: any[]; competitors: any[] }>('/api/sif/preview',
      { method: 'POST', body: JSON.stringify({ root, topN, withCompetitors }) }),
  inspect: (body: any) => req<{ type: string; data: any }>('/api/sif/inspect',
    { method: 'POST', body: JSON.stringify(body) }),
};

// ---- 格式化 ----

function fmtN(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !isFinite(Number(v))) return '—';
  const n = Number(v);
  if (digits === 0 && Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + 'w';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}
function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !isFinite(Number(v))) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 100 ? 0 : digits) + '%';
}
function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return '$' + Number(v).toFixed(2);
}
function splitList(s: string): string[] {
  return s.split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
}
function md(text: string | null | undefined): string {
  if (!text) return '';
  try { return marked.parse(String(text), { async: false }) as string; } catch { return String(text); }
}
function statusCls(s: string): string {
  return s === 'running' ? 'sif-st-running' : s === 'done' ? 'sif-st-done'
    : s === 'error' ? 'sif-st-error' : s === 'partial' ? 'sif-st-running' : 'sif-st-idle';
}
function statusLabel(s: string): string {
  return s === 'running' ? '抓取中' : s === 'done' ? '正常' : s === 'error' ? '失败'
    : s === 'partial' ? '部分失败' : '待运行';
}
function retryHint(t: Task): string {
  if (t.tripped) return '已熔断，明日自动恢复';
  if (t.failCount > 0 && t.nextRetryAt) {
    const dt = t.nextRetryAt.slice(5, 16).replace('T', ' ');
    return `第 ${t.failCount} 次失败，${dt} 重试`;
  }
  return '';
}
function freqText(t: Task): string {
  const time = t.scheduleTime || '未设时刻';
  if (t.freqType === 'weekly') {
    const w = WEEKDAYS.find(x => x.v === (t.scheduleWeekday || 1));
    return `每${w ? w.label : '周一'} ${time}`;
  }
  if (t.freqType === 'every_n') return `每 ${t.everyNDays || 2} 天 ${time}`;
  return `每天 ${time}`;
}
function toCsv(name: string, rows: any[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]).filter(k => typeof rows[0][k] !== 'object');
  const body = [cols.join(','), ...rows.map(r => cols.map(c => {
    const v = (r as any)[c];
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name + '.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ---- 图表（手写 SVG） ----

interface Series { name: string; color: string; values: (number | null)[]; negative?: boolean }

function LineChart({ dates, series, height = 200, money = false }:
  { dates: string[]; series: Series[]; height?: number; money?: boolean }) {
  const [hov, setHov] = useState<number | null>(null);
  const lines = useMemo(() => series.map(s => ({
    ...s,
    values: s.values.map(v => (s.negative && v !== null && v !== undefined ? -v : v)) as (number | null)[],
  })), [series]);
  const valid = lines.flatMap(s => s.values).filter(v => v !== null && v !== undefined) as number[];
  if (dates.length < 2 || valid.length < 2) {
    return <div className="sif-chart-empty">数据不足（至少需要 2 天，随每日抓取自动累积）</div>;
  }
  const W = 900, H = height, PL = 64, PR = 16, PT = 14, PB = 24;
  const n = dates.length;
  let min = Math.min(...valid), max = Math.max(...valid);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const iw = W - PL - PR, ih = H - PT - PB;
  const x = (i: number) => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PT + ih - ((v - min) / (max - min)) * ih;
  const fmt = (v: number) => (money ? fmtMoney(Math.abs(v)) : fmtN(Math.abs(v)));
  const shown = Math.min(7, n);
  const labelIdx = Array.from(new Set(Array.from({ length: shown }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, shown - 1)))));

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHov(Math.max(0, Math.min(n - 1, i)));
  }
  return (
    <div className="sif-chart-wrap" onMouseMove={onMove} onMouseLeave={() => setHov(null)}>
      <svg className="sif-chart" viewBox={`0 0 ${W} ${H}`} style={{ height: H }}>
        {[0, 1, 2, 3, 4].map(k => {
          const v = min + ((max - min) * k) / 4;
          return (
            <g key={k}>
              <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="3 3" />
              <text x={PL - 8} y={y(v) + 3.5} fontSize="10" fill="var(--ink-4)" textAnchor="end">
                {lines.some(s => s.negative) && v < 0 ? fmt(v) : fmt(v)}
              </text>
            </g>
          );
        })}
        {labelIdx.map(i => (
          <text key={i} x={x(i)} y={H - 7} fontSize="10" fill="var(--ink-4)" textAnchor="middle">
            {(dates[i] || '').slice(5)}
          </text>
        ))}
        {lines.map((s, si) => {
          let started = false;
          const d = s.values.map((v, i) => {
            if (v === null || v === undefined) return '';
            const seg = `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
            started = true;
            return seg;
          }).join('');
          return <path key={si} d={d} fill="none" stroke={s.color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />;
        })}
        {hov !== null && (
          <g>
            <line x1={x(hov)} x2={x(hov)} y1={PT} y2={PT + ih} stroke="var(--ink-4)" strokeWidth="0.8" strokeDasharray="2 2" />
            {lines.map((s, si) => (s.values[hov] != null &&
              <circle key={si} cx={x(hov)} cy={y(s.values[hov] as number)} r="3.4" fill={s.color} stroke="var(--card-bg)" strokeWidth="1.2" />))}
          </g>
        )}
      </svg>
      <div className="sif-legend">
        {series.map((s, i) => (
          <span key={i} className="sif-legend-item">
            <i style={{ background: s.color }} />{s.name}{s.negative ? '（越靠上=越好）' : ''}
          </span>
        ))}
      </div>
      {hov !== null && (
        <div className="sif-chart-tip" style={{ left: `${Math.min(Math.max((x(hov) / W) * 100, 10), 90)}%`, top: 16 }}>
          <div className="sif-tip-date">{dates[hov]}</div>
          {lines.map((s, i) => {
            const raw = s.negative && s.values[hov] != null ? -(s.values[hov] as number) : s.values[hov];
            return <div key={i} className="sif-tip-val"><i style={{ background: s.color }} />
              {s.name} {raw == null ? '—' : (money ? fmtMoney(raw) : fmtN(raw))}</div>;
          })}
        </div>
      )}
    </div>
  );
}

function Spark({ values }: { values: (number | null)[] }) {
  const vs = (values || []).filter(v => v !== null && v !== undefined) as number[];
  if (vs.length < 2) return <span className="sif-spark-empty">—</span>;
  const W = 76, H = 22, n = (values || []).length;
  const min = Math.min(...vs), max = Math.max(...vs), span = (max - min) || 1;
  const pts: { x: number; y: number }[] = [];
  (values || []).forEach((v, i) => {
    if (v === null || v === undefined) return;
    pts.push({ x: 2 + (n > 1 ? (i / (n - 1)) * (W - 4) : (W - 4) / 2), y: H - 2 - ((v - min) / span) * (H - 4) });
  });
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const up = vs[vs.length - 1] >= vs[0];
  const color = up ? 'var(--green)' : 'var(--red)';
  return (
    <svg width={W} height={H} className="sif-spark">
      <path d={d} fill="none" strokeWidth="1.4" stroke={color} />
      <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r="1.8" fill={color} />
    </svg>
  );
}

/** 涨跌标记。invert=true 表示传入值已是「正=变好」的改善幅度 */
function Delta({ v, invert, suffix = '%' }: { v: number | null | undefined; invert?: boolean; suffix?: string }) {
  if (v === null || v === undefined) return <span className="sif-flat">—</span>;
  const n = Number(v);
  if (!isFinite(n)) return <span className="sif-flat">—</span>;
  const good = invert ? n > 0 : n >= 0;
  const cls = Math.abs(n) < 0.05 ? 'sif-flat' : good ? 'sif-up' : 'sif-down';
  const arrow = Math.abs(n) < 0.05 ? '·' : n > 0 ? '▲' : '▼';
  return <span className={cls}>{arrow} {fmtPct(n, suffix === 'pp' ? 0 : 1).replace('%', suffix)}</span>;
}

function SevTag({ s }: { s: string }) {
  return <span className={'sif-sev sif-sev-' + s}>{s === 'high' ? '高' : s === 'warn' ? '中' : '提示'}</span>;
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="sif-stat">
      <span className="sif-stat-k">{k}</span>
      <span className="sif-stat-v">{v}</span>
      {sub && <span className="sif-stat-sub">{sub}</span>}
    </div>
  );
}

function Modal({ title, onClose, wide, children }:
  { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="sif-modal" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'sif-modal-card' + (wide ? ' sif-modal-wide' : '')}>
        <div className="sif-modal-head"><span>{title}</span><button className="sif-x" onClick={onClose}>✕</button></div>
        <div className="sif-modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---- 点查结果通用渲染（对象/数组/Markdown 混合） ----

function DataView({ data, depth = 0 }: { data: any; depth?: number }) {
  if (data === null || data === undefined) return <span className="sif-flat">—</span>;
  if (typeof data === 'string') {
    if (/^\s*([|>]|[-*]\s)/.test(data) || /\*\*/.test(data)) {
      return <div className="sif-md" dangerouslySetInnerHTML={{ __html: md(data) }} />;
    }
    return <span>{data}</span>;
  }
  if (typeof data === 'number') return <span>{Number.isInteger(data) ? data.toLocaleString() : data.toFixed(3)}</span>;
  if (typeof data !== 'object') return <span>{String(data)}</span>;
  if (Array.isArray(data)) {
    if (!data.length) return <span className="sif-flat">（空）</span>;
    const uniform = data.every(x => x && typeof x === 'object' && !Array.isArray(x));
    if (uniform && depth < 3) {
      const sample = data.slice(0, 60) as any[];
      const cols: string[] = [];
      sample.forEach(r => Object.keys(r).forEach(k => {
        if (k.startsWith('_')) return;
        if (!['string', 'number', 'boolean'].includes(typeof r[k])) return;
        if (!cols.includes(k)) cols.push(k);
      }));
      return (
        <div className="sif-scroll">
          <table className="sif-table sif-table-sm">
            <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{data.slice(0, 60).map((r: any, i: number) => (
              <tr key={i}>{cols.map(c => {
                const v = r[c];
                return <td key={c}>{typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v ?? '')}</td>;
              })}</tr>
            ))}</tbody>
          </table>
          {data.length > 60 && <div className="sif-hint">共 {data.length} 条，仅显示前 60 条</div>}
        </div>
      );
    }
    return <div className="sif-md">{data.map((x, i) => (
      <div key={i}>{typeof x === 'object' ? <DataView data={x} depth={depth + 1} /> : String(x)}</div>))}</div>;
  }
  const keys = Object.keys(data).filter(k => !k.startsWith('_'));
  return (
    <div className="sif-kv" style={{ marginLeft: depth ? 8 : 0 }}>
      {keys.map(k => {
        const v = data[k];
        const primitive = v === null || typeof v !== 'object';
        return (
          <div key={k} className="sif-kv-row">
            <span className="sif-kv-k">{k}</span>
            {primitive
              ? <span className="sif-kv-v">{typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v ?? '—')}</span>
              : <div className="sif-kv-sub"><DataView data={v} depth={depth + 1} /></div>}
          </div>
        );
      })}
    </div>
  );
}

// ---- 点查弹窗 ----

const INSPECT_TITLES: Record<string, string> = {
  competition: '关键词竞争格局', discover: 'Top100 竞品四维格局', root_competitors: '词根头部竞品',
  root_trend: '词根市场规模与长尾分散度', history: 'SIF 周度历史趋势', screen: '同类机会词',
  asin_signals: 'ASIN 关键词流量信号', asin_profile: 'ASIN 产品画像', asin_sales: 'ASIN 变体销量',
  listing_keywords: 'Listing 关键词覆盖量', promotion: '推广可行性评估（该不该打广告）',
  profit: '采购成本上限反推',
};

function InspectModal({ title, body, onClose }: { title: string; body: any; onClose: () => void }) {
  const kind = String(body?.type || '');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<any>({ ...body });
  const [ran, setRan] = useState(false);

  const needsForm = kind === 'promotion' || kind === 'profit';

  async function go(payload?: any) {
    setBusy(true); setErr(''); setRes(null);
    try { const d = await api.inspect(payload || body); setRes(d.data); setRan(true); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (!needsForm) go(); }, []);   // eslint-disable-line

  function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const payload: any = { type: kind, country: form.country || 'US' };
    if (kind === 'promotion') {
      payload.keywords = splitList(form.keywordsText || (body.keywords || []).join(', ')).slice(0, 20);
      if (form.ownPrice) payload.ownPrice = Number(form.ownPrice);
      if (form.ownMargin) payload.ownMargin = Number(form.ownMargin);
      if (!payload.keywords.length) { setErr('请至少填写一个关键词'); return; }
    } else {
      const map: Record<string, string> = {
        price: 'price', category: 'category', weight_oz: 'weightOz', freight_cost: 'freightCost',
        target_margin: 'targetMargin', tariff_rate: 'tariffRate', turnover_days: 'turnoverDays',
        length_in: 'lengthIn', width_in: 'widthIn', height_in: 'heightIn',
      };
      for (const [k, fk] of Object.entries(map)) if (form[fk] !== '' && form[fk] != null) payload[k] = Number(form[fk]) || form[fk];
      payload.is_apparel = !!form.isApparel;
      const miss = ['price', 'category', 'weight_oz', 'freight_cost', 'target_margin'].filter(k => payload[k] === undefined || payload[k] === '');
      if (miss.length) { setErr('还需填写：' + miss.join(' / ')); return; }
    }
    go(payload);
  }

  const promoList: any[] = res?.assessments || [];
  const profit = res?.purchase_cost_ceiling;

  return (
    <Modal title={title || INSPECT_TITLES[kind] || '点查结果'} onClose={onClose} wide>
      {kind === 'promotion' && (
        <form className="sif-inline" onSubmit={submitForm}>
          <label className="sif-field sif-inline-field"><span className="sif-field-label">关键词</span>
            <input className="sif-pool-input" defaultValue={(body.keywords || []).join(', ')}
              onChange={e => setForm({ ...form, keywordsText: e.target.value })} /></label>
          <label className="sif-field sif-inline-field"><span className="sif-field-label">售价 $</span>
            <input type="number" step="0.01" defaultValue={body.ownPrice ?? ''} placeholder="59.99"
              onChange={e => setForm({ ...form, ownPrice: e.target.value })} /></label>
          <label className="sif-field sif-inline-field"><span className="sif-field-label">利润率 0~1</span>
            <input type="number" step="0.01" defaultValue={body.ownMargin ?? 0.25}
              onChange={e => setForm({ ...form, ownMargin: e.target.value })} /></label>
          <button className="btn btn-primary sif-btn-sm" disabled={busy} style={{ alignSelf: 'end' }}>
            {busy ? '评估中…' : '开始评估'}</button>
        </form>
      )}
      {kind === 'profit' && (
        <form className="sif-form-grid" onSubmit={submitForm}>
          {([
            ['price', '目标售价 $', form.price ?? body.price ?? ''],
            ['category', 'Amazon 类目', form.category ?? body.category ?? 'Home & Kitchen'],
            ['weightOz', '重量 oz', form.weightOz ?? body.weight_oz ?? ''],
            ['freightCost', '头程运费 $/件', form.freightCost ?? ''],
            ['targetMargin', '目标毛利率 0~1', form.targetMargin ?? 0.25],
            ['tariffRate', '关税税率（可空）', form.tariffRate ?? ''],
          ] as [string, string, any][]).map(([k, label, dv]) => (
            <label key={k} className="sif-field"><span className="sif-field-label">{label}</span>
              <input type={k === 'category' ? 'text' : 'number'} step="0.01" defaultValue={dv}
                onChange={e => setForm({ ...form, [k]: e.target.value })} /></label>
          ))}
          <label className="sif-field sif-check">
            <input type="checkbox" checked={!!form.isApparel} onChange={e => setForm({ ...form, isApparel: e.target.checked })} />
            <span>服装类目（影响 FBA 费率）</span>
          </label>
          <div className="sif-field" style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" disabled={busy}>{busy ? '计算中…' : '计算采购上限'}</button>
          </div>
        </form>
      )}
      {busy && <div className="sif-hint">SIF 重接口返回中，可能需要几秒…</div>}
      {err && <div className="sif-err">{err}</div>}
      {promoList.length > 0 && promoList.map((a: any, i: number) => (
        <div key={i} className="sif-trend-block">
          <div className="sif-trend-title">{a.keyword}{a.judgment ? ` — ${a.judgment}` : ''}</div>
          {a.anchor_sentence && <div className="sif-anchor">{a.anchor_sentence}</div>}
          {a.evidence_block && <div className="sif-md" dangerouslySetInnerHTML={{ __html: md(a.evidence_block) }} />}
          {a.recommendation && <div className="sif-note"><b>建议：</b>{a.recommendation}</div>}
          {a.econ_table && <div className="sif-md" dangerouslySetInnerHTML={{ __html: md(a.econ_table) }} />}
          {a.cpc_table && <div className="sif-md" dangerouslySetInnerHTML={{ __html: md(a.cpc_table) }} />}
          {a.cpc_action_hint && <div className="sif-hint">{a.cpc_action_hint}</div>}
        </div>
      ))}
      {profit && (
        <div className="sif-trend-block">
          <div className="sif-anchor">
            采购成本上限：淡季 ${profit.off_peak} / 旺季 ${profit.peak} —— 工厂谈判目标 ${profit.negotiation_target}
          </div>
          {profit.note && <div className="sif-note">{profit.note}</div>}
        </div>
      )}
      {res && !promoList.length && !profit && <DataView data={res} />}
      {ran && !needsForm && (
        <div className="sif-hint">本次为手动点查，消耗 1 次 SIF 调用；重接口不进定时链路，不会自动产生费用。</div>
      )}
    </Modal>
  );
}

function useInspector() {
  const [insp, setInsp] = useState<{ title: string; body: any } | null>(null);
  const node = insp ? (
    <InspectModal key={insp.title + JSON.stringify(insp.body)} title={insp.title}
      body={insp.body} onClose={() => setInsp(null)} />
  ) : null;
  return { open: (body: any, title?: string) => setInsp({ body, title: title || INSPECT_TITLES[body.type] || '点查结果' }), node };
}

// ---- 任务表单 ----

function TaskForm({ task, defaults, onClose, onSaved }:
  { task: Task | null; defaults: Defaults; onClose: () => void; onSaved: (msg: string) => void }) {
  const isNew = !task;
  const [name, setName] = useState(task?.name || '');
  const [dir, setDir] = useState(task?.direction || 'heating');
  const [mode, setMode] = useState<'root' | 'keywords'>(task?.mode || 'root');
  const [roots, setRoots] = useState((task?.roots || []).join(', ')
    || (DIR_PRESETS.find(p => p.key === 'heating')!.roots.join(', ')));
  const [kws, setKws] = useState((task?.keywords || []).join(', '));
  const [asins, setAsins] = useState((task?.asins || []).join(', '));
  const [country, setCountry] = useState(task?.country || defaults.country || 'US');
  const [topN, setTopN] = useState(task?.topN ?? defaults.topN ?? 8);
  const [quota, setQuota] = useState(task?.quotaLimit ?? defaults.quotaLimit ?? 30);
  const [asinLimit, setAsinLimit] = useState(task?.asinLimit ?? defaults.asinLimit ?? 20);
  const [backfill, setBackfill] = useState(task?.backfillDays ?? defaults.backfillDays ?? 90);
  const [autoAsin, setAutoAsin] = useState(task ? task.autoAsin : true);
  const [freq, setFreq] = useState<'daily' | 'every_n' | 'weekly'>(task?.freqType || 'daily');
  const [everyN, setEveryN] = useState(task?.everyNDays ?? 2);
  const [wd, setWd] = useState(task?.scheduleWeekday ?? 1);
  const [time, setTime] = useState(task?.scheduleTime || '08:00');
  const [enabled, setEnabled] = useState(task ? task.enabled : true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pvRoot, setPvRoot] = useState('');
  const [pv, setPv] = useState<{ kws: any[]; comps: any[] } | null>(null);
  const [pvBusy, setPvBusy] = useState(false);

  const nRoots = mode === 'root' ? splitList(roots).length : 0;
  const nFixed = mode === 'keywords' ? splitList(kws).length : 0;
  const estDaily = nRoots + (autoAsin ? Number(asinLimit) : 0);
  const estWeekly = Math.ceil(Math.min(quota, Math.max(nFixed, nRoots * topN)) / 10) * 2 + nRoots;

  function applyPreset(k: string) {
    setDir(k);
    const p = DIR_PRESETS.find(d => d.key === k);
    if (p && p.roots.length) setRoots(p.roots.join(', '));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    const body: any = {
      name: name.trim(), direction: dir, mode, country, enabled, topN: Number(topN),
      quotaLimit: Number(quota), asinLimit: Number(asinLimit), backfillDays: Number(backfill),
      autoAsin, freqType: freq, everyNDays: Number(everyN), scheduleWeekday: Number(wd),
      scheduleTime: time || null, asins: splitList(asins).map(x => x.toUpperCase()),
    };
    if (mode === 'root') {
      const r = splitList(roots);
      if (!r.length) { setErr('请至少填写一个词根'); return; }
      body.roots = r;
    } else {
      const k = splitList(kws);
      if (!k.length) { setErr('请至少填写一个关键词'); return; }
      body.keywords = k;
    }
    if (task) body.id = task.id;
    setBusy(true);
    try {
      await api.saveTask(body);
      onSaved(task ? '任务已更新' : '任务已创建');
    } catch (ex: any) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  async function preview() {
    const root = (pvRoot || splitList(roots)[0] || '').trim();
    if (!root) { setErr('请填写要试查的词根'); return; }
    setPvBusy(true); setErr('');
    try {
      const d = await api.preview(root, Math.min(Number(topN), 20), true);
      setPv({ kws: d.keywords || [], comps: d.competitors || [] });
    } catch (ex: any) { setErr('试查失败：' + ex.message); }
    finally { setPvBusy(false); }
  }

  return (
    <Modal title={isNew ? '新建监控任务' : '编辑任务：' + task!.name} onClose={onClose} wide>
      <form className="sif-form" onSubmit={submit}>
        <div className="sif-field">
          <span className="sif-field-label">任务名称</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="如：加热穿戴毯-美站" required />
        </div>

        <div className="sif-field">
          <span className="sif-field-label">方向（预设词根，可自由修改）</span>
          <div className="sif-dir-picker">
            {DIR_PRESETS.map(p => (
              <button type="button" key={p.key} title={p.hint}
                className={'sif-dir-btn' + (dir === p.key ? ' sif-dir-active' : '')}
                onClick={() => applyPreset(p.key)}>{p.icon} {p.label}</button>
            ))}
          </div>
        </div>

        <div className="sif-field">
          <span className="sif-field-label">抓取方式</span>
          <div className="sif-seg">
            <button type="button" className={'sif-seg-btn' + (mode === 'root' ? ' sif-seg-on' : '')} onClick={() => setMode('root')}>按词根发现机会词</button>
            <button type="button" className={'sif-seg-btn' + (mode === 'keywords' ? ' sif-seg-on' : '')} onClick={() => setMode('keywords')}>固定关键词清单</button>
          </div>
        </div>

        {mode === 'root' ? (
          <div className="sif-field">
            <span className="sif-field-label">词根（逗号或换行分隔，每个词根每天 1 次调用）</span>
            <textarea rows={2} value={roots} onChange={e => setRoots(e.target.value)} />
            <span className="sif-field-hint">词根可单词也可多词短语（如 “car fan”）；系统会自动筛出该词根下的机会词并持续追踪</span>
          </div>
        ) : (
          <div className="sif-field">
            <span className="sif-field-label">关键词清单（逗号或换行分隔）</span>
            <textarea rows={3} value={kws} onChange={e => setKws(e.target.value)} placeholder="heated blanket, heated neck wrap" />
            <span className="sif-field-hint">固定词模式每日只做快照与环比追踪、不发现新词，适合盯已确定的目标词</span>
          </div>
        )}

        <div className="sif-form-grid">
          <label className="sif-field"><span className="sif-field-label">站点</span>
            <select value={country} onChange={e => setCountry(e.target.value)}>
              {['US', 'UK', 'DE', 'JP', 'CA', 'FR', 'IT', 'ES', 'MX', 'AU'].map(c => <option key={c}>{c}</option>)}
            </select></label>
          <label className="sif-field"><span className="sif-field-label">每词根机会词数 topN</span>
            <input type="number" min={1} max={20} value={topN} onChange={e => setTopN(Number(e.target.value))} /></label>
          <label className="sif-field"><span className="sif-field-label">关键词数量上限</span>
            <input type="number" min={1} max={200} value={quota} onChange={e => setQuota(Number(e.target.value))} /></label>
          <label className="sif-field"><span className="sif-field-label">ASIN 监控池上限</span>
            <input type="number" min={0} max={100} value={asinLimit} onChange={e => setAsinLimit(Number(e.target.value))} /></label>
          <label className="sif-field"><span className="sif-field-label">新 ASIN 回补天数</span>
            <input type="number" min={3} max={180} value={backfill} onChange={e => setBackfill(Number(e.target.value))} /></label>
          <label className="sif-field"><span className="sif-field-label">手填监控 ASIN（可选）</span>
            <input type="text" value={asins} onChange={e => setAsins(e.target.value)} placeholder="B0XXXXXX, B0YYYYYY" /></label>
        </div>

        <label className="sif-field sif-check">
          <input type="checkbox" checked={autoAsin} onChange={e => setAutoAsin(e.target.checked)} />
          <span>自动把机会词的 Top3 点击 ASIN、词根头部竞品加入监控池（受池上限约束；手动添加不受限）</span>
        </label>

        <div className="sif-field">
          <span className="sif-field-label">抓取频率</span>
          <div className="sif-seg">
            {(['daily', 'every_n', 'weekly'] as const).map(f => (
              <button type="button" key={f} className={'sif-seg-btn' + (freq === f ? ' sif-seg-on' : '')} onClick={() => setFreq(f)}>
                {FREQ_LABEL[f]}
              </button>
            ))}
          </div>
        </div>

        <div className="sif-form-grid">
          {freq === 'every_n' && (
            <label className="sif-field"><span className="sif-field-label">每隔几天</span>
              <input type="number" min={1} max={30} value={everyN} onChange={e => setEveryN(Number(e.target.value))} /></label>
          )}
          {freq === 'weekly' && (
            <label className="sif-field"><span className="sif-field-label">每周几</span>
              <select value={wd} onChange={e => setWd(Number(e.target.value))}>
                {WEEKDAYS.map(w => <option key={w.v} value={w.v}>{w.label}</option>)}
              </select></label>
          )}
          <label className="sif-field"><span className="sif-field-label">触发时刻（服务器本地时间）</span>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
          <label className="sif-field sif-check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            <span>启用定时抓取（不勾选=只能手动抓取）</span>
          </label>
        </div>

        <div className="sif-note">
          预估每日约 <b>{estDaily}</b> 次 SIF 调用（词根 {nRoots} + 池内 ASIN 最多 {autoAsin ? asinLimit : 0}）；
          每周层约 <b>{estWeekly}</b> 次 / 7 天（需求画像 + 周度趋势 + 词根竞品）。
          画像与趋势属每周层，会自动搭在每日抓取里跑，无需单独设置。实际调用数以「运行记录」为准。
        </div>

        <div className="sif-field">
          <span className="sif-field-label">试查词根（不落库，消耗 2 次调用：机会词 + 头部竞品）</span>
          <div className="sif-inline">
            <input type="text" value={pvRoot} onChange={e => setPvRoot(e.target.value)} placeholder="留空则用第一个词根" />
            <button type="button" className="btn" onClick={preview} disabled={pvBusy}>{pvBusy ? '查询中…' : '试查'}</button>
          </div>
          {pv && (
            <div className="sif-preview">
              <div className="sif-preview-head"><span>机会词 {pv.kws.length} 个</span></div>
              <div className="sif-preview-table">
                <table className="sif-table sif-table-sm">
                  <thead><tr><th>关键词</th><th>搜索量</th><th>CPC</th><th>CVR</th><th>入场信号</th></tr></thead>
                  <tbody>{pv.kws.map((k: any, i: number) => (
                    <tr key={i}>
                      <td className="sif-kw">{k.keyword}</td><td>{fmtN(k.search_volume)}</td>
                      <td>{fmtMoney(k.cpc)}</td>
                      <td>{k.cvr != null ? (Number(k.cvr) * 100).toFixed(1) + '%' : '—'}</td>
                      <td className="sif-signal">{k.entry_signal}</td>
                    </tr>))}</tbody>
                </table>
              </div>
              {pv.comps.length > 0 && <>
                <div className="sif-preview-head"><span>词根头部竞品 {pv.comps.length} 个（自动入池候选）</span></div>
                <div className="sif-chips">{pv.comps.map((c: any, i: number) => (
                  <span key={i} className="sif-chip">{c.asin} · 覆盖 {fmtN(c.covered_volume)} · 首选 {fmtN(c.rank1_count)} 词</span>))}</div>
              </>}
            </div>
          )}
        </div>

        {err && <div className="sif-err">{err}</div>}
        <div className="sif-form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存任务'}</button>
          <button type="button" className="btn" onClick={onClose}>取消</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- 关键词详情 ----

function KwDetail({ taskId, kw, onClose, onInspect }:
  { taskId: string; kw: string; onClose: () => void; onInspect: (b: any, t?: string) => void }) {
  const [rows, setRows] = useState<KwRow[] | null>(null);
  const [prof, setProf] = useState<any>(null);
  const [err, setErr] = useState('');
  const [days, setDays] = useState(90);
  const [weekly, setWeekly] = useState<any>(null);
  const [wBusy, setWBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    setRows(null); setErr(''); setWeekly(null);
    api.kwTrend(taskId, kw, days)
      .then(d => { if (!stop) { setRows(d.daily || []); setProf(d.profile); } })
      .catch(e => { if (!stop) setErr(e.message); });
    return () => { stop = true; };
  }, [taskId, kw, days]);

  async function loadWeekly() {
    setWBusy(true); setErr('');
    try {
      const d = await api.inspect({ type: 'history', keywords: [kw], country: 'US', granularity: 'week' });
      setWeekly((d.data?.keywords || [])[0] || null);
    } catch (e: any) { setErr('周度历史拉取失败：' + e.message); }
    finally { setWBusy(false); }
  }

  const dates = (rows || []).map(r => r.runDate);
  const p = prof?.profile;
  const last = rows && rows.length ? rows[rows.length - 1] : null;

  return (
    <Modal title={'关键词：' + kw} onClose={onClose} wide>
      {err && <div className="sif-err">{err}</div>}
      <div className="sif-inline">
        <span className="sif-hint">自建日序列（每日快照累积）</span>
        <select className="sif-mini" value={days} onChange={e => setDays(Number(e.target.value))}>
          {[30, 60, 90, 180, 365].map(x => <option key={x} value={x}>近 {x} 天</option>)}
        </select>
        <button className="btn sif-btn-sm" onClick={loadWeekly} disabled={wBusy}>
          {wBusy ? '拉取中…' : '叠加 SIF 周度历史（点查 1 次）'}</button>
      </div>

      {last && (
        <div className="sif-grid4">
          <Stat k="最新搜索量" v={fmtN(last.searchVolume)} sub={last.dod != null ? `日环比 ${fmtPct(last.dod)}` : '日环比 —'} />
          <Stat k="7 日环比" v={last.wow != null ? fmtPct(last.wow) : '—'} sub={last.prevVolume != null ? `昨日 ${fmtN(last.prevVolume)}` : ''} />
          <Stat k="ABA 排名" v={fmtN(last.rank)} sub="每周层回填" />
          <Stat k="CPC / CVR" v={`${fmtMoney(last.cpc)} / ${last.cvr != null ? (last.cvr * 100).toFixed(1) + '%' : '—'}`}
            sub={last.clickShare != null ? `Top3 点击集中 ${(last.clickShare * 100).toFixed(0)}%` : ''} />
        </div>
      )}

      {rows && rows.length > 1 && (
        <div className="sif-trend-block">
          <div className="sif-trend-title">搜索量（每日快照）</div>
          <LineChart dates={dates} series={[{ name: '搜索量', color: 'var(--blue)', values: rows.map(r => r.searchVolume) }]} />
        </div>
      )}
      {rows && rows.length > 1 && rows.some(r => r.rank != null) && (
        <div className="sif-trend-block">
          <div className="sif-trend-title">ABA 排名（小=好，已用负轴使「越靠上越好」）</div>
          <LineChart dates={dates} series={[{ name: 'ABA 排名', color: 'var(--orange)', negative: true, values: rows.map(r => r.rank) }]} />
        </div>
      )}
      {weekly && (weekly.dates || []).length > 1 && (
        <div className="sif-trend-block">
          <div className="sif-trend-title">SIF 周度历史（ABA 官方口径，最新一期 {weekly.latest?.date || '—'}）</div>
          <LineChart dates={(weekly.dates || []).map((x: string) => String(x).slice(0, 10))}
            series={[{ name: '周搜索量', color: 'var(--green)', values: weekly.volumes || [] }]} />
        </div>
      )}

      {p && (
        <div className="sif-note">
          <b>需求画像</b>（{prof.week}）：{p.demand_type || '—'} · 趋势 {p.trend_direction || '—'}
          {p.yoy_change != null ? `（同比 ${fmtPct(Number(p.yoy_change) * 100, 0)}）` : ''}
          {p.peak_month ? ` · 旺季 ${p.peak_month} 月` : ''}
          {p.weeks_to_peak != null ? ` · 距旺季约 ${p.weeks_to_peak} 周` : ''}
          {p.season_position ? ` · 当前处于${p.season_position}` : ''}
          {p.diagnosis ? <>；诊断：{p.diagnosis}</> : null}
          {p.ad_hint ? <>；广告建议：{p.ad_hint}</> : null}
        </div>
      )}
      {last?.entrySignal && <div className="sif-anchor">{last.entrySignal}</div>}

      {rows && rows.length > 1 && (
        <div className="sif-trend-block">
          <div className="sif-trend-title">每日明细（近 {Math.min(rows.length, 30)} 天，新→旧）</div>
          <div className="sif-scroll sif-scroll-sm">
            <table className="sif-table sif-table-sm">
              <thead><tr><th>日期</th><th>搜索量</th><th>日环比</th><th>ABA 排名</th><th>CPC</th><th>点击集中度</th><th>入场信号</th></tr></thead>
              <tbody>{rows.slice(-30).reverse().map((r, i, arr) => {
                const prev = arr[i + 1];
                const dd = (r.searchVolume != null && prev && prev.searchVolume)
                  ? ((r.searchVolume - prev.searchVolume) / prev.searchVolume) * 100 : null;
                return (
                  <tr key={i}>
                    <td>{r.runDate}</td><td>{fmtN(r.searchVolume)}</td>
                    <td><Delta v={dd} /></td><td>{fmtN(r.rank)}</td><td>{fmtMoney(r.cpc)}</td>
                    <td>{r.clickShare != null ? (r.clickShare * 100).toFixed(0) + '%' : '—'}</td>
                    <td className="sif-signal">{r.entrySignal}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      )}

      <div className="sif-actions">
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'competition', keyword: kw })}>竞争格局</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'discover', keyword: kw, max_results: 10 })}>Top100 四维格局</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'root_trend', keyword: kw })}>词根市场盘子</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'root_competitors', keyword: kw, topN: 10 })}>词根头部竞品</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'screen', keyword: kw, topN: 10 })}>同类机会词</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'promotion', keywords: [kw] })}>该打广告吗</button>
      </div>
      <div className="sif-hint">
        口径提醒：日环比来自 SIF 每日刷新的估算值逐日对比（ABA 官方口径为周/月），不是亚马逊官方日搜索量；
        点查各消耗 1 次调用，按需使用。
      </div>
    </Modal>
  );
}

// ---- ASIN（爆品）详情 ----

function AsinDetail({ taskId, asin, onClose, onInspect, onChanged }:
  { taskId: string; asin: string; onClose: () => void; onInspect: (b: any, t?: string) => void; onChanged: () => void }) {
  const [data, setData] = useState<{ series: AsinLatest[]; profile: AsinRow | null } | null>(null);
  const [err, setErr] = useState('');
  const [days, setDays] = useState(90);

  useEffect(() => {
    let stop = false;
    setData(null); setErr('');
    api.asinTrend(taskId, asin, days)
      .then(r => { if (!stop) setData({ series: r.series || [], profile: r.profile }); })
      .catch(e => { if (!stop) setErr(e.message); });
    return () => { stop = true; };
  }, [taskId, asin, days]);

  const s = data?.series || [];
  const dates = s.map(x => x.date || '');
  const p = data?.profile;
  const last = s.length ? s[s.length - 1] : null;
  const nfShare = last && last.totalScore ? (last.nfScore || 0) / last.totalScore * 100 : null;
  const onSaleDays = p?.firstAvailableDay
    ? Math.round((Date.now() - new Date(p.firstAvailableDay).getTime()) / 86400000) : null;

  async function remove() {
    if (!confirm(`把 ${asin} 移出监控池？其历史日数据会一并删除。`)) return;
    try { await api.poolRemove(taskId, asin); onChanged(); onClose(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <Modal title={'爆品监控：' + asin} onClose={onClose} wide>
      {err && <div className="sif-err">{err}</div>}
      {p && (
        <div className="sif-asin-head">
          {p.img && <img className="sif-asin-img" src={p.img} alt="" />}
          <div className="sif-asin-info">
            <a className="sif-asin-title" target="_blank" rel="noreferrer"
              href={p.url || 'https://www.amazon.com/dp/' + p.asin}>{p.title || asin}</a>
            <div className="sif-asin-meta">
              {p.brand || '—'} · {p.category || '—'} · {fmtN(p.ratingNum)} 条评论 · {p.star ?? '—'} 星
              {p.firstAvailableDay ? ` · 上架 ${p.firstAvailableDay}${onSaleDays != null ? `（${onSaleDays} 天）` : ''}` : ''}
              {p.variationNum ? ` · ${p.variationNum} 个变体` : ''}{p.weightOz ? ` · ${p.weightOz} oz` : ''}
            </div>
            <div className="sif-chips">
              <span className="sif-chip">来源：{p.source === 'opportunity' ? '机会词点击' : p.source === 'competitor' ? '词根竞品' : '手动添加'}</span>
              {p.sourceRef?.keyword && <span className="sif-chip">来自词：{p.sourceRef.keyword}</span>}
              {p.sourceRef?.root && <span className="sif-chip">词根：{p.sourceRef.root}</span>}
              {p.sourceRef?.covered_volume != null && <span className="sif-chip">覆盖搜索量 {fmtN(p.sourceRef.covered_volume)}</span>}
              {p.sourceRef?.rank1_count != null && <span className="sif-chip">ABA 首选 {fmtN(p.sourceRef.rank1_count)} 词</span>}
              {last?.promotion && <span className="sif-chip">促销：{last.promotion}</span>}
              {last?.coupon && <span className="sif-chip">优惠券：{last.coupon}</span>}
            </div>
          </div>
          <button className="btn sif-btn-sm sif-del" onClick={remove}>移出池</button>
        </div>
      )}
      <div className="sif-inline">
        <span className="sif-hint">SIF 真日粒度数据（T+1~T+2 延迟）</span>
        <select className="sif-mini" value={days} onChange={e => setDays(Number(e.target.value))}>
          {[30, 60, 90, 180].map(x => <option key={x} value={x}>近 {x} 天</option>)}
        </select>
        <span className="sif-hint">已入库 {s.length} 天{s.length ? `（${s[0].date} → ${s[s.length - 1].date}）` : ''}</span>
      </div>
      <div className="sif-grid4">
        <Stat k="近30天销量" v={fmtN(last?.boughtMonth ?? null)} />
        <Stat k="BSR 大类排名" v={fmtN(last?.bsr ?? null)} />
        <Stat k="价格" v={fmtMoney(last?.price ?? null)} />
        <Stat k="自然流量占比" v={nfShare != null ? nfShare.toFixed(0) + '%' : '—'} sub={`评论 ${fmtN(last?.reviewNum ?? null)}`} />
      </div>
      {s.length > 1 && (
        <>
          <div className="sif-trend-block">
            <div className="sif-trend-title">近30天销量（逐日）</div>
            <LineChart dates={dates} series={[{ name: '月销量', color: 'var(--green)', values: s.map(x => x.boughtMonth ?? null) }]} />
          </div>
          <div className="sif-trend-block">
            <div className="sif-trend-title">BSR 大类排名（小=好，负轴后越靠上代表排名越前）</div>
            <LineChart dates={dates} series={[{ name: 'BSR', color: 'var(--orange)', negative: true, values: s.map(x => x.bsr ?? null) }]} />
          </div>
          <div className="sif-trend-block">
            <div className="sif-trend-title">价格（跳水 = 降价内卷 / 清仓信号）</div>
            <LineChart dates={dates} height={150} money
              series={[{ name: '成交价', color: 'var(--blue)', values: s.map(x => x.price ?? null) }]} />
          </div>
          <div className="sif-trend-block">
            <div className="sif-trend-title">流量结构（自然 vs 广告，SIF 流量分数）</div>
            <LineChart dates={dates} height={170} series={[
              { name: '总流量分', color: 'var(--ink-3)', values: s.map(x => x.totalScore ?? null) },
              { name: '自然流量分', color: 'var(--green)', values: s.map(x => x.nfScore ?? null) },
              { name: '广告流量分', color: 'var(--red)', values: s.map(x => x.adScore ?? null) },
            ]} />
          </div>
          <div className="sif-trend-block">
            <div className="sif-trend-title">评论数增长（配合销量看是否真起量）</div>
            <LineChart dates={dates} height={150}
              series={[{ name: '评论数', color: 'var(--blue)', values: s.map(x => x.reviewNum ?? null) }]} />
          </div>
        </>
      )}
      <div className="sif-actions">
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'asin_signals', asin, recentDays: 7 })}>它靠哪些词卖货</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'asin_profile', asins: [asin] })}>产品画像</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'asin_sales', asins: [asin], dimension: 'size' })}>变体销量</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({ type: 'listing_keywords', asin })}>Listing 词量</button>
        <button className="btn sif-btn-sm" onClick={() => onInspect({
          type: 'profit', price: p?.price ?? undefined, category: p?.category || 'Home & Kitchen',
          weight_oz: p?.weightOz ?? undefined,
        }, '采购成本上限：' + asin)}>算采购上限</button>
      </div>
      <div className="sif-note">
        拆解路径建议：先看「它靠哪些词卖货」找对方没守住的缺口词 → 回关键词页对缺口词做竞争格局与推广可行性 →
        再用「算采购上限」把经济账跑通，最后才决定是否立项。
      </div>
    </Modal>
  );
}

// ---- 设置页（阈值 + 默认配额，前端可配） ----

function SettingsPanel({ settings, onSaved }:
  { settings: { thresholds: Thresholds; defaults: Defaults }; onSaved: (msg: string) => void }) {
  const [th, setTh] = useState<Record<string, any>>({ ...settings.thresholds });
  const [df, setDf] = useState<Record<string, any>>({ ...settings.defaults });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setBusy(true); setErr('');
    try {
      await api.saveSettings('thresholds', th);
      await api.saveSettings('defaults', df);
      onSaved('设置已保存，下次抓取与信号计算即生效');
    } catch (e: any) { setErr('保存失败：' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="sif-panel">
      <div className="sif-panel-head">
        <span className="sif-panel-title">信号阈值与默认配额</span>
        <div className="sif-inline">
          {err && <span className="sif-err">{err}</span>}
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存设置'}</button>
        </div>
      </div>
      <div className="sif-settings-grid">
        <div className="sif-trend-block">
          <div className="sif-trend-title">信号阈值 —— 决定什么算「异动」（越小越灵敏，信号越多）</div>
          {THRESHOLD_FIELDS.map(f => (
            <div className="sif-setting-row" key={f.key}>
              <label>
                <span className="sif-setting-label">{f.label}{f.unit && f.unit !== '0/1' ? `（${f.unit}）` : ''}</span>
                <input type="number" step="any" value={th[f.key] ?? ''}
                  onChange={e => setTh({ ...th, [f.key]: e.target.value === '' ? 0 : Number(e.target.value) })} />
              </label>
              <span className="sif-setting-hint">{f.hint}{f.unit === '0/1' ? '（填 1 开启 / 0 关闭）' : ''}</span>
            </div>
          ))}
        </div>
        <div className="sif-trend-block">
          <div className="sif-trend-title">新建任务的默认配额 —— SIF 按调用计费，这里是最主要的成本阀门</div>
          {DEFAULT_FIELDS.map(f => (
            <div className="sif-setting-row" key={f.key}>
              <label>
                <span className="sif-setting-label">{f.label}</span>
                {f.num
                  ? <input type="number" value={df[f.key] ?? ''} onChange={e => setDf({ ...df, [f.key]: Number(e.target.value) })} />
                  : <input type="text" value={df[f.key] ?? ''} onChange={e => setDf({ ...df, [f.key]: e.target.value })} />}
              </label>
              <span className="sif-setting-hint">{f.hint}</span>
            </div>
          ))}
          <div className="sif-note">
            调用量估算：每个任务每日 ≈ 词根数 + 池内 ASIN 数；每周层 ≈ ⌈词数/10⌉×2 + 词根数（每 7 天一次）。
            想砍成本优先降 <b>ASIN 监控池上限</b>，其次把频率拉长到「每 N 天」，最后才降 topN。
            历史数据按「数据保留天数」自动清理，不会无限增长。
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 主组件 ----

export function SifKeyword() {
  const [board, setBoard] = useState<Board | null>(null);
  const [tab, setTab] = useState('board');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [form, setForm] = useState<{ open: boolean; task: Task | null }>({ open: false, task: null });
  const [kwOpen, setKwOpen] = useState<string | null>(null);
  const [asinOpen, setAsinOpen] = useState<string | null>(null);
  const [poolAdd, setPoolAdd] = useState('');
  const [pool, setPool] = useState<{ pool: AsinRow[]; limit: number } | null>(null);
  const [universe, setUniverse] = useState<{ keyword: string; lastDate: string; peakVolume: number }[]>([]);
  const [sigTop, setSigTop] = useState<any[]>([]);
  const [kwSort, setKwSort] = useState<'volume' | 'dod' | 'wow' | 'rank'>('volume');
  const [asinSort, setAsinSort] = useState<'sales' | 'bsr' | 'new' | 'growth'>('sales');
  const [kwFilter, setKwFilter] = useState('');
  const [sigFilter, setSigFilter] = useState('all');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const inspector = useInspector();
  const flash = useCallback((s: string) => { setMsg(s); setTimeout(() => setMsg(''), 2800); }, []);
  const bootRef = useRef(false);

  const reload = useCallback(async (quiet = true) => {
    try {
      const b = await api.board(taskId, days, date);
      setBoard(b);
      if (b.taskId && !taskId) setTaskId(b.taskId);
      if (quiet) setErr('');
    } catch (e: any) {
      if (!quiet || !bootRef.current) setErr(e.message);
    } finally {
      bootRef.current = true;
    }
  }, [taskId, days, date]);

  useEffect(() => { reload(false); }, [reload]);

  // 有任务在抓取时轮询进度
  useEffect(() => {
    if (!board?.tasks?.some(t => t.lastStatus === 'running')) return;
    const iv = setInterval(() => reload(), 5000);
    return () => clearInterval(iv);
  }, [board, reload]);

  // 池 / 全量词 / 异动榜（随看板刷新同步）
  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    api.pool(taskId).then(d => { if (!stop) setPool(d); }).catch(() => { });
    api.universe(taskId).then(d => { if (!stop) setUniverse(d.keywords || []); }).catch(() => { });
    api.signalTop(Math.min(days, 30), taskId).then(d => { if (!stop) setSigTop(d.items || []); }).catch(() => { });
    return () => { stop = true; };
  }, [taskId, board, days]);

  const task = board?.task || null;
  const kws = useMemo(() => {
    let arr = [...(board?.keywords || [])];
    const q = kwFilter.trim().toLowerCase();
    if (q) arr = arr.filter(k => k.keyword.toLowerCase().includes(q));
    const by: Record<string, (a: KwRow, b: KwRow) => number> = {
      volume: (a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0),
      dod: (a, b) => (b.dod ?? -9999) - (a.dod ?? -9999),
      wow: (a, b) => (b.wow ?? -9999) - (a.wow ?? -9999),
      rank: (a, b) => (a.rank ?? 1e12) - (b.rank ?? 1e12),
    };
    return arr.sort(by[kwSort]);
  }, [board, kwSort, kwFilter]);

  const asins = useMemo(() => {
    let arr = [...(board?.asins || [])];
    const num = (v: any) => (v === null || v === undefined ? null : Number(v));
    if (asinSort === 'bsr') arr.sort((a, b) => (num(a.latest?.bsr) ?? 1e12) - (num(b.latest?.bsr) ?? 1e12));
    else if (asinSort === 'new') arr.sort((a, b) => (a.onSaleDays ?? 1e9) - (b.onSaleDays ?? 1e9));
    else if (asinSort === 'growth') arr.sort((a, b) => (num(b.salesWow) ?? -1e9) - (num(a.salesWow) ?? -1e9));
    else arr.sort((a, b) => (num(b.latest?.boughtMonth) ?? 0) - (num(a.latest?.boughtMonth) ?? 0));
    return arr;
  }, [board, asinSort]);

  const allSignals = board?.signals || [];
  const signals = sigFilter === 'all' ? allSignals
    : sigFilter === 'kw' ? allSignals.filter(s => SIGNAL_KIND[s.kind]?.group === 'kw')
      : sigFilter === 'asin' ? allSignals.filter(s => SIGNAL_KIND[s.kind]?.group === 'asin')
        : allSignals.filter(s => s.severity === sigFilter);

  async function runNow(t: Task) {
    setErr('');
    try {
      await api.run(t.id);
      flash('已触发抓取：每日层必跑，每周层满 7 天附带');
      setTimeout(() => reload(), 1800);
    } catch (e: any) { setErr(e.message); }
  }
  async function delTask(t: Task) {
    if (!confirm(`删除任务「${t.name}」？其关键词快照、ASIN 池与日数据、信号、运行记录会一并清空。`)) return;
    try {
      await api.delTask(t.id);
      setTaskId(null); setDate(null); flash('任务已删除');
      const b = await api.board(null, days, null); setBoard(b); if (b.taskId) setTaskId(b.taskId);
    } catch (e: any) { setErr(e.message); }
  }
  async function toggleTask(t: Task) {
    try { await api.saveTask({ id: t.id, enabled: !t.enabled }); await reload(); }
    catch (e: any) { setErr(e.message); }
  }
  async function addPool() {
    const codes = splitList(poolAdd).map(x => x.toUpperCase()).filter(x => /^B0[A-Z0-9]{8}$/.test(x));
    if (!codes.length) { setErr('ASIN 格式应为 B0 开头共 10 位，多个用逗号分隔'); return; }
    if (!taskId) return;
    setErr('');
    try {
      const r = await api.poolAdd(taskId, codes);
      flash(`已入池 ${r.added} 只，回补日数据消耗 ${r.calls} 次调用`);
      if (r.errors?.length) setErr(r.errors.join('；'));
      setPoolAdd('');
      await reload();
      setPool(await api.pool(taskId));
    } catch (e: any) { setErr(e.message); }
  }
  async function toggleAsin(a: AsinRow) {
    if (!taskId) return;
    await api.poolToggle(taskId, a.asin, !a.active);
    await reload(); setPool(await api.pool(taskId));
  }

  if (!board) {
    return (
      <div className="sif-wrap"><div className="sif-main">
        {err
          ? <div className="sif-err">加载失败：{err}{/未配置|SIF_MCP_KEY/.test(err) ? '——请检查 data/sif-config.json 或环境变量 SIF_MCP_KEY' : ''}</div>
          : <div className="sif-hint">加载中…</div>}
      </div></div>
    );
  }
  const ov = board.overview;
  const cnt = board.signalCounts;

  return (
    <div className="sif-wrap">
      {/* ---- 左栏：任务 ---- */}
      <div className="sif-left">
        <div className="sif-left-head">
          <span className="sif-left-title">监控任务 {board.tasks.length}</span>
          <button className="btn btn-primary sif-btn-sm" onClick={() => setForm({ open: true, task: null })}>+ 新建</button>
        </div>
        {!board.tasks.length && (
          <div className="sif-empty">还没有监控任务。<br />点「新建」选个方向（升温/降温/礼物/车载），<br />之后每天自动抓机会词并建 ASIN 监控池。</div>
        )}
        {board.tasks.map(t => (
          <div key={t.id} className="sif-task" data-active={taskId === t.id}
            onClick={() => { setTaskId(t.id); setDate(null); }}>
            <div className="sif-task-top">
              <span className="sif-task-icon">{DIR_ICON[t.direction] || '🔎'}</span>
              <span className="sif-task-name">{t.name}</span>
              <span className={'sif-st ' + statusCls(t.lastStatus)}>{statusLabel(t.lastStatus)}</span>
            </div>
            <div className="sif-task-meta">{freqText(t)} · {t.mode === 'root' ? `${t.roots.length} 词根` : `${t.keywords.length} 词`} · 池 {t.asinLimit}</div>
            <div className="sif-task-foot">
              <span className="sif-task-time">日 {t.lastDailyAt || '—'} · 周 {t.lastWeeklyAt || '—'}</span>
              <span className="sif-task-ops">
                <button className="btn sif-btn-sm" disabled={t.lastStatus === 'running'}
                  onClick={e => { e.stopPropagation(); runNow(t); }}>{t.lastStatus === 'running' ? '抓取中' : '抓取'}</button>
                <button className="btn sif-btn-sm" onClick={e => { e.stopPropagation(); toggleTask(t); }}>{t.enabled ? '停用' : '启用'}</button>
                <button className="btn sif-btn-sm" onClick={e => { e.stopPropagation(); setForm({ open: true, task: t }); }}>编辑</button>
                <button className="btn sif-btn-sm sif-del" onClick={e => { e.stopPropagation(); delTask(t); }}>删</button>
              </span>
            </div>
            {retryHint(t) && (
              <div className={'sif-retry-hint' + (t.tripped ? ' sif-retry-tripped' : '')}>{retryHint(t)}</div>
            )}
            {t.lastError && <div className="sif-last-err">{t.lastError}</div>}
          </div>
        ))}
        <div className="sif-foot-stats">
          <div><b>{ov.keywords}</b>监控词</div>
          <div><b>{ov.asins}</b>监控 ASIN</div>
          <div><b>{fmtN(ov.totalCalls)}</b>累计调用</div>
        </div>
      </div>

      {/* ---- 右栏 ---- */}
      <div className="sif-main">
        <div className="sif-tabs">
          {TABS.map(t => (
            <button key={t.k} className={'sif-tab' + (tab === t.k ? ' sif-tab-on' : '')} onClick={() => setTab(t.k)}>
              {t.label}{t.k === 'signal' && cnt.total ? ` (${cnt.total})` : ''}
            </button>
          ))}
          <div className="sif-tabs-right">
            <select className="sif-mini" value={days} onChange={e => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>信号窗口 {d} 天</option>)}
            </select>
            {(board.dates || []).length > 1 && (
              <select className="sif-mini" value={date || board.runDate || ''} onChange={e => setDate(e.target.value || null)}>
                {board.dates.slice(0, 90).map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            <button className="btn sif-btn-sm" onClick={() => reload(false)}>刷新</button>
          </div>
        </div>

        {err && <div className="sif-err">{err}</div>}

        {tab === 'setting'
          ? <SettingsPanel settings={board.settings} onSaved={flash} />
          : !task
            ? <div className="sif-main-empty"><div className="sif-main-empty-ic">🔑</div>
              <div>先在左上新建一个监控任务</div></div>
            : (
              <>
                <div className="sif-detail-head">
                  <div>
                    <div className="sif-detail-title">{DIR_ICON[task.direction] || '🔎'} {task.name}
                      <span className={'sif-st ' + statusCls(task.lastStatus)}>{statusLabel(task.lastStatus)}</span>
                    </div>
                    <div className="sif-detail-sub">
                      {DIR_LABEL[task.direction] || '自定义'} · {task.country} · {freqText(task)} · topN {task.topN}
                      · 词上限 {task.quotaLimit} · 池上限 {task.asinLimit} · 数据日 {board.runDate || '—'}
                      <span className="sif-inline-tag">每日层 {task.lastDailyAt || '未跑'}</span>
                      <span className="sif-inline-tag">每周层 {task.lastWeeklyAt || '未跑'}</span>
                      {board.weeklyDue === false && <span className="sif-hint">（每周层满 {board.weeklyInterval || 7} 天自动附带）</span>}
                    </div>
                  </div>
                  <div className="sif-detail-ops">
                    <button className="btn btn-primary sif-btn-sm" disabled={task.lastStatus === 'running'}
                      onClick={() => runNow(task)}>{task.lastStatus === 'running' ? '抓取中…' : '立即抓取'}</button>
                    <button className="btn sif-btn-sm"
                      onClick={() => inspector.open({ type: 'promotion', keywords: (board.keywords || []).slice(0, 8).map(k => k.keyword) },
                        '推广可行性评估：本任务前 8 个词')}>这批词该打广告吗</button>
                  </div>
                </div>

                {/* ===== 看板 ===== */}
                {tab === 'board' && (
                  <>
                    <div className="sif-grid4">
                      <Stat k="当日机会词" v={String(kws.length)}
                        sub={`日环比上涨 ${kws.filter(k => (k.dod ?? 0) > 0).length} 个 · 新入榜 ${kws.filter(k => k.isNewEntry).length} 个`} />
                      <Stat k="监控 ASIN" v={String(asins.length)}
                        sub={`近30天销量合计 ${fmtN(asins.reduce((s, a) => s + (a.latest?.boughtMonth || 0), 0))}`} />
                      <Stat k={`近 ${Math.min(days, 30)} 天信号`} v={String(cnt.total)} sub={`高 ${cnt.high} · 中 ${cnt.warn} · 提示 ${cnt.info}`} />
                      <Stat k="数据日期" v={`${board.runDate || '—'}`}
                        sub={`ASIN 数据日 ${ov.latestAsinDate || '—'}（SIF T+1~T+2）`} />
                    </div>

                    {sigTop.length > 0 && (
                      <div className="sif-panel">
                        <div className="sif-panel-head">
                          <span className="sif-panel-title">异动榜（同一对象命中信号种类越多越靠前）</span>
                          <button className="btn sif-btn-sm" onClick={() => setTab('signal')}>看全部信号</button>
                        </div>
                        <div className="sif-chips" style={{ padding: '12px 14px' }}>
                          {sigTop.slice(0, 24).map((it, i) => (
                            <button key={i} className={'sif-chip sif-chip-btn sif-sev-' + it.severity}
                              onClick={() => { it.refType === 'keyword' ? setKwOpen(it.refId) : setAsinOpen(it.refId); }}>
                              {it.refType === 'keyword' ? '🔑' : '📦'} {it.refId}
                              <b>{it.kinds.map(k => SIGNAL_KIND[k]?.label || k).join(' · ')}</b>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="sif-two-col">
                      <div className="sif-panel">
                        <div className="sif-panel-head">
                          <span className="sif-panel-title">关键词榜</span>
                          <select className="sif-mini" value={kwSort} onChange={e => setKwSort(e.target.value as any)}>
                            <option value="volume">按搜索量</option><option value="dod">按日环比</option>
                            <option value="wow">按 7 日环比</option><option value="rank">按 ABA 排名</option>
                          </select>
                        </div>
                        <div className="sif-scroll">
                          <table className="sif-table">
                            <thead><tr><th>关键词</th><th>搜索量</th><th>日环比</th><th>7日</th><th>入场信号</th></tr></thead>
                            <tbody>
                              {kws.slice(0, 12).map(k => (
                                <tr key={k.keyword} className="sif-row" onClick={() => setKwOpen(k.keyword)}>
                                  <td className="sif-kw">{k.keyword}{k.isNewEntry && <span className="sif-badge">新</span>}</td>
                                  <td>{fmtN(k.searchVolume)}</td>
                                  <td><Delta v={k.dod} /></td>
                                  <td><Delta v={k.wow} /></td>
                                  <td className="sif-signal">{(k.entrySignal || '').slice(0, 42)}</td>
                                </tr>
                              ))}
                              {!kws.length && <tr><td colSpan={5} className="sif-hint">该日期没有快照数据，先点「立即抓取」</td></tr>}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      <div className="sif-panel">
                        <div className="sif-panel-head">
                          <span className="sif-panel-title">爆品榜</span>
                          <select className="sif-mini" value={asinSort} onChange={e => setAsinSort(e.target.value as any)}>
                            <option value="sales">按月销</option><option value="bsr">按 BSR</option>
                            <option value="growth">按销量增速</option><option value="new">按上架天数</option>
                          </select>
                        </div>
                        <div className="sif-scroll">
                          <table className="sif-table">
                            <thead><tr><th>ASIN / 产品</th><th>月销</th><th>7日增速</th><th>BSR</th></tr></thead>
                            <tbody>
                              {asins.slice(0, 12).map(a => (
                                <tr key={a.asin} className="sif-row" onClick={() => setAsinOpen(a.asin)}>
                                  <td><div className="sif-kw">{a.asin}</div>
                                    <div className="sif-sub">{(a.title || '').slice(0, 24)}
                                      {a.onSaleDays != null && a.onSaleDays <= (board.settings.thresholds.new_product_days || 180)
                                        ? ` · 上架${a.onSaleDays}天` : ''}</div></td>
                                  <td>{fmtN(a.latest?.boughtMonth ?? null)}</td>
                                  <td><Delta v={a.salesWow} /></td>
                                  <td>{fmtN(a.latest?.bsr ?? null)} <Delta v={a.bsrChg} invert /></td>
                                </tr>
                              ))}
                              {!asins.length && <tr><td colSpan={4} className="sif-hint">监控池为空：抓一次会自动入池，或在「爆品池」手动加</td></tr>}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>

                    <div className="sif-panel">
                      <div className="sif-panel-head"><span className="sif-panel-title">最新信号</span>
                        <button className="btn sif-btn-sm" onClick={() => setTab('signal')}>信号中心</button></div>
                      {allSignals.slice(0, 6).map(sg => (
                        <div key={sg.id} className="sif-sig-row"
                          onClick={() => { sg.refType === 'keyword' ? setKwOpen(sg.refId) : setAsinOpen(sg.refId); }}>
                          <SevTag s={sg.severity} />
                          <span className="sif-sig-kind">{SIGNAL_KIND[sg.kind]?.label || sg.kind}</span>
                          <span className="sif-sig-ref">{sg.refId}</span>
                          <span className="sif-sig-title">{sg.title}</span>
                          <span className="sif-sig-date">{sg.date}</span>
                        </div>
                      ))}
                      {!allSignals.length && (
                        <div className="sif-hint" style={{ padding: 14 }}>
                          近 {Math.min(days, 30)} 天暂无信号。信号需要至少 2 个数据日才能算环比——
                          先跑一两次抓取积累，或在「设置」里放宽阈值。
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* ===== 关键词 ===== */}
                {tab === 'kw' && (
                  <div className="sif-panel">
                    <div className="sif-panel-head">
                      <span className="sif-panel-title">关键词每日快照（{kws.length} 个 · {board.runDate}）</span>
                      <div className="sif-inline">
                        <input className="sif-mini sif-pool-input" placeholder="筛选关键词…"
                          value={kwFilter} onChange={e => setKwFilter(e.target.value)} />
                        <select className="sif-mini" value={kwSort} onChange={e => setKwSort(e.target.value as any)}>
                          <option value="volume">按搜索量</option><option value="dod">按日环比</option>
                          <option value="wow">按 7 日环比</option><option value="rank">按 ABA 排名</option>
                        </select>
                        <button className="btn sif-btn-sm" onClick={() => toCsv('sif_keywords_' + (board.runDate || ''),
                          kws.map(k => ({
                            keyword: k.keyword, search_volume: k.searchVolume, dod_pct: k.dod, wow_pct: k.wow,
                            aba_rank: k.rank, cpc: k.cpc, cvr: k.cvr, click_share_top3: k.clickShare,
                            traffic_cost: k.trafficCost, trend: k.profile?.trendDirection, yoy: k.profile?.yoyChange,
                            peak_month: k.profile?.peakMonth, weeks_to_peak: k.profile?.weeksToPeak,
                            root: k.root, entry_signal: k.entrySignal,
                          })))}>导出 CSV</button>
                      </div>
                    </div>
                    <div className="sif-scroll">
                      <table className="sif-table">
                        <thead><tr>
                          <th>关键词</th><th>搜索量</th><th>日环比</th><th>7日</th><th>近 7 日</th><th>ABA 排名</th>
                          <th>CPC</th><th>CVR</th><th>点击集中度</th><th>趋势 / 旺季</th><th>入场信号</th>
                        </tr></thead>
                        <tbody>
                          {kws.map(k => {
                            const u = universe.find(x => x.keyword === k.keyword);
                            return (
                              <tr key={k.keyword} className="sif-row" onClick={() => setKwOpen(k.keyword)}>
                                <td className="sif-kw">{k.keyword}{k.isNewEntry && <span className="sif-badge">新</span>}
                                  {k.root && <div className="sif-sub">词根 {k.root}</div>}</td>
                                <td>{fmtN(k.searchVolume)}</td>
                                <td><Delta v={k.dod} /></td>
                                <td><Delta v={k.wow} /></td>
                                <td title={u ? `自监控以来峰值 ${fmtN(u.peakVolume)}，最近收录 ${u.lastDate}` : undefined}>
                                  <Spark values={k.spark || []} /></td>
                                <td>{fmtN(k.rank)}</td>
                                <td>{fmtMoney(k.cpc)}</td>
                                <td>{k.cvr != null ? (Number(k.cvr) * 100).toFixed(1) + '%' : '—'}</td>
                                <td>{k.clickShare != null ? (Number(k.clickShare) * 100).toFixed(0) + '%' : '—'}</td>
                                <td>{k.profile?.trendDirection || '—'}
                                  {k.profile?.peakMonth ? ` · ${k.profile.peakMonth}月` : ''}
                                  {k.profile?.weeksToPeak != null ? `（约 ${k.profile.weeksToPeak} 周）` : ''}</td>
                                <td className="sif-signal">{k.entrySignal}</td>
                              </tr>
                            );
                          })}
                          {!kws.length && <tr><td colSpan={11} className="sif-hint">无当日快照</td></tr>}
                        </tbody>
                      </table>
                    </div>
                    <div className="sif-hint" style={{ padding: '8px 14px' }}>
                      口径：搜索量与日环比来自 SIF 每日刷新的估算值逐日对比（ABA 官方口径为周/月），不是官方日搜索量；
                      ABA 排名由每周层回填。点击任意行看日序列与深度点查分析。
                    </div>
                  </div>
                )}

                {/* ===== 爆品池 ===== */}
                {tab === 'asin' && (
                  <div className="sif-panel">
                    <div className="sif-panel-head">
                      <span className="sif-panel-title">
                        ASIN 监控池（活跃 {(pool?.pool || []).filter(a => a.active).length} 只 · 自动入池上限 {pool?.limit ?? task.asinLimit}，手动添加不受此限）</span>
                      <div className="sif-inline">
                        <input className="sif-mini sif-pool-input" placeholder="B0XXXXXX,B0YYYYYY"
                          value={poolAdd} onChange={e => setPoolAdd(e.target.value)} />
                        <button className="btn sif-btn-sm" onClick={addPool} disabled={!poolAdd.trim()}>加入并回补</button>
                        <select className="sif-mini" value={asinSort} onChange={e => setAsinSort(e.target.value as any)}>
                          <option value="sales">按月销</option><option value="bsr">按 BSR</option>
                          <option value="growth">按销量增速</option><option value="new">按上架天数</option>
                        </select>
                        <button className="btn sif-btn-sm" onClick={() => toCsv('sif_asins_' + (board.runDate || ''),
                          (pool?.pool || []).filter(a => a.active).map(a => ({
                            asin: a.asin, title: a.title, brand: a.brand, price: a.latest?.price ?? a.price,
                            bsr: a.latest?.bsr ?? null, bought_month_30d: a.latest?.boughtMonth ?? null,
                            review_num: a.latest?.reviewNum ?? null, nf_share_pct: a.nfShare,
                            on_sale_days: a.onSaleDays, source: a.source, stat_date: a.statDate,
                          })))}>导出 CSV</button>
                      </div>
                    </div>
                    <div className="sif-scroll">
                      <table className="sif-table">
                        <thead><tr>
                          <th>ASIN / 产品</th><th>来源</th><th>近30天销量</th><th>7日增速</th><th>BSR</th><th>BSR变动</th>
                          <th>价格</th><th>价格变动</th><th>评论数</th><th>自然占比</th><th>上架天数</th><th>入库天数</th><th></th>
                        </tr></thead>
                        <tbody>
                          {(pool?.pool || []).filter(a => a.active).map(a => (
                            <tr key={a.asin} className="sif-row" onClick={() => setAsinOpen(a.asin)}>
                              <td><div className="sif-kw">{a.asin}</div><div className="sif-sub">{(a.title || '').slice(0, 28)}</div></td>
                              <td>{a.source === 'opportunity' ? '机会词' : a.source === 'competitor' ? '词根竞品' : '手动'}</td>
                              <td>{fmtN(a.latest?.boughtMonth ?? null)}</td>
                              <td><Delta v={a.salesWow} /></td>
                              <td>{fmtN(a.latest?.bsr ?? null)}</td>
                              <td><Delta v={a.bsrChg} invert /></td>
                              <td>{fmtMoney(a.latest?.price ?? null)}</td>
                              <td><Delta v={a.priceChg} /></td>
                              <td>{fmtN(a.latest?.reviewNum ?? null)} <Delta v={a.reviewWow} /></td>
                              <td>{a.nfShare != null ? a.nfShare.toFixed(0) + '%' : '—'}</td>
                              <td>{a.onSaleDays != null ? a.onSaleDays + ' 天' : '—'}</td>
                              <td>{a.statDays ?? '—'}</td>
                              <td><button className="btn sif-btn-sm" onClick={e => { e.stopPropagation(); toggleAsin(a); }}>停用</button></td>
                            </tr>
                          ))}
                          {(pool?.pool || []).filter(a => !a.active).length > 0 && (
                            <tr><td colSpan={13} className="sif-hint">
                              已停用 {(pool!.pool.filter(a => !a.active)).length} 只：
                              {(pool!.pool.filter(a => !a.active)).slice(0, 6).map(a => (
                                <button key={a.asin} className="sif-link" style={{ marginRight: 10 }}
                                  onClick={() => toggleAsin(a)}>{a.asin} 重新启用</button>))}
                            </td></tr>
                          )}
                          {!(pool?.pool || []).some(a => a.active) && (
                            <tr><td colSpan={13} className="sif-hint">池为空：跑一次抓取会自动入池，也可在上方手动填 ASIN（会立即回补日数据）。</td></tr>)}
                        </tbody>
                      </table>
                    </div>
                    <div className="sif-hint" style={{ padding: '8px 14px' }}>
                      口径：SIF 的 ASIN 日粒度数据有 T+1~T+2 延迟，当前 ASIN 数据日 = {ov.latestAsinDate || '—'}；
                      每行的「最新值」取该 ASIN 最近一个有值的日期（{board.asins?.[0]?.statDate || '—'}），缺口日自动跳过。
                      实际调用数见「运行记录」。
                    </div>
                  </div>
                )}

                {/* ===== 信号中心 ===== */}
                {tab === 'signal' && (
                  <div className="sif-panel">
                    <div className="sif-panel-head">
                      <span className="sif-panel-title">信号中心（近 {days} 天 · {allSignals.length} 条）</span>
                      <div className="sif-seg">
                        {[['all', '全部'], ['high', '高'], ['warn', '中'], ['kw', '关键词'], ['asin', '爆品']].map(([k, l]) => (
                          <button key={k} className={'sif-seg-btn' + (sigFilter === k ? ' sif-seg-on' : '')}
                            onClick={() => setSigFilter(k)}>{l}</button>
                        ))}
                      </div>
                    </div>
                    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {signals.map(sg => (
                        <div key={sg.id} className={'sif-sig-card sif-sev-border-' + sg.severity + (sg.ack ? ' sif-ack' : '')}>
                          <div className="sif-sig-card-head">
                            <SevTag s={sg.severity} />
                            <span className="sif-sig-kind">{SIGNAL_KIND[sg.kind]?.label || sg.kind}</span>
                            <button className="sif-sig-ref"
                              onClick={() => { sg.refType === 'keyword' ? setKwOpen(sg.refId) : setAsinOpen(sg.refId); }}>
                              {sg.refId}</button>
                            <span className="sif-sig-date">{sg.date}</span>
                            <button className="btn sif-btn-sm"
                              onClick={() => api.ackSignal(sg.id, !sg.ack).then(() => reload())}>
                              {sg.ack ? '取消标记' : '标记已处理'}</button>
                          </div>
                          <div className="sif-sig-title">{sg.title}</div>
                          <div className="sif-sig-detail">
                            {Object.entries(sg.detail || {})
                              .filter(([k, v]) => !['title', 'img', 'url', 'sourceRef', 'entrySignal'].includes(k) && v !== null && v !== undefined)
                              .slice(0, 9).map(([k, v]: [string, any]) => (
                                <span key={k} className="sif-chip">{k}: {typeof v === 'number'
                                  ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : String(v)}</span>))}
                          </div>
                          <div className="sif-sig-ops">
                            {sg.refType === 'keyword' ? <>
                              <button className="btn sif-btn-sm" onClick={() => inspector.open({ type: 'competition', keyword: sg.refId })}>竞争格局</button>
                              <button className="btn sif-btn-sm" onClick={() => inspector.open({ type: 'root_trend', keyword: sg.refId })}>词根盘子</button>
                              <button className="btn sif-btn-sm" onClick={() => inspector.open({ type: 'promotion', keywords: [sg.refId] })}>该打广告吗</button>
                              <button className="btn sif-btn-sm" onClick={() => setKwOpen(sg.refId)}>看日序列</button>
                            </> : <>
                              <button className="btn sif-btn-sm" onClick={() => inspector.open({ type: 'asin_signals', asin: sg.refId })}>它靠哪些词</button>
                              <button className="btn sif-btn-sm" onClick={() => inspector.open({
                                type: 'profit', price: sg.detail?.price, category: sg.detail?.category || 'Home & Kitchen',
                                weight_oz: (sg.detail as any)?.weightOz,
                              }, '采购成本上限：' + sg.refId)}>算采购上限</button>
                              <button className="btn sif-btn-sm" onClick={() => setAsinOpen(sg.refId)}>看日趋势</button>
                            </>}
                          </div>
                        </div>
                      ))}
                      {!signals.length && <div className="sif-hint">该筛选下没有信号。</div>}
                    </div>
                  </div>
                )}

                {/* ===== 运行记录 ===== */}
                {tab === 'run' && (
                  <div className="sif-panel">
                    <div className="sif-panel-head">
                      <span className="sif-panel-title">运行记录（每次抓取的层级、调用数与统计）</span>
                      <span className="sif-hint">累计 {fmtN(ov.totalCalls)} 次 SIF 调用</span>
                    </div>
                    <div className="sif-scroll">
                      <table className="sif-table">
                        <thead><tr>
                          <th>日期</th><th>层</th><th>状态</th><th>调用数</th><th>发现词</th><th>监控/新增 ASIN</th>
                          <th>画像词</th><th>日数据点</th><th>信号</th><th>耗时</th><th>错误</th>
                        </tr></thead>
                        <tbody>
                          {(board.runs || []).map(r => {
                            const st = r.stats || {};
                            const secs = r.startedAt && r.finishedAt
                              ? Math.max(0, Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000))
                              : null;
                            return (
                              <tr key={r.id}>
                                <td>{r.runDate}</td>
                                <td>{r.tier === 'daily' ? '每日层' : r.tier === 'weekly' ? '每周层' : r.tier}</td>
                                <td>{r.status === 'done' ? '完成' : r.status === 'partial' ? '部分失败' : r.status === 'error' ? '失败' : r.status}</td>
                                <td>{st.calls ?? '—'}</td>
                                <td>{st.discovered ?? '—'}</td>
                                <td>{st.asin_monitored ?? '—'}{st.asin_new ? ` (+${st.asin_new})` : ''}</td>
                                <td>{st.profiles_updated ?? (st.weekly ? st.weekly.profiles_updated : '—') ?? '—'}</td>
                                <td>{st.asin_points_saved ?? '—'}</td>
                                <td>{st.signals ?? '—'}</td>
                                <td>{secs != null ? secs + 's' : '—'}</td>
                                <td className="sif-last-err">{(r.error || '').slice(0, 90)}</td>
                              </tr>
                            );
                          })}
                          {!(board.runs || []).length && <tr><td colSpan={11} className="sif-hint">还没有运行记录</td></tr>}
                        </tbody>
                      </table>
                    </div>
                    <div className="sif-hint" style={{ padding: '8px 14px' }}>
                      每日层 = 机会词发现 + ASIN 日数据（每天跑）；每周层 = 需求画像 + 周度趋势 + 词根竞品（≥{board.weeklyInterval || 7} 天搭在每日层里跑一次）。
                      竞争格局 / 推广可行性 / 采购上限等重接口只在手动点查时消耗调用，不出现在这里。
                    </div>
                  </div>
                )}
              </>
            )}
      </div>

      {msg && <div className="sif-msg">{msg}</div>}
      {form.open && (
        <TaskForm task={form.task} defaults={board.settings.defaults}
          onClose={() => setForm({ open: false, task: null })}
          onSaved={m => { setForm({ open: false, task: null }); flash(m); reload(false); }} />
      )}
      {kwOpen && taskId && (
        <KwDetail taskId={taskId} kw={kwOpen} onClose={() => setKwOpen(null)} onInspect={(b, t) => inspector.open(b, t)} />
      )}
      {asinOpen && taskId && (
        <AsinDetail taskId={taskId} asin={asinOpen} onClose={() => setAsinOpen(null)}
          onInspect={(b, t) => inspector.open(b, t)}
          onChanged={async () => { if (taskId) setPool(await api.pool(taskId)); reload(); }} />
      )}
      {inspector.node}
    </div>
  );
}
