import React, { useState, useEffect } from 'react';
import { marked } from 'marked';
import { LineChart } from './SifKeyword';

const AUTH_TOKEN_KEY = 'fba-auth-v1';
export function authHeaders(): Record<string, string> {
  const t = localStorage.getItem(AUTH_TOKEN_KEY) || '';
  return t ? { Authorization: 'Bearer ' + t } : {};
}

// 以后加新 skill：这里加一条（Sidebar.tsx 会据此渲染"AI分析"分组下的按钮），
// 后端 backend/workers/ai_analysis_worker.py 的 AI_SKILLS 字典也要加一条同 id 的对应项。
// rootOnly=true 的技能只对 root 可见（后端 PUBLIC_SKILLS 之外的一律仍挂 root 门禁）。
export const AI_SKILLS = [
  { id: 'cosmo-diagnose', ic: '🩺', label: 'CosmoDiagnose', desc: 'Amazon Listing 诊断（COSMO）', rootOnly: true },
  { id: 'traffic-compare', ic: '📈', label: '流量分析', desc: '自身流量结构 + 竞品流量对比（SIF 数据源）', rootOnly: false },
  { id: 'rank-monitor', ic: '📊', label: '排名监测', desc: '关键词下竞品排名 / ASIN 各词自然排名，支持每日监测', rootOnly: false },
  { id: 'catmon', ic: '🏆', label: '类目榜单监控', desc: 'Amazon 类目畅销榜 / 新品榜采集，点击按需查看详情', rootOnly: false },
];

/** 当前角色可见的技能：root 看全部，其他角色只看非 rootOnly 的 */
export function visibleAiSkills(isRoot: boolean) {
  return AI_SKILLS.filter(s => !s.rootOnly || isRoot);
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中', running: '分析中…', done: '已完成', failed: '失败', cancelled: '已终止',
};

interface AiFile { name: string; type: string; }
interface AiTask {
  id: string;
  skillId: string;
  asin: string;
  params: { alexaQuestions?: number };
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  summary: string | null;
  files: AiFile[];
  createdAt: string;
  completedAt: string | null;
}

// ---- 流量分析数据类型（对应 backend/traffic_compare.py 的 data.json） ----
interface KeywordSignal {
  keyword: string;
  traffic_share: number | null;
  contri_change: number | null;
  organic_rank: number | null;
  rank_evolution: string | null;
  health: string | null;
  search_volume: number | null;
  natural_ratio: number | null;
  top3_click_share: number | null;
}
interface PriceBand {
  own_price: number;
  competitor_count: number;
  min: number;
  median: number;
  max: number;
  premium_pct: number | null;
}
interface TrafficChannel {
  key: string; name: string;
  score: number | null; share_of_ad: number | null; share_of_total: number | null;
}
interface TrafficStats {
  days: number;
  avg_total: number | null;
  natural_ratio_median: number | null;
  ad_ratio_median: number | null;
  slope_total: number | null;
  slope_nf: number | null;
  slope_ad: number | null;
  last_week_vs_prev_week_pct: number | null;
  volatility_cv: number | null;
  peak: { date: string; total: number } | null;
  trough: { date: string; total: number } | null;
  price: { first: number; last: number; change_pct: number | null } | null;
  bsr: { first: number; last: number; change_pct: number | null; improve_pct?: number | null } | null;
  review: { first: number; last: number; change_pct: number | null } | null;
  excluded_last_point: boolean;
}
interface TrafficDataset {
  meta: {
    asin: string; country: string; days: number; sif_calls: number;
    dataset_id?: string;
    period_type: string;
    period_value: string;
    period_label: string;
    period_window_start: string | null;
    period_window_end: string | null;
    period_notes: string[];
    latest_point_date: string | null; latest_point_complete: boolean | null;
    data_notice?: string | null;
  };
  own: {
    asin: string;
    profile: any;
    overview: {
      total: number | null;
      nf: { name: string | null; score: number | null; ratio: number | null };
      ad: { name: string | null; score: number | null; ratio: number | null };
      channels: TrafficChannel[];
      recommend: { name: string; ratio: number | null; score: number | null }[];
      notice?: string | null;
    };
    trend: {
      dates: string[]; total: (number | null)[]; nf: (number | null)[];
      ad: (number | null)[]; price: (number | null)[]; bsr: (number | null)[];
    };
    stats: TrafficStats;
    variants: any[];
    variant_concentration: { variant_count: number; variants_with_flow: number; top1_share: number | null; hhi: number | null } | null;
    keywords?: any[];
    keyword_signals?: {
      top_keywords?: KeywordSignal[];
      rank_gaps?: KeywordSignal[];
      declining?: KeywordSignal[];
      gaining?: KeywordSignal[];
    };
    errors?: Record<string, string>;
  };
  competitors: any[];
  price_band?: PriceBand | null;
  auto_competitor_pool: any[];
  auto_note?: string;
  auto_used_keywords?: string[];
}

class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

