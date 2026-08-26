import React, { useState, useEffect, useCallback } from 'react';

// ===========================================================================
// SIF 关键词监测工具
// 每日定时（自定义时刻）从 SIF MCP 抓取三大方向（降温/保暖/礼物）关键词数据：
// 机会词发现（screen_keyword_opportunities）+ 需求画像（keyword_demand）
// + 历史趋势（keyword_history），全部为结构化 JSON，无需 LLM 参与。
// ===========================================================================

// ---- 类型 ----

interface SifTask {
  id: string;
  name: string;
  direction: string;
  mode: 'root' | 'keywords';
  roots: string[];
  keywords: string[];
  asins: string[];
  country: string;
  topN: number;
  quotaLimit: number;
  scheduleTime: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string;
  lastError: string | null;
  createdAt: string;
}

interface SnapshotRow {
  id: number;
  runDate: string;
  capturedAt: string;
  keyword: string;
  searchVolume: number | null;
  rank: number | null;
  cpc: number | null;
  entrySignal: string;
  demand: any;
  detail: any;
}

interface PreviewItem {
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  entry_signal: string;
  top_asins: string[];
}

// ---- 方向预设（新建任务时一键填充词根） ----

const DIRECTION_PRESETS = [
  { key: 'cooling', icon: '🧊', label: '降温冷却', roots: ['cooling', 'cool', 'fan', 'ice'], hint: '冷却毯 / 宠物冰垫 / 风扇 / 冰丝凉席等' },
  { key: 'heating', icon: '🔥', label: '升温保暖', roots: ['heated', 'heating', 'warm', 'thermal'], hint: '加热毯 / 暖颈枕 / 加热眼罩 / 加热穿戴等' },
  { key: 'gift', icon: '🎁', label: '礼物', roots: ['gift', 'gifts', 'present'], hint: '礼物 / 礼盒 / 节日送礼等' },
];

const DIR_ICON: Record<string, string> = Object.fromEntries(DIRECTION_PRESETS.map(d => [d.key, d.icon]));
const DIR_LABEL: Record<string, string> = Object.fromEntries(DIRECTION_PRESETS.map(d => [d.key, d.label]));

// ---- API ----

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('fba-auth-v1') || '';
  return t ? { Authorization: 'Bearer ' + t } : {};
}

async function apiListTasks(): Promise<SifTask[]> {
  const r = await fetch('/api/sif/tasks', { headers: authHeaders() });
  if (!r.ok) throw new Error('load tasks failed');
  return (await r.json()).tasks || [];
}

async function apiCreateTask(t: any): Promise<SifTask> {
  const r = await fetch('/api/sif/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(t),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'create failed');
  return d.task;
}

async function apiUpdateTask(id: string, patch: any): Promise<void> {
  const r = await fetch('/api/sif/tasks', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ id, ...patch }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'update failed');
}

async function apiDeleteTask(id: string): Promise<void> {
  await fetch('/api/sif/tasks?id=' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
}

async function apiRunTask(id: string): Promise<void> {
  const r = await fetch('/api/sif/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'run failed');
}

async function apiSnapshots(taskId: string): Promise<{ runDate: string | null; snapshots: SnapshotRow[] }> {
  const r = await fetch('/api/sif/snapshots?taskId=' + encodeURIComponent(taskId), { headers: authHeaders() });
  if (!r.ok) return { runDate: null, snapshots: [] };
  return r.json();
}

async function apiRuns(taskId: string): Promise<string[]> {
  const r = await fetch('/api/sif/runs?taskId=' + encodeURIComponent(taskId), { headers: authHeaders() });
  if (!r.ok) return [];
  return (await r.json()).runs || [];
}

async function apiPreview(root: string, topN: number): Promise<PreviewItem[]> {
  const r = await fetch('/api/sif/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ root, topN }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'preview failed');
  return d.keywords || [];
}

async function apiHistory(keywords: string[]): Promise<any> {
  const r = await fetch('/api/sif/history?keywords=' + encodeURIComponent(keywords.join(',')) + '&country=US', { headers: authHeaders() });
  if (!r.ok) throw new Error('history failed');
  return r.json();
}

// ---- 小工具 ----

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function statusMeta(st: string): { label: string; cls: string } {
  switch (st) {
    case 'running': return { label: '运行中', cls: 'sif-st-running' };
    case 'done':   return { label: '已完成', cls: 'sif-st-done' };
    case 'error':  return { label: '失败', cls: 'sif-st-error' };
    default:       return { label: '待运行', cls: 'sif-st-idle' };
  }
}

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString();
}

// ---- 趋势迷你图（SVG） ----

function TrendChart({ points }: { points: { date: string; value: number }[] }) {
  if (points.length < 2) return <span className="sif-chart-empty">数据不足</span>;
  const W = 260, H = 56, PAD = 4;
  const vals = points.map(p => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} className="sif-chart" viewBox={`0 0 ${W} ${H}`}>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => i % Math.max(1, Math.floor(points.length / 6)) === 0 && (
        <text key={i} x={x(i)} y={H - 2} fontSize="8" fill="var(--muted)" textAnchor="middle">
          {p.date.slice(5)}
        </text>
      ))}
    </svg>
  );
}

