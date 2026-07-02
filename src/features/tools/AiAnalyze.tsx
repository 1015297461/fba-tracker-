import React, { useState, useEffect } from 'react';
import { marked } from 'marked';

const AUTH_TOKEN_KEY = 'fba-auth-v1';
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem(AUTH_TOKEN_KEY) || '';
  return t ? { Authorization: 'Bearer ' + t } : {};
}

// 以后加新 skill：这里加一条（Sidebar.tsx 会据此渲染"AI分析"分组下的按钮），
// 后端 server.py 的 AI_SKILLS 字典也要加一条同 id 的对应项。
export const AI_SKILLS = [
  { id: 'cosmo-diagnose', ic: '🩺', label: 'CosmoDiagnose', desc: 'Amazon Listing 诊断（COSMO）' },
];

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

function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const m = iso.match(/\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}
function fileUrl(taskId: string, name: string, mode: 'inline' | 'download'): string {
  return `/api/ai/file?taskId=${encodeURIComponent(taskId)}&name=${encodeURIComponent(name)}&mode=${mode}`;
}

// ============================================================
// Main AiAnalyze component
// 技能通过 Sidebar 的"AI分析"分组按钮选择，本组件只负责单个技能内部的
// ASIN 输入 / 历史记录 / 结果展示，skillId 由父级（app.tsx）传入。
// ============================================================
export function AiAnalyze({ skillId }: { skillId: string }) {
  const skill = AI_SKILLS.find(s => s.id === skillId);
  const [asinInput, setAsinInput] = useState('');
  const [alexaQuestions, setAlexaQuestions] = useState(3);
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

  const asin = asinInput.trim().toUpperCase();
  const asinValid = /^[A-Z0-9]{10}$/.test(asin);

  async function reloadTasks() {
    try { setTasks(await apiListAiTasks(skillId)); setLoadErr(''); }
    catch (e: any) { setLoadErr(e.message || '加载失败'); }
  }
  // 切换技能（未来有多个技能时，Sidebar 会传入不同 skillId）需要重新加载历史、清空当前选中
  useEffect(() => { reloadTasks(); setActiveId(null); }, [skillId]);

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
            placeholder="B0XXXXXXXXX" disabled={submitting} />
        </div>

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

        <div className="ai-history">
          <div className="ai-history-head">历史记录</div>
          {loadErr && <div className="ai-err">{loadErr}</div>}
          {!tasks.length && !loadErr && <div className="ai-empty">暂无分析记录</div>}
          {tasks.map(t => (
            <div key={t.id} className="ai-task" data-active={t.id === activeId}>
              <button className="ai-task-main" onClick={() => setActiveId(t.id)}>
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
        </div>
      </div>

      {/* 右侧：详情 */}
      <div className="ai-main">
        {!active ? (
          <div className="ai-empty ai-empty-lg">在左侧输入 ASIN 并点击「开始分析」，或点击历史记录查看结果</div>
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