function mapTask(row: any): AiTask {
  return {
    id: row.id,
    skillId: row.skill_id,
    asin: row.asin,
    params: row.params || {},
    status: row.status,
    error: row.error,
    summary: row.summary,
    files: row.files || [],
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

// ---- API ----
async function apiListAiTasks(skillId: string): Promise<AiTask[]> {
  const r = await fetch('/api/ai/tasks?skillId=' + encodeURIComponent(skillId), { headers: authHeaders() });
  if (!r.ok) throw new Error('加载历史任务失败');
  const data = await r.json();
  return (data.tasks || []).map(mapTask);
}
async function apiGetAiTask(id: string): Promise<AiTask> {
  const r = await fetch('/api/ai/task?id=' + encodeURIComponent(id), { headers: authHeaders() });
  if (!r.ok) throw new Error('加载任务失败');
  return mapTask(await r.json());
}
async function apiRunAi(skillId: string, asin: string, params: any): Promise<string> {
  const r = await fetch('/api/ai/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ skillId, asin, params }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new ApiError(e.error || '创建任务失败', e.code);
  }
  return (await r.json()).taskId;
}
async function apiDeleteAiTask(id: string): Promise<void> {
  await fetch('/api/ai/tasks?id=' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
}
async function apiLoginSkill(skillId: string): Promise<void> {
  const r = await fetch('/api/ai/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ skillId }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || '发起登录失败');
  }
}
async function apiCancelTask(id: string): Promise<void> {
  const r = await fetch('/api/ai/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || '终止失败');
  }
}
/** 取数预览：纯 SIF 调用，不创建 AI 任务、不产生 AI 费用。
 *  periodType/periodValue 会由后端 normalize_period() 归一化为 SIF 合法格式。 */
async function apiTrafficPreview(
  asin: string, periodType: string, periodValue: string,
  competitorAsins: string[], autoCompetitors: boolean,
): Promise<{ datasetId: string; data: TrafficDataset }> {
  const r = await fetch('/api/ai/traffic/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ asin, periodType, periodValue, competitorAsins, autoCompetitors }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new ApiError(e.error || '取数失败', e.code);
  }
  return await r.json();
}

/** 生成 Markdown 分析报告（调后端配置的模型，一次调用，同步返回）。 */
async function apiTrafficReport(datasetId: string, force = false): Promise<{
  markdown: string; meta: any; cached: boolean;
}> {
  const r = await fetch('/api/ai/traffic/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ datasetId, force }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new ApiError(e.error || '生成报告失败', e.code);
  }
  return await r.json();
}

/** 模型配置摘要（不含 key），用于决定按钮是否可用 */
async function apiLlmInfo(): Promise<any> {
  const r = await fetch('/api/ai/traffic/llm', { headers: authHeaders() });
  if (!r.ok) throw new Error('读取模型配置失败');
  return await r.json();
}

/** 读取已生成的 Markdown 报告（不存在抛错） */
async function apiTrafficReportGet(datasetId: string): Promise<{ markdown: string; meta: any }> {
  const r = await fetch('/api/ai/traffic/report?datasetId=' + encodeURIComponent(datasetId),
    { headers: authHeaders() });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new ApiError(e.error || '读取报告失败', e.code);
  }
  return await r.json();
}

/** 报告历史（历史列表数据源） */
async function apiTrafficHistory(): Promise<any[]> {
  const r = await fetch('/api/ai/traffic/history', { headers: authHeaders() });
  if (!r.ok) throw new Error('加载报告历史失败');
  return (await r.json()).reports || [];
}

async function apiDeleteTrafficHistory(id: string): Promise<void> {
  const r = await fetch('/api/ai/traffic/history?id=' + encodeURIComponent(id),
    { method: 'DELETE', headers: authHeaders() });
  if (!r.ok) throw new Error('删除失败');
}

/** 按 datasetId 回放数据集（点历史项恢复预览上下文） */
async function apiTrafficDataset(datasetId: string): Promise<{ datasetId: string; data: TrafficDataset }> {
  const r = await fetch('/api/ai/traffic/dataset?datasetId=' + encodeURIComponent(datasetId),
    { headers: authHeaders() });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new ApiError(e.error || '数据集已清理，请重新取数', e.code);
  }
  return await r.json();
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const m = iso.match(/\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}
function fileUrl(taskId: string, name: string, mode: 'inline' | 'download'): string {
  return `/api/ai/file?taskId=${encodeURIComponent(taskId)}&name=${encodeURIComponent(name)}&mode=${mode}`;
}

/** 模型输出属于「半可信」内容：渲染前剥掉脚本、iframe 与事件属性，避免意外注入 */
function sanitizeHtml(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

// ---- 周期工具（与 SIF 的 timePiece 语义严格对齐，避免传参错误） ----
type PeriodType = 'latelyDay' | 'week' | 'month';

function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
/** SIF 以周日为每周第一天：返回该日期所在周的周日（传非周日会静默拿空数据） */
function weekSundayOf(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const sun = new Date(d);
  sun.setDate(d.getDate() - d.getDay());   // getDay(): 0=周日
  return isoDate(sun);
}
/** 上一个完整周的周日（当周数据因 T+1 延迟不完整） */
function defaultWeek(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() - 7);
  return isoDate(d);
}
function defaultMonth(): string {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

// ---- 流量分析展示小工具 ----
function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: digits });
}
function fmtShare(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !isFinite(Number(v))) return '—';
  return (Number(v) * 100).toFixed(digits) + '%';
}
function fmtSigned(v: number | null | undefined, digits = 1, suffix = '%'): string {
  if (v === null || v === undefined || !isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}${suffix}`;
}
/** 涨跌着色（项目习惯：涨红跌绿）。invert 参数保留给「已反向的指标」，
 *  例如 bsr.improve_pct 正数=排名变好，语义上与普通正数一致，颜色仍按正=红处理。 */
function tone(v: number | null | undefined, _invert = false): string {
  if (v === null || v === undefined || !isFinite(Number(v))) return '';
  const n = Number(v);
  if (Math.abs(n) < 0.05) return '';
  return n > 0 ? 'tf-up' : 'tf-down';
}

const CH_COLORS = ['var(--blue)', 'var(--orange)', 'var(--purple)', '#0891b2', '#a16207'];
const CH_LABEL: Record<string, string> = {
  sp: 'SP常规', recommend: 'SP推荐', sb: 'SB', sbv: 'SBV',
};

/** 流量结构堆叠条：自然 + 各广告渠道，合计按「占总量」口径铺满 100% */
function ShareBar({ nfRatio, channels }: { nfRatio: number | null; channels: TrafficChannel[] }) {
  const segs = [
    { name: '自然流量', v: nfRatio || 0, color: 'var(--green)' },
    ...channels.map((c, i) => ({
      name: c.name || CH_LABEL[c.key] || c.key,
      v: c.share_of_total || 0,
      color: CH_COLORS[i % CH_COLORS.length],
    })),
  ].filter(s => s.v > 0);
  const sum = segs.reduce((a, b) => a + b.v, 0) || 1;
  if (!segs.length) return <div className="ai-empty">无流量结构数据</div>;
  return (
    <div className="tf-share">
      <div className="tf-share-bar">
        {segs.map((s, i) => (
          <div key={i} className="tf-share-seg" style={{ width: `${(s.v / sum) * 100}%`, background: s.color }}
            title={`${s.name} ${(s.v * 100).toFixed(1)}%`} />
        ))}
      </div>
      <div className="tf-share-legend">
        {segs.map((s, i) => (
          <span key={i} className="tf-share-item">
            <i style={{ background: s.color }} />{s.name} <b>{(s.v * 100).toFixed(1)}%</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, hint, cls }: { label: string; value: React.ReactNode; hint?: string; cls?: string }) {
  return (
    <div className="tf-metric">
      <div className="tf-metric-label">{label}</div>
      <div className={'tf-metric-value ' + (cls || '')}>{value}</div>
      {hint && <div className="tf-metric-hint">{hint}</div>}
    </div>
  );
}

// ---- 关键词信号（报告里「调哪些词」的依据） ----
type KwGroupKey = 'top_keywords' | 'rank_gaps' | 'declining' | 'gaining';
const KW_GROUPS: { key: KwGroupKey; label: string; hint: string }[] = [
  { key: 'top_keywords', label: 'Top 词', hint: '按流量占比排序' },
  { key: 'rank_gaps', label: '排名断档', hint: '有流量但自然位缺失或靠后' },
  { key: 'declining', label: '贡献下滑', hint: '流量贡献在下降' },
  { key: 'gaining', label: '增长词', hint: '流量贡献在上升' },
];

/** 自然排名 → 人话。SIF 没有自然位时返回 null，不等于排名靠后，必须区分 */
export function rankText(r: number | null | undefined): string {
  if (r === null || r === undefined) return '无自然位';
  // 排名必须取整：接口/历史数据里可能是 12.0，直接插值会显示成「#12.0 第2页」
  const n = Math.round(Number(r));
  if (!Number.isFinite(n) || n <= 0) return '无自然位';
  if (n <= 10) return `#${n} 第1页`;
  if (n <= 30) return `#${n} 前3页`;
  return `#${n} 第${Math.ceil(n / 10)}页`;
}
export function rankCls(r: number | null | undefined): string {
  if (r === null || r === undefined || r <= 0) return 'tf-rank-none';
  if (r <= 10) return 'tf-rank-top';
  if (r <= 30) return 'tf-rank-mid';
  return 'tf-rank-low';
}

