import React, { useState, useEffect, useMemo } from 'react';

const AUTH_TOKEN_KEY = 'fba-auth-v1';
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem(AUTH_TOKEN_KEY) || '';
  return t ? { Authorization: 'Bearer ' + t } : {};
}

const MARKETPLACES = [
  { code: 'US', flag: '🇺🇸', name: '美国',     domain: 'www.amazon.com' },
  { code: 'UK', flag: '🇬🇧', name: '英国',     domain: 'www.amazon.co.uk' },
  { code: 'DE', flag: '🇩🇪', name: '德国',     domain: 'www.amazon.de' },
  { code: 'FR', flag: '🇫🇷', name: '法国',     domain: 'www.amazon.fr' },
  { code: 'IT', flag: '🇮🇹', name: '意大利',   domain: 'www.amazon.it' },
  { code: 'ES', flag: '🇪🇸', name: '西班牙',   domain: 'www.amazon.es' },
  { code: 'JP', flag: '🇯🇵', name: '日本',     domain: 'www.amazon.co.jp' },
  { code: 'CA', flag: '🇨🇦', name: '加拿大',   domain: 'www.amazon.ca' },
  { code: 'AU', flag: '🇦🇺', name: '澳大利亚', domain: 'www.amazon.com.au' },
  { code: 'IN', flag: '🇮🇳', name: '印度',     domain: 'www.amazon.in' },
  { code: 'MX', flag: '🇲🇽', name: '墨西哥',   domain: 'www.amazon.com.mx' },
  { code: 'BR', flag: '🇧🇷', name: '巴西',     domain: 'www.amazon.com.br' },
  { code: 'SG', flag: '🇸🇬', name: '新加坡',   domain: 'www.amazon.sg' },
  { code: 'AE', flag: '🇦🇪', name: '阿联酋',   domain: 'www.amazon.ae' },
  { code: 'SA', flag: '🇸🇦', name: '沙特阿拉伯', domain: 'www.amazon.sa' },
  { code: 'NL', flag: '🇳🇱', name: '荷兰',     domain: 'www.amazon.nl' },
  { code: 'SE', flag: '🇸🇪', name: '瑞典',     domain: 'www.amazon.se' },
  { code: 'PL', flag: '🇵🇱', name: '波兰',     domain: 'www.amazon.pl' },
  { code: 'BE', flag: '🇧🇪', name: '比利时',   domain: 'www.amazon.com.be' },
  { code: 'TR', flag: '🇹🇷', name: '土耳其',   domain: 'www.amazon.com.tr' },
];
function mkInfo(code: string) {
  return MARKETPLACES.find(m => m.code === code) || { code, flag: '', name: code, domain: 'www.amazon.com' };
}

const BATCH_SIZE = 2;
const PAGE_SIZE = 20;

const STAR_OPTIONS = [
  { value: '', label: '全部星级' },
  { value: '5', label: '5 星' },
  { value: '4', label: '4 星' },
  { value: '3', label: '3 星' },
  { value: '2', label: '2 星' },
  { value: '1', label: '1 星' },
];

// ============================================================
// Types
// ============================================================
interface ReviewResult {
  id?: number;
  taskId: string;
  asin: string;
  marketplace: string;
  reviewId: string;
  rating: number | null;
  title: string | null;
  author: string | null;
  dateRaw: string | null;
  verified: boolean;
  body: string | null;
  helpfulCount: number | null;
  images: string[];
  fetchedAt: string;
}
interface ReviewTask {
  id: string;
  marketplace: string;
  asins: string[];
  sortBy: string;
  filterStar: string | null;
  verifiedOnly: boolean;
  maxPages: number;
  total: number;
  newCount: number;
  status: string;
  createdAt: string;
}
interface ReviewRunSummary {
  asin: string;
  marketplace: string;
  totalFetched: number;
  newCount: number;
  status: string;
  errorMessage: string | null;
}

