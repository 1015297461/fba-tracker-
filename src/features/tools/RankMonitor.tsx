import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { authHeaders, rankCls } from './AiAnalyze';
import { LineChart } from './SifKeyword';

// ============================================================
// 排名监测
// ------------------------------------------------------------
// 结果区分上下两块，各看各的、**不做交叉对比**（采集时刻与口径都不同）：
//   A · 前台实测（爬虫）  抓亚马逊搜索结果页，实时；数据存 rmon_srps
//   B · SIF 平台数据      第三方口径，ABA 周维度；数据存 rmon_queries
//
// 两个查询方向（都在 B 区）：
//   · 查关键词 → 该词下的竞品份额榜 + 我的卡位
//   · 查 ASIN  → 它在各词上的自然排名 + ABA 卡位
//
// ⚠ 三种「排名」口径不同，页面必须分开标注，不要都叫「排名」：
//   · share_rank   该词下的流量份额排名（按 total_share 排）
//   · organic_rank SIF 观测的自然搜索位（null = 无自然位）
//   · aba_rank     ABA 买家实际点击的第 1/2/3 位
// ============================================================

type Kind = 'keyword' | 'asin';

interface RankTarget {
  id: string;
  kind: Kind;
  value: string;
  label?: string | null;
  country: string;
  own_asin?: string | null;
  freq: string;
  competitor_n?: number | null;   // 采集几个竞品的自然位（1~15，默认 10）
  paused?: number | null;         // 1 = 暂停自动采集
  run_at?: string | null;         // 采集时刻 HH:MM（空 = 当天首次检查即跑）
  extra_asins?: string | null;    // 额外指定跟踪自然位的 ASIN（JSON 数组串）
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  snapshot_date?: string | null;
  summary?: any;
  event_count?: number;
  high_count?: number;
  latest_event?: any;
}

const KIND_LABEL: Record<Kind, string> = { keyword: '关键词', asin: 'ASIN' };
const LEVEL_LABEL: Record<string, string> = { high: '高', mid: '中', low: '低' };

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    ...init,
    headers: { ...((init && init.headers) || {}), ...authHeaders() },
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const er: any = new Error(e.error || `请求失败 ${r.status}`);
    er.status = r.status;      // 上层据此区分「登录失效」和「普通失败」
    throw er;
  }
  return r.json();
}

/** 401 不是「数据没了」，是「读不到」。必须持续显示，不能被 toast 自动吞掉。 */
function authError(e: any): { title: string; hint?: string; sticky?: boolean } | null {
  if (e && e.status === 401) {
    return {
      title: '登录已失效，读不到数据',
      hint: '列表显示为空不是数据被删了，是这个登录态已过期。请重新登录（或刷新页面）后再看。',
      sticky: true,
    };
  }
  return null;
}

/** 库里 extra_asins 是 JSON 字符串；输入框里要显示成「B0X, B0Y」这种可编辑串 */
function asinText(v: any): string {
  if (!v) return '';
  try {
    const arr = JSON.parse(String(v));
    return Array.isArray(arr) ? arr.join(', ') : String(v);
  } catch {
    return String(v);
  }
}

/** 手敲的串里数出有效 ASIN 个数（用于估算调用量与提示，不依赖后端） */
function countAsins(v: string): number {
  return v.split(/[,;\s、，；]+/).filter(x => /^[A-Z0-9]{10}$/i.test(x.trim())).length;
}

/** 数据周期文案：SIF 份额榜是 ABA 周数据，同一周内每天抓到的都是同一份 */
function periodText(p: any): string {
  if (!p || !p.start) return '';
  const s = String(p.start).slice(5);
  const e = p.end ? String(p.end).slice(5) : '';
  const unit = p.granularity === 'week' ? 'ABA 周' : (p.granularity || '');
  return `数据周期 ${s}${e ? '~' + e : ''}${unit ? `（${unit}）` : ''}`;
}

/** 自然位展示：优先「第X页 第Y位」（SIF 前台的形态），没有页码信息才退回绝对位次 */
function organicText(rank?: number | null, page?: number | null, pos?: number | null): string {
  if (rank == null) return '无自然位';
  if (page && pos) return `第${page}页 第${pos}位`;
  return `#${rank}`;
}

const q = encodeURIComponent;
const apiTargets = () => api('/api/rank/targets').then((d: any) => d.targets || []);
const apiAdd = (body: any) => api('/api/rank/targets', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const apiRun = (body: any) => api('/api/rank/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const apiSnapshot = (id: string) => api('/api/rank/snapshot?targetId=' + q(id));
const apiQueryAsync = (kind: Kind, value: string, ownAsin: string) =>
  api('/api/rank/query/async', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, value, ownAsin: ownAsin || null }),
  });
const apiQueryStatus = (taskId: string) => api('/api/rank/query/status?taskId=' + q(taskId));
/** 查某个竞品在当前词上的自然搜索位（点竞品榜某一行时按需调用） */
const apiOrganicInKeyword = (asin: string, keyword: string) =>
  api(`/api/rank/asin-in-keyword?asin=${q(asin)}&keyword=${q(keyword)}`);
const apiSettings = () => api('/api/rank/settings').then((d: any) => d.settings || {});
const apiUpdateTarget = (body: any) =>
  api('/api/rank/targets/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const apiAsinProfile = (asin: string) =>
  api('/api/rank/asin-profile?asin=' + q(asin)).then((d: any) => d.profile);
const apiAsinHistory = (asin: string, keyword: string) =>
  api(`/api/rank/asin-history?asin=${q(asin)}&keyword=${encodeURIComponent(keyword)}`);

const apiTrendByValue = (kind: Kind, value: string, topN = 5) =>
  api(`/api/rank/trend?kind=${kind}&value=${encodeURIComponent(value)}&topN=${topN}`);

/** topN 不传时由后端按该目标「采集设置」里的竞品数决定（采集多少就画多少） */
const apiTrend = (targetId: string, topN?: number) =>
  api(`/api/rank/trend?targetId=${q(targetId)}` + (topN ? `&topN=${topN}` : ''));

const apiOrganicBatch = (asins: string[], keyword: string) =>
  api('/api/rank/asin-in-keyword/batch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asins, keyword }),
  });

// ---- 前台实测（爬虫抓搜索页）----
// 与上面 SIF 的接口完全独立：数据存 rmon_srps，页面上两块也不交叉比较
const SCRAPE_MARKET = 'US';
const apiScrapeConfig = (keyword?: string) =>
  api('/api/rank/scrape/config' +
    (keyword ? `?keyword=${q(keyword)}&country=${SCRAPE_MARKET}` : ''));
const apiScrapeSavePages = (pages: number, keyword?: string) =>
  api('/api/rank/scrape/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages, keyword: keyword || null, country: SCRAPE_MARKET }),
  });
const apiScrapeAsync = (keyword: string, pages: number) =>
  api('/api/rank/scrape/async', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, country: SCRAPE_MARKET, pages }),
  });
const apiScrapeStatus = (taskId: string) =>
  api('/api/rank/scrape/status?taskId=' + q(taskId));
const apiScrapeStop = (taskId: string) =>
  api('/api/rank/scrape/stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
const apiScrapeLatest = (keyword: string) =>
  api(`/api/rank/scrape/latest?keyword=${q(keyword)}&country=${SCRAPE_MARKET}`)
    .then((d: any) => d.snapshot);
const apiScrapeHistory = (keyword: string) =>
  api(`/api/rank/scrape/history?keyword=${q(keyword)}&country=${SCRAPE_MARKET}&limit=60`)
    .then((d: any) => d.history || []);
/** 最近一条抓取记录（不限关键词）—— 页面刷新后用它恢复上次的榜单 */
const apiScrapeRecent = () =>
  api(`/api/rank/scrape/history?country=${SCRAPE_MARKET}&limit=1`)
    .then((d: any) => (d.history || [])[0] || null);
/** 全部抓取记录（左栏合并列表用） */
const apiScrapeAll = (limit = 60) =>
  api(`/api/rank/scrape/history?country=${SCRAPE_MARKET}&limit=${limit}`)
    .then((d: any) => d.history || []);
const apiScrapeSnap = (id: string) =>
  api('/api/rank/scrape/snap?id=' + q(id)).then((d: any) => d.snapshot);
const apiScrapeTrend = (keyword: string) =>
  api(`/api/rank/scrape/trend?keyword=${q(keyword)}&country=${SCRAPE_MARKET}&limit=60`);
const apiScrapeEvents = (keyword: string) =>
  api(`/api/rank/scrape/events?keyword=${q(keyword)}&country=${SCRAPE_MARKET}`);
/** ASIN 静态属性（上架日期/品牌）：优先用该词竞品榜的上架天数（覆盖率 100%），
 *  缓存按 ASIN 永久保存；两者都没有才去问 asin_profile 兜底 */
const apiScrapeMeta = (asins: string[], keyword?: string) =>
  api('/api/rank/scrape/meta', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asins, country: SCRAPE_MARKET, keyword }),
  });
/** 检查留痕：点过「获取最新数据」但内容没变的那几次（A/B 各自一套） */
const apiChecks = (source: 'scrape' | 'sif', keyword: string) =>
  api(`/api/rank/checks?source=${source}&keyword=${q(keyword)}&country=${SCRAPE_MARKET}`)
    .then((d: any) => d.checks || []);
const apiKeywordTrend = (keyword: string, weeks = 52) =>
  api(`/api/rank/keyword-trend?keyword=${q(keyword)}&country=${SCRAPE_MARKET}&weeks=${weeks}`);
/** 前台实测的定时监测目标（每天自动抓） */
const apiScrapeTargets = () =>
  api('/api/rank/scrape/targets').then((d: any) => d.targets || []);
const apiSaveScrapeTarget = (body: any) =>
  api('/api/rank/scrape/targets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const apiDelScrapeTarget = (id: string) =>
  api('/api/rank/scrape/targets?id=' + q(id), { method: 'DELETE' });
const apiScrapeDel = (id: string) =>
  api('/api/rank/scrape/snap?id=' + q(id), { method: 'DELETE' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const apiQueries = () => api('/api/rank/queries').then((d: any) => d.queries || []);
const apiQueryDetail = (id: string) => api('/api/rank/query/detail?id=' + q(id));
const apiDelQuery = (id: string) =>
  api('/api/rank/queries?id=' + q(id), { method: 'DELETE' });

/** 导出 Excel：带 token 用 fetch 取 blob，不能直接用 <a href>（要鉴权头） */
async function downloadExcel(id?: string) {
  const url = '/api/rank/export' + (id ? '?id=' + q(id) : '');
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || '导出失败');
  }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = id ? 'rank_query.xlsx' : 'rank_queries.xlsx';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
const apiDel = (id: string) => api('/api/rank/targets?id=' + q(id), { method: 'DELETE' });

// ---- 小工具 ----
const fmtPct = (v?: number | null, nd = 1) =>
  v === null || v === undefined ? '—' : (Number(v) * 100).toFixed(nd) + '%';
const fmtNum = (v?: number | null, nd = 0) =>
  v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-CN', {
    minimumFractionDigits: nd, maximumFractionDigits: nd,
  });
const fmtDate = (s?: string | null) => (s || '—').replace('T', ' ').slice(0, 16);

function ModeTag({ mode }: { mode?: string | null }) {
  if (!mode) return <span className="tf-tag">—</span>;
  const natural = mode === 'natural_dominant';
  return <span className={'tf-tag ' + (natural ? 'tf-tag-green' : 'tf-tag-amber')}>
    {natural ? '自然主导' : '广告主导'}
  </span>;
}

function TierTag({ tier, rank }: { tier?: string | null; rank?: number | null }) {
  // 有份额排名就先显示名次：SIF 的卡位判定（absent）和份额榜口径不同，
  // 用户真正想问的是「它在这个词排第几」，不是「卡位够不够」。
  if (rank) {
    const cls = rank <= 3 ? 'tf-tag-green' : rank <= 10 ? 'tf-tag-amber' : 'tf-tag';
    return <span className={'tf-tag ' + cls}>份额第 {rank}</span>;
  }
  if (!tier || tier === 'absent') return <span className="tf-tag tf-tag-red">未进前 100</span>;
  if (tier === 'top3') return <span className="tf-tag tf-tag-green">Top3</span>;
  return <span className="tf-tag tf-tag-amber">{tier}</span>;
}