/** 价格带兜底：旧数据集没有 price_band 字段时前端自己算，保证历史记录也能显示。
 *  算法与后端 statistics.median 一致（偶数个取中间两个的平均）。 */
function computeBand(data: TrafficDataset): PriceBand | null {
  const own = data.own?.profile?.price;
  const prices = (data.competitors || [])
    .filter((c: any) => !c.error && c.profile?.price != null)
    .map((c: any) => Number(c.profile.price));
  if (!own || !prices.length) return null;
  const sorted = prices.sort((a, b) => a - b);
  const mid = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    own_price: own,
    competitor_count: sorted.length,
    min: sorted[0],
    median: mid,
    max: sorted[sorted.length - 1],
    premium_pct: mid ? (own - mid) / mid * 100 : null,
  };
}

function KeywordSignals({ signals }: {
  signals: NonNullable<TrafficDataset['own']['keyword_signals']>;
}) {
  const groups = KW_GROUPS.filter(g => (signals[g.key] || []).length > 0);
  const [active, setActive] = useState<KwGroupKey>(groups[0]?.key || 'top_keywords');
  const rows = (signals[active] || []) as KeywordSignal[];
  if (!groups.length) return <div className="ai-empty">本期未采集到关键词信号</div>;
  return (
    <>
      <div className="tf-mini-tabs">
        {groups.map(g => (
          <button key={g.key} className="tf-mini-tab" data-active={active === g.key}
            onClick={() => setActive(g.key)} title={g.hint}>
            {g.label}<i>{(signals[g.key] || []).length}</i>
          </button>
        ))}
      </div>
      <div className="tf-table-wrap">
        <table className="tf-table">
          <thead>
            <tr><th>关键词</th><th>流量占比</th><th>自然排名</th><th>自然位占比</th>
              <th>Top3点击</th><th>搜索量</th><th>状态</th></tr>
          </thead>
          <tbody>
            {rows.map(k => (
              <tr key={k.keyword}>
                <td className="tf-kw">{k.keyword}</td>
                <td className="mono">{fmtShare(k.traffic_share)}</td>
                <td className={'mono ' + rankCls(k.organic_rank)}>{rankText(k.organic_rank)}</td>
                <td className="mono">{fmtShare(k.natural_ratio)}</td>
                <td className="mono">{fmtShare(k.top3_click_share)}</td>
                <td className="mono">{fmtNum(k.search_volume)}</td>
                <td><span className={'tf-health tf-health-' + (k.health || 'none')}>{k.health || '—'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** 找渠道结构里差异最大的一项，用一句话表达 */
function topChannelDiff(diff: Record<string, number | null> | undefined): string {
  if (!diff) return '—';
  const items = Object.entries(diff)
    .filter(([, v]) => v !== null && v !== undefined && Math.abs(Number(v)) >= 0.5) as [string, number][];
  if (!items.length) return '结构接近';
  items.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const [k, v] = items[0];
  return `${CH_LABEL[k] || k} ${v > 0 ? '+' : ''}${v.toFixed(1)}pp`;
}

function TrafficPanel({ data, selected, onToggle, onApply, busy,
  report, reportBusy, onGenerate, llm, onDownloadReport }: {
  data: TrafficDataset;
  selected: string[];
  onToggle: (asin: string) => void;
  onApply: () => void;
  busy: boolean;
  report: { markdown: string; meta: any } | null;
  reportBusy: boolean;
  onGenerate: (force?: boolean) => void;
  llm: any;
  onDownloadReport: () => void;
}) {
  const own = data.own;
  const st = own.stats || ({} as TrafficStats);
  const ov = own.overview;
  const trend = own.trend;
  const comps = data.competitors || [];
  const pool = data.auto_competitor_pool || [];
  const conc = own.variant_concentration;
  const lastIncomplete = data.meta.latest_point_complete === false;
  const band = data.price_band || computeBand(data);
  // 数据预览 / 分析报告 两个 tab：报告不再压在所有数据下面，免得看完结论要一路滚回去
  const [tab, setTab] = useState<'data' | 'report'>('data');
  useEffect(() => {
    // 报告出现 → 落到报告 tab；报告被清空（重新取数）→ 回数据 tab
    setTab(report ? 'report' : 'data');
  }, [report]);

  return (
    <>
      <div className="ai-main-head">
        <div className="ai-main-title">
          <span className="mono">{data.meta.asin}</span>
          <span className="ai-status ai-status-done">取数完成</span>
          {lastIncomplete && <span className="ai-status ai-status-running">末点未出完</span>}
        </div>
        <div className="ai-main-sub">
          {data.meta.country} · {data.meta.period_label} · 父体聚合口径（listingSearch=true）·
          数据截至 {data.meta.latest_point_date || '—'} · SIF 调用 {data.meta.sif_calls} 次
        </div>
      </div>

      {data.meta.period_notes?.length > 0 && (
        <div className="tf-note tf-warn">
          周期已自动调整：{data.meta.period_notes.join('；')}
        </div>
      )}

      <div className="tf-tabs">
        <button className="tf-tab" data-active={tab === 'data'} onClick={() => setTab('data')}>
          数据预览
        </button>
        <button className="tf-tab" data-active={tab === 'report'} onClick={() => setTab('report')}>
          分析报告
          {report ? <i className="tf-tab-dot" title="报告已生成" /> : null}
        </button>
        <span className="tf-tabs-spacer" />
        {llm?.configured ? (
          <button className="tf-tab-gen" onClick={() => { setTab('report'); onGenerate(!!report); }}
            disabled={reportBusy}>
            {reportBusy ? '生成中…' : (report ? '重新生成' : '生成报告')}
          </button>
        ) : (
          <span className="tf-tab-gen-hint">未配置模型</span>
        )}
      </div>

      {tab === 'data' ? (
        <>
      {/* KPI */}
      <div className="tf-kpis">
        <Metric label="日均流量分（无量纲）" value={fmtNum(st.avg_total, 0)}
          hint={`峰值 ${st.peak?.date || '—'} / 谷值 ${st.trough?.date || '—'}`} />
        <Metric label="自然流量占比（中位数）" value={fmtShare(st.natural_ratio_median)}
          hint={`广告占比 ${fmtShare(st.ad_ratio_median)}`}
          cls={(st.natural_ratio_median ?? 1) < 0.6 ? 'tf-bad' : ''} />
        <Metric label="近 7 天 vs 前 7 天" value={fmtSigned(st.last_week_vs_prev_week_pct)}
          hint="流量分均值环比" cls={tone(st.last_week_vs_prev_week_pct)} />
        <Metric label="趋势斜率（每周）" value={fmtSigned(st.slope_total)}
          hint={`自然 ${fmtSigned(st.slope_nf)} / 广告 ${fmtSigned(st.slope_ad)}`}
          cls={tone(st.slope_total)} />
      </div>

      {/* 结构 */}
      <div className="tf-card">
        <div className="tf-card-head">
          <span>流量结构</span>
          <span className="tf-card-sub">总量 {fmtNum(ov.total, 0)} 分</span>
        </div>
        <ShareBar nfRatio={ov.nf.ratio} channels={ov.channels} />
        {ov.recommend?.length > 0 && (
          <div className="tf-rec">
            <span className="tf-rec-label">推荐专栏来源：</span>
            {ov.recommend.slice(0, 4).map((r, i) => (
              <span key={i} className="tf-rec-item">{r.name} {fmtShare(r.ratio)}</span>
            ))}
          </div>
        )}
        <div className="tf-note">
          口径：渠道百分比为「占总量」；SIF score 是无量纲相对分，只能看占比与涨跌，不代表 UV。
        </div>
      </div>

      {/* 趋势 */}
      <div className="tf-card">
        <div className="tf-card-head">
          <span>流量趋势</span>
          <span className="tf-card-sub">
            波动系数 {st.volatility_cv === null ? '—' : st.volatility_cv.toFixed(2)}
            {st.excluded_last_point ? ' · 末点未出完已排除' : ''}
          </span>
        </div>
        {trend.dates.length >= 2 ? (
          <LineChart
            dates={trend.dates}
            series={[
              { name: '总流量', color: 'var(--blue)', values: trend.total },
              { name: '自然', color: 'var(--green)', values: trend.nf },
              { name: '广告', color: 'var(--orange)', values: trend.ad },
            ]}
          />
        ) : <div className="ai-empty">趋势数据不足（至少需要 2 天）</div>}
      </div>

      {/* 价格 / BSR / 评论 + 变体 */}
      <div className="tf-row2">
        <div className="tf-card">
          <div className="tf-card-head"><span>同期变化</span></div>
          <table className="tf-table">
            <tbody>
              <tr>
                <td>价格</td>
                <td className="mono">{fmtNum(st.price?.first, 2)} → {fmtNum(st.price?.last, 2)}</td>
                <td className={tone(st.price?.change_pct)}>{fmtSigned(st.price?.change_pct)}</td>
              </tr>
              <tr>
                <td>BSR</td>
                <td className="mono">{fmtNum(st.bsr?.first)} → {fmtNum(st.bsr?.last)}</td>
                <td className={tone(st.bsr?.improve_pct, true)}>{fmtSigned(st.bsr?.improve_pct)}</td>
              </tr>
              <tr>
                <td>评论数</td>
                <td className="mono">{fmtNum(st.review?.first)} → {fmtNum(st.review?.last)}</td>
                <td className={tone(st.review?.change_pct)}>{fmtSigned(st.review?.change_pct)}</td>
              </tr>
            </tbody>
          </table>
          <div className="tf-note">BSR 显示为「改善幅度」，正数表示排名变好。</div>
        </div>

        <div className="tf-card">
          <div className="tf-card-head">
            <span>变体集中度</span>
            {conc && <span className="tf-card-sub">{conc.variant_count} 个变体中 {conc.variants_with_flow} 个有流量</span>}
          </div>
          {conc ? (
            <>
              <div className="tf-kpis tf-kpis-2">
                <Metric label="Top1 变体流量占比" value={fmtShare(conc.top1_share)} />
                <Metric label="HHI" value={conc.hhi === null ? '—' : conc.hhi.toFixed(2)}
                  hint={conc.hhi !== null && conc.hhi > 0.5 ? '高度集中' : '相对分散'} />
              </div>
              <table className="tf-table tf-table-compact">
                <thead><tr><th>变体</th><th>流量占比</th><th>自然占比</th><th>词数</th></tr></thead>
                <tbody>
                  {(own.variants || []).slice(0, 5).map((v: any) => (
                    <tr key={v.asin}>
                      <td className="mono">{v.asin}<div className="tf-tiny">{(v.features || []).join(' / ')}</div></td>
                      <td className="mono">{fmtShare(v.flow_ratio)}</td>
                      <td className="mono">{fmtShare(v.nf_share_in_variant)}</td>
                      <td className="mono">{fmtNum(v.kw_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : <div className="ai-empty">无变体数据</div>}
        </div>
      </div>

      {/* 竞品对比 */}
      <div className="tf-card">
        <div className="tf-card-head">
          <span>竞品流量对比</span>
          <span className="tf-card-sub">
            {comps.length ? `${comps.length} 个竞品 · 同口径` : '未选竞品'}
            {data.auto_used_keywords?.length ? ` · 推荐依据：${data.auto_used_keywords.join(' / ')}` : ''}
          </span>
        </div>

        {band && (
          <div className="tf-band">
            <span>自身 <b>${fmtNum(band.own_price, 2)}</b></span>
            <span>竞品中位 <b>${fmtNum(band.median, 2)}</b></span>
            <span className="tf-band-range">
              区间 ${fmtNum(band.min, 2)} ~ ${fmtNum(band.max, 2)}（n={band.competitor_count}）
            </span>
            <span>对中位溢价{' '}
              <b className={(band.premium_pct ?? 0) > 20 ? 'tf-bad' : ''}>
                {fmtSigned(band.premium_pct)}
              </b>
            </span>
          </div>
        )}

        {comps.length === 0 ? (
          <div className="ai-empty">
            {data.auto_note || '暂无竞品。可在左侧填写竞品 ASIN，或从下方候选里勾选。'}
          </div>
        ) : (
          <div className="tf-table-wrap">
            <table className="tf-table">
              <thead>
                <tr>
                  <th>竞品</th><th>价格</th><th>总流量倍数</th><th>自然占比</th>
                  <th>自然占比差</th><th>斜率差</th><th>渠道结构差</th><th>提示</th>
                </tr>
              </thead>
              <tbody>
                {comps.map((c: any) => c.error ? (
                  <tr key={c.asin}>
                    <td className="mono">{c.asin}</td>
                    <td colSpan={7} className="tf-err-cell">取数失败：{c.error}</td>
                  </tr>
                ) : (
                  <tr key={c.asin}>
                    <td>
                      <div className="mono">{c.asin}</div>
                      <div className="tf-tiny">{c.profile?.brand || '—'}</div>
                    </td>
                    <td className="mono">${fmtNum(c.profile?.price, 2)}</td>
                    <td className="mono">{c.compare?.total_multiple_vs_own === null || c.compare?.total_multiple_vs_own === undefined
                      ? '—' : c.compare.total_multiple_vs_own.toFixed(2) + '×'}</td>
                    <td className="mono">{fmtShare(c.stats?.natural_ratio_median)}</td>
                    <td className={tone(c.compare?.natural_ratio_diff_pp)}>{fmtSigned(c.compare?.natural_ratio_diff_pp, 1, 'pp')}</td>
                    <td className={tone(c.compare?.slope_diff_pct_per_week)}>{fmtSigned(c.compare?.slope_diff_pct_per_week)}</td>
                    <td className="mono">{topChannelDiff(c.compare?.channel_share_diff_pp)}</td>
                    <td className="tf-tiny">
                      {c.compare?.warnings?.length ? c.compare.warnings.join('；') : '可比'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="tf-note">
          总流量倍数 = 竞品窗口均值 ÷ 自身窗口均值（SIF 分为相对值，倍数只说明规模差，不等于销量差）。
          自然占比差为竞品减自身，单位百分点。
        </div>
      </div>

      {/* 关键词信号 */}
      {own.keyword_signals && (
        <div className="tf-card">
          <div className="tf-card-head">
            <span>关键词信号</span>
            <span className="tf-card-sub">报告里「调哪些词」的依据 · 近 30 天</span>
          </div>
          <KeywordSignals signals={own.keyword_signals} />
          <div className="tf-note">
            「无自然位」表示该词有流量但 listing 没进自然结果，不等于排名靠后；
            排名为页内位置，数字越小越好。状态为 SIF 的健康度判定（core 稳 / volatile 波动 / at_risk 有风险）。
          </div>
        </div>
      )}

      {/* 候选池 */}
      {pool.length > 0 && (
        <div className="tf-card">
          <div className="tf-card-head">
            <span>竞品候选（自动推荐）</span>
            <span className="tf-card-sub">勾选后点右侧按钮重新取数</span>
          </div>
          <div className="tf-pool">
            {pool.map((c: any) => {
              const checked = selected.includes(c.asin);
              return (
                <label key={c.asin} className={'tf-pool-item' + (checked ? ' is-checked' : '')}>
                  <input type="checkbox" checked={checked} onChange={() => onToggle(c.asin)} disabled={busy} />
                  <div className="tf-pool-main">
                    <div className="tf-pool-top">
                      <span className="mono">{c.asin}</span>
                      <span className="tf-tiny">{c.profile?.brand || '—'} · ${fmtNum(c.profile?.price, 2)}</span>
                    </div>
                    <div className="tf-tiny">
                      命中 {c.hits} 个词（{(c.hit_keywords || []).join('、')}）· 评论 {fmtNum(c.profile?.rating_num)}
                      {c.warnings?.length ? ` · ⚠ ${c.warnings.join('；')}` : ''}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="ai-actions">
            <button className="btn btn-sm" onClick={onApply} disabled={busy || !selected.length}>
              {busy ? '取数中…' : `用所选 ${selected.length} 个竞品重新取数`}
            </button>
          </div>
        </div>
      )}

        </>
      ) : (
        <>
      {/* 分析报告（模型生成，Markdown 直接渲染） */}
      <div className="tf-card">
        <div className="tf-card-head">
          <span>分析报告</span>
          <span className="tf-card-sub">
            {report
              ? `${report.meta?.model || '模型'} · ${report.meta?.report_chars || 0} 字 · ${report.meta?.elapsed ?? '?'}s`
              : (llm?.configured ? `模型：${llm.model}` : '未配置模型')}
          </span>
        </div>

        {!report ? (
          <>
            <div className="tf-note">
              {llm?.configured
                ? '基于当前取数数据生成 Markdown 报告（约 30~90 秒）。报告只引用数据预览里已有的数字，不会自己重算，也不会换算成绝对流量。点右上角「生成报告」开始。'
                : '未检测到模型配置。请在 data/ai-config.json 填入 api_key，详见下方说明；改完无需重启（配置有 30 秒缓存）。'}
            </div>
          </>
        ) : (
          <>
            <div className="tf-report"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parse(report.markdown, { async: false }) as string) }} />
            <div className="ai-actions">
              <button className="btn btn-sm" onClick={onDownloadReport}>下载 .md</button>
            </div>
          </>
        )}
      </div>
        </>
      )}

      {own.errors && Object.keys(own.errors).length > 0 && (
        <div className="tf-note tf-warn">
          部分数据缺失：{Object.entries(own.errors).map(([k, v]) => `${k}（${v}）`).join('；')}
        </div>
      )}

      <div className="tf-note">
        实际查询：{data.meta.period_type} / {data.meta.period_value}
        {data.meta.period_window_start ? `（${data.meta.period_window_start} ~ ${data.meta.period_window_end}）` : ''}
        · dataset {data.meta.dataset_id || '—'}
      </div>
    </>
  );
}

// ============================================================
// Main AiAnalyze component
// 技能通过 Sidebar 的"AI分析"分组按钮选择，本组件只负责单个技能内部的
// ASIN 输入 / 历史记录 / 结果展示，skillId 由父级（app.tsx）传入。
// ============================================================
export function AiAnalyze({ skillId }: { skillId: string }) {
  const skill = AI_SKILLS.find(s => s.id === skillId);
  const isTraffic = skillId === 'traffic-compare';
  const [asinInput, setAsinInput] = useState('');
  const [alexaQuestions, setAlexaQuestions] = useState(3);
  // 时间维度：对应 SIF 的 timePieceType / timePieceValue
  const [periodType, setPeriodType] = useState<PeriodType>('latelyDay');
  const [latelyDays, setLatelyDays] = useState<'7' | '30'>('30');
  const [weekDate, setWeekDate] = useState<string>(() => defaultWeek());
  const [monthVal, setMonthVal] = useState<string>(() => defaultMonth());
  const [compInput, setCompInput] = useState('');
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<AiTask | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [loginRequired, setLoginRequired] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [preview, setPreview] = useState<{ taskId: string; name: string; type: string; text?: string } | null>(null);
  // 取数预览（流量分析专用）
  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<TrafficDataset | null>(null);
  const [selectedComps, setSelectedComps] = useState<string[]>([]);
  // Markdown 报告（模型生成）
  const [report, setReport] = useState<{ markdown: string; meta: any } | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [llmInfo, setLlmInfo] = useState<any>(null);
  // 流量分析的历史记录（数据源是 traffic_reports，不是 ai_analysis_tasks）
  const [hist, setHist] = useState<any[]>([]);

  const asin = asinInput.trim().toUpperCase();
  const asinValid = /^[A-Z0-9]{10}$/.test(asin);

  function parseComps(text: string): string[] {
    return (text || '')
      .split(/[\s,;，、]+/)
      .map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z0-9]{10}$/.test(s));
  }

  async function reloadTasks() {
    try { setTasks(await apiListAiTasks(skillId)); setLoadErr(''); }
    catch (e: any) { setLoadErr(e.message || '加载失败'); }
  }
  async function reloadHist() {
    try { setHist(await apiTrafficHistory()); setLoadErr(''); }
    catch (e: any) { setLoadErr(e.message || '加载失败'); }
  }
  // 切换技能（未来有多个技能时，Sidebar 会传入不同 skillId）需要重新加载历史、清空当前选中
  useEffect(() => {
    if (isTraffic) reloadHist(); else reloadTasks();
    setActiveId(null); setPreviewData(null); setReport(null); setErr('');
  }, [skillId]);

  // 查一次模型配置，决定「生成分析报告」按钮是否可用
  useEffect(() => {
    if (!isTraffic) return;
    let alive = true;
    apiLlmInfo().then(v => { if (alive) setLlmInfo(v); }).catch(() => {});
    return () => { alive = false; };
  }, [skillId]);

  // 有进行中任务时每3秒轮询历史列表
  useEffect(() => {
    const hasActive = tasks.some(t => t.status === 'pending' || t.status === 'running');
    if (!hasActive) return;
    const timer = setInterval(reloadTasks, 3000);
    return () => clearInterval(timer);
  }, [tasks]);

  // 选中记录后加载详情；若还在跑，每3秒刷新一次自己的状态
  useEffect(() => {
    if (!activeId) { setActive(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function load() {
      try {
        const t = await apiGetAiTask(activeId!);
        if (cancelled) return;
        setActive(t);
        if (t.status !== 'pending' && t.status !== 'running' && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch { /* ignore */ }
    }
    load();
    timer = setInterval(load, 3000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [activeId]);

  async function runAnalyze(overrideAsin?: string, overrideParams?: any) {
    const useAsin = overrideAsin ?? asin;
    if (!overrideAsin && !asinValid) { setErr('请输入有效的 ASIN（10 位字母数字）'); return; }
    setErr(''); setLoginRequired(false); setSubmitting(true);
    try {
      const taskId = await apiRunAi(skillId, useAsin, overrideParams ?? { alexaQuestions });
      if (!overrideAsin) setAsinInput('');
      await reloadTasks();
      setActiveId(taskId);
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'login_required') {
        setLoginRequired(true);
      } else {
        setErr(e.message || '创建任务失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** 把三档 UI 状态换成 SIF 的 timePieceValue；week 在这里就对齐到周日，双保险 */
  function currentPeriod(): { type: string; value: string } {
    if (periodType === 'latelyDay') return { type: 'latelyDay', value: latelyDays };
    if (periodType === 'week') return { type: 'week', value: weekSundayOf(weekDate) || weekDate };
    return { type: 'month', value: monthVal };
  }

  /** compOverride 不传时读输入框；传空数组则走自动推荐 */
  async function runPreview(compOverride?: string[]) {
    if (!asinValid) { setErr('请输入有效的 ASIN（10 位字母数字）'); return; }
    const comps = compOverride ?? parseComps(compInput);
    const p = currentPeriod();
    if (p.type === 'week' && !p.value) { setErr('请先选择周内任意日期'); return; }
    if (p.type === 'month' && !p.value) { setErr('请先选择月份'); return; }
    setErr(''); setPreviewing(true);
    try {
      const r = await apiTrafficPreview(asin, p.type, p.value, comps, comps.length === 0);
      setPreviewData(r.data);
      setReport(null);            // 换了数据集，旧报告作废
      setSelectedComps((r.data.competitors || []).filter((c: any) => !c.error).map((c: any) => c.asin));
      setActiveId(null); setActive(null);
    } catch (e: any) {
      setErr(e.message || '取数失败');
    } finally {
      setPreviewing(false);
    }
  }

  /** 生成 Markdown 报告：一次模型调用，同步等待（约 30~90 秒） */
  async function genReport(force = false) {
    const dsid = previewData?.meta?.dataset_id;
    if (!dsid) { setErr('请先取数，再生成报告'); return; }
    setErr(''); setReportBusy(true);
    try {
      const r = await apiTrafficReport(dsid, force);
      setReport({ markdown: r.markdown, meta: r.meta });
      reloadHist();      // 生成/重新生成后历史列表要跟着变
    } catch (e: any) {
      setErr(e.message || '生成报告失败');
    } finally {
      setReportBusy(false);
    }
  }

  function downloadReport() {
    if (!report || !previewData) return;
    const blob = new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${previewData.meta.asin}_流量分析_${previewData.meta.period_value}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  /** 点历史项：恢复「数据集 + 报告」的完整上下文 */
  async function openHistory(item: any) {
    setErr('');
    try {
      const [ds, rep] = await Promise.all([
        apiTrafficDataset(item.id),
        apiTrafficReportGet(item.id),
      ]);
      setPreviewData(ds.data);
      setReport({ markdown: rep.markdown, meta: rep.meta });
      setSelectedComps((ds.data.competitors || []).filter((c: any) => !c.error).map((c: any) => c.asin));
      setActiveId(null); setActive(null);
    } catch (e: any) {
      setErr(e.message || '加载失败');
    }
  }

  async function removeHistory(item: any) {
    if (!confirm(`删除「${item.asin}」的这条报告？（数据集与文件一并删除）`)) return;
    try {
      await apiDeleteTrafficHistory(item.id);
      setHist(h => h.filter(x => x.id !== item.id));
      if (previewData?.meta?.dataset_id === item.id) {
        setPreviewData(null); setReport(null);
      }
    } catch (e: any) {
      setErr(e.message || '删除失败');
    }
  }

  function toggleComp(a: string) {
    setSelectedComps(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]);
  }

  function applyComps() {
    if (!selectedComps.length) { setErr('请至少勾选一个竞品'); return; }
    setCompInput(selectedComps.join(','));
    runPreview(selectedComps);
  }

  async function triggerLogin() {
    setLoggingIn(true); setErr('');
    try {
      await apiLoginSkill(skillId);
    } catch (e: any) {
      setErr(e.message || '发起登录失败');
    } finally {
      setLoggingIn(false);
    }
  }

  async function removeTask(t: AiTask) {
    if (!confirm(`删除「${t.asin}」的分析记录？（本地报告文件也会一并删除）`)) return;
    await apiDeleteAiTask(t.id);
    setTasks(ts => ts.filter(x => x.id !== t.id));
    if (activeId === t.id) { setActiveId(null); setActive(null); }
  }

  async function cancelTask(t: AiTask) {
    if (!confirm(`确定要终止「${t.asin}」这次分析吗？终止后不可恢复，如需重试请用「重新运行」。`)) return;
    setCancelling(true); setErr('');
    try {
      await apiCancelTask(t.id);
      await reloadTasks();
      if (activeId === t.id) setActive(await apiGetAiTask(t.id));
    } catch (e: any) {
      setErr(e.message || '终止失败');
    } finally {
      setCancelling(false);
    }
  }

  function rerunTask(t: AiTask) {
    runAnalyze(t.asin, t.params);
  }

  async function openPreview(file: AiFile) {
    if (!active) return;
    if (file.type === 'html') {
      setPreview({ taskId: active.id, name: file.name, type: file.type });
      return;
    }
    try {
      const r = await fetch(fileUrl(active.id, file.name, 'inline'));
      const text = await r.text();
      setPreview({ taskId: active.id, name: file.name, type: file.type, text });
    } catch {
      setErr('预览加载失败');
    }
  }

  return (
    <div className="ai-root">
      {/* 左侧：ASIN 输入 + 历史记录（技能已由侧边栏"AI分析"分组选定） */}
      <div className="ai-side">
        <div className="ai-skill-hint">{skill?.desc || skillId}</div>

        <div className="ai-field">
          <label className="ai-label">ASIN</label>
          <input className="ai-select" value={asinInput} onChange={e => setAsinInput(e.target.value)}
            placeholder="B0XXXXXXXXX" disabled={submitting || previewing} />
        </div>

        {isTraffic ? (
          <>
            <div className="ai-field">
              <label className="ai-label">时间维度</label>
              <select className="ai-select" value={periodType}
                onChange={e => setPeriodType(e.target.value as PeriodType)} disabled={previewing}>
                <option value="latelyDay">近 N 天</option>
                <option value="week">指定周</option>
                <option value="month">指定月</option>
              </select>
            </div>

            {periodType === 'latelyDay' && (
              <div className="ai-field">
                <label className="ai-label">天数</label>
                <select className="ai-select" value={latelyDays}
                  onChange={e => setLatelyDays(e.target.value as '7' | '30')} disabled={previewing}>
                  <option value="7">近 7 天</option>
                  <option value="30">近 30 天</option>
                </select>
                <div className="ai-login-hint">
                  SIF 的「近 N 天」只支持 7 / 30 两档，其他天数会被接口拒绝，故不开放任意输入
                </div>
              </div>
            )}

            {periodType === 'week' && (
              <div className="ai-field">
                <label className="ai-label">周内任意一天</label>
                <input type="date" className="ai-select" value={weekDate}
                  onChange={e => setWeekDate(e.target.value)} disabled={previewing} />
                <div className="ai-login-hint">
                  SIF 要求传该周<b>周日</b>：{weekSundayOf(weekDate) || '—'} ~ {addDays(weekSundayOf(weekDate), 6) || '—'}
                  {weekDate && weekSundayOf(weekDate) && weekSundayOf(weekDate) !== weekDate ? '（已自动对齐）' : ''}
                </div>
              </div>
            )}

            {periodType === 'month' && (
              <div className="ai-field">
                <label className="ai-label">月份</label>
                <input type="month" className="ai-select" value={monthVal}
                  onChange={e => setMonthVal(e.target.value)} disabled={previewing} />
                <div className="ai-login-hint">
                  SIF 要求传月初日期：{monthVal ? monthVal + '-01' : '—'}
                </div>
              </div>
            )}

            <div className="ai-field">
              <label className="ai-label">竞品 ASIN（可选）</label>
              <textarea className="ai-select ai-textarea" value={compInput}
                onChange={e => setCompInput(e.target.value)}
                placeholder="留空=自动推荐；多个用逗号或换行分隔（最多 5 个）"
                disabled={previewing} rows={3} />
            </div>

            {err && <div className="ai-err">{err}</div>}

            <div className="ai-actions">
              <button className="btn btn-primary btn-sm" onClick={() => runPreview()}
                disabled={previewing || !asinValid}>
                {previewing ? '取数中（约 10 秒）…' : '取数预览'}
              </button>
            </div>
            <div className="ai-login-hint">
              取数只调用 SIF，不产生 AI 费用。确认数据与竞品无误后，再生成分析报告。
            </div>
          </>
        ) : (
          <>
            <div className="ai-field">
              <label className="ai-label">Alexa 反查问题数</label>
              <input className="ai-select" type="number" min={1} max={10} value={alexaQuestions}
                onChange={e => setAlexaQuestions(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3)))}
                disabled={submitting} />
            </div>

            {err && <div className="ai-err">{err}</div>}

            {loginRequired && (
              <div className="ai-login-block">
                <div>需要在本机重新登录 Amazon 账号才能开始分析。</div>
                <button className="btn btn-sm" onClick={triggerLogin} disabled={loggingIn}>
                  {loggingIn ? '正在弹出登录窗口…' : '去登录'}
                </button>
                <div className="ai-login-hint">点击后会在本机弹出一个浏览器窗口，登录完成后请重新点击「开始分析」。</div>
              </div>
            )}

            <div className="ai-actions">
              <button className="btn btn-primary btn-sm" onClick={() => runAnalyze()} disabled={submitting || !asinValid}>
                {submitting ? '提交中…' : '开始分析'}
              </button>
            </div>
          </>
        )}

        <div className="ai-history">
          <div className="ai-history-head">历史记录</div>
          {loadErr && <div className="ai-err">{loadErr}</div>}
          {isTraffic ? (
            <>
              {!hist.length && !loadErr && <div className="ai-empty">暂无报告，取数后点「生成分析报告」</div>}
              {hist.map(h => (
                <div key={h.id} className="ai-task" data-active={previewData?.meta?.dataset_id === h.id}>
                  <button className="ai-task-main" onClick={() => openHistory(h)}>
                    <div className="ai-task-top">
                      <span className="mono">{h.asin}</span>
                      <span className="ai-status ai-status-done">已生成</span>
                    </div>
                    <div className="ai-task-sub">
                      <span className="ai-task-time">{h.period_label || ''}</span>
                    </div>
                    <div className="ai-task-sub">
                      <span className="ai-task-time">{fmtDateTime(h.created_at)}</span>
                      <span className="ai-task-time">{h.report_chars ? h.report_chars + ' 字' : ''}</span>
                    </div>
                  </button>
                  <button className="btn btn-sm ai-del" onClick={() => removeHistory(h)}>删除</button>
                </div>
              ))}
            </>
          ) : (
            <>
              {!tasks.length && !loadErr && <div className="ai-empty">暂无分析记录</div>}
              {tasks.map(t => (
                <div key={t.id} className="ai-task" data-active={t.id === activeId}>
                  <button className="ai-task-main" onClick={() => { setActiveId(t.id); setPreviewData(null); }}>
                    <div className="ai-task-top">
                      <span className="mono">{t.asin}</span>
                      <span className={`ai-status ai-status-${t.status}`}>{STATUS_LABEL[t.status] || t.status}</span>
                    </div>
                    <div className="ai-task-sub">
                      <span className="ai-task-time">{fmtDateTime(t.createdAt)}</span>
                    </div>
                  </button>
                  <button className="btn btn-sm ai-del" onClick={() => removeTask(t)}>删除</button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* 右侧：详情（取数预览优先于历史任务详情，避免两块数据互相干扰） */}
      <div className="ai-main">
        {previewData ? (
          <TrafficPanel
            data={previewData}
            selected={selectedComps}
            onToggle={toggleComp}
            onApply={applyComps}
            busy={previewing}
            report={report}
            reportBusy={reportBusy}
            onGenerate={genReport}
            llm={llmInfo}
            onDownloadReport={downloadReport}
          />
        ) : !active ? (
          <div className="ai-empty ai-empty-lg">
            {isTraffic
              ? '在左侧输入 ASIN，点「取数预览」先看数据；确认无误后再生成分析报告'
              : '在左侧输入 ASIN 并点击「开始分析」，或点击历史记录查看结果'}
          </div>
        ) : (
          <>
            <div className="ai-main-head">
              <div className="ai-main-title">
                <span className="mono">{active.asin}</span>
                <span className={`ai-status ai-status-${active.status}`}>{STATUS_LABEL[active.status] || active.status}</span>
              </div>
              <div className="ai-main-sub">
                {skill?.label || active.skillId} · {fmtDateTime(active.createdAt)}
              </div>
            </div>

            {(active.status === 'pending' || active.status === 'running') && (
              <>
                <div className="ai-running">
                  正在跑分析（真实调用 Claude Code，通常需要数分钟），可以先做别的事，这里会自动刷新状态…
                </div>
                <div className="ai-actions">
                  <button className="btn btn-sm ai-cancel-btn" onClick={() => cancelTask(active)} disabled={cancelling}>
                    {cancelling ? '终止中…' : '结束分析'}
                  </button>
                </div>
              </>
            )}

            {active.status === 'failed' && (
              <>
                <div className="ai-err ai-err-block">分析失败：{active.error || '未知错误'}</div>
                <div className="ai-actions">
                  <button className="btn btn-sm" onClick={() => rerunTask(active)} disabled={submitting}>重新运行</button>
                </div>
              </>
            )}

            {active.status === 'cancelled' && (
              <>
                <div className="ai-err ai-err-block">已终止：{active.error || '用户手动结束'}</div>
                <div className="ai-actions">
                  <button className="btn btn-sm" onClick={() => rerunTask(active)} disabled={submitting}>重新运行</button>
                </div>
              </>
            )}

            {active.status === 'done' && (
              <>
                {active.summary && <div className="ai-summary">{active.summary}</div>}
                <div className="ai-files">
                  {active.files.map(f => (
                    <div key={f.name} className="ai-file-card">
                      <span className="ai-file-name">{f.name}</span>
                      <div className="ai-file-actions">
                        <button className="btn btn-sm" onClick={() => openPreview(f)}>预览</button>
                        <a className="btn btn-sm" href={fileUrl(active.id, f.name, 'download')}>下载</a>
                      </div>
                    </div>
                  ))}
                  {!active.files.length && <div className="ai-empty">未生成任何文件</div>}
                </div>
                <div className="ai-actions">
                  <button className="btn btn-sm" onClick={() => rerunTask(active)} disabled={submitting}>重新运行</button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal ai-preview-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span className="modal-title">{preview.name}</span>
              <button className="modal-close" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="modal-body ai-preview-body">
              {preview.type === 'html' ? (
                <iframe className="ai-preview-iframe" src={fileUrl(preview.taskId, preview.name, 'inline')} />
              ) : (
                // 报告本身是本工具自己生成的可信内容，非用户输入，此处不做额外净化。
                <div className="ai-preview-md" dangerouslySetInnerHTML={{ __html: marked.parse(preview.text || '', { async: false }) as string }} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
