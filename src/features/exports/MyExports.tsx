import React, { useState, useEffect } from 'react';

interface ExportJob {
  id: string;
  type: string;
  label: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  progress_cur: number;
  progress_total: number;
  error: string | null;
  download_id: string | null;
  file_name: string | null;
  created_at: string;
  completed_at: string | null;
}

function getToken() {
  return localStorage.getItem('fba-auth-v1') || '';
}

function fmtTime(iso: string): string {
  if (!iso) return '';
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, min] = m;
  const now = new Date();
  const date = new Date(iso);
  const isToday = now.toDateString() === date.toDateString();
  return isToday ? `${h}:${min}` : `${mo}-${d} ${h}:${min}`;
}

function StatusBadge({ status }: { status: ExportJob['status'] }) {
  const map: Record<string, string> = {
    pending:    'exp-badge-pending',
    processing: 'exp-badge-processing',
    done:       'exp-badge-done',
    failed:     'exp-badge-failed',
  };
  const label: Record<string, string> = {
    pending:    '排队中',
    processing: '生成中',
    done:       '完成',
    failed:     '失败',
  };
  return <span className={`exp-badge ${map[status] || ''}`}>{label[status] || status}</span>;
}

function ProgressBar({ cur, total }: { cur: number; total: number }) {
  const pct = total > 0 ? Math.round((cur / total) * 100) : 0;
  return (
    <div className="exp-progress-wrap">
      <div className="exp-progress">
        <div className="exp-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <span className="exp-progress-label">{cur}/{total} 张图片 · {pct}%</span>
    </div>
  );
}

export function MyExports() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);

  // 自调度轮询：用 setTimeout 链而非 setInterval，每次拿到最新数据后再决定下一次间隔
  // 避免首次渲染时 jobs=[] 导致 hasActive=false 、轮询被设成 10s 的问题
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/exports/list', {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (res.ok && !cancelled) {
          const data = await res.json();
          const newJobs: ExportJob[] = data.jobs || [];
          setJobs(newJobs);
          setLoading(false);
          const hasActive = newJobs.some(j => j.status === 'pending' || j.status === 'processing');
          if (!cancelled) timer = setTimeout(poll, hasActive ? 2000 : 10000);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleDelete = async (jid: string) => {
    try {
      await fetch(`/api/exports?id=${jid}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      setJobs(prev => prev.filter(j => j.id !== jid));
    } catch {
      alert('删除失败，请重试');
    }
  };

  const handleDownload = (job: ExportJob) => {
    if (!job.download_id) return;
    const a = document.createElement('a');
    a.href = `/api/pdf/download?id=${job.download_id}`;
    a.download = job.file_name || 'export.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const typeIcon: Record<string, string> = {
    scrape_xlsx: '📊',
  };

  return (
    <div className="exp-root">
      <div className="exp-header">
        <span className="exp-title">我的导出</span>
        <span className="exp-count">{jobs.length} 条记录</span>
      </div>

      {loading && <div className="exp-empty">加载中…</div>}

      {!loading && jobs.length === 0 && (
        <div className="exp-empty">
          <div className="exp-empty-icon">📥</div>
          <div>暂无导出记录</div>
          <div className="exp-empty-sub">在产品采集等模块点击「导出 Excel」后，记录将在此显示</div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="exp-list">
          {jobs.map(job => (
            <div key={job.id} className="exp-card">
              <div className="exp-card-head">
                <span className="exp-card-icon">{typeIcon[job.type] || '📄'}</span>
                <div className="exp-card-info">
                  <span className="exp-card-label" title={job.label}>{job.label}</span>
                  <span className="exp-card-time">{fmtTime(job.created_at)}</span>
                </div>
                <StatusBadge status={job.status} />
              </div>

              {(job.status === 'processing' || job.status === 'pending') && (
                <ProgressBar cur={job.progress_cur} total={job.progress_total} />
              )}

              {job.status === 'failed' && job.error && (
                <div className="exp-error" title={job.error}>
                  {job.error.length > 60 ? job.error.slice(0, 60) + '…' : job.error}
                </div>
              )}

              <div className="exp-card-actions">
                {job.status === 'done' && job.download_id && (
                  <button
                    className="btn btn-sm exp-dl-btn"
                    onClick={() => handleDownload(job)}
                  >
                    下载
                  </button>
                )}
                <button
                  className="btn btn-sm exp-del-btn"
                  onClick={() => handleDelete(job.id)}
                  disabled={job.status === 'processing'}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 供侧边栏用：返回活跃任务数（pending + processing），有活跃任务时 3s 轮询，无时 15s */
export function useExportBadge(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/exports/list', {
          headers: { Authorization: `Bearer ${localStorage.getItem('fba-auth-v1') || ''}` },
        });
        if (res.ok && !cancelled) {
          const data = await res.json();
          const jobs: ExportJob[] = data.jobs || [];
          const active = jobs.filter(j => j.status === 'pending' || j.status === 'processing').length;
          setCount(active);
          if (!cancelled) timer = setTimeout(poll, active > 0 ? 3000 : 15000);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 10000);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return count;
}
