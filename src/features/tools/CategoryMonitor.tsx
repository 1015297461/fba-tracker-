import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { authHeaders } from './AiAnalyze';
import { ProductDetailDialog } from './ProductScrape';
import type { ScrapedProduct } from './ProductScrape';
import { useColResize } from './colResize';
import { DateCalendar } from './DateCalendar';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
interface CatTarget {
  id: string;
  marketplace: string;
  nodeId: string;
  nodePath: string | null;
  label: string | null;
  listTypes: string[];
  enabled: boolean;
  freqType: 'daily' | 'every_n' | 'weekly';
  everyNDays: number;
  scheduleWeekday: number;
  scheduleTime: string | null;
  lastRunAt: string | null;
  lastStatus: string;
  lastError: string | null;
  lastProgress?: string | null;
}
interface CatItem {
  rank: number;
  asin: string;
  title: string | null;
  price: string | null;
  rating: number | null;
  reviewCount: number | null;
  image: string | null;
  productUrl: string | null;
  prevRank?: number | null;
  delta?: number | null;
}
interface CatSnapshot {
  date: string;
  prevDate?: string | null;
  capturedAt: string;
  status: string;
  items: CatItem[];
}
export interface CatDetail {
  asin: string;
  title?: string | null;
  brand?: string | null;
  price?: string | null;
  rating?: string | null;
  reviewCount?: number | null;
  image?: string | null;
  url?: string | null;
  bsr?: { rank: string; category: string }[];
  images?: string[];
  aplusImages?: string[];
  bulletPoints?: string[];
  description?: string | null;
  specifications?: Record<string, string>;
  productDetails?: Record<string, string>;
  categories?: string | null;
  seller?: string | null;
  availability?: string | null;
  customerReviews?: any;
  cached?: boolean;
  cachedAt?: number;
  error?: string | null;
}
interface TrendPoint { date: string; rank: number | null; }
interface TrendSeries { asin: string; title: string | null; points: TrendPoint[]; }
interface TrendData { dates: string[]; series: TrendSeries[]; }
interface CatEvent {
  targetId: string; listType: string; date: string; asin: string;
  eventType: string; oldRank: number | null; newRank: number | null;
  delta: number | null; title: string | null;
}
interface RunRec {
  id: number; target_id: string; started_at: string | null; finished_at: string | null;
  pages: number | null; requests: number | null; items: number | null;
  status: string; error: string | null;
}

const LIST_LABEL: Record<string, string> = { bestsellers: '畅销榜', 'new-releases': '新品榜' };
const COLORS = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#be185d', '#65a30d', '#d97706'];