// ---- API ----
async function apiGetReviewTasks(): Promise<ReviewTask[]> {
  const r = await fetch('/api/review/tasks', { headers: authHeaders() });
  if (!r.ok) throw new Error('加载历史任务失败');
  return (await r.json()).tasks || [];
}
async function apiGetReviewResults(taskId: string): Promise<ReviewResult[]> {
  const r = await fetch('/api/review/results?taskId=' + encodeURIComponent(taskId), { headers: authHeaders() });
  if (!r.ok) throw new Error('加载评论失败');
  return (await r.json()).results || [];
}
async function apiRunReview(
  asins: string[], marketplace: string, sortBy: string, filterStar: number | null,
  verifiedOnly: boolean, maxPages: number, taskId?: string,
): Promise<{ taskId: string; results: ReviewRunSummary[] }> {
  const r = await fetch('/api/review/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      asins, marketplace, sortBy, filterStar, verifiedOnly, maxPages,
      ...(taskId ? { taskId } : {}),
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || '采集失败');
  }
  const data = await r.json();
  return { taskId: data.taskId, results: data.results || [] };
}
async function apiDeleteReviewTask(id: string): Promise<void> {
  await fetch('/api/review/tasks?id=' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
}

// ---- Utilities ----
function fmtDateTime(iso: string): string {
  const m = iso.match(/\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}
function productUrl(asin: string, marketplace: string): string {
  return `https://${mkInfo(marketplace).domain}/dp/${asin}`;
}
function exportReviewCSV(results: ReviewResult[], marketplace: string) {
  const headers = ['ASIN', '站点', '评分', '标题', '作者', '日期', 'Verified Purchase', '有用数', '正文', '图片链接'];
  const rows = results.map(r => [
    r.asin, r.marketplace || marketplace,
    r.rating != null ? String(r.rating) : '',
    r.title || '', r.author || '', r.dateRaw || '',
    r.verified ? '是' : '否',
    r.helpfulCount != null ? String(r.helpfulCount) : '',
    r.body || '', (r.images || []).join(' | '),
  ]);
  const BOM = '﻿';
  const csv = BOM + [
    headers.map(h => `"${h}"`).join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `amazon_reviews_${marketplace}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// Main ReviewFetch component
// ============================================================
export function ReviewFetch() {
  const [asinInput, setAsinInput]     = useState('');
  const [marketplace, setMarketplace] = useState('US');
  const [sortBy, setSortBy]           = useState<'recent' | 'helpful'>('recent');
  const [filterStar, setFilterStar]   = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [maxPages, setMaxPages]       = useState(3);
  const [results, setResults]         = useState<ReviewResult[]>([]);
  const [summaries, setSummaries]     = useState<ReviewRunSummary[]>([]);
  const [running, setRunning]         = useState(false);
  const [progress, setProgress]       = useState({ completed: 0, total: 0, batch: 0, totalBatches: 0 });
  const [tasks, setTasks]             = useState<ReviewTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [err, setErr]                 = useState('');
  const [loadErr, setLoadErr]         = useState('');
  const [page, setPage]               = useState(1);
  const [hoverPreview, setHoverPreview] = useState<{ src: string; top: number; left: number } | null>(null);

  function showThumbPreview(e: React.MouseEvent<HTMLImageElement>, src: string) {
    const rect = e.currentTarget.getBoundingClientRect();
    const size = 200;
    const gap = 8;
    let left = rect.right + gap;
    if (left + size > window.innerWidth) left = rect.left - size - gap;
    let top = rect.top;
    if (top + size > window.innerHeight) top = window.innerHeight - size - gap;
    setHoverPreview({ src, top, left });
  }

  const asins = useMemo(() =>
    asinInput.split(/[\n,;\s]+/).map(a => a.trim().toUpperCase()).filter(Boolean),
    [asinInput]);
  const validAsins = useMemo(() => asins.filter(a => /^[A-Z0-9]{10}$/.test(a)), [asins]);

  async function reloadTasks() {
    try { setTasks(await apiGetReviewTasks()); setLoadErr(''); }
    catch (e: any) { setLoadErr(e.message || '加载失败'); }
  }
  useEffect(() => { reloadTasks(); }, []);

  async function runFetch() {
    if (!validAsins.length) { setErr('请输入有效的 ASIN（10 位字母数字）'); return; }
    setErr(''); setRunning(true); setResults([]); setSummaries([]); setActiveTaskId(null); setPage(1);

    const batches: string[][] = [];
    for (let i = 0; i < validAsins.length; i += BATCH_SIZE) batches.push(validAsins.slice(i, i + BATCH_SIZE));
    setProgress({ completed: 0, total: validAsins.length, batch: 0, totalBatches: batches.length });

    const filterStarNum = filterStar ? parseInt(filterStar, 10) : null;
    const allSummaries: ReviewRunSummary[] = [];
    let taskId: string | undefined;
    try {
      for (let i = 0; i < batches.length; i++) {
        setProgress(p => ({ ...p, batch: i + 1 }));
        const res = await apiRunReview(batches[i], marketplace, sortBy, filterStarNum, verifiedOnly, maxPages, taskId);
        taskId = res.taskId;
        allSummaries.push(...res.results);
        setSummaries([...allSummaries]);
        setProgress(p => ({ ...p, completed: p.completed + batches[i].length }));
      }
      if (taskId) {
        setActiveTaskId(taskId);
        setResults(await apiGetReviewResults(taskId));
      }
    } catch (e: any) {
      setErr(e.message || '采集失败');
    } finally {
      await reloadTasks();
      setRunning(false);
      setProgress({ completed: 0, total: 0, batch: 0, totalBatches: 0 });
    }
  }

  function clearResults() {
    setResults([]); setSummaries([]); setAsinInput(''); setActiveTaskId(null); setErr(''); setPage(1);
  }

  async function viewTask(t: ReviewTask) {
    setActiveTaskId(t.id); setErr(''); setPage(1); setSummaries([]);
    try { setResults(await apiGetReviewResults(t.id)); }
    catch (e: any) { setErr(e.message || '加载失败'); setResults([]); }
  }

  async function removeTask(t: ReviewTask) {
    if (!confirm(`删除任务（${mkInfo(t.marketplace).flag} ${mkInfo(t.marketplace).name} · ${t.asins.length} 个 ASIN）记录？\n（已采集的评论不会被删除）`)) return;
    await apiDeleteReviewTask(t.id);
    setTasks(ts => ts.filter(x => x.id !== t.id));
    if (activeTaskId === t.id) { setResults([]); setActiveTaskId(null); }
  }

  const progressPct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const totalFetched = summaries.reduce((s, r) => s + r.totalFetched, 0);
  const totalNew = summaries.reduce((s, r) => s + r.newCount, 0);
  const failedSummaries = summaries.filter(r => r.status === 'failed');

  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages]);
  const pagedResults = results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="rf-root">
      {/* Left: input + history */}
      <div className="rf-side">
        <div className="rf-field">
          <label className="rf-label">站点</label>
          <select className="rf-select" value={marketplace} onChange={e => setMarketplace(e.target.value)} disabled={running}>
            {MARKETPLACES.map(m => <option key={m.code} value={m.code}>{m.flag} {m.name}</option>)}
          </select>
        </div>

        <div className="rf-field">
          <label className="rf-label">ASIN（每行一个，支持逗号/空格分隔）</label>
          <textarea className="rf-textarea" rows={6} value={asinInput}
            onChange={e => setAsinInput(e.target.value)}
            placeholder={'B0XXXXXXXXX\nB0YYYYYYYYY'} disabled={running} />
          <div className="rf-asin-count">
            已输入 {asins.length} 个，有效 {validAsins.length} 个
            {asins.length > validAsins.length && <span className="rf-asin-bad"> · {asins.length - validAsins.length} 个无效</span>}
          </div>
        </div>

        <div className="rf-field">
          <label className="rf-label">排序方式</label>
          <select className="rf-select" value={sortBy} onChange={e => setSortBy(e.target.value as 'recent' | 'helpful')} disabled={running}>
            <option value="recent">最新发布</option>
            <option value="helpful">最有用</option>
          </select>
        </div>

        <div className="rf-field">
          <label className="rf-label">星级筛选</label>
          <select className="rf-select" value={filterStar} onChange={e => setFilterStar(e.target.value)} disabled={running}>
            {STAR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <label className="rf-check">
          <input type="checkbox" checked={verifiedOnly} onChange={e => setVerifiedOnly(e.target.checked)} disabled={running} />
          <span>仅看 Verified Purchase</span>
        </label>

        <div className="rf-field">
          <label className="rf-label">抓取页数（每页约10条，最多10页）</label>
          <input className="rf-select" type="number" min={1} max={10} value={maxPages}
            onChange={e => setMaxPages(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
            disabled={running} />
        </div>

        {err && <div className="rf-err">{err}</div>}

        <div className="rf-actions">
          <button className="btn btn-primary btn-sm" onClick={runFetch} disabled={running || !validAsins.length}>
            {running ? '采集中…' : '开始采集'}
          </button>
          <button className="btn btn-sm" onClick={clearResults} disabled={running}>清空</button>
        </div>

        {running && progress.total > 0 && (
          <div className="rf-progress">
            <div className="rf-progress-row">
              <span>第 {progress.batch}/{progress.totalBatches} 批</span>
              <span>{progress.completed}/{progress.total}（{progressPct}%）</span>
            </div>
            <div className="rf-progress-bar"><div className="rf-progress-fill" style={{ width: progressPct + '%' }} /></div>
          </div>
        )}

        {summaries.length > 0 && (
          <div className="rf-summary">
            <div>本次抓取 {totalFetched} 条，新增 {totalNew} 条</div>
            {failedSummaries.length > 0 && (
              <div className="rf-fail">
                {failedSummaries.length} 个 ASIN 失败：
                {failedSummaries.map(s => `${s.asin}(${s.errorMessage || '未知错误'})`).join('; ')}
              </div>
            )}
          </div>
        )}

        <div className="rf-history">
          <div className="rf-history-head">历史任务</div>
          {loadErr && <div className="rf-err">{loadErr}</div>}
          {!tasks.length && !loadErr && <div className="rf-empty">暂无历史任务</div>}
          {tasks.map(t => (
            <div key={t.id} className="rf-task" data-active={t.id === activeTaskId}>
              <button className="rf-task-main" onClick={() => viewTask(t)}>
                <div className="rf-task-top">
                  <span>{mkInfo(t.marketplace).flag} {mkInfo(t.marketplace).name}</span>
                  <span className="rf-task-time">{fmtDateTime(t.createdAt)}</span>
                </div>
                <div className="rf-task-sub">
                  <span>{t.asins.length} 个 ASIN</span>
                  <span className="rf-ok">累计新增 {t.newCount}</span>
                  {t.verifiedOnly && <span>仅Verified</span>}
                  {t.filterStar && <span>{t.filterStar} 星</span>}
                </div>
              </button>
              <button className="btn btn-sm rf-del" onClick={() => removeTask(t)}>删除</button>
            </div>
          ))}
        </div>
      </div>

      {/* Right: results table */}
      <div className="rf-main">
        <div className="rf-main-head">
          <div className="rf-main-title">
            评论列表
            {results.length > 0 && <span className="rf-badge">{results.length} 条</span>}
          </div>
          {results.length > 0 && (
            <div className="rf-main-actions">
              <button className="btn btn-sm" onClick={() => exportReviewCSV(results, marketplace)}>导出 CSV</button>
            </div>
          )}
        </div>

        {!results.length ? (
          <div className="rf-empty rf-empty-lg">
            {running ? '正在采集中…' : '输入 ASIN 并点击「开始采集」，或在左侧选择历史任务查看结果'}
          </div>
        ) : (
          <>
          <div className="rf-table-wrap">
            <table className="rf-table">
              <thead>
                <tr>
                  <th className="rf-col-asin">ASIN</th>
                  <th className="rf-col-img">图片</th>
                  <th>评分</th>
                  <th className="rf-col-content">标题 / 正文</th>
                  <th>作者</th>
                  <th>日期</th>
                  <th>Verified</th>
                  <th>有用数</th>
                  <th className="rf-col-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedResults.map((r, i) => (
                  <tr key={r.asin + '_' + r.reviewId + '_' + i}>
                    <td className="rf-col-asin"><span className="mono">{r.asin}</span></td>
                    <td className="rf-col-img">
                      {r.images && r.images[0]
                        ? <img className="ps-thumb" src={r.images[0]} alt=""
                            onMouseEnter={e => showThumbPreview(e, r.images[0])}
                            onMouseLeave={() => setHoverPreview(null)} />
                        : <div className="ps-thumb ps-thumb-empty" />}
                    </td>
                    <td>{r.rating != null ? `${r.rating} ★` : '—'}</td>
                    <td className="rf-col-content">
                      {r.title && <div className="rf-review-title">{r.title}</div>}
                      <div className="rf-review-body" title={r.body || ''}>
                        {r.body || <span className="ps-muted">无正文</span>}
                      </div>
                    </td>
                    <td>{r.author || '—'}</td>
                    <td>{r.dateRaw || '—'}</td>
                    <td>{r.verified ? <span className="rf-verified">✓</span> : '—'}</td>
                    <td>{r.helpfulCount != null ? r.helpfulCount : '—'}</td>
                    <td className="rf-col-ops">
                      <a className="btn btn-sm" href={productUrl(r.asin, r.marketplace || marketplace)} target="_blank" rel="noopener noreferrer">查看产品</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="rf-pagination">
              <span className="rf-page-info">第 {page}/{totalPages} 页 · 共 {results.length} 条</span>
              <div className="rf-page-btns">
                <button className="btn btn-sm" onClick={() => setPage(1)} disabled={page <= 1}>首页</button>
                <button className="btn btn-sm" onClick={() => setPage(p => p - 1)} disabled={page <= 1}>上一页</button>
                <button className="btn btn-sm" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages}>下一页</button>
                <button className="btn btn-sm" onClick={() => setPage(totalPages)} disabled={page >= totalPages}>末页</button>
              </div>
            </div>
          )}
          </>
        )}
      </div>

      {hoverPreview && (
        <div className="ps-thumb-preview" style={{ top: hoverPreview.top, left: hoverPreview.left }}>
          <img src={hoverPreview.src} alt="" />
        </div>
      )}
    </div>
  );
}