// ---- 配置这次查询：点按钮先弹窗，把 A/B 两块的参数一次配完 ----
// 之前按钮点下去直接跑：用户不知道会抓几页、要花多少配额、要不要顺手加监测。
// 现在把「这次跑什么」和「要不要每天/每周自动跑」都摊在一个弹窗里。
function RunConfigModal({ open, kind, value, pages, pageCfg, defaultN,
                          ownAsin, srpSched, sifSched, onClose, onRun }: {
  open: boolean; kind: Kind; value: string;
  pages: number; pageCfg: any; defaultN: number;
  ownAsin: string; srpSched: any; sifSched: any;
  onClose: () => void;
  onRun: (opt: {
    doScrape: boolean; doSif: boolean; pages: number; ownAsin: string;
    srpDaily: boolean; srpAt: string;
    sifMonitor: boolean; sifN: number; sifAt: string;
  }, execute: boolean) => void;
}) {
  const [doScrape, setDoScrape] = useState(kind === 'keyword');
  const [doSif, setDoSif] = useState(true);
  const [localPages, setLocalPages] = useState(pages);
  const [own, setOwn] = useState(ownAsin);
  const [srpDaily, setSrpDaily] = useState(false);
  const [srpAt, setSrpAt] = useState('09:00');
  const [sifMonitor, setSifMonitor] = useState(false);
  const [sifN, setSifN] = useState(defaultN);
  const [sifAt, setSifAt] = useState('09:00');

  // 只在「打开」那一刻初始化。必须带出该词**已有**的定时配置 ——
  // 曾经硬编码 false，导致顶部显示「已加入每天 07:00 抓取」而弹窗里没勾上。
  useEffect(() => {
    if (!open) return;
    setDoScrape(kind === 'keyword'); setDoSif(true);
    setLocalPages(pages); setOwn(ownAsin);
    setSrpDaily(!!srpSched);
    setSrpAt(srpSched?.daily_at || '09:00');
    setSifMonitor(!!sifSched);
    setSifN(sifSched?.competitor_n || defaultN);
    setSifAt(sifSched?.run_at || '09:00');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const minP = pageCfg?.min ?? 1;
  const maxP = pageCfg?.max ?? 5;

  return createPortal(
    <div className="rk-modal-mask" onClick={onClose}>
      <div className="rk-modal rk-modal-sm" role="dialog" aria-modal="true"
        aria-labelledby="rk-run-title" onClick={e => e.stopPropagation()}>
        <div className="rk-modal-head">
          <span id="rk-run-title">配置这次查询</span>
          <button className="rk-modal-x" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="rk-add-body">
          <div className="rk-add-target mono">{value}</div>

          {kind === 'keyword' && (
            <div className="rk-run-sec">
              <label className="rk-run-check">
                <input type="checkbox" checked={doScrape}
                  onChange={e => setDoScrape(e.target.checked)} />
                <span>A · 前台实测</span>
                <em>抓亚马逊搜索结果页，实时</em>
              </label>
              {doScrape && (
                <div className="rk-run-sub">
                  <div className="rk-run-row">
                    <span>抓取页数</span>
                    <div className="rk-pages">
                      {Array.from({ length: maxP - minP + 1 }, (_, i) => minP + i).map(n => (
                        <button key={n} type="button" data-active={localPages === n}
                          onClick={() => setLocalPages(n)}>{n}</button>
                      ))}
                    </div>
                    <em>每页 48 条 · 共 {localPages * 48} 位</em>
                  </div>
                  <label className="rk-run-check rk-run-check-2">
                    <input type="checkbox" checked={srpDaily}
                      onChange={e => setSrpDaily(e.target.checked)} />
                    <span>加入每天自动抓取</span>
                    {srpDaily ? (
                      <input type="time" value={srpAt}
                        onChange={e => setSrpAt(e.target.value)} />
                    ) : <em>不勾就只抓这一次</em>}
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="rk-run-sec">
            <label className="rk-run-check">
              <input type="checkbox" checked={doSif} onChange={e => setDoSif(e.target.checked)} />
              <span>B · SIF 平台数据</span>
              <em>ABA 周数据，同一周内重复查结果不变</em>
            </label>
            {doSif && (
              <div className="rk-run-sub">
                {kind === 'keyword' && (
                  <div className="rk-run-row">
                    <span>我的 ASIN</span>
                    <input className="mono" value={own} maxLength={10} placeholder="可选"
                      onChange={e => setOwn(e.target.value.toUpperCase())} />
                    <em>用于算你在该词的卡位</em>
                  </div>
                )}
                <label className="rk-run-check rk-run-check-2">
                  <input type="checkbox" checked={sifMonitor}
                    onChange={e => setSifMonitor(e.target.checked)} />
                  <span>加入每周监测</span>
                  {sifMonitor ? (
                    <>
                      <input type="number" min={1} max={15} value={sifN}
                        onChange={e => setSifN(Math.max(1, Math.min(15, Number(e.target.value) || 1)))} />
                      <em>个竞品</em>
                      <input type="time" value={sifAt}
                        onChange={e => setSifAt(e.target.value)} />
                    </>
                  ) : <em>不勾就只查这一次</em>}
                </label>
                {sifMonitor && (
                  <div className="rk-setup-hint" style={{ paddingLeft: 22 }}>
                    每周一执行 · 每次约 {1 + (sifN + 1) + 1} 次 SIF 调用
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="rk-add-foot">
          <button type="button" className="btn btn-sm" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-sm"
            onClick={() => onRun({
              doScrape, doSif, pages: localPages, ownAsin: own,
              srpDaily, srpAt, sifMonitor, sifN, sifAt,
            }, false)}>只保存配置</button>
          <button type="button" className="btn btn-primary btn-sm"
            disabled={!doScrape && !doSif}
            onClick={() => onRun({
              doScrape, doSif, pages: localPages, ownAsin: own,
              srpDaily, srpAt, sifMonitor, sifN, sifAt,
            }, true)}>保存并运行</button>
        </div>
      </div>
    </div>, document.body);
}

// ---- ASIN 悬浮浮层 + 点击详情 ----
// 浮层必须用 portal 挂到 body：表格容器是 overflow:auto，普通 absolute 会被裁掉。
// 鼠标从 ASIN 移到浮层时靠「延迟 220ms 关闭」保住——进入浮层立即取消计时。
function AsinPeek({ asin, profile, keyword, isMine }: {
  asin: string; profile?: any; keyword: string; isMine?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [modal, setModal] = useState(false);
  const [hist, setHist] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [prof, setProf] = useState<any>(profile || null);
  const timer = useRef<any>(null);

  function enter(e: React.MouseEvent) {
    if (timer.current) clearTimeout(timer.current);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({ x: r.left, y: r.bottom + 4 });
    setHover(true);
  }
  function leave() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(false), 220);
  }

  // 档案缺失时才懒加载（1 次 SIF 调用），已有就直接显示
  useEffect(() => {
    if (!hover || prof) return;
    apiAsinProfile(asin).then(setProf).catch(() => {});
  }, [hover, asin, prof]);

  async function openModal(e: React.MouseEvent) {
    e.preventDefault();
    setModal(true);
    if (hist) return;
    setLoading(true);
    try { setHist(await apiAsinHistory(asin, keyword)); }
    catch { setHist({ history: [] }); }
    finally { setLoading(false); }
  }

  return (
    <>
      <a href={`https://www.amazon.com/dp/${asin}`} target="_blank" rel="noreferrer"
        className="rk-asin-link" title="点击看详情与逐日记录"
        onMouseEnter={enter} onMouseLeave={leave} onClick={openModal}>
        {asin}
      </a>

      {hover && pos && createPortal(
        <div className="rk-peek-pop" style={{ left: pos.x, top: pos.y }}
          onMouseEnter={enter} onMouseLeave={leave}>
          {prof ? (
            <>
              {prof.img
                ? <img className="rk-peek-img" src={prof.img} alt="" loading="lazy" />
                : <div className="rk-peek-img rk-peek-noimg" />}
              <div className="rk-peek-body">
                <div className="rk-peek-title">{prof.title || '（无标题）'}</div>
                <div className="rk-peek-meta">
                  ${fmtNum(prof.price, 2)}
                  {prof.star ? ` · ★${fmtNum(prof.star, 1)}` : ''}
                  {prof.rating_num ? ` (${fmtNum(prof.rating_num)})` : ''}
                </div>
                {prof.brand ? <div className="rk-peek-brand">{prof.brand}</div> : null}
                <div className="rk-peek-hint">点击查看逐日排名记录</div>
              </div>
            </>
          ) : <div className="rk-peek-loading">加载中…</div>}
        </div>, document.body)}

      {modal && createPortal(
        <div className="rk-modal-mask" onClick={() => setModal(false)}>
          <div className="rk-modal" onClick={e => e.stopPropagation()}>
            <div className="rk-modal-head">
              <span className="mono">{asin}</span>
              {isMine ? <i className="tf-me">我</i> : null}
              <button className="rk-modal-x" onClick={() => setModal(false)}>×</button>
            </div>
            <div className="rk-modal-body">
              {prof?.img
                ? <img className="rk-modal-img" src={prof.img} alt="" />
                : <div className="rk-modal-img rk-peek-noimg" />}
              <div className="rk-modal-info">
                <div className="rk-peek-title">{prof?.title || '—'}</div>
                <div className="rk-peek-meta">
                  ${fmtNum(prof?.price, 2)} · ★{fmtNum(prof?.star, 1)}（{fmtNum(prof?.rating_num)} 条评论）
                </div>
                {prof?.brand ? <div className="rk-peek-brand">{prof.brand}</div> : null}
                <a className="btn btn-sm" href={`https://www.amazon.com/dp/${asin}`}
                  target="_blank" rel="noreferrer">打开 Amazon</a>
              </div>
            </div>
            <div className="rk-modal-hist">
              <div className="tf-card-head">
                <span>逐日记录</span>
                <span className="tf-card-sub">
                  {hist?.source === 'snapshot' ? '监测快照' : '查询历史'}
                  {hist?.history?.length ? ` · ${hist.history.length} 条` : ''}
                </span>
              </div>
              {loading ? <div className="ai-empty">加载中…</div>
                : (hist?.history || []).length ? (
                <div className="tf-table-wrap" style={{ maxHeight: 240 }}>
                  <table className="tf-table">
                    <thead><tr><th>日期</th><th>份额排名</th><th>自然位</th><th>总份额</th></tr></thead>
                    <tbody>
                      {(hist.history || []).map((h: any) => (
                        <tr key={h.date}>
                          <td className="mono">{h.date}</td>
                          <td className="mono">{h.share_rank ?? '—'}</td>
                          <td className={'mono ' + rankCls(h.organic_rank)}>
                        {h.organic_rank == null ? '无自然位' : `#${Math.round(h.organic_rank)}`}
                      </td>
                          <td className="mono">{h.total_share ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>) : <div className="ai-empty">还没有历史记录（抓两次以上才有）</div>}
            </div>
          </div>
        </div>, document.body)}
    </>
  );
}

// ---- 关键词维度结果 ----

/** 份额排名兜底：SIF 偶有缺失，用数组位置补；取整避免显示成 1.0 */
function rankOf(c: any, list: any[]): number {
  const r = c?.share_rank;
  return r != null ? Math.round(Number(r)) : list.indexOf(c) + 1;
}
function KeywordKpis({ data }: { data: any }) {
  const market = data.market || {};
  const my = data.my || null;
  return (
    <>
      <div className="tf-kpis">
        <div className="tf-metric">
          <div className="tf-metric-label">可见 ASIN</div>
          <div className="tf-metric-value">{fmtNum(market.visible_asin_count)}</div>
          <div className="tf-metric-hint">竞争集中度 {market.concentration_level || '—'}</div>
        </div>
        <div className="tf-metric">
          <div className="tf-metric-label">Top3 点击份额</div>
          <div className="tf-metric-value">{fmtPct(market.top3_click_share)}</div>
          <div className="tf-metric-hint">转化份额 {fmtPct(market.top3_conversion_share)}</div>
        </div>
        <div className="tf-metric">
          <div className="tf-metric-label">机会窗口</div>
          <div className={'tf-metric-value ' + (market.conversion_gap ? 'tf-bad' : '')}>
            {market.conversion_gap ? '开着' : '关闭'}
          </div>
          <div className="tf-metric-hint">已连续 {fmtNum(market.gap_weeks)} 周</div>
        </div>
        <div className="tf-metric">
          <div className="tf-metric-label">我的卡位</div>
          <div className="tf-metric-value" style={{ fontSize: 14 }}>
            <TierTag tier={my?.rank_tier} rank={my?.share_rank} />
          </div>
          <div className="tf-metric-hint">
            {my?.asin || '未指定我的 ASIN'}
            {my?.organic_checked
              ? (my.asin_organic_rank
                  ? ` · 自然 ${organicText(my.asin_organic_rank, my.asin_organic_page, my.asin_organic_pos)}`
                  : ' · 无自然位')
              : ''}
          </div>
        </div>
      </div>

      {my && !my.share_rank && (
        <div className="tf-note tf-warn">
          你的 ASIN <b className="mono">{my.asin}</b> 不在 SIF 前 100 份额榜内，没有份额排名。
          {my.organic_checked
            ? (my.asin_organic_rank
                ? ` 该词的自然搜索位是 ${organicText(my.asin_organic_rank, my.asin_organic_page, my.asin_organic_pos)}${my.asin_organic_at ? `（SIF 抓取于 ${my.asin_organic_at}）` : ''}。`
                : ` 该词也查不到自然排名——月搜索量 ${fmtNum(my.asin_search_volume)}，但完全没有卡位。`)
            : ' 想看它在哪些词上有自然排名，切到「查 ASIN」查同一个 ASIN。'}
        </div>
      )}
      {my?.note && (
        <div className="tf-note tf-warn">{my.note}</div>
      )}
      {my?.position === 'blocked' && (
        <div className="tf-note tf-warn">
          卡位判定「blocked」——Top3 已拿走 {fmtPct(market.top3_click_share)} 的点击，
          正面进攻 ROI 存疑，建议找细分词或差异化角度。
        </div>
      )}
      {!my && (
        <div className="tf-note">没填「我的 ASIN」，只显示竞品榜，不计算你的卡位。</div>
      )}
    </>
  );
}

function KeywordResult({ data, hideKpis }: { data: any; hideKpis?: boolean }) {
  const market = data.market || {};
  const my = data.my || null;
  const top: any[] = data.top || [];
  const [showAll, setShowAll] = useState(false);
  const [asinFilter, setAsinFilter] = useState('');
  const [organic, setOrganic] = useState<Record<string, { loading?: boolean; data?: any; err?: string }>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  // 快照里已采集的自然位 {asin: rank|null}：抓取时一起采的，直接展示，不用再点
  const collected: Record<string, number | null> = data.organic || {};
  const collectedCount = Math.max(0, Object.keys(collected).length - 1);   // 去掉「我的 ASIN」那条

  async function loadOrganic(asin: string) {
    if (organic[asin]?.data || organic[asin]?.loading) return;
    setOrganic(m => ({ ...m, [asin]: { loading: true } }));
    try {
      const r = await apiOrganicInKeyword(asin, String(data.keyword || ''));
      setOrganic(m => ({ ...m, [asin]: { data: r } }));
    } catch (e: any) {
      setOrganic(m => ({ ...m, [asin]: { err: e.message || '查询失败' } }));
    }
  }

  async function loadBatch(n = 10) {
    const list = top.slice(0, n).map((c: any) => String(c.asin || '')).filter(Boolean);
    if (!list.length) return;
    setBatchBusy(true);
    try {
      const r = await apiOrganicBatch(list, String(data.keyword || ''));
      setOrganic(prev => {
        const next: Record<string, any> = { ...prev };
        for (const [a, v] of Object.entries(r.results || {})) {
          next[a] = (v as any)?.error ? { err: (v as any).error } : { data: v };
        }
        return next;
      });
    } catch (e: any) {
      setOrganic(prev => {
        const next: Record<string, any> = { ...prev };
        for (const a of list) next[a] = { err: e.message || '批量查询失败' };
        return next;
      });
    } finally { setBatchBusy(false); }
  }

  const kw = asinFilter.trim().toUpperCase();
  const filtered = kw ? top.filter(c => String(c.asin || '').includes(kw)) : top;
  const PAGE = 20;
  const visible = (showAll || kw) ? filtered : filtered.slice(0, PAGE);

  return (
    <>
      {!hideKpis && <KeywordKpis data={data} />}

      <div className="tf-card">
        <div className="tf-card-head">
          <span>竞品份额榜</span>
          <span className="tf-card-sub">
            {kw ? `匹配 ${filtered.length} / ${top.length}` : `共 ${top.length} 个`}
          </span>
        </div>
        <div className="rk-tools">
          <input className="ai-select mono" value={asinFilter}
            placeholder="输入 ASIN 定位（可只输前几位）"
            onChange={e => setAsinFilter(e.target.value.toUpperCase())} maxLength={10} />
          {asinFilter && (
            <button className="btn btn-sm" onClick={() => setAsinFilter('')}>清除</button>
          )}
          <button className="btn btn-sm" onClick={() => loadBatch(10)} disabled={batchBusy}>
            {batchBusy ? '批量查询中（约 30 秒）…' : '补查前 10 名自然位'}
          </button>
        </div>
        <div className="tf-table-wrap">
          <table className="tf-table">
            <thead>
              <tr>
                <th title="该词下的综合流量份额排名（自然+SP+品牌+视频全部计入），不是自然搜索位">
                  份额排名
                </th><th>ASIN</th>
                <th title="采集时一起抓的自然搜索位（我的 ASIN + 份额前 N 名）；未采集的可点「查」单独查">
                  自然位
                </th>
                <th>价格</th><th>评分</th><th>评论</th><th>月销</th>
                <th>自然</th><th>SP</th><th>品牌</th><th>视频</th><th>模式</th><th>上架</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c: any) => (
                <tr key={c.asin} className={my?.asin === c.asin ? 'rk-mine' : undefined}>
                  <td className={'mono rk-rank' + (rankOf(c, top) <= 3 ? ' rk-rank-top' : '')}>
                    {rankOf(c, top)}
                    {c.rank_derived ? (
                      <i className="rk-derived" title="SIF 未返回名次，此值按份额顺序推算">*</i>
                    ) : null}
                  </td>
                  <td className="tf-kw mono">
                    <AsinPeek asin={c.asin} keyword={String(data.keyword || '')}
                      profile={(data.profiles || {})[c.asin]} isMine={my?.asin === c.asin} />
                    {my?.asin === c.asin ? <i className="tf-me">我</i> : null}
                  </td>
                  <td className="mono rk-organic">
                    {(() => {
                      // 优先用快照里已采集的值（0 次额外调用）；没有才给「查」按钮
                      const hasCollected = Object.prototype.hasOwnProperty.call(collected, c.asin);
                      let rank: number | null | undefined;
                      if (hasCollected) {
                        rank = collected[c.asin];
                      } else if (organic[c.asin]?.data) {
                        rank = organic[c.asin]!.data.organic_rank;
                      } else {
                        const o = organic[c.asin];
                        if (o?.loading) return <span className="rk-obtn">查…</span>;
                        if (o?.err) return <span className="rk-obtn rk-obtn-bad" title={o.err}>失败</span>;
                        return (
                          <button type="button" className="rk-obtn rk-obtn-btn"
                            onClick={() => loadOrganic(c.asin)}
                            title="该行未在采集范围内，点此单独查（1 次 SIF 调用）">
                            查
                          </button>
                        );
                      }
                      // 快照里的 organic_detail 有「第几页第几位 + 抓取时间」，比裸数字好读
                      const det = (data.organic_detail || {})[c.asin] || {};
                      const tip = det.at
                        ? `SIF 抓取于 ${det.at}（周期内最后一次抓取值，非当日实时）`
                        : 'SIF 自然搜索位';
                      return rank == null
                        ? <span className="tf-rank-none" title={tip}>无自然位</span>
                        : <span className={rankCls(rank)} title={tip}>
                            {organicText(rank, det.page, det.pos)}
                          </span>;
                    })()}
                  </td>
                  <td className="mono">${fmtNum(c.price, 2)}</td>
                  <td className="mono">{fmtNum(c.rating, 1)}</td>
                  <td className="mono">{fmtNum(c.review_count)}</td>
                  <td className="mono">{c.monthly_orders || '—'}</td>
                  <td className="mono">{fmtPct(c.organic_share)}</td>
                  <td className="mono">{fmtPct(c.sp_share)}</td>
                  <td className="mono">{fmtPct(c.brand_share)}</td>
                  <td className="mono">{fmtPct(c.video_share)}</td>
                  <td><ModeTag mode={c.competition_mode} /></td>
                  <td className="mono">{fmtNum(c.listed_age_days)}天</td>
                </tr>
              ))}
              {!visible.length && (
                <tr><td colSpan={13} className="tf-note" style={{ textAlign: 'center' }}>
                  没有匹配的 ASIN
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {!kw && filtered.length > PAGE && (
          <div className="ai-actions">
            <button className="btn btn-sm" onClick={() => setShowAll(v => !v)}>
              {showAll ? `收起（只显示前 ${PAGE}）` : `展开全部 ${filtered.length} 条`}
            </button>
          </div>
        )}
        <div className="tf-note">
          <b>「份额排名」是自然 + SP + 品牌 + 视频的总流量排名，不是自然搜索位。</b>
          「自然 / SP / 品牌 / 视频」四列就是这个 ASIN 在该词的流量构成（加起来≈100%）：
          视频或 SP 占比高的，排名是买上来的；自然占比高的，才是靠自然位吃量。
          <b>「自然位」列是 SIF 观测的自然搜索位</b>（显示「第几页第几位」，鼠标悬停看抓取时间；
          它是周期内最后一次抓取值，不是当日实时排名，同一天重复抓不会变）：
          采集时一起抓的（范围＝我的 ASIN + 份额前{' '}
          {data.competitor_n || collectedCount} 名），直接显示，不额外花调用；
          范围外的行显示「查」，点一下单独查 1 次。
          <b>自然位是 SIF 最新一次观测的排名</b>（换 7 天 / 30 天窗口结果都一样），
          而同一行的流量占比、健康度是近 30 天窗口累计——两者时间口径不同，别混着读。
          份额是相对值，不能当绝对流量读；SIF 只返回前 100 名，榜外的 ASIN 这里看不到。
        </div>
      </div>
    </>
  );
}

// ---- ASIN 维度结果 ----
function AsinResult({ data }: { data: any }) {
  const aba = data.aba || {};
  const allKws: any[] = data.keywords || [];
  const [kwFilter, setKwFilter] = useState('');
  const needle = kwFilter.trim().toLowerCase();
  const kws = needle ? allKws.filter(k => String(k.keyword || '').toLowerCase().includes(needle)) : allKws;
  // 按自然排名分档计数，给一眼能看的分布
  const buckets = { top3: 0, top10: 0, top30: 0, deeper: 0, none: 0 };
  allKws.forEach((k: any) => {
    const r = k.organic_rank;
    if (r === null || r === undefined) buckets.none++;
    else if (r <= 3) buckets.top3++;
    else if (r <= 10) buckets.top10++;
    else if (r <= 30) buckets.top30++;
    else buckets.deeper++;
  });

  return (
    <>
      <div className="tf-kpis">
        <div className="tf-metric">
          <div className="tf-metric-label">覆盖词数</div>
          <div className="tf-metric-value">{fmtNum(data.keyword_count)}</div>
          <div className="tf-metric-hint">有流量记录的词</div>
        </div>
        <div className="tf-metric">
          <div className="tf-metric-label">前 3 页内</div>
          <div className="tf-metric-value">{buckets.top3 + buckets.top10 + buckets.top30}</div>
          <div className="tf-metric-hint">top3 {buckets.top3} · 4-10 {buckets.top10} · 11-30 {buckets.top30}</div>
        </div>
        <div className="tf-metric">
          <div className="tf-metric-label">无自然位</div>
          <div className={'tf-metric-value ' + (buckets.none > 0 ? 'tf-bad' : '')}>{buckets.none}</div>
          <div className="tf-metric-hint">有流量但没进自然结果</div>
        </div>
        <div className="tf-metric">
          <div className="tf-metric-label">ABA top3 卡位</div>
          <div className="tf-metric-value">{fmtNum(aba.rank1)}+{fmtNum(aba.rank2)}+{fmtNum(aba.rank3)}</div>
          <div className="tf-metric-hint">共 {fmtNum(aba.total_keyword_count)} 词</div>
        </div>
      </div>

      <div className="tf-card">
        <div className="tf-card-head">
          <span>各词自然排名</span>
          <span className="tf-card-sub">
            {needle ? `匹配 ${kws.length} / ${allKws.length}` : `共 ${allKws.length} 个词`}
          </span>
        </div>
        <div className="rk-tools">
          <input className="ai-select" value={kwFilter} placeholder="输入关键词定位…"
            onChange={e => setKwFilter(e.target.value)} />
          {kwFilter && <button className="btn btn-sm" onClick={() => setKwFilter('')}>清除</button>}
        </div>
        <div className="tf-table-wrap">
          <table className="tf-table">
            <thead>
              <tr><th>关键词</th><th>自然排名</th><th>流量占比</th><th>自然位占比</th>
                <th>搜索量</th><th>状态</th></tr>
            </thead>
            <tbody>
              {kws.map((k: any) => (
                <tr key={k.keyword}>
                  <td className="tf-kw">{k.keyword}</td>
                  <td className={'mono ' + rankCls(k.organic_rank)}
                    title={k.organic_rank_time ? `SIF 抓取于 ${k.organic_rank_time}（周期内最后一次抓取值）` : ''}>
                    {organicText(k.organic_rank, k.organic_page, k.organic_pos)}
                  </td>
                  <td className="mono">{fmtPct(k.traffic_share)}</td>
                  <td className="mono">{fmtPct(k.natural_ratio)}</td>
                  <td className="mono">{fmtNum(k.search_volume)}</td>
                  <td><span className={'tf-health tf-health-' + (k.health || 'none')}>{k.health || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tf-note">
          「无自然位」= 有这个词的流量，但 listing 没进自然搜索结果，和「排名靠后」不是一回事。
          ABA 卡位是另一套口径（买家实际点击的第 1/2/3 位），只统计进了 top3 的词。
        </div>
      </div>
    </>
  );
}

// ---- 排名趋势 ----
const TREND_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2'];

function TrendCard({ trend }: { trend: any }) {
  if (!trend) return null;
  if (!trend.count) {
    return (
      <div className="tf-card">
        <div className="tf-card-head"><span>自然位排名趋势</span></div>
        <div className="ai-empty">{trend.note || '还没有快照'}</div>
      </div>
    );
  }
  // 只保留真正有数据的线：竞品数配大后，末尾几个可能还没采集到，
  // 全 null 的线画不出来却会占图例，看着像「少了数据」
  const series = (trend.kind === 'keyword'
    ? [
        ...(trend.my ? [{ name: `我 ${trend.my.asin}`, color: TREND_COLORS[0], values: trend.my.ranks }] : []),
        ...(trend.competitors || []).map((c: any, i: number) => ({
          name: c.asin, color: TREND_COLORS[(i + 1) % TREND_COLORS.length], values: c.ranks,
        })),
      ]
    : (trend.keywords || []).map((k: any, i: number) => ({
        name: k.keyword, color: TREND_COLORS[i % TREND_COLORS.length], values: k.ranks,
      }))
  ).filter((x: any) => (x.values || []).some((v: any) => v != null));

  // 自然位在补采之前没有记录（老快照只有份额排名），全空时直说，别画一条空白图
  const hasPoint = series.some((x: any) => (x.values || []).some((v: any) => v != null));
  if (!hasPoint) {
    return (
      <div className="tf-card">
        <div className="tf-card-head"><span>自然位排名趋势</span></div>
        <div className="tf-note">
          已有 {trend.count} 个时间点，但当时还没记录自然位（份额榜本身不含自然搜索位，
          是后来单独补采的）。下一次抓取之后这里就会有曲线。
        </div>
      </div>
    );
  }

  return (
    <div className="tf-card">
      <div className="tf-card-head">
        <span>自然位排名趋势</span>
        <span className="tf-card-sub">
          {trend.count} 个时间点{trend.count === 1 ? '（再抓一次就连成线）' : ''}
          {trend.kind === 'keyword' && trend.my && series.length > 1
            ? ` · ${series.length - 1} 个竞品` : ''}
          {trend.kind === 'keyword' && !trend.my && series.length
            ? ` · ${series.length} 个竞品` : ''}
          {trend.kind === 'asin' && series.length
            ? ` · ${series.length} 个词` : ''}
          {' · 数字越小越好，折线往下 = 变好'}
        </span>
      </div>
      {trend.kind === 'keyword' && trend.period && trend.period.start && (
        <div className="tf-note">
          份额榜与自然位来自 SIF 的 {periodText(trend.period)}，同一周内每天抓到的都是同一份数据，
          所以这几天的点会重合；到下一期才会出现变化。
        </div>
      )}
      <LineChart dates={trend.dates} series={series} height={200} />
      <div className="tf-note">{trend.note || '自然搜索位（不是份额排名）。'}</div>
    </div>
  );
}

// ---- 小图标（内联 SVG，避免 emoji 在不同系统渲染不一致）----
// ============================================================
// 前台实测（爬虫抓搜索结果页）
// ------------------------------------------------------------
// 这块只展示爬虫自己抓到的榜单，不掺任何 SIF 数据 —— 两边采集时刻和
// 口径都不同，摆在一起比只会让人纠结该信哪个。
// ============================================================

/**
 * 位次变化：上面折线（前 5 个常驻 ASIN），下面热力图（前 20 个）。
 * 为什么主视图是热力图而不是折线：位次是「存在 / 缺失」的离散事件，
 * 一个 ASIN 今天第 5、明天掉出范围、后天回到第 80，折线要么断开、要么连出误导性的直线；
 * 热力图的空白格能直接表达「掉榜」。折线只留给最稳定的几个，看具体波动。
 */
function SrpTrendBlock({ trend }: { trend: any }) {
  if (!trend || !trend.count) return null;
  if (trend.count < 2) {
    return (
      <div className="rk-srp-note">
        位次变化要至少 2 天数据才画得出来（现在只有 1 天）。再抓一天就能看谁在爬、谁在掉。
      </div>
    );
  }
  const rows = (trend.asins || []).slice(0, 20);
  if (!rows.length) return null;
  const lines = rows.filter((r: any) => r.last != null).slice(0, 5).map((r: any, i: number) => ({
    name: r.asin, color: TREND_COLORS[i % TREND_COLORS.length], values: r.ranks,
  }));

  return (
    <div className="rk-srp-trend">
      <div className="rk-srp-sub">
        位次趋势 · 前 {lines.length} 个常驻 ASIN（数字越小越好，往下 = 变好）
      </div>
      <LineChart dates={trend.dates} series={lines} height={180} />
      <div className="rk-srp-sub">
        全部常驻 ASIN 位次（{trend.count} 天 · 空白 = 当天不在抓取范围内）
      </div>
      <div className="rk-heat-wrap">
        <table className="rk-heat">
          <thead>
            <tr>
              <th>ASIN</th>
              {trend.dates.map((d: string) => <th key={d}>{d.slice(5)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.asin}>
                <td className="mono">{r.asin}</td>
                {r.ranks.map((v: number | null, i: number) => (
                  <td key={i} data-lv={v ? Math.min(4, Math.floor(v / 40)) : -1}>
                    {v ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const EVENT_META: Record<string, { label: string; cls: string }> = {
  drop_out: { label: '掉榜', cls: 'rk-ev-bad' },
  enter_top: { label: '新进', cls: 'rk-ev-good' },
  down: { label: '下跌', cls: 'rk-ev-bad' },
  up: { label: '上升', cls: 'rk-ev-good' },
};

/** 榜单异动：相邻两天对比出的进榜 / 掉榜 / 大涨大跌 */
function SrpEvents({ data }: { data: any }) {
  if (!data) return null;
  const events = data.events || [];
  if (!events.length) {
    return <div className="rk-srp-note">{data.note || '这两天没有异动'}</div>;
  }
  return (
    <div className="rk-ev-wrap">
      <div className="rk-srp-sub">
        榜单异动 · {data.prev_date} → {data.curr_date}（{events.length} 条）
      </div>
      <div className="rk-ev-list">
        {events.map((e: any, i: number) => {
          const m = EVENT_META[e.kind] || { label: e.kind, cls: '' };
          return (
            <div key={e.asin + '-' + i} className="rk-ev-item">
              <span className={'rk-ev-tag ' + m.cls}>{m.label}</span>
              <span className="mono rk-ev-asin">{e.asin}</span>
              <span className="rk-ev-pos">
                {e.prev ?? '—'} → {e.curr ?? '—'}
                {e.delta ? `（${e.delta > 0 ? '退' : '进'} ${Math.abs(e.delta)} 位）` : ''}
              </span>
              <span className="rk-ev-title" title={e.title || ''}>{e.title || ''}</span>
            </div>
          );
        })}
      </div>
      <div className="rk-srp-note">{data.note}</div>
    </div>
  );
}

/** 上架天数：从 first_available_day 算到今天。算不出返回 null（不猜） */
function daysOnline(day?: string | null): number | null {
  if (!day) return null;
  const t = Date.parse(`${day}T00:00:00`);
  if (Number.isNaN(t)) return null;
  const d = Math.floor((Date.now() - t) / 86400000);
  return d >= 0 ? d : null;
}

/** 「上架」列的悬停说明：日期是原始值，天数是派生的，所以天数只放 tooltip */
function dateTip(m: any): string {
  if (!m) return '还没有这条 ASIN 的上架记录';
  if (!m.first_available_day) {
    return 'SIF 没有这个 ASIN 的上架日期（asin 档案里多数为空，且该词竞品榜里也没有它）';
  }
  const d = daysOnline(m.first_available_day);
  const brand = m.brand ? ` · 品牌 ${m.brand}` : '';
  const src = m.src === 'age' ? '（由 SIF 上架天数换算，可能差 1 天）' : '';
  return (d == null ? `上架 ${m.first_available_day}${brand}` : `上架 ${d} 天${brand}`) + src;
}

/** 导出前台实测榜单为 CSV（含 UTF-8 BOM，Excel 直接双击打开不乱码） */
function exportSrpCsv(snap: any, meta?: Record<string, any>) {
  const data = snap?.data || {};
  const items: any[] = data.items || [];
  if (!items.length) return;
  const kw = snap?.keyword || data.keyword || 'keyword';
  const date = snap?.snap_date || (data.captured_at || '').slice(0, 10) || 'today';
  const esc = (v: any) => {
    const s = v == null ? '' : String(v).replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  const headers = ['页码', '页内坑位', '类型', '自然位', 'ASIN', '销量', '上架日期', '上架天数', '品牌',
    '价格', '评分', '评论数', '标题', '图片链接'];
  const rows = items.map(it => {
    const m = meta?.[String(it.asin || '').toUpperCase()];
    return [
      it.page ?? '',
      it.pos ?? '',
      it.ad ? '广告' : '自然',
      it.ad ? '' : (it.org ?? ''),
      it.asin ?? '',
      it.sales ?? '',
      m?.first_available_day ?? '',
      daysOnline(m?.first_available_day) ?? '',
      m?.brand ?? '',
      it.price != null ? `${it.symbol || '$'}${Number(it.price).toFixed(2)}` : '',
      it.rating ?? '',
      it.reviews ?? '',
      it.title ?? '',
      it.img ?? '',
    ].map(esc).join(',');
  });
  const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safeKw = String(kw).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 30);
  a.download = `srp_${safeKw}_${date}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/** 关键词搜索趋势（SIF ABA 周数据）—— 类似「产品时光机」的时长序列。
 *  只画这个词自己的量与排名；词根长尾拆分是另一个工具的事，不混进来。 */
function KeywordTrendCard({ keyword }: { keyword: string }) {
  const [weeks, setWeeks] = useState(52);
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!keyword) return;
    let alive = true;
    setBusy(true); setErr(null);
    apiKeywordTrend(keyword, weeks)
      .then(d => { if (alive) setData(d); })
      .catch((e: any) => { if (alive) { setData(null); setErr(e.message || '取趋势失败'); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [keyword, weeks]);

  const s = data?.summary || {};
  const dates: string[] = data?.dates || [];
  // 两条曲线放同一张图，用左右两个 Y 轴：搜索量 0~20 万、ABA 排名 0~5000，
  // 共用一根轴的话排名线会被压成一条贴地的直线。
  // 图例可点：只点其中一条 = 单独查看，再点一次恢复。
  const series = [
    { name: '周搜索量', color: 'var(--blue)', values: data?.volumes || [],
      axis: 'left' as const, format: (v: number) => fmtNum(v) },
    { name: 'ABA 排名', color: 'var(--orange)', values: data?.ranks || [],
      axis: 'right' as const, negative: true,
      format: (v: number) => (v ? `#${fmtNum(v)}` : '—') },
  ];

  return (
    <div className="rk-kwtrend">
      <div className="rk-sec-head">
        <span className="rk-sec-title">关键词搜索趋势</span>
        <span className="rk-sec-sub">
          SIF · ABA 官方周数据{data?.latestDate ? ` · 最新一周 ${data.latestDate}` : ''}
          {data?.source === 'cache' ? ' · 缓存' : ''}
        </span>
        <div className="rk-kwtrend-ctl">
          {[26, 52, 104].map(w => (
            <button key={w} className="rk-ghost-btn" data-active={weeks === w}
              onClick={() => setWeeks(w)}>{w} 周</button>
          ))}
        </div>
      </div>

      {err ? (
        <div className="rk-srp-note">{err}</div>
      ) : busy && !data ? (
        <div className="rk-srp-note">正在取 SIF 周数据…</div>
      ) : !dates.length ? (
        <div className="rk-srp-note">这个词没有可用于画趋势的 ABA 周数据。</div>
      ) : (
        <>
          <div className="rk-srp-kpis">
            <div>
              <b>{s.volumeLast != null ? fmtNum(s.volumeLast) : '—'}</b>
              <span>
                最新周搜索量
                {s.wowPct != null && (
                  <i className={s.wowPct >= 0 ? 'rk-up' : 'rk-down'}>
                    {' '}{s.wowPct >= 0 ? '+' : ''}{s.wowPct}% 周环比
                  </i>
                )}
              </span>
            </div>
            <div>
              <b>{s.volume4wAvg != null ? fmtNum(s.volume4wAvg) : '—'}</b>
              <span>近 4 周平均</span>
            </div>
            <div>
              <b>#{s.rankLast != null ? fmtNum(s.rankLast) : '—'}</b>
              <span>最新 ABA 排名（数字越小越热）</span>
            </div>
            <div>
              <b>{s.peakVolume != null ? fmtNum(s.peakVolume) : '—'}</b>
              <span>区间峰值{s.peakDate ? `（${s.peakDate}）` : ''}</span>
            </div>
          </div>
          <LineChart dates={dates} series={series} height={210} legendClick />
          <div className="rk-srp-note" style={{ marginTop: 4 }}>
            点图例上的「周搜索量」或「ABA 排名」可单独查看，再点一次恢复两条。
            {data.note ? ` ${data.note}` : ''}
          </div>
        </>
      )}
    </div>
  );
}

/** 前台实测榜单主体 */
function ScrapeResult({ snap, ownAsin, history, trend, events, onPick, onDel }: {
  snap: any;
  ownAsin?: string;
  history: any[];
  trend: any;
  events: any;
  onPick: (id: string) => void;
  onDel: (id: string) => void;
}) {
  const data = snap?.data || {};
  const items: any[] = data.items || [];
  const [onlyOrganic, setOnlyOrganic] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [limit, setLimit] = useState(50);

  // 上架日期：搜索页没有这个字段，向 SIF 批量档案要（后端按 ASIN 永久缓存，
  // 命中缓存不再调用；所以打开多少次都只付一次成本）
  const [meta, setMeta] = useState<Record<string, any>>({});
  const [metaBusy, setMetaBusy] = useState(false);
  useEffect(() => {
    const asins = Array.from(new Set(items.map((i: any) => String(i.asin || '').toUpperCase())))
      .filter(Boolean);
    setMeta({});
    if (!asins.length) return;
    setMetaBusy(true);
    apiScrapeMeta(asins, snap?.keyword || data.keyword)
      .then((d: any) => setMeta(d.meta || {}))
      .catch(() => setMeta({}))
      .finally(() => setMetaBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.id]);

  const myAsin = (ownAsin || '').trim().toUpperCase();
  const myHits = myAsin ? items.filter((i: any) => String(i.asin || '').toUpperCase() === myAsin) : [];
  const myBestOrg = myHits.find((i: any) => !i.ad);
  const myBestAd = myHits.find((i: any) => i.ad);

  const needle = filterText.trim().toLowerCase();
  const baseList = onlyOrganic ? items.filter((i: any) => !i.ad) : items;
  const list = needle
    ? baseList.filter((i: any) =>
        String(i.asin || '').toLowerCase().includes(needle) ||
        String(i.title || '').toLowerCase().includes(needle))
    : baseList;

  // 排序：点表头循环「升序 → 降序 → 恢复原始顺序」。
  // 空值（没有自然位 / 没展示销量 / 没有上架日期）无论升降都排到最后，不让它挤在第一位。
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sortVal = (it: any): number | string | null => {
    switch (sort?.key) {
      case 'pos': return it.ad ? null : (it.org ?? null);
      case 'page': return it.page ?? null;
      case 'asin': return String(it.asin || '');
      case 'title': return String(it.title || '').toLowerCase();
      case 'sales': {
        const m = /^([\d.]+)\s*([KM]?)/i.exec(String(it.sales || ''));
        if (!m) return null;
        let n = parseFloat(m[1]);
        if (/^k$/i.test(m[2])) n *= 1000;
        if (/^m$/i.test(m[2])) n *= 1e6;
        return n;
      }
      case 'date': {
        const mm = meta[String(it.asin || '').toUpperCase()];
        return mm?.first_available_day || null;
      }
      case 'price': return it.price ?? null;
      case 'rating': return it.rating ?? null;
      case 'reviews': return it.reviews ?? null;
      default: return null;
    }
  };
  const sorted = (() => {
    if (!sort) return list;
    const dir = sort.dir;
    return [...list].sort((a: any, b: any) => {
      const va = sortVal(a), vb = sortVal(b);
      const ea = va === null || va === undefined || va === '';
      const eb = vb === null || vb === undefined || vb === '';
      if (ea && eb) return 0;
      if (ea) return 1;          // 空值恒在最后，不随方向翻转
      if (eb) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  })();
  const shown = needle ? sorted : sorted.slice(0, limit);
  const thSort = (key: string, label: string, cls?: string, tip?: string) => {
    const on = sort?.key === key;
    return (
      <th className={cls}
        title={tip ? `${tip}（点击排序）` : '点击排序'}
        data-sort={on ? (sort!.dir === 1 ? 'asc' : 'desc') : undefined}
        onClick={() => setSort(cur =>
          !cur || cur.key !== key ? { key, dir: 1 }
            : cur.dir === 1 ? { key, dir: -1 } : null)}>
        {label}<i className="rk-sort-arrow" />
      </th>
    );
  };
  const captured = (data.captured_at || snap?.created_at || '').replace('T', ' ').slice(0, 16);

  return (
    <>
      <div className="ai-main-head">
        <div className="ai-main-title">
          <span className="mono">{snap?.keyword || data.keyword}</span>
        </div>
        <div className="ai-main-sub">
          抓取于 {captured} · 站点 {snap?.country || SCRAPE_MARKET} ·{' '}
          {data.pages_ok}/{data.pages_requested} 页 · 耗时 {data.elapsed}s
          {history.length > 1 && (
            <>
              {' · '}
              <select className="rk-srp-select" value={snap?.id || ''}
                onChange={e => onPick(e.target.value)}>
                {history.map(h => {
                  // 同一天可能有多条（内容有变化才追加），只显示日期会分不清是哪次
                  const sameDay = history.filter(x => x.snap_date === h.snap_date).length > 1;
                  const tm = String(h.created_at || '').slice(11, 16);
                  return (
                    <option key={h.id} value={h.id}>
                      {sameDay ? `${h.snap_date} ${tm}` : h.snap_date}（{h.org_total} 条）
                    </option>
                  );
                })}
              </select>
            </>
          )}
        </div>
      </div>

      {data.warn && <div className="rk-srp-warn">{data.warn}</div>}

      <div className="rk-srp-kpis">
        <div><b>{data.org_total ?? 0}</b><span>自然位</span></div>
        <div><b>{data.ad_total ?? 0}</b><span>广告位</span></div>
        <div><b>{items.length}</b><span>总条目（{data.pages_ok ?? 0} 页）</span></div>
        <div>
          {myAsin ? (
            myBestOrg ? (
              <>
                <b className="rk-srp-my-ok">#{myBestOrg.org}</b>
                <span>
                  我的 {myAsin} · 第{myBestOrg.page}页第{myBestOrg.pos}位
                  {myBestAd ? `（另有广告位）` : ''}
                </span>
              </>
            ) : myBestAd ? (
              <>
                <b className="rk-srp-my-warn">仅广告位</b>
                <span>我的 {myAsin} · 第{myBestAd.page}页第{myBestAd.pos}位（无自然位）</span>
              </>
            ) : (
              <>
                <b className="rk-srp-my-none">未上榜</b>
                <span>我的 {myAsin} · 前 {data.pages_ok ?? 0} 页内未出现</span>
              </>
            )
          ) : (
            <>
              <b>{data.pages_ok ?? 0}</b>
              <span>抓取页数（填「我的 ASIN」可看卡位）</span>
            </>
          )}
        </div>
      </div>

      <div className="rk-srp-bar">
        <label className="rk-srp-check">
          <input type="checkbox" checked={onlyOrganic}
            onChange={e => { setOnlyOrganic(e.target.checked); setLimit(50); }} />
          只看自然位
        </label>
        <input className="ai-select rk-srp-filter" value={filterText}
          placeholder="按 ASIN 或标题词过滤…"
          onChange={e => setFilterText(e.target.value)} />
        {filterText && (
          <button className="btn btn-sm" onClick={() => setFilterText('')}>清除</button>
        )}
        <span className="tf-tiny" style={{ marginLeft: 'auto' }}>
          {needle ? `匹配 ${list.length} / ${baseList.length} 条` : `共 ${list.length} 条，显示前 ${shown.length} 条`}
        </span>
        <button className="rk-ghost-btn" onClick={() => exportSrpCsv(snap, meta)} title="导出当前实测榜单 CSV">
          <DownloadIcon />
          导出 CSV
        </button>
        <button className="rk-ghost-btn" onClick={() => onDel(snap.id)} title="删除这一天的快照">
          <TrashIcon />
        </button>
      </div>

      <div className="rk-srp-scroll">
        <table className="rk-srp-table">
          <thead>
            <tr>
              {thSort('pos', '自然位', 'c-pos rk-th-sort', '跨页累加的自然搜索位次（广告位为空）')}
              {thSort('page', '页数', 'c-page rk-th-sort', '这条结果出现在第几页')}
              <th className="c-img">主图</th>
              {thSort('asin', 'ASIN', 'c-asin rk-th-sort')}
              {thSort('title', '标题', 'c-title rk-th-sort')}
              {thSort('sales', '销量', 'c-sales rk-th-sort', '亚马逊搜索结果页上的「N+ bought in past month」')}
              {thSort('date', '上架', 'c-date rk-th-sort', '上架日期（Date First Available），取自 SIF 商品档案')}
              {thSort('price', '价格', 'c-price rk-th-sort')}
              {thSort('rating', '评分', 'c-rate rk-th-sort')}
              {thSort('reviews', '评论数', 'c-rev rk-th-sort')}
            </tr>
          </thead>
          <tbody>
            {shown.map((it: any) => {
              const isMine = !!myAsin && String(it.asin || '').toUpperCase() === myAsin;
              return (
                <tr key={it.page + '-' + it.pos + '-' + it.asin}
                  data-ad={it.ad || undefined}
                  className={isMine ? 'rk-mine' : undefined}>
                  <td className="c-pos" title={`第 ${it.page} 页 · 页内第 ${it.pos} 位`}>
                    {it.ad ? <span className="rk-ad-tag">广告</span> : it.org}
                  </td>
                  <td className="c-page mono">P{it.page}</td>
                  <td className="c-img">
                    {it.img ? (
                      <img className="rk-srp-thumb" src={it.img} alt="" loading="lazy" />
                    ) : (
                      <div className="rk-srp-thumb rk-srp-noimg" />
                    )}
                  </td>
                  <td className="c-asin mono">
                    <a href={`https://www.amazon.com/dp/${it.asin}`} target="_blank" rel="noreferrer">
                      {it.asin}
                    </a>
                    {isMine ? <i className="tf-me">我</i> : null}
                  </td>
                  <td className="c-title" title={it.title || ''}>{it.title || '—'}</td>
                  <td className="c-sales mono">{it.sales || '—'}</td>
                  <td className="c-date mono" title={dateTip(meta[String(it.asin || '').toUpperCase()])}>
                    {(() => {
                      const m = meta[String(it.asin || '').toUpperCase()];
                      if (m === undefined) return metaBusy ? '…' : '—';
                      return m?.first_available_day || '—';
                    })()}
                  </td>
                  <td className="c-price mono">
                    {it.price != null ? `${it.symbol || '$'}${Number(it.price).toFixed(2)}` : '—'}
                  </td>
                  <td className="c-rate mono">{it.rating != null ? it.rating : '—'}</td>
                  <td className="c-rev mono">{it.reviews != null ? fmtNum(it.reviews) : '—'}</td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={10} className="tf-note" style={{ textAlign: 'center', padding: '14px 8px' }}>
                  没有匹配的榜单记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!needle && list.length > shown.length && (
        <div className="ai-actions">
          <button className="btn btn-sm" onClick={() => setLimit(l => l + 100)}>
            再显示 100 条（还有 {list.length - shown.length} 条）
          </button>
        </div>
      )}

      <SrpEvents data={events} />
      <SrpTrendBlock trend={trend} />
    </>
  );
}

const RefreshIcon = ({ spin }: { spin?: boolean }) => (
  <svg className={'rk-ico' + (spin ? ' rk-ico-spin' : '')} viewBox="0 0 16 16" width="13" height="13"
    aria-hidden="true">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" />
    <path d="M13.4 2.6v3.3h-3.3" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const PauseIcon = () => (
  <svg className="rk-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
    <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
  </svg>
);
const PlayIcon = () => (
  <svg className="rk-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M5.2 3.4 12.3 8l-7.1 4.6z" fill="currentColor" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.8 4.2h10.4" />
    <path d="M6.2 4.2V3a.9.9 0 0 1 .9-.9h1.8a.9.9 0 0 1 .9.9v1.2" />
    <path d="M4.3 4.2l.6 8.1a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.1" />
    <path d="M6.6 6.9v3.8M9.4 6.9v3.8" />
  </svg>
);
const DownloadIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2.6v7.1" />
    <path d="M5 6.9 8 9.9l3-3" />
    <path d="M2.8 12.7h10.4" />
  </svg>
);

export function RankMonitor() {
  // 一个输入框：10 位字母数字自动当 ASIN，其余当关键词。省掉"先选方向再输入"这一步，
  // 也避免切完 tab 还留着上一次的错误提示。
  const [input, setInput] = useState('');
  const [own, setOwn] = useState('');
  const [forceKind, setForceKind] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ title: string; hint?: string; sticky?: boolean } | null>(null);
  const [result, setResult] = useState<any>(null);
  const [resultKind, setResultKind] = useState<Kind>('keyword');
  const [targets, setTargets] = useState<RankTarget[]>([]);
  const [queries, setQueries] = useState<any[]>([]);
  const [resultFrom, setResultFrom] = useState<'live' | 'history'>('live');
  const [progress, setProgress] = useState<any>(null);
  // 查询结果的趋势：来自同一目标的查询历史（没建监测也能看）
  const [trend, setTrend] = useState<any>(null);
  // 新目标的默认竞品数（全局只留这一个预填值，采集时刻已下沉到每个关键词）
  const [defaultN, setDefaultN] = useState(10);

  // ---- 前台实测（爬虫）----
  // 与上面的 SIF 查询是两条独立链路：各自 state、各自接口、各自存储
  const [scrapeSnap, setScrapeSnap] = useState<any>(null);
  const [scrapeTaskId, setScrapeTaskId] = useState<string | null>(null);
  const [scrapeHist, setScrapeHist] = useState<any[]>([]);
  const [scrapeProg, setScrapeProg] = useState<any>(null);
  const [scrapeTrend, setScrapeTrend] = useState<any>(null);
  const [scrapeEvents, setScrapeEvents] = useState<any>(null);
  const [scrapePages, setScrapePages] = useState(3);
  const [pageCfg, setPageCfg] = useState<any>(null);
  const [scraping, setScraping] = useState(false);
  // 「获取最新数据」的回执：已更新 / 无变化 / 失败，A、B 各一份
  const [receiptA, setReceiptA] = useState<any>(null);
  const [receiptB, setReceiptB] = useState<any>(null);
  // 无变化那几次的留痕（刷新页面后仍能看到「上次检查 15:22」）
  const [checksA, setChecksA] = useState<any[]>([]);
  const [checksB, setChecksB] = useState<any[]>([]);
  const [srpList, setSrpList] = useState<any[]>([]);
  const [srpTargets, setSrpTargets] = useState<any[]>([]);
  const [runOpen, setRunOpen] = useState(false);
  // 当前正在看的是哪一条记录（列表高亮用）。之前没有这个，点哪条都看不出选中了谁
  const [activeRecId, setActiveRecId] = useState<string | null>(null);

  const trimmed = input.trim();
  const looksAsin = /^[A-Z0-9]{10}$/i.test(trimmed);
  const kind: Kind = forceKind ?? (looksAsin ? 'asin' : 'keyword');
  const value = kind === 'asin' ? trimmed.toUpperCase() : trimmed;
  const valid = kind === 'asin' ? /^[A-Z0-9]{10}$/.test(value) : value.length >= 2;

  const loadTargets = useCallback(async () => {
    try { setTargets(await apiTargets()); }
    catch (e: any) {
      // 401 时列表为空 = 没登录，不是「没数据」，必须说清楚
      setErr(authError(e) || { title: e.message || '加载监测列表失败' });
    }
  }, []);

  const loadQueries = useCallback(async () => {
    try { setQueries(await apiQueries()); }
    catch (e: any) {
      const ae = authError(e);
      if (ae) setErr(ae);        // 登录失效要显示；其余静默，免得打断主流程
    }
  }, []);

  /** 左栏列表里的爬虫记录 */
  const loadSrpList = useCallback(async () => {
    try { setSrpList(await apiScrapeAll()); } catch { /* 静默，不影响主流程 */ }
  }, []);

  /** 前台实测的定时抓取目标（每天自动跑） */
  const loadSrpTargets = useCallback(async () => {
    try { setSrpTargets(await apiScrapeTargets()); } catch { /* 静默 */ }
  }, []);

  // 首次加载必须等四个列表都回来再自动选中。
  // 之前是「records 一非空就选第一条」，而 queries 常比 srpList 先返回 ——
  // 于是选中了一条只有 SIF 的临时记录，A 区被清空，看起来就是「第一次进来 A 没数据」。
  const [initDone, setInitDone] = useState(false);
  useEffect(() => {
    Promise.all([loadTargets(), loadQueries(), loadSrpList(), loadSrpTargets()])
      .finally(() => setInitDone(true));
  }, [loadTargets, loadQueries, loadSrpList, loadSrpTargets]);

  useEffect(() => {
    apiSettings().then((x: any) => setDefaultN(Number(x.default_competitor_n || 10))).catch(() => {});
  }, []);

  // 抓取页数是「每个关键词各自一份」：换词就拉该词保存过的值，
  // 不同词的榜单深度需求不一样（头部词 2 页够，长尾词要多翻几页）
  useEffect(() => {
    const kw = value.trim();
    if (kind !== 'keyword' || !kw) {
      apiScrapeConfig().then((c: any) => setPageCfg(c)).catch(() => {});
      return;
    }
    const t = window.setTimeout(() => {
      apiScrapeConfig(kw)
        .then((c: any) => { setPageCfg(c); setScrapePages(Number(c.pages) || 3); })
        .catch(() => {});
    }, 500);
    return () => window.clearTimeout(t);
  }, [value, kind]);

  // 错误改成顶部 toast：停留 4.5 秒自动消失，不再占左栏空间。
  // sticky（登录失效）不自动消失 —— 否则用户只看到「空列表」，不知道是没权限。
  useEffect(() => {
    if (!err || err.sticky) return;
    const t = window.setTimeout(() => setErr(null), 4500);
    return () => window.clearTimeout(t);
  }, [err]);

  /** 输入变化就清掉旧错误与手动覆盖，重新自动识别 */
  function onInput(v: string) {
    setInput(v);
    if (err) setErr(null);
    setForceKind(null);
  }

  async function doQuery(ownOverride?: string) {
    if (!valid) { setErr({ title: kind === 'asin' ? '请输入 10 位 ASIN' : '请输入关键词' }); return; }
    setErr(null); setBusy(true);
    // 同理：换词了，上一个词的爬虫榜单也不该继续挂着
    if (scrapeSnap && scrapeSnap.keyword !== value) {
      setScrapeSnap(null); setScrapeHist([]); setScrapeTrend(null); setScrapeEvents(null);
    }
    setProgress({ stage: '提交查询…', elapsed: 0 });
    try {
      const { taskId } = await apiQueryAsync(kind, value,
        (ownOverride ?? own).trim().toUpperCase());
      for (let i = 0; i < 400; i++) {
        const t = await apiQueryStatus(taskId);
        setProgress(t);
        if (t.status === 'done') {
          setResult(t.result); setResultKind(kind); setResultFrom('live');
          if (t.query_id) setActiveRecId('sif-' + t.query_id);
          setProgress(null); loadQueries();
          // 后端已按内容指纹比对过：没变就不新增记录，只更新时间
          setReceiptB(t.changed === false
            ? { kind: 'same', text: '与上次完全一致，未新增记录' }
            : { kind: 'ok', text: '已更新 · 新增 1 条记录' });
          apiTrendByValue(kind, value).then(setTrend).catch(() => setTrend(null));
          return;
        }
        if (t.status === 'failed') {
          const e = new Error(t.error || '查询失败');
          (e as any).code = t.code;
          throw e;
        }
        await sleep(900);
      }
      throw new Error('查询超时（超过 6 分钟），请稍后再试');
    } catch (e: any) {
      if (e?.code === 'sif_timeout' || /超时|timed out/i.test(e?.message || '')) {
        setErr({
          title: 'SIF 响应超时，已自动重试一次',
          hint: kind === 'asin'
            ? '该 ASIN 的词量较大时 SIF 侧会较慢。可稍后重试，或先加入监测让它在后台慢慢跑。'
            : '该词要拉前 100 名竞品，SIF 侧负载高时要 30~60 秒以上。可稍后重试，或换搜索量小一点的词。',
        });
      } else {
        setErr({ title: e.message || '查询失败' });
      }
      setProgress(null);
    } finally { setBusy(false); }
  }

  /**
   * 抓取前台搜索结果页（爬虫）。
   * 3 页约 1 分钟（页间限速防封），所以后端是异步任务，这里轮询进度。
   */
  async function doScrape(overridePages?: number) {
    const kw = value.trim();
    const pages = overridePages ?? scrapePages;
    if (!kw || kind !== 'keyword') {
      setErr({ title: '前台实测按关键词抓，请输入一个关键词' });
      return;
    }
    setErr(null); setScraping(true);
    // 换词了就别留着上一个词的 SIF 结果，否则两个 tab 会显示不同词的数据
    if (result && (result.keyword || result.asin) !== kw) setResult(null);
    setScrapeProg({ stage: '提交抓取…', page_done: 0, page_total: pages });
    try {
      const { taskId } = await apiScrapeAsync(kw, pages);
      setScrapeTaskId(taskId);
      for (let i = 0; i < 400; i++) {
        const t = await apiScrapeStatus(taskId);
        setScrapeProg(t);
        if (t.status === 'done') {
          const res = t.result || {};
          setScrapeSnap({
            id: t.snap_id,
            keyword: res.keyword || kw,
            country: SCRAPE_MARKET,
            snap_date: (res.captured_at || '').slice(0, 10),
            data: res,
          });
          setScrapeProg(null);
          setActiveRecId(t.snap_id ? 'scrape-' + t.snap_id : null);
          // changed=false 时 snap_id 指向当天已存在的那条，不新增
          setReceiptA(t.changed === false
            ? { kind: 'same', text: '与上次完全一致，未新增记录' }
            : { kind: 'ok', text: '已更新 · 新增 1 条记录' });
          apiScrapeHistory(kw).then(setScrapeHist).catch(() => setScrapeHist([]));
          apiScrapeTrend(kw).then(setScrapeTrend).catch(() => setScrapeTrend(null));
          apiScrapeEvents(kw).then(setScrapeEvents).catch(() => setScrapeEvents(null));
          loadSrpList();
          return;
        }
        if (t.status === 'failed') throw new Error(t.error || '抓取失败');
        await sleep(1200);
      }
      throw new Error('抓取超时（超过 8 分钟）');
    } catch (e: any) {
      const msg = e?.message || '抓取失败';
      setReceiptA({ kind: 'fail', text: msg });
      setErr({
        title: msg,
        hint: /限流|503|blocked|被亚马逊/i.test(msg)
          ? '亚马逊对同一 IP 的搜索请求限得很紧。等 2~3 分钟再试，或先把页数降到 1~2 页。'
          : undefined,
      });
      setScrapeProg(null);
    } finally { setScraping(false); setScrapeTaskId(null); }
  }

  /** 弹窗确认：先把监测配置落库；execute=false 时只存配置、不跑数据 */
  async function handleRun(opt: {
    doScrape: boolean; doSif: boolean; pages: number; ownAsin: string;
    srpDaily: boolean; srpAt: string;
    sifMonitor: boolean; sifN: number; sifAt: string;
  }, execute = true) {
    setRunOpen(false);
    const kw = value.trim();
    if (!kw) { setErr({ title: '请输入关键词' }); return; }
    const ownNow = (opt.ownAsin || '').trim().toUpperCase();
    setOwn(ownNow);

    // B 侧：每周监测。勾了就建/更新；取消勾选则暂停（不删，历史快照要留）
    if (opt.doSif) {
      if (opt.sifMonitor) {
        try {
          await apiAdd({
            kind, value: kw,
            ownAsin: kind === 'keyword' ? (ownNow || null) : null,
            competitorN: opt.sifN, runAt: opt.sifAt, freq: 'weekly', extraAsins: null,
          });
          loadTargets();
        } catch (e: any) { setErr({ title: e.message || '加入监测失败' }); }
      } else if (curSifSched && !curSifSched.paused) {
        try { await apiUpdateTarget({ id: curSifSched.id, paused: true }); loadTargets(); }
        catch (e: any) { setErr({ title: e.message || '暂停监测失败' }); }
      }
    }

    // A 侧：页数 + 每天自动抓取。取消勾选则停掉定时（已抓到的榜单保留）
    if (opt.doScrape && kind === 'keyword') {
      changePages(opt.pages);
      if (opt.srpDaily) {
        try {
          await apiSaveScrapeTarget({
            keyword: kw, country: SCRAPE_MARKET,
            pages: opt.pages, dailyAt: opt.srpAt, enabled: true,
          });
          loadSrpTargets();
        } catch (e: any) { setErr({ title: e.message || '保存每天抓取失败' }); }
      } else if (curSrpSched && curSrpSched.enabled) {
        try {
          await apiSaveScrapeTarget({
            keyword: kw, country: SCRAPE_MARKET,
            pages: opt.pages, dailyAt: curSrpSched.daily_at || '', enabled: false,
          });
          loadSrpTargets();
        } catch (e: any) { setErr({ title: e.message || '暂停每天抓取失败' }); }
      }
    }

    // 立刻执行。两个都勾就并行：一个抓搜索页、一个查 SIF，互不阻塞。
    // 点「只保存配置」时 execute=false，只落配置、不跑数据 ——
    // 之前只有一个「开始」按钮，等于强制「改配置就得重跑一次」，用户只是想改个页数也被迫跑了一遍。
    if (execute) {
      if (opt.doScrape && kind === 'keyword') doScrape(opt.pages);
      if (opt.doSif) doQuery(ownNow);
    }
  }

  /** 请求停止当前正在进行的搜索页抓取（等当前页抓完即收尾） */
  async function stopCurrentScrape() {
    if (!scrapeTaskId) return;
    try {
      await apiScrapeStop(scrapeTaskId);
      setScrapeProg((p: any) => p ? { ...p, stage: '正在停止（等当前页抓完）…' } : p);
    } catch (e: any) { setErr({ title: e.message || '停止失败' }); }
  }

  /** 暂停/恢复某个词的每天自动抓取 */
  /** 暂停/恢复某个 SIF 定时监测目标 */
  /** 点「待首次抓取」的定时项：这个词只有定时、还没有榜单可看 */
  /** 取消某个词的每天自动抓取 */
  /** 切换日期：读某一天的快照 */
  async function pickScrapeDate(id: string) {
    try {
      const s = await apiScrapeSnap(id);
      if (s) setScrapeSnap(s);
    } catch (e: any) { setErr({ title: e.message || '读取快照失败' }); }
  }

  /** 删除一条抓取记录。删的是当前正在看的那条时，回退到同词最近一条 */
  /** 点左栏某条抓取记录：载入那一次的榜单（输入框同步成该词） */
  /** 改抓取页数：存到当前这个词名下，换个词会是它自己的值 */
  function changePages(n: number) {
    setScrapePages(n);
    const kw = value.trim();
    apiScrapeSavePages(n, kind === 'keyword' && kw ? kw : undefined).catch(() => {});
  }

  /** 点左栏某条 SIF 记录：载入那次查询的结果 */
  async function exportExcel(id?: string) {
    setErr(null);
    try { await downloadExcel(id); }
    catch (e: any) { setErr({ title: e.message || '导出失败' }); }
  }

  /** 点左栏某条记录：把该词的 A/B 两侧一起载入（一个词一行，点开就是它的全部） */
  async function openRecord(r: any) {
    setErr(null);
    setInput(r.value || '');
    setForceKind(null);
    setActiveRecId(r.key);

    if (r.scrape && !r.scrape.pending && r.scrape.id) {
      try {
        const s = await apiScrapeSnap(r.scrape.id);
        setScrapeSnap(s || null);
        const [hist, tr, ev] = await Promise.all([
          apiScrapeHistory(r.value).catch(() => []),
          apiScrapeTrend(r.value).catch(() => null),
          apiScrapeEvents(r.value).catch(() => null),
        ]);
        setScrapeHist(hist); setScrapeTrend(tr); setScrapeEvents(ev);
      } catch (e: any) { setErr({ title: e.message || '读取榜单失败' }); }
    } else {
      setScrapeSnap(null); setScrapeHist([]); setScrapeTrend(null); setScrapeEvents(null);
    }

    if (r.sif && !r.sif.pending && r.sif.id) {
      try {
        const d = await apiQueryDetail(r.sif.id);
        const rec = d.query || {};
        setResult(rec.data || {});
        setResultKind(rec.kind || 'keyword');
        setResultFrom('history');
        apiTrendByValue(rec.kind || 'keyword', rec.value || r.value)
          .then(setTrend).catch(() => setTrend(null));
      } catch (e: any) { setErr({ title: e.message || '读取查询结果失败' }); }
    } else {
      setResult(null); setTrend(null);
    }
  }

  /** A 区定时：暂停 / 恢复「每天自动抓取」。只停定时，不动已抓到的榜单 */
  async function toggleSrp(t: any) {
    if (!t) return;
    try {
      await apiSaveScrapeTarget({
        keyword: t.keyword,
        country: t.country || SCRAPE_MARKET,
        pages: t.pages || scrapePages,
        dailyAt: t.daily_at || '',
        enabled: !t.enabled,
      });
      await Promise.all([loadSrpTargets(), loadSrpList()]);
    } catch (e: any) { setErr({ title: e.message || '操作失败' }); }
  }

  /** B 区定时：暂停 / 恢复「每周监测」。只置 paused，不删目标（历史快照要留） */
  async function toggleSif(t: any) {
    if (!t) return;
    try {
      await apiUpdateTarget({ id: t.id, paused: !t.paused });
      await loadTargets();
    } catch (e: any) { setErr({ title: e.message || '操作失败' }); }
  }

  /** 删掉一个词的全部内容：两侧记录 + 两侧定时（定时只停用，配置保留） */
  async function delRecord(r: any) {
    const also: string[] = [];
    if (r.scrapeSched?.enabled) also.push(`停掉每天 ${r.scrapeSched.daily_at || '随时'} 自动抓取`);
    if (r.sifSched && !r.sifSched.paused) also.push('暂停每周监测');
    const extra = also.length
      ? `\n\n顺带会${also.join('、')}（以后可在配置弹窗里重新勾上）。` : '';
    if (!confirm(`删除「${r.value}」的全部记录？${extra}`)) return;

    try {
      for (const s of srpList.filter(
        (x: any) => String(x.keyword || '').toLowerCase() === r.key)) {
        await apiScrapeDel(s.id);
      }
      if (r.scrapeSched?.enabled) {
        await apiSaveScrapeTarget({
          keyword: r.scrapeSched.keyword,
          country: r.scrapeSched.country || SCRAPE_MARKET,
          pages: r.scrapeSched.pages || 3,
          dailyAt: r.scrapeSched.daily_at || '',
          enabled: false,
        });
      }
      for (const q of queries.filter(
        (x: any) => String(x.value || '').toLowerCase() === r.key)) {
        await apiDelQuery(q.id);
      }
      if (r.sifSched && !r.sifSched.paused) {
        await apiUpdateTarget({ id: r.sifSched.id, paused: true });
      }

      await loadSrpList(); await loadQueries(); loadSrpTargets(); loadTargets();
      if (activeRecId === r.key) {
        setScrapeSnap(null); setScrapeHist([]); setScrapeTrend(null); setScrapeEvents(null);
        setResult(null); setTrend(null); setActiveRecId(null);
      }
    } catch (e: any) { setErr({ title: e.message || '删除失败' }); }
  }

  /** A 区标题旁的删除：只删当前这一条榜单，不碰 SIF 和定时 */
  async function deleteCurrentScrape(id: string) {
    if (!confirm('删除这条抓取记录？')) return;
    try {
      await apiScrapeDel(id);
      await loadSrpList();
      setScrapeSnap(null); setScrapeHist([]); setScrapeTrend(null); setScrapeEvents(null);
    } catch (e: any) { setErr({ title: e.message || '删除失败' }); }
  }

  // 左栏一个列表，**按关键词聚合**：一个词只占一行，行内分两小行分别显示
  // 前台实测与 SIF 的状态。之前是「一条爬虫记录 + 一条 SIF 记录」，同一个词点一次查询
  // 就跑出两行重复项，看着像重复数据。
  const records = (() => {
    const map = new Map<string, any>();

    const ensure = (kw: string) => {
      const k = String(kw || '').toLowerCase();
      if (!map.has(k)) {
        map.set(k, { key: k, value: kw, created_at: '', scrape: null, sif: null,
                     scrapeSched: null, sifSched: null });
      }
      return map.get(k);
    };
    const bump = (r: any, ts: any) => {
      if (String(ts || '') > String(r.created_at || '')) r.created_at = ts;
    };

    // 列表已按时间倒序，同词只取最新一条
    srpList.forEach((s: any) => {
      const r = ensure(s.keyword);
      if (!r.scrape) {
        r.scrape = { id: s.id, pages: s.pages, org_total: s.org_total,
                     ad_total: s.ad_total, created_at: s.created_at };
      }
      bump(r, s.created_at);
    });
    queries.forEach((q: any) => {
      const r = ensure(q.value);
      if (!r.sif) {
        r.sif = { id: q.id, kind: q.kind, summary: q.summary, created_at: q.created_at };
      }
      bump(r, q.created_at);
    });

    // 定时目标：有就挂徽章；没有对应记录且**仍在启用**时，补一条「待首次」
    srpTargets.forEach((t: any) => {
      const r = ensure(t.keyword);
      r.scrapeSched = t;
      if (!r.scrape && t.enabled) r.scrape = { pending: true, pages: t.pages, org_total: 0 };
      bump(r, t.created_at);
    });
    targets.forEach((t: any) => {
      const r = ensure(t.value);
      r.sifSched = t;
      if (!r.sif && !t.paused) r.sif = { pending: true, summary: '' };
      bump(r, t.created_at);
    });

    // 两边都没内容的（例如只有一条已停用的定时）不显示
    return [...map.values()]
      .filter(r => r.scrape || r.sif)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  })();

  // 首次进入自动选中第一条记录，走 openRecord 把 A/B 两侧一起加载。
  // 之前另写了一段「恢复最近一次抓取」，只喂了 A 区，导致左栏没有选中态、
  // B 区 SIF 数据空白，用户得再点一次左侧记录才正常。
  const autoPicked = useRef(false);
  useEffect(() => {
    // 必须等 initDone：四个列表都到齐，records 才是完整的（否则可能选到半成品记录）
    if (!initDone || autoPicked.current || records.length === 0) return;
    autoPicked.current = true;
    // 优先选「有实测榜单」的那条，A 区一进来就有内容
    const first = records.find((r: any) => r.scrape && !r.scrape.pending) || records[0];
    openRecord(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initDone, records.length]);

  // 记录被删光时，右侧的旧榜单/旧查询结果也要一起清掉。
  // 否则下次有记录进来，A/B 会突然冒出上一个已被删除的词的榜单。
  useEffect(() => {
    if (records.length > 0) return;
    setScrapeSnap(null); setScrapeHist([]); setScrapeTrend(null); setScrapeEvents(null);
    setResult(null); setTrend(null); setActiveRecId(null);
  }, [records.length]);

  // 切词或刷新记录后重新拉「检查留痕」，并清掉上一条的回执
  useEffect(() => {
    const kw = value.trim();
    setReceiptA(null); setReceiptB(null);
    if (!kw) { setChecksA([]); setChecksB([]); return; }
    let alive = true;
    apiChecks('scrape', kw).then(r => { if (alive) setChecksA(r); }).catch(() => {});
    apiChecks('sif', kw).then(r => { if (alive) setChecksB(r); }).catch(() => {});
    return () => { alive = false; };
  }, [value, srpList.length, queries.length]);

  const lastCheck = (rows: any[]) =>
    rows.length ? String(rows[0].checked_at || '').replace('T', ' ').slice(5, 16) : '';

  // 当前输入词已经配了哪些定时（顶部配置区回显用）
  const curKw = value.trim().toLowerCase();
  const curSrpSched = srpTargets.find(
    (t: any) => String(t.keyword || '').toLowerCase() === curKw) || null;
  const curSifSched = targets.find(
    (t: any) => String(t.value || '').toLowerCase() === curKw) || null;

  return (
    <>
    <div className="ai-root">
      <div className="ai-side">
        <div className="ai-field">
          <label className="ai-label">查询对象</label>
          <input className="ai-select mono" value={input}
            placeholder="关键词，或 10 位 ASIN"
            onChange={e => onInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && valid && !busy && !scraping) setRunOpen(true);
            }} />
          <div className="rk-hint">
            {trimmed ? (
              <>
                按 <b>{kind === 'asin' ? 'ASIN' : '关键词'}</b> 查询
                {looksAsin && kind === 'asin' && (
                  <button type="button" className="rk-link" onClick={() => setForceKind('keyword')}>
                    其实是个词？
                  </button>
                )}
                {forceKind && (
                  <button type="button" className="rk-link" onClick={() => setForceKind(null)}>
                    恢复自动识别
                  </button>
                )}
              </>
            ) : (
              <span className="tf-tiny">10 位字母数字会按 ASIN 查，其余按关键词查</span>
            )}
          </div>
        </div>


        <div className="ai-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setRunOpen(true)}
            disabled={!valid || busy || scraping}>
            {busy || scraping ? '执行中…' : '查询 / 抓取'}
          </button>
        </div>

        {scraping && scrapeProg && (
          <div className="rk-progress">
            <div className="rk-progress-bar">
              <b style={{
                width: `${Math.max(8, Math.min(100, Math.round(((scrapeProg.page_done || 0) / Math.max(1, scrapeProg.page_total || scrapePages)) * 100)))}%`,
              }} />
            </div>
            <div className="rk-progress-row">
              <span className="rk-progress-text">
                {scrapeProg.stage || '抓取中'}
                {scrapeProg.page_total ? ` (${scrapeProg.page_done || 0}/${scrapeProg.page_total}页)` : ''}
                {scrapeProg.elapsed ? ` · ${Math.round(scrapeProg.elapsed)}s` : ''}
              </span>
              {scrapeTaskId && (
                <button type="button" className="rk-link rk-stop-link" onClick={stopCurrentScrape}>
                  停止
                </button>
              )}
            </div>
          </div>
        )}

        {busy && progress && (
          <div className="rk-progress">
            <div className="rk-progress-bar"><i /></div>
            <div className="rk-progress-text">
              {progress.stage || '处理中'}
              {progress.elapsed ? ` · 已 ${Math.round(progress.elapsed)}s` : ''}
              {progress.attempt > 1 ? ` · 第 ${progress.attempt} 次尝试` : ''}
            </div>
          </div>
        )}

        <div className="ai-history">
          <div className="rk-hist-head">
            <span className="rk-hist-title">查询记录 <i>{records.length}</i></span>
          </div>

          {!records.length && (
            <div className="ai-empty">还没有记录。抓一次榜单或查一次 SIF 就会出现在这里。</div>
          )}
          {records.map(r => {
            const sc = r.scrape, sf = r.sif;
            const scOff = r.scrapeSched && !r.scrapeSched.enabled;
            const sfOff = r.sifSched && r.sifSched.paused;
            return (
              <div key={r.key} className="ai-task rk-li"
                data-active={activeRecId === r.key}>
                {/* 这里用 div 而不是 button：行内要放「暂停/继续」按钮，
                    按钮套按钮是非法 HTML，点击也会连带触发打开记录 */}
                <div className="ai-task-main rk-li-main" role="button" tabIndex={0}
                  onClick={() => openRecord(r)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRecord(r); } }}>
                  <div className="rk-li-top">
                    <span className="rk-li-title mono" title={r.value}>{r.value}</span>
                    <span className="rk-li-time">{fmtDate(r.created_at)}</span>
                  </div>

                  {sc && (
                    <div className="rk-li-row">
                      <span className="rk-li-src rk-li-src-a">前台实测</span>
                      <span className="rk-li-val" data-dim={(sc.pending || scOff) ? true : undefined}>
                        {sc.pending ? '待首次抓取' : `${sc.pages || 0} 页 · ${sc.org_total || 0} 自然位`}
                      </span>
                      {r.scrapeSched ? (
                        <span className="rk-badge-sched" data-off={scOff ? true : undefined}>
                          每日 {r.scrapeSched.daily_at || '随时'}
                        </span>
                      ) : <span />}
                      {r.scrapeSched && (
                        <button className="rk-li-pause" type="button"
                          title={scOff ? '恢复每天自动抓取' : '暂停每天自动抓取'}
                          aria-label={scOff ? '恢复每天自动抓取' : '暂停每天自动抓取'}
                          onClick={e => { e.stopPropagation(); toggleSrp(r.scrapeSched); }}>
                          {scOff ? <PlayIcon /> : <PauseIcon />}
                        </button>
                      )}
                    </div>
                  )}

                  {sf && (
                    <div className="rk-li-row">
                      <span className="rk-li-src rk-li-src-b">SIF</span>
                      <span className="rk-li-val" data-dim={(sf.pending || sfOff) ? true : undefined}>
                        {sf.pending ? '待首次查询' : (sf.summary || '—')}
                      </span>
                      {r.sifSched ? (
                        <span className="rk-badge-sched" data-off={sfOff ? true : undefined}>
                          每周一{r.sifSched.run_at ? ' ' + r.sifSched.run_at : ''}
                        </span>
                      ) : <span />}
                      {r.sifSched && (
                        <button className="rk-li-pause" type="button"
                          title={sfOff ? '恢复每周监测' : '暂停每周监测'}
                          aria-label={sfOff ? '恢复每周监测' : '暂停每周监测'}
                          onClick={e => { e.stopPropagation(); toggleSif(r.sifSched); }}>
                          {sfOff ? <PlayIcon /> : <PauseIcon />}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="rk-li-acts">
                  {((sc && !sc.pending) || (sf && !sf.pending)) && (
                    <button className="rk-li-btn rk-dl"
                      title={sc && !sc.pending ? '导出这个词的实测榜单 CSV' : '导出这条查询 Excel'}
                      aria-label={sc && !sc.pending ? '导出这个词的实测榜单 CSV' : '导出这条查询 Excel'}
                      onClick={async () => {
                        try {
                          if (sc && !sc.pending && sc.id) {
                            const s = scrapeSnap?.id === sc.id ? scrapeSnap
                              : await apiScrapeSnap(sc.id);
                            if (s) exportSrpCsv(s);
                          } else if (sf && !sf.pending && sf.id) {
                            exportExcel(sf.id);
                          }
                        } catch (e: any) { setErr({ title: e.message || '导出失败' }); }
                      }}>
                      <DownloadIcon />
                    </button>
                  )}
                  <button className="rk-li-btn rk-del" title="删除这个词的全部记录"
                    aria-label="删除这个词的全部记录" onClick={() => delRecord(r)}>
                    <TrashIcon />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

      </div>

      <div className="ai-main">
        {records.length === 0 ? (
          // 左栏一条记录都没有时，右侧整体清空 —— 否则会残留上一次的配置回显，
          // 看着像「还有数据」，其实只是配置。
          <div className="ai-empty">
            <div>左栏还没有任何记录。</div>
            <div style={{ marginTop: 6 }}>输入关键词后点「查询 / 抓取」，结果会显示在这里。</div>
          </div>
        ) : (
        <>
            {/* 顶部只回显当前配置；改配置统一走弹窗，避免两处都能改、互相覆盖 */}
            <div className="rk-setup">
              <div className="rk-setup-bar">
                <span className="rk-setup-title mono">{trimmed || '未选择关键词'}</span>
                <button type="button" className="rk-link" onClick={() => setRunOpen(true)}
                  disabled={!valid}>
                  修改配置
                </button>
              </div>
              <div className="rk-setup-grid">
                <div className="rk-setup-item">
                  <div className="rk-setup-head">
                    <span className="rk-setup-name">A · 前台实测</span>
                    <span className="rk-setup-hint">爬虫抓搜索页 · 实时</span>
                  </div>
                  <div className="rk-setup-body">
                    <span className="tf-tiny">
                      {kind !== 'keyword'
                        ? '仅关键词可用'
                        : `${scrapePages} 页（${scrapePages * 48} 位）· ${curSrpSched ? `已加入每天 ${curSrpSched.daily_at || '随时'} 抓取` : '不自动抓取'}`}
                    </span>
                  </div>
                </div>
                <div className="rk-setup-item">
                  <div className="rk-setup-head">
                    <span className="rk-setup-name">B · SIF 平台数据</span>
                    <span className="rk-setup-hint">ABA 周数据 · 一周查一次即可</span>
                  </div>
                  <div className="rk-setup-body">
                    <span className="tf-tiny">
                      {`前 ${curSifSched?.competitor_n || defaultN} 名竞品 + 自然位 · ${curSifSched ? `已加入每周监测${curSifSched.run_at ? ' ' + curSifSched.run_at : ''}` : '不自动监测'}`}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {(scrapeSnap || result) ? (
          <>
            <section className="rk-sec">
              <div className="rk-sec-head">
                <span className="rk-sec-title">A · 前台实测（爬虫）</span>
                <span className="rk-sec-sub">实时抓取，带抓取时刻与原页面顺序</span>
                <div className="rk-sec-act">
                  {checksA.length > 0 && (
                    <span className="tf-tiny" title={`共 ${checksA.length} 次检查无变化`}>
                      上次检查 {lastCheck(checksA)}
                    </span>
                  )}
                  {receiptA && (
                    <span className={`rk-receipt rk-receipt-${receiptA.kind}`}>{receiptA.text}</span>
                  )}
                  <button className="rk-ghost-btn" onClick={() => doScrape()}
                    disabled={scraping || !valid} title="重新抓一次亚马逊搜索结果页">
                    {scraping
                      ? `抓取中 ${scrapeProg?.page_done ?? 0}/${scrapeProg?.page_total ?? scrapePages}…`
                      : '获取最新数据'}
                  </button>
                </div>
              </div>
              {scrapeSnap ? (
                <ScrapeResult snap={scrapeSnap} ownAsin={own} history={scrapeHist} trend={scrapeTrend}
                  events={scrapeEvents} onPick={pickScrapeDate} onDel={deleteCurrentScrape} />
              ) : (
                <div className="ai-empty">
                  还没有抓取过这个词。点上面的「获取最新数据」。
                </div>
              )}
            </section>

            <section className="rk-sec">
              <div className="rk-sec-head">
                <span className="rk-sec-title">B · SIF 平台数据</span>
                <span className="rk-sec-sub">第三方口径，周期取值；与上面各看各的，不做交叉对比</span>
                <div className="rk-sec-act">
                  {checksB.length > 0 && (
                    <span className="tf-tiny" title={`共 ${checksB.length} 次检查无变化`}>
                      上次检查 {lastCheck(checksB)}
                    </span>
                  )}
                  {receiptB && (
                    <span className={`rk-receipt rk-receipt-${receiptB.kind}`}>{receiptB.text}</span>
                  )}
                  <button className="rk-ghost-btn" onClick={() => doQuery()}
                    disabled={busy || !valid} title="重新调一次 SIF（ABA 周数据，同一周内结果不变）">
                    {busy
                      ? `查询中${progress?.elapsed ? ' ' + Math.round(progress.elapsed) + 's' : ''}…`
                      : '获取最新数据'}
                  </button>
                </div>
              </div>
            {result ? (
          <>
            <div className="ai-main-head">
              <div className="ai-main-title">
                <span className="mono">{resultKind === 'keyword' ? result.keyword : result.asin}</span>
                <span className="ai-status ai-status-done">
                  {resultFrom === 'history' ? '历史查询' : '即时查询'}
                </span>
                <span className="ai-status ai-status-running">
                  {resultFrom === 'history' ? '已存档' : '已存历史'}
                </span>
              </div>
              <div className="ai-main-sub">
                {resultKind === 'keyword'
                  ? `站点 ${result.country} · 竞品 ${result.competitor_count} 个${result.notice ? ' · ' + result.notice : ''}`
                  : `站点 ${result.country} · 覆盖 ${result.keyword_count} 个词`}
              </div>
            </div>
            <div className="ai-actions">
              <button className="btn btn-sm" onClick={() => exportExcel()} disabled={busy}>
                导出全部历史 Excel
              </button>
            </div>
            {resultKind === 'keyword' && <KeywordTrendCard keyword={result.keyword} />}
            {trend && trend.count >= 2 && <TrendCard trend={trend} />}
            {resultKind === 'keyword' ? <KeywordResult data={result} /> : <AsinResult data={result} />}
          </>
            ) : (
              <div className="ai-empty">还没有 SIF 数据。点左栏「查询 / 抓取」，在弹窗里勾上 B 区。</div>
            )}
            </section>
          </>
            ) : (
          <div className="ai-empty">
            <div>左边输入关键词或 ASIN 后，这里有上下两块，各看各的：</div>
            <div style={{ marginTop: 6 }}>· 勾 A 区 → <b>前台实测</b>（爬虫抓的整页榜单，带抓取时刻与主图）</div>
            <div>· 勾 B 区 → <b>SIF 平台数据</b>（第三方口径，周期取值）</div>
            <div style={{ marginTop: 6 }}>两块互不覆盖，也不会互相比较。</div>
          </div>
            )}
          </>
        )}
      </div>
    </div>

    {err && createPortal(
      <div className={'rk-toast' + (err.hint ? ' rk-toast-multi' : '')} role="status" aria-live="polite">
        <div className="rk-toast-title">{err.title}</div>
        {err.hint && <div className="rk-toast-hint">{err.hint}</div>}
      </div>, document.body)}

    <RunConfigModal open={runOpen} kind={kind} value={value} pages={scrapePages}
      pageCfg={pageCfg} defaultN={defaultN}
      ownAsin={own || curSifSched?.own_asin || ''}
      srpSched={curSrpSched} sifSched={curSifSched}
      onClose={() => setRunOpen(false)} onRun={handleRun} />

    </>
  );
}