// ---- 主组件 ----

export function SifKeyword() {
  const [tasks, setTasks] = useState<SifTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [runDate, setRunDate] = useState<string | null>(null);
  const [runs, setRuns] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SifTask | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<SnapshotRow | null>(null);
  const [trend, setTrend] = useState<any>(null);
  const [msg, setMsg] = useState('');

  // 表单状态
  const [fName, setFName] = useState('');
  const [fDir, setFDir] = useState('cooling');
  const [fMode, setFMode] = useState<'root' | 'keywords'>('root');
  const [fRoots, setFRoots] = useState('cooling, cool, fan, ice');
  const [fKeywords, setFKeywords] = useState('');
  const [fTopN, setFTopN] = useState(8);
  const [fQuota, setFQuota] = useState(30);
  const [fSchedule, setFSchedule] = useState('08:00');
  const [fEnabled, setFEnabled] = useState(true);
  const [previewRoot, setPreviewRoot] = useState('');
  const [previewItems, setPreviewItems] = useState<PreviewItem[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const refreshTasks = useCallback(async () => {
    try { setTasks(await apiListTasks()); } catch { /* 忽略轮询失败 */ }
  }, []);

  useEffect(() => { refreshTasks(); }, [refreshTasks]);

  // 有任务在运行时每 4s 轮询任务状态
  useEffect(() => {
    if (!tasks.some(t => t.lastStatus === 'running')) return;
    const iv = setInterval(refreshTasks, 4000);
    return () => clearInterval(iv);
  }, [tasks, refreshTasks]);

  // 选中任务时加载快照
  useEffect(() => {
    if (!selectedId) { setSnapshots([]); setRunDate(null); setRuns([]); return; }
    let stopped = false;
    (async () => {
      const [snap, runList] = await Promise.all([apiSnapshots(selectedId), apiRuns(selectedId)]);
      if (stopped) return;
      setSnapshots(snap.snapshots);
      setRunDate(snap.runDate);
      setRuns(runList);
    })();
    return () => { stopped = true; };
  }, [selectedId, tasks]);

  const selected = tasks.find(t => t.id === selectedId) || null;

  function openForm(task?: SifTask) {
    if (task) {
      setEditing(task);
      setFName(task.name);
      setFDir(task.direction || 'custom');
      setFMode(task.mode);
      setFRoots(task.roots.join(', '));
      setFKeywords(task.keywords.join(', '));
      setFTopN(task.topN);
      setFQuota(task.quotaLimit);
      setFSchedule(task.scheduleTime || '08:00');
      setFEnabled(task.enabled);
    } else {
      setEditing(null);
      setFName('');
      setFDir('cooling');
      setFMode('root');
      setFRoots('cooling, cool, fan, ice');
      setFKeywords('');
      setFTopN(8);
      setFQuota(30);
      setFSchedule('08:00');
      setFEnabled(true);
    }
    setPreviewItems(null);
    setShowForm(true);
  }

  function applyPreset(key: string) {
    const p = DIRECTION_PRESETS.find(d => d.key === key);
    setFDir(key);
    if (p) setFRoots(p.roots.join(', '));
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const body: any = {
      name: fName.trim(),
      direction: fDir,
      mode: fMode,
      country: 'US',
      topN: fTopN,
      quotaLimit: fQuota,
      scheduleTime: fSchedule || null,
      enabled: fEnabled,
    };
    if (fMode === 'root') {
      const roots = fRoots.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
      if (!roots.length) { alert('请至少填写一个词根'); return; }
      body.roots = roots;
    } else {
      const kws = fKeywords.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
      if (!kws.length) { alert('请至少填写一个关键词'); return; }
      body.keywords = kws;
    }
    try {
      if (editing) {
        await apiUpdateTask(editing.id, body);
      } else {
        const t = await apiCreateTask(body);
        setSelectedId(t.id);
      }
      setShowForm(false);
      await refreshTasks();
      setMsg(editing ? '任务已更新' : '任务已创建');
      setTimeout(() => setMsg(''), 2500);
    } catch (err: any) {
      alert('保存失败: ' + err.message);
    }
  }

  async function runNow(task: SifTask) {
    try {
      await apiRunTask(task.id);
      setMsg('已触发运行');
      setTimeout(() => setMsg(''), 2500);
      setTimeout(refreshTasks, 1500);
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function toggleEnabled(task: SifTask) {
    try {
      await apiUpdateTask(task.id, { enabled: !task.enabled });
      await refreshTasks();
    } catch { /* 忽略 */ }
  }

  async function removeTask(task: SifTask) {
    if (!confirm(`删除任务「${task.name}」及其全部快照？`)) return;
    try {
      await apiDeleteTask(task.id);
      if (selectedId === task.id) setSelectedId(null);
      await refreshTasks();
    } catch (err: any) { alert(err.message); }
  }

  async function doPreview() {
    const root = previewRoot.trim();
    if (!root) return;
    setPreviewBusy(true);
    setPreviewItems(null);
    try {
      setPreviewItems(await apiPreview(root, 10));
    } catch (err: any) {
      alert('试查失败: ' + err.message);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function openDetail(snap: SnapshotRow) {
    setDetail(snap);
    setTrend(null);
    try {
      const h = await apiHistory([snap.keyword]);
      const s = (h.series || {})[snap.keyword];
      if (s && s.dates && s.volumes) {
        const pts = s.dates.slice(-20).map((d: string, i: number) => ({
          date: d,
          value: s.volumes[s.volumes.length - 20 + i],
        })).filter((p: any) => p.value !== null && p.value !== undefined);
        setTrend(pts);
      }
    } catch { /* 趋势获取失败不阻塞详情 */ }
  }

  const d = detail?.demand || {};

  return (
    <div className="sif-wrap">
      <div className="sif-left">
        <div className="sif-left-head">
          <span className="sif-left-title">监测任务</span>
          <button className="btn btn-sm btn-primary" onClick={() => openForm()}>+ 新建任务</button>
        </div>
        {tasks.length === 0 && (
          <div className="sif-empty">暂无任务。<br />新建任务后即可每日定时抓取关键词数据。</div>
        )}
        {tasks.map(t => {
          const st = statusMeta(t.lastStatus);
          return (
            <div key={t.id} className="sif-task" data-active={selectedId === t.id}
              onClick={() => setSelectedId(t.id)}>
              <div className="sif-task-top">
                <span className="sif-task-icon">{DIR_ICON[t.direction] || '📌'}</span>
                <span className="sif-task-name">{t.name}</span>
                <span className={`sif-st ${st.cls}`}>{st.label}</span>
              </div>
              <div className="sif-task-meta">
                {DIR_LABEL[t.direction] || t.direction || '自定义'} · {t.mode === 'root' ? `词根×${t.roots.length}` : `关键词×${t.keywords.length}`}
                {t.scheduleTime ? ` · 每日 ${t.scheduleTime}` : ' · 仅手动'}
              </div>
              <div className="sif-task-foot">
                <span className="sif-task-time">最近: {fmtTime(t.lastRunAt)}</span>
                <span className="sif-task-ops" onClick={e => e.stopPropagation()}>
                  <button className="btn btn-xs" title={t.enabled ? '暂停定时' : '启用定时'}
                    onClick={() => toggleEnabled(t)}>{t.enabled ? '⏸' : '▶️'}</button>
                  <button className="btn btn-xs" title="立即运行" onClick={() => runNow(t)}>▶ 运行</button>
                  <button className="btn btn-xs" title="编辑" onClick={() => openForm(t)}>✎</button>
                  <button className="btn btn-xs" title="删除" onClick={() => removeTask(t)}>🗑</button>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sif-main">
        {!selected && !showForm && (
          <div className="sif-main-empty">
            <div className="sif-main-empty-ic">🔑</div>
            <p>选择左侧任务查看关键词数据，或新建任务开始监测。</p>
            <p className="sif-main-empty-sub">数据源：SIF MCP（每日刷新，延迟 1 天）· 每日定时自动抓取</p>
          </div>
        )}

        {selected && !showForm && (
          <div className="sif-detail">
            <div className="sif-detail-head">
              <div>
                <div className="sif-detail-title">{DIR_ICON[selected.direction] || '📌'} {selected.name}</div>
                <div className="sif-detail-sub">
                  {DIR_LABEL[selected.direction] || selected.direction || '自定义'} · {selected.country} ·
                  词根: {selected.roots.join(' / ') || selected.keywords.join(' / ')} · 每日 {selected.scheduleTime || '手动'} ·
                  配额 {selected.quotaLimit} 词
                  {selected.lastError && <span className="sif-last-err"> · {selected.lastError}</span>}
                </div>
              </div>
              <div className="sif-detail-ops">
                <button className="btn btn-sm" onClick={() => refreshTasks()}>⟳ 刷新</button>
                <button className="btn btn-sm btn-primary" onClick={() => runNow(selected)} disabled={selected.lastStatus === 'running'}>
                  {selected.lastStatus === 'running' ? '运行中...' : '▶ 立即运行'}
                </button>
              </div>
            </div>

            {runs.length > 1 && (
              <div className="sif-runs-bar">
                <span>历史运行: </span>
                {runs.slice(0, 14).map(d => (
                  <button key={d} className={`btn btn-xs ${runDate === d ? 'sif-run-active' : ''}`}
                    onClick={async () => {
                      const snap = await apiSnapshots(selectedId!);
                      setSnapshots(snap.snapshots);
                      setRunDate(d);
                      setRuns(await apiRuns(selectedId!));
                    }}>{d.slice(5)}</button>
                ))}
              </div>
            )}

            {snapshots.length === 0 ? (
              <div className="sif-main-empty">
                <p>该任务还没有数据。点「立即运行」抓取一次（首次约 10-30 秒）。</p>
              </div>
            ) : (
              <table className="sif-table">
                <thead>
                  <tr>
                    <th>关键词</th><th>月搜索量</th><th>ABA排名</th><th>CPC</th>
                    <th>峰值月</th><th>距峰值</th><th>趋势方向</th><th>入场信号 / 诊断</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map(s => (
                    <tr key={s.id} onClick={() => openDetail(s)} className="sif-row">
                      <td className="sif-kw">{s.keyword}</td>
                      <td>{fmtNum(s.searchVolume)}</td>
                      <td>{s.rank ?? '—'}</td>
                      <td>{s.cpc ? '$' + Number(s.cpc).toFixed(2) : '—'}</td>
                      <td>{d.peak_month || '—'}</td>
                      <td>{s.demand?.weeks_to_peak != null ? `${s.demand.weeks_to_peak} 周` : '—'}</td>
                      <td>
                        {s.demand?.trend_direction
                          ? <span className={s.demand.trend_direction === '增长' ? 'sif-up' : 'sif-flat'}>
                              {s.demand.trend_direction}{s.demand.yoy_change != null ? ` (${(s.demand.yoy_change * 100).toFixed(0)}%)` : ''}
                            </span>
                          : '—'}
                      </td>
                      <td className="sif-signal">{s.entrySignal || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="sif-hint">点击行查看需求画像与搜索量趋势（点查 SIF，按需调用）</div>
          </div>
        )}

        {showForm && (
          <form className="sif-form" onSubmit={submitForm}>
            <div className="sif-form-head">
              <span>{editing ? '编辑任务' : '新建监测任务'}</span>
              <button type="button" className="btn btn-sm" onClick={() => setShowForm(false)}>✕ 关闭</button>
            </div>

            <label className="sif-field">
              <span>任务名称</span>
              <input value={fName} onChange={e => setFName(e.target.value)} placeholder="如：降温方向每日监测" required />
            </label>

            <label className="sif-field">
              <span>方向预设（一键填充词根）</span>
              <div className="sif-dir-picker">
                {DIRECTION_PRESETS.map(p => (
                  <button key={p.key} type="button" className={`btn btn-sm ${fDir === p.key ? 'sif-dir-active' : ''}`}
                    onClick={() => applyPreset(p.key)}>
                    {p.icon} {p.label}
                  </button>
                ))}
                <button type="button" className={`btn btn-sm ${fDir === 'custom' ? 'sif-dir-active' : ''}`}
                  onClick={() => setFDir('custom')}>📌 自定义</button>
              </div>
              {DIRECTION_PRESETS.find(p => p.key === fDir) && (
                <span className="sif-field-hint">{DIRECTION_PRESETS.find(p => p.key === fDir)!.hint}</span>
              )}
            </label>

            <div className="sif-field">
              <span>抓取模式</span>
              <div className="sif-dir-picker">
                <button type="button" className={`btn btn-sm ${fMode === 'root' ? 'sif-dir-active' : ''}`}
                  onClick={() => setFMode('root')}>词根发现（按词根筛机会词）</button>
                <button type="button" className={`btn btn-sm ${fMode === 'keywords' ? 'sif-dir-active' : ''}`}
                  onClick={() => setFMode('keywords')}>指定关键词（直接画像）</button>
              </div>
            </div>

            {fMode === 'root' ? (
              <label className="sif-field">
                <span>词根（逗号分隔，每个词根一次机会词筛选）</span>
                <textarea value={fRoots} onChange={e => setFRoots(e.target.value)} rows={2} />
                <span className="sif-field-hint">
                  <button type="button" className="btn btn-xs" onClick={() => { setPreviewRoot(fRoots.split(',')[0].trim()); }}>
                    试查第一个词根 →
                  </button>
                </span>
              </label>
            ) : (
              <label className="sif-field">
                <span>关键词（逗号分隔，批量需求画像）</span>
                <textarea value={fKeywords} onChange={e => setFKeywords(e.target.value)} rows={2} placeholder="cooling blanket, cooling pillow, ..." />
              </label>
            )}

            {previewRoot && (
              <div className="sif-preview">
                <div className="sif-preview-head">
                  <span>试查「{previewRoot}」的机会词（不落库，仅供评估）</span>
                  <button type="button" className="btn btn-xs" onClick={doPreview} disabled={previewBusy}>
                    {previewBusy ? '查询中...' : '查询'}
                  </button>
                </div>
                {previewItems && (
                  <table className="sif-table sif-preview-table">
                    <thead><tr><th>关键词</th><th>月搜索量</th><th>CPC</th><th>入场信号</th></tr></thead>
                    <tbody>
                      {previewItems.map(p => (
                        <tr key={p.keyword}>
                          <td className="sif-kw">{p.keyword}</td>
                          <td>{fmtNum(p.search_volume)}</td>
                          <td>{p.cpc ? '$' + Number(p.cpc).toFixed(2) : '—'}</td>
                          <td className="sif-signal">{p.entry_signal}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            <div className="sif-form-grid">
              <label className="sif-field">
                <span>每词根取词数</span>
                <input type="number" min={3} max={20} value={fTopN}
                  onChange={e => setFTopN(Number(e.target.value) || 8)} />
              </label>
              <label className="sif-field">
                <span>本次最多画像词数（配额）</span>
                <input type="number" min={5} max={200} value={fQuota}
                  onChange={e => setFQuota(Number(e.target.value) || 30)} />
              </label>
              <label className="sif-field">
                <span>每日定时时刻</span>
                <input type="time" value={fSchedule} onChange={e => setFSchedule(e.target.value)} />
              </label>
              <label className="sif-field sif-check">
                <input type="checkbox" checked={fEnabled} onChange={e => setFEnabled(e.target.checked)} />
                <span>启用每日定时</span>
              </label>
            </div>

            <div className="sif-form-actions">
              <button type="submit" className="btn btn-primary">{editing ? '保存修改' : '创建任务'}</button>
              <button type="button" className="btn" onClick={() => setShowForm(false)}>取消</button>
            </div>
          </form>
        )}

        {msg && <div className="sif-msg">{msg}</div>}
      </div>

      {detail && (
        <div className="sif-modal" onClick={() => setDetail(null)}>
          <div className="sif-modal-card" onClick={e => e.stopPropagation()}>
            <div className="sif-modal-head">
              <span>{detail.keyword}</span>
              <button className="btn btn-sm" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="sif-modal-body">
              <div className="sif-modal-stats">
                {[
                  ['月搜索量', fmtNum(detail.searchVolume)],
                  ['ABA 排名', detail.rank ?? '—'],
                  ['CPC', detail.cpc ? '$' + Number(detail.cpc).toFixed(2) : '—'],
                  ['需求类型', d.demand_type || '—'],
                  ['季节位置', d.season_position || '—'],
                  ['峰值月', d.peak_month || '—'],
                  ['距峰值', d.weeks_to_peak != null ? `${d.weeks_to_peak} 周` : '—'],
                  ['季节强度', d.seasonal_strength != null ? d.seasonal_strength : '—'],
                ].map(([k, v]) => (
                  <div key={k as string} className="sif-stat">
                    <span className="sif-stat-k">{k}</span>
                    <span className="sif-stat-v">{v}</span>
                  </div>
                ))}
              </div>

              {trend && trend.length >= 2 && (
                <div className="sif-trend-block">
                  <div className="sif-trend-title">近 20 周搜索量趋势（周度）</div>
                  <TrendChart points={trend} />
                </div>
              )}

              {d.ad_hint && <div className="sif-note">💡 {d.ad_hint}</div>}
              {d.interpretation && <div className="sif-note">📝 {d.interpretation}</div>}
              {d.diagnosis && <div className="sif-note">🔎 {d.diagnosis}</div>}
              {detail.entrySignal && <div className="sif-note">📊 {detail.entrySignal}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