function statusText(s: string): string {
  return ({
    idle: '空闲', running: '采集中', ok: '成功', partial: '部分成功',
    error: '失败', paused: '已暂停', cancelled: '已取消',
  } as Record<string, string>)[s] || s;
}
/** 把后端 `bestsellers:partial` / `acp:TimeoutError` 这类内部串翻译成人话 */
function fmtRunErr(s: string | null): string {
  if (!s) return '';
  const ST: Record<string, string> = {
    partial: '部分条目字段不全', error: '采集失败', blocked: '被反爬拦截',
    incomplete: '部分条目字段不全', no_html: '未取到页面', no_recs: '页面无榜单数据',
  };
  return s.split(';').map(seg => {
    const t = seg.trim();
    if (!t) return '';
    const i = t.indexOf(':');
    if (i < 0) return t;
    const lt = t.slice(0, i), st = t.slice(i + 1);
    const ltLabel = LIST_LABEL[lt];
    return ltLabel ? `${ltLabel}：${ST[st] || st}` : t;
  }).filter(Boolean).join('；');
}
function freqText(t: CatTarget): string {
  const time = t.scheduleTime || '09:00';
  if (t.freqType === 'every_n') return `每 ${t.everyNDays || 1} 天 ${time}`;
  if (t.freqType === 'weekly') {
    const w = ['一', '二', '三', '四', '五', '六', '日'][((t.scheduleWeekday || 1) - 1 + 7) % 7];
    return `每周${w} ${time}`;
  }
  return `每日 ${time}`;
}
function stars(r: number): string {
  const full = Math.round(r);
  return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
}
function money(v: string | null | undefined): string {
  if (!v) return '—';
  const n = Number(v);
  return isNaN(n) ? String(v) : '$' + n.toFixed(2);
}
function isoDay(d: Date): string { return d.toISOString().slice(0, 10); }
function daysAgo(n: number): string { return isoDay(new Date(Date.now() - n * 86400000)); }
// 时间戳格式化：ISO(2026-10-29T16:45:00) → 2026-10-29 16:45（去掉 T，保留年月日+时分）
function fmtTs(iso?: string | null): string {
  if (!iso) return '—';
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

async function apiGet<T = any>(path: string): Promise<T> {
  const r = await fetch(path, { headers: authHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error || `HTTP ${r.status}`);
  return j as T;
}
async function apiSend<T = any>(path: string, method: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error || `HTTP ${r.status}`);
  return j as T;
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------
export function CategoryMonitor() {
  const [targets, setTargets] = useState<CatTarget[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [listType, setListType] = useState('bestsellers');
  const [snap, setSnap] = useState<CatSnapshot | null>(null);
  const [snapDates, setSnapDates] = useState<string[]>([]);   // 历史快照日期（供选择）
  const [snapDate, setSnapDate] = useState('');               // 当前查看的快照日期；'' = 最新
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('https://www.amazon.com/gp/bestsellers/home-garden/3732191/');
  const [q, setQ] = useState('');
  const [runBusy, setRunBusy] = useState(false);
  const [detail, setDetail] = useState<CatDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<'trend' | 'events' | 'runs'>('trend');
  // 分析区（趋势图 / 位次矩阵）**自己的**榜单类型，与上方榜单列表的 tab 互不影响
  const [anaLT, setAnaLT] = useState('');
  // 分析区榜单与上方不同时，趋势悬浮窗的缩略图要从"分析区那个榜单"的快照里取
  const [anaImages, setAnaImages] = useState<Record<string, string | null> | null>(null);
  const pollRef = useRef<number | null>(null);

  const current = targets.find(t => t.id === selected) || targets[0] || null;
  // 查询记录拖拽排序
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const didDragRef = useRef(false);

  const onDropOn = async (targetId: string) => {
    const from = dragId;
    setDragId(null);
    setOverId(null);
    if (!from || from === targetId) return;
    const ids = targets.map(t => t.id);
    const a = ids.indexOf(from), b = ids.indexOf(targetId);
    if (a < 0 || b < 0) return;
    ids.splice(b, 0, ids.splice(a, 1)[0]);
    const byId = new Map(targets.map(t => [t.id, t]));
    setTargets(ids.map(id => byId.get(id)!));       // 先本地生效，避免闪一下
    try {
      await apiSend('/api/catmon/targets/order', 'PUT', { ids });
    } catch (e: any) {
      setErr(e.message);
      await loadTargets();
    }
  };

  const loadTargets = useCallback(async () => {
    try {
      const j = await apiGet<{ targets: CatTarget[] }>('/api/catmon/targets');
      setTargets(j.targets || []);
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  const loadSnapshot = useCallback(async (tid: string, lt: string, date?: string) => {
    setLoading(true);
    setErr('');
    try {
      const j = await apiGet<{ snapshot: CatSnapshot | null }>(
        `/api/catmon/snapshot?targetId=${encodeURIComponent(tid)}&listType=${encodeURIComponent(lt)}` +
        (date ? `&date=${encodeURIComponent(date)}` : ''));
      setSnap(j.snapshot);
    } catch (e: any) {
      setErr(e.message);
      setSnap(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSnapDates = useCallback(async (tid: string, lt: string) => {
    try {
      const j = await apiGet<{ snapshots: { date: string }[] }>(
        `/api/catmon/snapshots?targetId=${encodeURIComponent(tid)}&listType=${encodeURIComponent(lt)}`);
      setSnapDates((j.snapshots || []).map(s => s.date));
    } catch {
      setSnapDates([]);
    }
  }, []);

  useEffect(() => { loadTargets(); }, [loadTargets]);
  useEffect(() => {
    if (!selected && targets.length) setSelected(targets[0].id);
  }, [targets, selected]);
  useEffect(() => {
    if (!current) return;
    const lts = current.listTypes || ['bestsellers', 'new-releases'];
    if (!lts.includes(listType)) setListType(lts[0]);
  }, [current?.id]);
  useEffect(() => {
    if (!current) return;
    setSnapDate('');
    loadSnapDates(current.id, listType);
    loadSnapshot(current.id, listType);
  }, [current?.id, listType, loadSnapshot, loadSnapDates]);
  // 只在**切换监控对象**时重置分析区榜单；上方切 tab 不影响分析区（两边独立）
  useEffect(() => { setAnaLT(''); }, [current?.id]);

  const ltsOfCurrent = (current?.listTypes && current.listTypes.length)
    ? current.listTypes : ['bestsellers'];
  const analysisLT = ltsOfCurrent.includes(anaLT) ? anaLT : ltsOfCurrent[0];

  useEffect(() => {
    if (!current || analysisLT === listType) { setAnaImages(null); return; }
    let alive = true;
    apiGet<{ snapshot: CatSnapshot | null }>(
      `/api/catmon/snapshot?targetId=${encodeURIComponent(current.id)}&listType=${encodeURIComponent(analysisLT)}`)
      .then(j => {
        if (!alive) return;
        const m: Record<string, string | null> = {};
        for (const it of (j.snapshot?.items || [])) m[it.asin] = it.image;
        setAnaImages(m);
      })
      .catch(() => { if (alive) setAnaImages(null); });
    return () => { alive = false; };
  }, [current?.id, listType, analysisLT]);

  const addTarget = async () => {
    setErr('');
    try {
      const j = await apiSend<{ target: CatTarget }>('/api/catmon/targets', 'POST', { url });
      await loadTargets();
      setSelected(j.target.id);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const removeTarget = async (id: string) => {
    if (!confirm('删除该监控对象及全部监控数据？')) return;
    try {
      await apiSend(`/api/catmon/targets?id=${encodeURIComponent(id)}`, 'DELETE', {});
      if (selected === id) setSelected(null);
      setSnap(null);
      await loadTargets();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const stopPoll = () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  };

  /** 轮询采集状态：只在 running 时跑；暂停/结束后停表并刷新快照 */
  const startPoll = (id: string) => {
    stopPoll();
    let tries = 0;
    pollRef.current = window.setInterval(async () => {
      tries++;
      try {
        const j = await apiGet<{ targets: CatTarget[] }>('/api/catmon/targets');
        setTargets(j.targets || []);
        const t = (j.targets || []).find(x => x.id === id);
        const still = !!t && (t.lastStatus === 'running' || t.lastStatus === 'paused');
        if (!still || tries > 120) {           // 最多盯 6 分钟
          stopPoll();
          setRunBusy(false);
          setSnapDate('');
          loadSnapDates(id, listType);
          loadSnapshot(id, listType);
        }
      } catch {
        stopPoll();
        setRunBusy(false);
      }
    }, 3000);
  };

  const runNow = async (id: string) => {
    setRunBusy(true);
    setErr('');
    try {
      await apiSend('/api/catmon/run', 'POST', { id });
      await loadTargets();
      startPoll(id);
    } catch (e: any) {
      setErr(e.message);
      setRunBusy(false);
    }
  };

  const pauseRun = async (id: string) => {
    setErr('');
    try {
      await apiSend('/api/catmon/pause', 'POST', { id });
      stopPoll();                              // 暂停后不再轮询，状态由接口即时写回
      setRunBusy(false);
      await loadTargets();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const resumeRun = async (id: string) => {
    setErr('');
    setRunBusy(true);
    try {
      await apiSend('/api/catmon/resume', 'POST', { id });
      await loadTargets();
      startPoll(id);
    } catch (e: any) {
      setErr(e.message);
      setRunBusy(false);
    }
  };

  const openDetail = async (asin: string, refresh = false) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const mk = current?.marketplace || 'US';
      const j = await apiGet<CatDetail>(
        `/api/catmon/detail?asin=${encodeURIComponent(asin)}&marketplace=${encodeURIComponent(mk)}${refresh ? '&refresh=1' : ''}`);
      setDetail(j);
    } catch (e: any) {
      setDetail({ asin, error: e.message });
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => { setDetail(null); setDetailLoading(false); };

  const items = snap?.items || [];
  // ASIN → 缩略图（趋势悬浮窗用；趋势接口不返回图，从当前快照映射）
  const imageByAsin = useMemo(() => {
    const m: Record<string, string | null> = {};
    for (const it of items) m[it.asin] = it.image;
    return m;
  }, [snap]);
  const ql = q.trim().toLowerCase();
  const filtered = items.filter(i => !ql || (i.title || '').toLowerCase().includes(ql) || i.asin.toLowerCase().includes(ql));
  // 列表排序：点表头切换 升/降，再点切回；null 表示按原始（排名）顺序
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const toggleSort = (k: string) => {
    if (sortKey === k) setSortDir(d => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(1); }
  };
  const sortedRows = useMemo(() => {
    if (!sortKey) return filtered;
    const get = (i: CatItem): number | string | null => {
      switch (sortKey) {
        case 'rank': return i.rank;
        case 'price': return i.price != null ? Number(i.price) : null;
        case 'rating': return i.rating;
        case 'reviews': return i.reviewCount;
        case 'delta': return i.delta ?? null;
        case 'title': return (i.title || i.asin || '').toLowerCase();
        default: return null;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;          // 空值无论升降都排最后
      if (vb == null) return -1;
      if (typeof va === 'string' || typeof vb === 'string')
        return sortDir * String(va).localeCompare(String(vb));
      return sortDir * ((va as number) - (vb as number));
    });
  }, [filtered, sortKey, sortDir]);
  const full = items.filter(i => i.title);
  const prices = full.map(i => Number(i.price)).filter(n => n > 0);
  const ratings = full.map(i => Number(i.rating)).filter(n => n > 0);
  const avgP = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const avgR = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
  // 「较上次」列常驻显示：有上一次快照时显示涨跌，否则整列显示「—」
  const hasPrev = !!snap?.prevDate;
  // 列宽可拖拽：排名62/价格92/商品(自动)/评分108/评论82/较上次92/详情66
  const catListCols = useColResize('catmon-list', [62, 92, null, 108, 82, 92, 66]);

  return (
    <div className="cm-wrap">
      <style>{CSS}</style>

      {/* ===== 左栏 ===== */}
      <aside className="cm-records">
        <div className="cm-label">监控对象</div>
        <input className="cm-input" value={url} onChange={e => setUrl(e.target.value)}
               placeholder="粘贴 Amazon 榜单 URL" />
        <button className="cm-btn" onClick={addTarget}>添加 / 采集</button>
        <div className="cm-sub">查询记录 <b>{targets.length}</b></div>
        <div className="cm-list">
          {targets.map(t => (
            <div key={t.id}
                 draggable
                 onDragStart={e => {
                   didDragRef.current = true;
                   setDragId(t.id);
                   e.dataTransfer.effectAllowed = 'move';
                   try { e.dataTransfer.setData('text/plain', t.id); } catch { /* 老浏览器忽略 */ }
                 }}
                 onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overId !== t.id) setOverId(t.id); }}
                 onDragLeave={() => setOverId(cur => (cur === t.id ? null : cur))}
                 onDrop={e => { e.preventDefault(); onDropOn(t.id); }}
                 onDragEnd={() => { setDragId(null); setOverId(null); setTimeout(() => { didDragRef.current = false; }, 0); }}
                 className={'cm-card'
                   + (current?.id === t.id ? ' active' : '')
                   + (dragId === t.id ? ' dragging' : '')
                   + (overId === t.id && dragId && dragId !== t.id ? ' drag-over' : '')}
                 onClick={() => { if (didDragRef.current) return; setSelected(t.id); }}>
              <div className="cm-card-head">
                <span className="cm-drag" title="拖动调整排序">⋮⋮</span>
                <span className="cm-card-name">{t.label || t.nodeId}</span>
                <span className="cm-card-acts">
                  <button title="立即采集" onClick={e => { e.stopPropagation(); runNow(t.id); }}>↻</button>
                  <button title="删除" onClick={e => { e.stopPropagation(); removeTarget(t.id); }}>✕</button>
                </span>
              </div>
              <div className="cm-card-node">{t.marketplace} · node {t.nodeId}</div>
              <div className="cm-card-row">
                {(t.listTypes || []).map(lt => (
                  <span key={lt}
                        className={'cm-b' + (current?.id === t.id && listType === lt ? ' on' : '')}>
                    {LIST_LABEL[lt] || lt}
                  </span>
                ))}
                <span className="cm-freq">{freqText(t)}</span>
              </div>
              <div className="cm-card-row">
                <span className={'cm-st ' + (t.lastStatus || 'idle')}>{statusText(t.lastStatus)}</span>
                {t.lastRunAt && <span className="cm-muted">{fmtTs(t.lastRunAt)}</span>}
              </div>
            </div>
          ))}
          {!targets.length && <div className="cm-empty">还没有监控对象，粘贴榜单 URL 添加</div>}
        </div>
      </aside>

      {/* ===== 右栏 ===== */}
      <section className="cm-detail">
        {err && <div className="cm-err">{err}</div>}
        {current ? (
          <>
            <div className="cm-target">
              <div className="cm-target-row">
                <div>
                  <div className="cm-target-title">
                    {current.label || current.nodeId}
                    <span className="cm-muted"> · {current.marketplace} · node {current.nodeId}</span>
                  </div>
                  <div className="cm-target-meta">
                    {freqText(current)} · 上次 {fmtTs(current.lastRunAt)} · {statusText(current.lastStatus)}
                    {current.lastError ? <span className="cm-err-inline"> · {fmtRunErr(current.lastError)}</span> : null}
                  </div>
                </div>
                <span className="cm-spacer" />
                {snapDates.length > 0 && (
                  <span className="cm-snap-pick" title="选择历史快照">
                    <span className="cm-muted" style={{ fontSize: 11 }}>快照</span>
                    <DateCalendar
                      value={snapDate || snap?.date || ''}
                      dates={snapDates}
                      onChange={d => { setSnapDate(d); loadSnapshot(current.id, listType, d); }}
                    />
                  </span>
                )}
                <span className="cm-chip">覆盖 <b>{items.length}</b> 条</span>
                <button className="cm-ghost" onClick={() => runNow(current.id)} disabled={runBusy}>
                  {runBusy ? '采集中…' : '立即采集'}
                </button>
                {current.lastStatus === 'running' && (
                  <button className="cm-ghost" onClick={() => pauseRun(current.id)}>暂停</button>
                )}
                {current.lastStatus === 'paused' && (
                  <button className="cm-btn" style={{ marginTop: 0, padding: '6px 14px' }}
                          onClick={() => resumeRun(current.id)}>继续</button>
                )}
              </div>
              <ScheduleEditor target={current} onSaved={loadTargets} />
            </div>

            {current.lastStatus === 'running' && (
              <div className="cm-progress">
                <span className="cm-spin" /> {current.lastProgress || '采集中…'}
              </div>
            )}
            {current.lastStatus === 'paused' && (
              <div className="cm-progress paused">
                <span>⏸</span> 已暂停 · 当前榜单抓完后停在原地，点「继续」接着跑
              </div>
            )}

            <div className="cm-toolbar">
              <div className="cm-tabs">
                {(current.listTypes || ['bestsellers']).map(lt => (
                  <button key={lt} className={'cm-tab' + (listType === lt ? ' active' : '')}
                          onClick={() => setListType(lt)}>{LIST_LABEL[lt] || lt}</button>
                ))}
              </div>
              <input className="cm-search" value={q} onChange={e => setQ(e.target.value)}
                     placeholder="搜索标题 / ASIN…" />
            </div>

            <div className="cm-note">
              每次采集自动补全 100 条；点缩略图或标题查看完整详情。
            </div>

            <div className="cm-kpis">
              <div className="cm-kpi"><div className="k">榜单条目</div><div className="v">{items.length} / 100</div></div>
              <div className="cm-kpi"><div className="k">平均价格</div><div className="v">{money(avgP ? String(avgP) : null)}</div></div>
              <div className="cm-kpi"><div className="k">平均评分</div><div className="v">{avgR ? avgR.toFixed(2) : '—'}</div></div>
            </div>

            <div className="cm-table-wrap">
              <table className={'cm-table col-rsz' + (catListCols.active ? ' cw-fixed' : '')}>
                {catListCols.colgroup}
                <thead {...catListCols.thProps}>
                  <tr>
                    <SortTh label="排名" k="rank" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <SortTh label="价格" k="price" cls="r" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <SortTh label="商品" k="title" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <SortTh label="评分" k="rating" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <SortTh label="评论" k="reviews" cls="r" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <SortTh label="较上次" k="delta" title={hasPrev ? `对比 ${snap?.prevDate}` : '暂无上一次快照，再采集一次后显示涨跌'} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map(i => {
                    const d = i.delta;
                    return (
                      <tr key={i.asin}>
                        <td><span className={'cm-rk' + (i.rank <= 3 ? ' top' : '')}>#{i.rank}</span></td>
                        <td className="cm-price r">{money(i.price)}</td>
                        <td>
                          <div className="cm-good">
                            <CmThumb src={i.image} onClick={() => openDetail(i.asin)} />
                            <div className="cm-good-main">
                              <div className="cm-title" onClick={() => openDetail(i.asin)}>
                                {i.title || `ASIN ${i.asin}（点击采集标题/品牌/BSR）`}
                              </div>
                              <div className="cm-asin">{i.asin}</div>
                            </div>
                          </div>
                        </td>
                        <td>{i.rating ? <span className="cm-stars">{stars(i.rating)} {i.rating.toFixed(1)}</span> : '—'}</td>
                        <td className="cm-muted r">{i.reviewCount ? i.reviewCount.toLocaleString() : '—'}</td>
                        <td>
                          {!hasPrev
                            ? <span className="cm-muted">—</span>
                            : i.prevRank == null
                              ? <span className="cm-new">新进</span>
                              : d == null || d === 0
                                ? <span className="cm-flat">持平</span>
                                : <span className={d < 0 ? 'cm-up' : 'cm-down'}>
                                    {d < 0 ? '↑' : '↓'}{Math.abs(d)}
                                  </span>}
                        </td>
                        <td className="r">
                          <button className="cm-mini" onClick={() => openDetail(i.asin)}>详情</button>
                        </td>
                      </tr>
                    );
                  })}
                  {!sortedRows.length && (
                    <tr><td colSpan={7} className="cm-empty-cell">
                      {loading ? '加载中…' : (snap ? '无匹配结果' : '还没有采集数据，点「立即采集」')}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* 分析区 */}
            <div className="cm-analysis">
              <div className="cm-atabs">
                <button className={'cm-atab' + (tab === 'trend' ? ' active' : '')} onClick={() => setTab('trend')}>排名趋势</button>
                <button className={'cm-atab' + (tab === 'events' ? ' active' : '')} onClick={() => setTab('events')}>全部 ASIN 位次</button>
                <button className={'cm-atab' + (tab === 'runs' ? ' active' : '')} onClick={() => setTab('runs')}>运行记录</button>
                {tab !== 'runs' && ltsOfCurrent.length > 1 && (
                  <span className="cm-atab-lt" title="分析区看哪个榜单，与上方列表独立">
                    <span className="cm-atab-lt-lb">查看</span>
                    {ltsOfCurrent.map(lt => (
                      <button key={lt}
                              className={'cm-lt-b' + (analysisLT === lt ? ' on' : '')}
                              onClick={() => setAnaLT(lt)}>
                        {LIST_LABEL[lt] || lt}
                      </button>
                    ))}
                  </span>
                )}
              </div>
              <div className="cm-analysis-body">
                {tab === 'trend' && (
                  <TrendPanel targetId={current.id} listType={analysisLT}
                              imageByAsin={analysisLT === listType ? imageByAsin : (anaImages || {})} />
                )}
                {tab === 'events' && <MatrixPanel targetId={current.id} listType={analysisLT} onOpen={openDetail} />}
                {tab === 'runs' && <RunsPanel targetId={current.id} />}
              </div>
            </div>
          </>
        ) : (
          <div className="cm-empty-detail">请选择或添加一个监控类目</div>
        )}
      </section>

      {/* ===== 详情弹窗：完全复用「产品采集」的 ProductDetailDialog ===== */}
      {detailLoading && (
        <div className="modal-backdrop">
          <div className="modal ps-detail-modal" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink-3)' }}>
              <span className="cm-spin" /> 正在采集详情…
            </div>
          </div>
        </div>
      )}

      {!detailLoading && detail && detail.error && !detail.title && (
        <div className="modal-backdrop" onClick={closeDetail}>
          <div className="modal" style={{ padding: 20, maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>详情采集失败</div>
            <div className="cm-err" style={{ marginBottom: 12 }}>{detail.error}</div>
            <button className="cm-btn" style={{ marginTop: 0 }} onClick={() => openDetail(detail.asin, true)}>↻ 重试</button>
          </div>
        </div>
      )}

      {!detailLoading && detail && !(detail.error && !detail.title) && (
        <ProductDetailDialog
          product={toScrapedProduct(detail, current?.marketplace || 'US')}
          open={true}
          onClose={closeDetail}
          taskId=""
          onRefresh={() => openDetail(detail.asin, true)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 定时设置
// ---------------------------------------------------------------------------
function ScheduleEditor({ target, onSaved }: { target: CatTarget; onSaved: () => void }) {
  const [freq, setFreq] = useState<'daily' | 'weekly'>(target.freqType === 'weekly' ? 'weekly' : 'daily');
  const [time, setTime] = useState(target.scheduleTime || '09:00');
  const [weekday, setWeekday] = useState(target.scheduleWeekday || 1);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setFreq(target.freqType === 'weekly' ? 'weekly' : 'daily');
    setTime(target.scheduleTime || '09:00');
    setWeekday(target.scheduleWeekday || 1);
    setMsg('');
  }, [target.id]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await apiSend('/api/catmon/targets', 'PUT', {
        id: target.id, freqType: freq, scheduleTime: time, scheduleWeekday: weekday,
      });
      setMsg('已保存');
      onSaved();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cm-sched">
      <span className="cm-sched-label">定时</span>
      <select value={freq} onChange={e => setFreq(e.target.value as 'daily' | 'weekly')}>
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
      </select>
      {freq === 'weekly' && (
        <select value={weekday} onChange={e => setWeekday(Number(e.target.value))}>
          {['一', '二', '三', '四', '五', '六', '日'].map((w, i) => (
            <option key={i} value={i + 1}>周{w}</option>
          ))}
        </select>
      )}
      <input type="time" value={time} onChange={e => setTime(e.target.value)} />
      <button className="cm-ghost" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
      {msg && <span className="cm-muted">{msg}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 缩略图：悬浮显示 300x300 大图（与排名监测 ImgThumb 一致）
// ---------------------------------------------------------------------------
function CmThumb({ src, onClick }: { src: string | null; onClick: () => void }) {
  const [pv, setPv] = useState<{ x: number; y: number } | null>(null);
  if (!src) return <div className="cm-thumb ph" onClick={onClick}>点击</div>;
  return (
    <>
      <img className="cm-thumb" src={src} alt="" loading="lazy" onClick={onClick}
        onMouseEnter={e => {
          const r = (e.currentTarget as HTMLImageElement).getBoundingClientRect();
          const W = 300, H = 300, gap = 14;
          let x = r.right + gap;
          if (x + W > window.innerWidth - 10) x = r.left - W - gap;
          if (x < 10) x = 10;
          let y = r.top + r.height / 2 - H / 2;
          y = Math.max(10, Math.min(y, window.innerHeight - H - 10));
          setPv({ x, y });
        }}
        onMouseLeave={() => setPv(null)}
        onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
      {pv && createPortal(
        <div className="cm-img-pop" style={{ left: pv.x, top: pv.y }}>
          <img src={src} alt="" />
        </div>, document.body)}
    </>
  );
}

/** 可点击排序的表头：点一次升序、再点降序、再点取消 */
function SortTh({ label, k, cls, title, sortKey, sortDir, onSort }: {
  label: string; k: string; cls?: string; title?: string;
  sortKey: string | null; sortDir: 1 | -1; onSort: (k: string) => void;
}) {
  const active = sortKey === k;
  return (
    <th className={(cls || '') + ' cm-sort' + (active ? ' cm-sort-on' : '')}
        onClick={() => onSort(k)} title={title || `点击按「${label}」排序`}>
      {label}{active ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
}

// ---------------------------------------------------------------------------
// 排名趋势（自定义时间范围 + Top ASIN / 自定义 ASIN）
// ---------------------------------------------------------------------------
function TrendPanel({ targetId, listType, imageByAsin }: {
  targetId: string; listType: string; imageByAsin?: Record<string, string | null>;
}) {
  const [start, setStart] = useState(daysAgo(13));
  const [end, setEnd] = useState(daysAgo(0));
  const [topN, setTopN] = useState(5);
  const [custom, setCustom] = useState('');
  const [data, setData] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const asins = custom.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).join(',');
      const j = await apiGet<TrendData>(
        `/api/catmon/trend?targetId=${encodeURIComponent(targetId)}&listType=${encodeURIComponent(listType)}` +
        `&start=${start}&end=${end}&topN=${topN}&asins=${encodeURIComponent(asins)}`);
      setData(j);
    } catch (e: any) {
      setErr(e.message); setData(null);
    } finally {
      setLoading(false);
    }
  }, [targetId, listType, start, end, topN, custom]);

  useEffect(() => { load(); }, [targetId, listType]);
  useEffect(() => { setData(null); }, [targetId, listType]);

  const setQuick = (n: number) => { setStart(daysAgo(n - 1)); setEnd(daysAgo(0)); };

  return (
    <div>
      <div className="cm-filters">
        <span>时间</span>
        <input type="date" value={start} onChange={e => setStart(e.target.value)} />
        <span>~</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} />
        <button className="cm-ghost" onClick={() => setQuick(7)}>近7天</button>
        <button className="cm-ghost" onClick={() => setQuick(14)}>近14天</button>
        <button className="cm-ghost" onClick={() => setQuick(30)}>近30天</button>
        <span style={{ marginLeft: 10 }}>ASIN</span>
        <select value={topN} onChange={e => setTopN(Number(e.target.value))}>
          {[3, 5, 10, 15, 20].map(n => <option key={n} value={n}>Top {n}</option>)}
        </select>
        <input type="text" value={custom} onChange={e => setCustom(e.target.value)}
               placeholder="自定义 ASIN（逗号分隔，留空用 Top N）" />
        <button className="cm-btn" style={{ marginTop: 0, padding: '5px 12px' }} onClick={load} disabled={loading}>
          {loading ? '查询中…' : '查询'}
        </button>
      </div>

      {err && <div className="cm-err">{err}</div>}
      {!err && data && data.dates.length === 0 && <div className="cm-muted" style={{ fontSize: 12 }}>该区间没有数据</div>}
      {!err && data && data.dates.length > 0 && data.series.length === 0 && (
        <div className="cm-muted" style={{ fontSize: 12 }}>没有匹配的 ASIN 数据</div>
      )}
      {!err && data && data.series.length > 0 && (
        <>
          <TrendChart data={data} imageByAsin={imageByAsin} />
          <div className="cm-legend">
            {data.series.map((s, i) => (
              <span key={s.asin}>
                <i style={{ background: COLORS[i % COLORS.length] }} />
                {s.asin} {s.title ? '· ' + s.title.slice(0, 18) : ''}
              </span>
            ))}
          </div>
        </>
      )}
      {!err && !data && !loading && <div className="cm-muted" style={{ fontSize: 12 }}>点「查询」加载趋势</div>}
    </div>
  );
}

function TrendChart({ data, imageByAsin }: {
  data: TrendData; imageByAsin?: Record<string, string | null>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const W = 660, H = 250, P = { l: 36, r: 14, t: 12, b: 24 };
  const dates = data.dates;
  const allRanks = data.series.flatMap(s => s.points.map(p => p.rank)).filter((r): r is number => r != null);
  const maxRank = allRanks.length ? Math.max(10, ...allRanks) : 100;
  const y = (r: number) => P.t + (r - 1) / Math.max(1, maxRank - 1) * (H - P.t - P.b);
  const x = (i: number) => P.l + (dates.length <= 1 ? 0 : i / (dates.length - 1)) * (W - P.l - P.r);
  const gridRanks = [1, Math.round(maxRank / 2), maxRank];

  // 移出图表/悬浮窗后延迟关闭，让鼠标能移到悬浮窗上而不闪退
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined; } };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHover(null), 220);
  };

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    cancelClose();
    const r = e.currentTarget.getBoundingClientRect();
    if (!rect || Math.abs(rect.left - r.left) > 1 || Math.abs(rect.top - r.top) > 1 || Math.abs(rect.width - r.width) > 1) {
      setRect({ left: r.left, top: r.top, width: r.width });
    }
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    dates.forEach((_, i) => { const d = Math.abs(x(i) - px); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  };

  // 悬浮提示：锚定在「悬停日期所在的数据点」正上方（图表顶部），
  // 这样鼠标向上移动即可移到弹层上（纵向移动不改日期 → 弹层不跑）。
  const tipStyle = (() => {
    if (hover == null || !rect) return undefined;
    const TW = 300, TH = 30 + data.series.length * 42;
    const pxScreen = rect.left + (x(hover) / W) * rect.width;
    let left = pxScreen + 14;
    if (left + TW > window.innerWidth - 8) left = pxScreen - TW - 14;
    if (left < 8) left = 8;
    let top = rect.top + 6;
    if (top + TH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - TH - 8);
    return { left, top };
  })();

  return (
    <div className="cm-chart-wrap" onMouseMove={onMove} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <svg className="cm-chart" viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 250 }}>
        {gridRanks.map(r => (
          <g key={r}>
            <line x1={P.l} y1={y(r)} x2={W - P.r} y2={y(r)} stroke="var(--border)" strokeWidth={1} />
            <text x={P.l - 8} y={y(r) + 3} fontSize={9} fill="var(--ink-4)" textAnchor="end">{r}</text>
          </g>
        ))}
        {dates.map((d, i) => {
          if (dates.length > 10 && i % Math.ceil(dates.length / 8) !== 0 && i !== dates.length - 1) return null;
          return <text key={d} x={x(i)} y={H - 6} fontSize={9} fill="var(--ink-4)" textAnchor="middle">{d.slice(5)}</text>;
        })}
        {hover != null && (
          <line x1={x(hover)} y1={P.t} x2={x(hover)} y2={H - P.b}
                stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="3 3" />
        )}
        {data.series.map((s, si) => {
          const color = COLORS[si % COLORS.length];
          const pts = s.points.map((p, i) => (p.rank != null ? `${x(i)},${y(p.rank)}` : null)).filter(Boolean).join(' ');
          return (
            <g key={s.asin}>
              {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />}
              {s.points.map((p, i) => p.rank != null
                ? <circle key={i} cx={x(i)} cy={y(p.rank)} r={2.4} fill={color} />
                : null)}
            </g>
          );
        })}
        {hover != null && data.series.map((s, si) => {
          const pt = s.points[hover];
          return pt && pt.rank != null
            ? <circle key={'h' + s.asin} cx={x(hover)} cy={y(pt.rank)} r={4}
                      fill={COLORS[si % COLORS.length]} stroke="var(--card-bg)" strokeWidth={1.5} />
            : null;
        })}
      </svg>
      {hover != null && tipStyle && createPortal(
        <div className="cm-chart-tip" style={tipStyle}
             onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
          <div className="d">{dates[hover]}</div>
          {data.series.map((s, si) => {
            const pt = s.points[hover];
            const img = imageByAsin?.[s.asin] || null;
            return (
              <div key={s.asin} className="row" style={{ borderLeftColor: COLORS[si % COLORS.length] }}>
                {img
                  ? <img className="tp-thumb" src={img} alt=""
                         onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                  : <span className="tp-thumb ph" />}
                <div className="tp-main">
                  <span className="tp-title">{s.title || s.asin}</span>
                  <span className="tp-asin">{s.asin}</span>
                </div>
                <b>{pt && pt.rank != null ? '#' + pt.rank : '—'}</b>
              </div>
            );
          })}
        </div>, document.body)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 全部 ASIN 位次（区间内出现过的全部 ASIN；展示形式与排名监测一致，去掉「上架」列）
// ---------------------------------------------------------------------------
interface CatMatrixRow {
  asin: string; title: string | null; image: string | null; price: number | null;
  ranks: (number | null)[]; present: number; best: number | null; last: number | null;
}
interface CatMatrix { dates: string[]; rows: CatMatrixRow[]; }

function MatrixPanel({ targetId, listType, onOpen }: {
  targetId: string; listType: string; onOpen: (asin: string) => void;
}) {
  const [data, setData] = useState<CatMatrix | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; head: string; body: string } | null>(null);
  const stripIdx = useRef<number | null>(null);
  const cols = useColResize('catmon-matrix', undefined, 9);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiGet<CatMatrix>(
        `/api/catmon/matrix?targetId=${encodeURIComponent(targetId)}&listType=${encodeURIComponent(listType)}`);
      setData(j);
      const ds = j.dates || [];
      setFrom(ds[Math.max(0, ds.length - 14)] || '');
      setTo(ds[ds.length - 1] || '');
    } catch (e: any) { setErr(e.message); setData(null); }
    finally { setLoading(false); }
  }, [targetId, listType]);

  useEffect(() => { setData(null); }, [targetId, listType]);
  useEffect(() => { load(); }, [targetId, listType]);

  const allDates = data?.dates || [];
  const rows = data?.rows || [];
  // 选中区间对应的日期下标
  const winIdx: number[] = [];
  allDates.forEach((d, i) => { if ((!from || d >= from) && (!to || d <= to)) winIdx.push(i); });
  const winDates = winIdx.map(i => allDates[i]);

  // 每行在区间内的派生值（出现天数 / 最好 / 最新 / 变化 / 趋势序列）
  const view = rows.map(r => {
    const seq = winIdx.map(i => r.ranks[i] ?? null);
    const vals = seq.filter((v): v is number => v != null);
    const first = seq.find(v => v != null) ?? null;
    const last = [...seq].reverse().find(v => v != null) ?? null;
    const delta = first != null && last != null ? last - first : null;
    return { ...r, seq, present: vals.length, bestW: vals.length ? Math.min(...vals) : null, lastW: last, delta };
  });

  const sortVal = (r: any): number | string | null => {
    if (!sort) return null;
    switch (sort.key) {
      case 'asin': return String(r.asin || '');
      case 'title': return String(r.title || '').toLowerCase();
      case 'price': return r.price != null ? Number(r.price) : null;
      case 'days': return r.present;
      case 'best': return r.bestW;
      case 'last': return r.lastW;
      case 'delta': return r.delta == null ? null : Math.abs(r.delta);
      case 'trend': {
        const v = r.seq.filter((x: number | null) => x != null) as number[];
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      }
      default: return null;
    }
  };
  const sorted = sort ? [...view].sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string' || typeof vb === 'string') return sort.dir * String(va).localeCompare(String(vb));
    return sort.dir * ((va as number) - (vb as number));
  }) : view;
  const th = (key: string, label: string, cls?: string, tip?: string) => {
    const on = sort?.key === key;
    return (
      <th className={(cls ? cls + ' ' : '') + 'rk-th-sort'} title={tip ? tip + '（点击排序）' : '点击排序'}
        data-sort={on ? (sort!.dir === 1 ? 'asc' : 'desc') : undefined}
        onClick={() => setSort(cur => (!cur || cur.key !== key ? { key, dir: 1 } : cur.dir === 1 ? { key, dir: -1 } : null))}>
        {label}<i className="rk-sort-arrow" />
      </th>
    );
  };

  // 趋势条悬浮：显示当天位次（复用排名监测的 .rk-tip-card）
  const stripMove = (e: React.MouseEvent, seq: (number | null)[]) => {
    const t = e.target as HTMLElement;
    const di = t.dataset ? t.dataset.i : undefined;
    if (di == null) { stripIdx.current = null; setTip(null); return; }
    const i = Number(di);
    if (stripIdx.current === i) return;
    stripIdx.current = i;
    const v = seq[i];
    const rect = t.getBoundingClientRect();
    const W = 200, H = 56, pad = 8;
    let x = Math.min(Math.max(rect.left - 70, pad), window.innerWidth - W - pad);
    let y = rect.bottom + 6;
    if (y + H > window.innerHeight - pad) y = rect.top - 6 - H;
    if (y < pad) y = pad;
    setTip({ x, y, head: winDates[i], body: v == null ? '掉榜（当天不在抓取范围内）' : `自然位 #${v}` });
  };
  const stripLeave = () => { stripIdx.current = null; setTip(null); };

  return (
    <div>
      <div className="rk-ev-head rk-mtx-filter" style={{ marginBottom: 8 }}>
        <span className="rk-range-lb">时间</span>
        <DateCalendar value={from} dates={allDates} onChange={setFrom} />
        <span className="rk-range-arrow">→</span>
        <DateCalendar value={to} dates={allDates} onChange={setTo} />
        <span className="rk-ev-count">（{winDates.length} 天）{loading ? ' 读取中…' : ''}</span>
      </div>
      {err && <div className="cm-err">{err}</div>}
      {!err && data && !rows.length && <div className="cm-muted" style={{ fontSize: 12 }}>该区间没有数据</div>}
      {!err && rows.length > 0 && (
        <div className="rk-mtx-wrap">
          <table className={'rk-mtx col-rsz' + (cols.active ? ' cw-fixed' : '')}>
            {cols.colgroup}
            <thead {...cols.thProps}>
              <tr>
                <th className="c-img">主图</th>
                {th('asin', 'ASIN', 'c-asin')}
                {th('title', '标题', 'c-title')}
                {th('price', '价格', 'c-price')}
                {th('days', '出现天数', 'c-days', '区间内有数据的天数中该 ASIN 出现的天数')}
                {th('best', '最好', 'c-num', '区间内最好自然位')}
                {th('last', '最新', 'c-num')}
                {th('delta', '变化', 'c-delta', '区间内位次变化（负数=变好）')}
                {th('trend', `趋势（${winDates.length} 天）`, 'c-strip')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r: any) => {
                const dlt = r.delta;
                const cls = dlt == null || dlt === 0 ? 'delta-flat' : dlt < 0 ? 'delta-up' : 'delta-dn';
                return (
                  <tr key={r.asin}>
                    <td className="c-img"><CmThumb src={r.image} onClick={() => onOpen(r.asin)} /></td>
                    <td className="c-asin mono">
                      <span className="cm-mtx-link" onClick={() => onOpen(r.asin)}>{r.asin}</span>
                    </td>
                    <td className="c-title">{r.title ? <span className="rk-el" title={r.title}>{r.title}</span> : '—'}</td>
                    <td className="c-price mono">{r.price != null ? `$${Number(r.price).toFixed(2)}` : '—'}</td>
                    <td className="c-days mono" title={`区间内共 ${winDates.length} 天有数据`}>{r.present}/{winDates.length}</td>
                    <td className="c-num mono">
                      {r.bestW != null
                        ? <span className={'rk-rank' + (r.bestW <= 10 ? ' top' : r.bestW <= 50 ? ' mid' : '')}>{r.bestW}</span>
                        : '—'}
                    </td>
                    <td className="c-num mono">
                      {r.lastW != null
                        ? <span className={'rk-rank' + (r.lastW <= 10 ? ' top' : r.lastW <= 50 ? ' mid' : '')}>{r.lastW}</span>
                        : '—'}
                    </td>
                    <td className={'c-delta ' + cls}>{dlt == null ? '—' : dlt === 0 ? '持平' : dlt < 0 ? `↑ ${Math.abs(dlt)}` : `↓ ${dlt}`}</td>
                    <td className="c-strip">
                      <div className="rk-strip" onMouseMove={e => stripMove(e, r.seq)} onMouseLeave={stripLeave}>
                        {r.seq.map((v: number | null, i: number) => (
                          <i key={i} data-i={i} className={v == null ? 'na' : ('lv' + Math.min(4, Math.floor(v / 40)))} />
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tip && (
        <div className="rk-tip-card" style={{ left: tip.x, top: tip.y }}>
          <div className="rk-tip-head">{tip.head}</div>
          <div className="rk-tip-body">{tip.body}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 运行记录
// ---------------------------------------------------------------------------
function RunsPanel({ targetId }: { targetId: string }) {
  const [runs, setRuns] = useState<RunRec[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiGet<{ runs: RunRec[] }>(`/api/catmon/runs?targetId=${encodeURIComponent(targetId)}`);
      setRuns(j.runs || []);
    } catch (e: any) {
      setErr(e.message); setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [targetId]);

  useEffect(() => { load(); }, [targetId]);
  const runsCols = useColResize('catmon-runs');

  return (
    <div>
      <div className="cm-filters">
        <button className="cm-btn" style={{ marginTop: 0, padding: '5px 12px' }} onClick={load} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
        <span className="cm-muted">{runs.length} 条</span>
      </div>
      {err && <div className="cm-err">{err}</div>}
      {!err && !runs.length && <div className="cm-muted" style={{ fontSize: 12 }}>还没有运行记录</div>}
      {runs.length > 0 && (
        <table className={'cm-runs-table col-rsz' + (runsCols.active ? ' cw-fixed' : '')}>
          {runsCols.colgroup}
          <thead {...runsCols.thProps}>
            <tr><th>开始</th><th>结束</th><th>状态</th><th>页数</th><th>请求</th><th>条目</th><th>错误</th></tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id}>
                <td className="cm-muted">{fmtTs(r.started_at)}</td>
                <td className="cm-muted">{fmtTs(r.finished_at)}</td>
                <td><span className={'cm-st ' + (r.status || '')}>{statusText(r.status)}</span></td>
                <td>{r.pages ?? '—'}</td>
                <td>{r.requests ?? '—'}</td>
                <td>{r.items ?? '—'}</td>
                <td className="cm-muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.error || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 把 catmon 详情映射成「产品采集」的 ScrapedProduct，供 ProductDetailDialog 复用
// ---------------------------------------------------------------------------
export function toScrapedProduct(d: CatDetail, marketplace: string): ScrapedProduct {
  const main = d.bsr?.[0];
  const sub = d.bsr?.[1];
  const price = d.price
    ? (d.price.startsWith('$') ? d.price : (marketplace === 'US' ? '$' + d.price : d.price))
    : null;
  return {
    asin: d.asin,
    marketplace,
    title: d.title || null,
    brand: d.brand || null,
    price,
    rating: d.rating || null,
    reviewCount: d.reviewCount != null ? String(d.reviewCount) : null,
    availability: d.availability || null,
    bulletPoints: d.bulletPoints || [],
    description: d.description || null,
    mainImage: d.image || null,
    images: d.images || [],
    aplusImages: d.aplusImages || [],
    specifications: d.specifications || {},
    productDetails: d.productDetails || {},
    categories: d.categories || null,
    seller: d.seller || null,
    bestSellerRank: {
      mainCategory: main?.category || null,
      mainRank: main?.rank ? Number(main.rank) : null,
      subCategory: sub?.category || null,
      subRank: sub?.rank ? Number(sub.rank) : null,
      rawText: null,
    } as any,
    customerReviews: (d.customerReviews || {}) as any,
    status: 'success',
    errorMessage: d.error || null,
  };
}

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------
const CSS = `
.cm-wrap{display:flex;min-height:0;height:100%;}
.cm-records{width:328px;flex:0 0 328px;border-right:1px solid var(--border);background:var(--bg-2);padding:12px;overflow:auto;}
.cm-detail{flex:1;min-width:0;overflow:auto;padding:14px;}
.cm-label{font-size:11px;color:var(--ink-4);margin-bottom:6px;}
.cm-input{width:100%;background:var(--bg);border:1px solid var(--border-strong);color:var(--ink);border-radius:8px;padding:8px 10px;font-size:12px;box-sizing:border-box;}
.cm-input:focus{outline:none;border-color:var(--blue);}
.cm-btn{border:0;border-radius:8px;padding:8px 14px;font-size:12.5px;font-weight:600;cursor:pointer;color:#fff;background:var(--blue);display:inline-block;margin-top:8px;}
.cm-ghost{background:transparent;border:1px solid var(--border-strong);color:var(--ink-2);border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer;}
.cm-ghost:disabled{opacity:.55;cursor:default;}
.cm-sub{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ink-3);margin:14px 0 8px;}
.cm-sub b{color:var(--ink);}
.cm-list{display:flex;flex-direction:column;gap:8px;}
.cm-card{border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--card-bg);cursor:pointer;position:relative;}
.cm-card:hover{border-color:var(--border-strong);}
.cm-card.dragging{opacity:.45;}
.cm-card.drag-over{box-shadow:0 -2px 0 0 var(--blue) inset;border-color:var(--blue);}
.cm-drag{cursor:grab;color:var(--ink-4);font-size:11px;letter-spacing:-1px;user-select:none;flex:0 0 auto;}
.cm-card:hover .cm-drag{color:var(--ink-3);}
.cm-card:active .cm-drag{cursor:grabbing;}
.cm-card.active{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue) inset;}
.cm-card-head{display:flex;align-items:center;gap:6px;}
.cm-card-name{font-weight:650;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cm-card-acts{margin-left:auto;display:flex;gap:2px;opacity:0;}
.cm-card:hover .cm-card-acts{opacity:.85;}
.cm-card-acts button{border:0;background:transparent;color:var(--ink-4);cursor:pointer;font-size:12px;padding:2px 4px;border-radius:5px;}
.cm-card-acts button:hover{background:rgba(128,128,128,.15);color:var(--ink);}
.cm-card-node{font-size:10.5px;color:var(--ink-4);font-family:var(--font-mono);margin-top:2px;}
.cm-card-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:6px;}
.cm-b{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--bg-2);border:1px solid var(--border);color:var(--ink-3);}
.cm-b.on{color:var(--blue);border-color:rgba(37,99,235,.4);background:var(--blue-soft);}
.cm-freq{font-size:10px;color:var(--ink-3);margin-left:auto;}
.cm-st{font-size:10.5px;color:var(--ink-4);}
.cm-st.ok{color:var(--green);} .cm-st.partial{color:var(--orange);} .cm-st.error{color:var(--red);} .cm-st.running{color:var(--blue);} .cm-st.paused{color:var(--orange);font-weight:600;} .cm-st.cancelled{color:var(--ink-4);}
.cm-muted{color:var(--ink-4);}
.cm-empty{font-size:12px;color:var(--ink-4);padding:12px;text-align:center;}
.cm-empty-detail{font-size:13px;color:var(--ink-4);padding:40px;text-align:center;}
.cm-err{background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.4);color:var(--red);border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:10px;}
.cm-err-inline{color:var(--red);}
.cm-target{display:flex;flex-direction:column;gap:8px;border:1px solid var(--border);border-radius:10px;padding:11px 13px;background:var(--card-bg);margin-bottom:12px;}
.cm-target-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.cm-target-title{font-weight:650;font-size:14px;}
.cm-target-meta{font-size:11.5px;color:var(--ink-3);margin-top:2px;}
.cm-spacer{flex:1;}
.cm-chip{border:1px solid var(--border);background:var(--bg-2);border-radius:999px;padding:2px 9px;font-size:11px;color:var(--ink-3);}
.cm-chip b{color:var(--ink);}
.cm-sched{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:8px;font-size:12px;color:var(--ink-3);}
.cm-sched-label{font-size:11px;color:var(--ink-4);}
.cm-sched select,.cm-sched input[type=time]{background:var(--bg-2);border:1px solid var(--border);color:var(--ink);border-radius:6px;padding:4px 8px;font-size:12px;}
.cm-sched .cm-ghost{padding:4px 10px;}
.cm-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;}
.cm-tabs{display:inline-flex;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;padding:2px;}
.cm-tab{border:0;background:transparent;color:var(--ink-3);font-size:12.5px;padding:6px 14px;border-radius:7px;cursor:pointer;}
.cm-tab.active{background:var(--card-bg);color:var(--ink);font-weight:600;}
.cm-search{margin-left:auto;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--ink);font-size:12px;width:200px;}
.cm-note{font-size:11px;color:var(--ink-4);margin:-2px 0 10px;line-height:1.5;}
.cm-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;}
.cm-img-pop{position:fixed;z-index:90;width:300px;height:300px;background:var(--card-bg);border:1px solid var(--border-strong);border-radius:10px;padding:6px;box-shadow:var(--shadow-md);pointer-events:none;}
.cm-img-pop img{width:100%;height:100%;object-fit:contain;}
.cm-progress{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--blue);background:var(--blue-soft);border:1px solid rgba(37,99,235,.3);border-radius:8px;padding:7px 10px;margin:-4px 0 10px;}
.cm-progress.paused{color:var(--orange);background:rgba(234,88,12,.08);border-color:rgba(234,88,12,.3);}
.cm-chart-wrap{position:relative;}
.cm-chart-tip{position:fixed;transform:none;background:var(--card-bg);border:1px solid var(--border-strong);border-radius:8px;box-shadow:var(--shadow-md);padding:8px 10px;font-size:11px;pointer-events:auto;z-index:200;width:300px;}
.cm-chart-tip .d{font-weight:600;margin-bottom:6px;color:var(--ink-2);}
.cm-chart-tip .row{display:flex;align-items:center;gap:8px;padding:4px 0 4px 7px;border-left:3px solid transparent;line-height:1.3;}
.cm-chart-tip .row + .row{border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent);}
.cm-chart-tip .tp-thumb{width:30px;height:30px;flex:0 0 30px;object-fit:cover;border-radius:5px;background:var(--bg-2);}
.cm-chart-tip .tp-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.cm-chart-tip .tp-title{font-size:10.5px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cm-chart-tip .tp-asin{font-family:var(--font-mono);font-size:9.5px;color:var(--ink-4);}
.cm-chart-tip .row b{margin-left:auto;font-variant-numeric:tabular-nums;padding-left:8px;font-size:12px;}
.cm-kpi{border:1px solid var(--border);border-radius:9px;background:var(--card-bg);padding:10px 12px;}
.cm-kpi .k{font-size:11px;color:var(--ink-3);}
.cm-kpi .v{font-size:17px;font-weight:700;margin-top:3px;}
.cm-table-wrap{border:1px solid var(--border);border-radius:10px;overflow:auto;max-height:520px;background:var(--card-bg);}
.cm-table{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:fixed;}
.cm-table th{position:sticky;top:0;z-index:1;background:var(--card-bg);text-align:left;font-size:11px;color:var(--ink-3);font-weight:600;padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap;}
.cm-table th.cm-sort{cursor:pointer;user-select:none;}
.cm-table th.cm-sort:hover{color:var(--ink-2);}
.cm-table th.cm-sort-on{color:var(--blue);}
.cm-table td{padding:7px 12px;border-bottom:1px solid var(--border);vertical-align:middle;}
.cm-table tr:last-child td{border-bottom:0;}
.cm-table tr:hover{background:rgba(128,128,128,.06);}
.cm-table .r{text-align:right;font-variant-numeric:tabular-nums;}
.cm-good{display:flex;align-items:center;gap:10px;min-width:0;}
.cm-good-main{min-width:0;flex:1;}
.cm-rk{font-weight:700;font-variant-numeric:tabular-nums;}
.cm-rk.top{color:var(--orange);}
.cm-thumb{width:42px;height:42px;border-radius:7px;object-fit:cover;background:var(--bg-2);border:1px solid var(--border);cursor:pointer;display:block;flex:0 0 auto;}
.cm-thumb.ph{display:grid;place-items:center;font-size:10px;color:var(--ink-4);}
.cm-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;cursor:pointer;}
.cm-title:hover{color:var(--blue);}
.cm-asin{font-family:var(--font-mono);font-size:10.5px;color:var(--ink-4);margin-top:1px;}
.cm-price{font-weight:650;white-space:nowrap;}
.cm-up{color:var(--green);font-size:11.5px;font-weight:600;white-space:nowrap;}
.cm-down{color:var(--red);font-size:11.5px;font-weight:600;white-space:nowrap;}
.cm-flat{color:var(--ink-4);font-size:11px;}
.cm-new{color:var(--blue);font-size:11px;font-weight:600;}
.cm-mini{border:1px solid var(--border);background:transparent;color:var(--ink-3);font-size:11px;padding:3px 8px;border-radius:6px;cursor:pointer;opacity:.6;transition:opacity .12s,border-color .15s,color .15s;}
.cm-table tr:hover .cm-mini{opacity:1;}
.cm-mini:hover{border-color:var(--border-strong);color:var(--ink);}
.cm-stars{color:#f59e0b;font-size:11px;white-space:nowrap;}
.cm-ok{color:var(--green);font-size:11px;}
.cm-todo{color:var(--ink-4);font-size:11px;border:1px dashed var(--border-strong);border-radius:4px;padding:0 5px;}
.cm-empty-cell{padding:24px;text-align:center;color:var(--ink-4);}
.cm-analysis{margin-top:14px;border:1px solid var(--border);border-radius:10px;background:var(--card-bg);}
.cm-atabs{display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--border);padding:6px 8px;}
.cm-atab{border:0;background:transparent;color:var(--ink-3);font-size:12.5px;padding:6px 12px;border-radius:7px;cursor:pointer;}
.cm-atab.active{background:var(--blue-soft);color:var(--ink);font-weight:600;}
.cm-atab-lt{margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding-right:2px;}
.cm-atab-lt-lb{font-size:11px;color:var(--ink-4);}
.cm-lt-b{border:1px solid var(--border);background:var(--bg-2);color:var(--ink-3);font-size:11.5px;
  padding:4px 10px;border-radius:999px;cursor:pointer;}
.cm-lt-b:hover{border-color:var(--border-strong);color:var(--ink-2);}
.cm-lt-b.on{color:var(--blue);border-color:rgba(37,99,235,.45);background:var(--blue-soft);font-weight:600;}
.cm-analysis-body{padding:12px 14px;}
.cm-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--ink-3);}
.cm-filters input[type=date],.cm-filters input[type=number],.cm-filters input[type=text],.cm-filters select{background:var(--bg-2);border:1px solid var(--border);color:var(--ink);border-radius:6px;padding:4px 8px;font-size:12px;}
.cm-filters input[type=text]{min-width:200px;}
.cm-filters .cm-ghost{padding:4px 10px;}
.cm-filters .cm-btn{padding:5px 12px;margin-top:0;}
.cm-chart{width:100%;height:auto;}
.cm-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--ink-3);margin-top:8px;}
.cm-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;}
.cm-ev-list{display:flex;flex-direction:column;gap:8px;max-height:340px;overflow:auto;}
.cm-ev{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-2);}
.cm-ev-k{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;flex:0 0 auto;}
.cm-ev-k.new{color:#0e7490;background:rgba(6,182,212,.16);}
.cm-ev-k.out{color:var(--ink-3);background:rgba(128,128,128,.16);}
.cm-ev-k.up{color:var(--green);background:rgba(22,163,74,.16);}
.cm-ev-k.down{color:var(--red);background:rgba(220,38,38,.16);}
.cm-ev-body{min-width:0;}
.cm-ev-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cm-ev-meta{font-size:10.5px;color:var(--ink-4);}
.cm-runs-table{width:100%;border-collapse:collapse;font-size:12px;}
.cm-runs-table th{text-align:left;font-size:11px;color:var(--ink-3);padding:7px 8px;border-bottom:1px solid var(--border);}
.cm-runs-table td{padding:7px 8px;border-bottom:1px solid var(--border);}
.cm-modal-back{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:70;padding:24px;}
.cm-modal{width:min(720px,100%);max-height:86vh;overflow:auto;background:var(--card-bg);border:1px solid var(--border-strong);border-radius:14px;position:relative;}
.cm-modal-close{position:absolute;top:10px;right:10px;width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--bg-2);color:var(--ink-3);cursor:pointer;font-size:15px;}
.cm-dm{padding:18px;}
.cm-dm-hero{display:flex;gap:14px;}
.cm-dm-img{width:128px;height:128px;border-radius:10px;object-fit:cover;border:1px solid var(--border);background:var(--bg-2);flex:0 0 auto;}
.cm-dm-img.ph{display:grid;place-items:center;color:var(--ink-4);font-size:11px;}
.cm-dm-badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:5px;}
.cm-src{font-size:10px;color:var(--ink-4);border:1px solid var(--border);border-radius:999px;padding:1px 7px;}
.cm-src.ok{color:var(--green);border-color:rgba(22,163,74,.4);}
.cm-dm-title{font-size:15px;font-weight:650;margin:0 0 3px;line-height:1.35;}
.cm-dm-sub{font-size:11.5px;color:var(--ink-4);font-family:var(--font-mono);}
.cm-dm-price{font-size:21px;font-weight:750;margin-top:7px;}
.cm-dm-rating{font-size:12px;color:var(--ink-3);margin-top:3px;}
.cm-dm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px;}
.cm-field{border:1px solid var(--border);border-radius:9px;padding:8px 10px;background:var(--bg-2);}
.cm-field span{display:block;font-size:10.5px;color:var(--ink-4);margin-bottom:2px;}
.cm-field b{font-size:12.5px;word-break:break-word;}
.cm-dm-bsr{margin-top:12px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--bg-2);}
.cm-dm-bsr-t{font-size:11px;color:var(--ink-4);font-weight:600;margin-bottom:6px;}
.cm-bsr-row{display:flex;gap:10px;padding:2px 0;font-size:12px;}
.cm-bsr-row .r{font-weight:700;color:var(--blue);min-width:48px;}
.cm-dm-actions{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap;}
.cm-dm-actions .cm-btn{margin-top:0;}
.cm-dm-note{margin-top:10px;font-size:11px;color:var(--ink-4);background:var(--bg-2);border:1px dashed var(--border-strong);border-radius:8px;padding:8px 10px;}
.cm-loading{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3);margin-top:14px;}
.cm-spin{width:13px;height:13px;border:2px solid var(--border-strong);border-top-color:var(--blue);border-radius:50%;animation:cmspin .7s linear infinite;display:inline-block;}
@keyframes cmspin{to{transform:rotate(360deg)}}
.cm-sk{background:linear-gradient(90deg,var(--border) 25%,var(--bg-2) 37%,var(--border) 63%);background-size:400% 100%;animation:cmsk 1.1s ease infinite;border-radius:6px;}
@keyframes cmsk{0%{background-position:100% 0}100%{background-position:-100% 0}}
.cm-sk-img{width:128px;height:128px;flex:0 0 auto;border-radius:10px;}
.cm-sk-line{height:12px;margin-bottom:9px;}
`;

export default CategoryMonitor;
