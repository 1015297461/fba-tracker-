import React, { useState, useRef, useCallback, useEffect } from 'react';

interface FileItem {
  file_id: string;
  name: string;
  pages: number;
  size: number;
}

interface FileConfig {
  mode: 'max_pages' | 'custom_ranges';
  maxPages: string;
  pageFrom: string;
  pageTo: string;
  rangesStr: string;
  expanded: boolean;
}

interface OutputFile {
  name: string;
  download_id: string | null;
  saved_to: string | null;
}

interface SplitResult {
  name: string;
  status: 'success' | 'failed';
  output_files: OutputFile[];
  error: string | null;
}

function getToken() {
  return localStorage.getItem('fba-auth-v1') || '';
}

const DEFAULT_CONFIG: Omit<FileConfig, 'expanded'> = {
  mode: 'max_pages',
  maxPages: '50',
  pageFrom: '',
  pageTo: '',
  rangesStr: '',
};

const MIN_SIDE_WIDTH = 220;
const MAX_SIDE_WIDTH = 560;
const DEFAULT_SIDE_WIDTH = 300;

export function PdfSplit() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [fileConfigs, setFileConfigs] = useState<Record<string, FileConfig>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SplitResult[]>([]);
  const [runErr, setRunErr] = useState('');
  const [batchDlLoading, setBatchDlLoading] = useState(false);
  const [sideWidth, setSideWidth] = useState(DEFAULT_SIDE_WIDTH);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // ---- 拖拽调整左侧宽度 ----
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sideWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sideWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - dragStartX.current;
      const next = Math.min(MAX_SIDE_WIDTH, Math.max(MIN_SIDE_WIDTH, dragStartWidth.current + delta));
      setSideWidth(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const updateConfig = (fid: string, patch: Partial<FileConfig>) =>
    setFileConfigs(prev => ({ ...prev, [fid]: { ...prev[fid], ...patch } }));

  const uploadFiles = useCallback(async (fileList: FileList) => {
    const pdfs = Array.from(fileList).filter(f =>
      f.name.toLowerCase().endsWith('.pdf')
    );
    if (!pdfs.length) return;
    setUploading(true);
    setUploadErr('');
    const newItems: FileItem[] = [];
    const errors: string[] = [];
    for (const file of pdfs) {
      try {
        const buf = await file.arrayBuffer();
        const res = await fetch('/api/pdf/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name),
            'Authorization': `Bearer ${getToken()}`,
          },
          body: buf,
        });
        const data = await res.json();
        if (res.ok) {
          newItems.push(data as FileItem);
        } else {
          errors.push(`${file.name}: ${data.error || '上传失败'}`);
        }
      } catch {
        errors.push(`${file.name}: 网络错误`);
      }
    }
    if (errors.length) setUploadErr(errors.join('；'));
    if (newItems.length) {
      setFiles(prev => {
        const ids = new Set(prev.map(f => f.file_id));
        return [...prev, ...newItems.filter(f => !ids.has(f.file_id))];
      });
      setFileConfigs(prev => {
        const next = { ...prev };
        for (const item of newItems) {
          if (!next[item.file_id]) {
            next[item.file_id] = { ...DEFAULT_CONFIG, expanded: true };
          }
        }
        return next;
      });
    }
    setUploading(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  const removeFile = (fid: string) => {
    setFiles(prev => prev.filter(f => f.file_id !== fid));
    setFileConfigs(prev => { const next = { ...prev }; delete next[fid]; return next; });
  };

  const handleRun = async () => {
    if (!files.length) { setRunErr('请先添加 PDF 文件'); return; }
    setRunning(true);
    setRunErr('');
    setResults([]);
    const jobs = files.map(f => {
      const cfg = fileConfigs[f.file_id] ?? { ...DEFAULT_CONFIG };
      return {
        file_id: f.file_id,
        mode: cfg.mode,
        max_pages: Math.max(1, parseInt(cfg.maxPages) || 50),
        page_from: Math.max(1, parseInt(cfg.pageFrom) || 1),
        page_to: parseInt(cfg.pageTo) || f.pages,
        ranges_str: cfg.rangesStr,
        output_dir: '',
      };
    });
    try {
      const res = await fetch('/api/pdf/split', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ jobs }),
      });
      const data = await res.json();
      if (res.ok) {
        setResults(data.results || []);
      } else {
        setRunErr(data.error || '拆分请求失败');
      }
    } catch {
      setRunErr('网络错误，请检查服务是否正常');
    }
    setRunning(false);
  };

  const handleBatchDownload = async () => {
    const allIds = results.flatMap(r =>
      r.status === 'success' ? r.output_files.filter(f => f.download_id).map(f => f.download_id as string) : []
    );
    if (!allIds.length) return;
    setBatchDlLoading(true);
    try {
      const res = await fetch('/api/pdf/zip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ ids: allIds, name: 'split_results.zip' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || '打包失败，请重试');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'split_results.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert('网络错误，请检查服务是否正常');
    }
    setBatchDlLoading(false);
  };

  const successCount = results.filter(r => r.status === 'success').length;
  const totalOutputFiles = results.flatMap(r =>
    r.status === 'success' ? r.output_files.filter(f => f.download_id) : []
  ).length;

  return (
    <div className="pf-root" ref={rootRef}>

      {/* ===================== 左侧面板 ===================== */}
      <div className="pf-side" style={{ width: sideWidth, minWidth: sideWidth, maxWidth: sideWidth }}>

        {/* 顶部固定：标题 + 上传区 */}
        <div className="pf-side-top">
          <div className="pf-side-title">批量拆分 PDF</div>
          <div
            className="pf-dropzone"
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? '上传中，请稍候...' : '点击选择 / 拖入 PDF 文件'}
          </div>
          <input
            ref={inputRef} type="file" accept=".pdf" multiple hidden
            onChange={e => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ''; }}
          />
          {uploadErr && <div className="pf-error">{uploadErr}</div>}
        </div>

        {/* 中间可滚动：文件配置卡片 */}
        <div className="pf-side-files">
          {files.length === 0 && (
            <div className="pf-files-empty">暂无文件，请在上方添加</div>
          )}
          {files.map(f => {
            const cfg = fileConfigs[f.file_id] ?? { ...DEFAULT_CONFIG, expanded: true };
            return (
              <div key={f.file_id} className="pf-file-card">
                <div className="pf-file-card-head">
                  <div className="pf-file-info">
                    <span
                      className="pf-file-name"
                      data-tooltip={f.name}
                    >{f.name}</span>
                    <span className="pf-file-meta">{f.pages} 页 · {(f.size / 1024).toFixed(0)} KB</span>
                  </div>
                  <button
                    className="pf-icon-btn"
                    title={cfg.expanded ? '收起' : '展开'}
                    onClick={() => updateConfig(f.file_id, { expanded: !cfg.expanded })}
                  >{cfg.expanded ? '▲' : '▼'}</button>
                  <button
                    className="pf-icon-btn pf-icon-del"
                    title="移除"
                    onClick={() => removeFile(f.file_id)}
                  >×</button>
                </div>

                {cfg.expanded && (
                  <div className="pf-file-card-body">
                    <div className="pf-mode-tabs pf-mode-sm">
                      <button
                        className="pf-mode-btn"
                        data-active={cfg.mode === 'max_pages'}
                        onClick={() => updateConfig(f.file_id, { mode: 'max_pages' })}
                      >按最大页数</button>
                      <button
                        className="pf-mode-btn"
                        data-active={cfg.mode === 'custom_ranges'}
                        onClick={() => updateConfig(f.file_id, { mode: 'custom_ranges' })}
                      >自定义范围</button>
                    </div>

                    {cfg.mode === 'max_pages' ? (
                      <>
                        <div className="pf-sub-field">
                          <label className="pf-sub-label">每份最大页数</label>
                          <input
                            className="pf-input pf-input-sm" type="number" min="1"
                            value={cfg.maxPages}
                            onChange={e => updateConfig(f.file_id, { maxPages: e.target.value })}
                            placeholder="50"
                          />
                        </div>
                        <div className="pf-sub-row">
                          <div className="pf-sub-field">
                            <label className="pf-sub-label">起始页</label>
                            <input
                              className="pf-input pf-input-sm" type="number" min="1"
                              value={cfg.pageFrom}
                              onChange={e => updateConfig(f.file_id, { pageFrom: e.target.value })}
                              placeholder="1"
                            />
                          </div>
                          <div className="pf-sub-field">
                            <label className="pf-sub-label">结束页</label>
                            <input
                              className="pf-input pf-input-sm" type="number" min="1"
                              value={cfg.pageTo}
                              onChange={e => updateConfig(f.file_id, { pageTo: e.target.value })}
                              placeholder={String(f.pages)}
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="pf-sub-field">
                        <label className="pf-sub-label">页码范围</label>
                        <input
                          className="pf-input pf-input-sm" type="text"
                          value={cfg.rangesStr}
                          onChange={e => updateConfig(f.file_id, { rangesStr: e.target.value })}
                          placeholder="例：1-50, 51-200"
                        />
                        <span className="pf-hint">多段用逗号分隔，每段生成一个文件</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底部固定：运行按钮 */}
        <div className="pf-side-bottom">
          {runErr && <div className="pf-error">{runErr}</div>}

          <button
            className="btn btn-primary pf-run-btn"
            disabled={running || !files.length || uploading}
            onClick={handleRun}
          >
            {running ? '拆分中...' : `开始拆分${files.length ? `（${files.length} 个文件）` : ''}`}
          </button>
        </div>
      </div>

      {/* ===================== 拖拽分隔条 ===================== */}
      <div className="pf-resize-handle" onMouseDown={onResizeMouseDown} />

      {/* ===================== 右侧结果区 ===================== */}
      <div className="pf-main">
        {results.length === 0 && !running && (
          <div className="pf-placeholder">
            <div className="pf-placeholder-icon">✂️</div>
            <div className="pf-placeholder-text">添加 PDF 文件后点击「开始拆分」</div>
            <div className="pf-placeholder-sub">每个文件可单独设置拆分方式和页码范围</div>
          </div>
        )}
        {running && (
          <div className="pf-placeholder">
            <div className="pf-placeholder-text">拆分中，请稍候...</div>
          </div>
        )}
        {results.length > 0 && (
          <div className="pf-results">
            <div className="pf-results-head">
              <span>拆分完成 · {successCount}/{results.length} 个文件成功</span>
              {totalOutputFiles > 0 && (
                <button
                  className="pf-batch-dl-btn"
                  onClick={handleBatchDownload}
                  disabled={batchDlLoading}
                >
                  {batchDlLoading ? '打包中...' : `全部下载 ZIP（${totalOutputFiles} 个）`}
                </button>
              )}
            </div>
            {results.map((r, i) => (
              <div key={i} className="pf-result-card">
                <div className="pf-result-header">
                  <span className="pf-result-name" title={r.name}>{r.name}</span>
                  <span className={`pf-result-badge ${r.status === 'success' ? 'pf-badge-ok' : 'pf-badge-fail'}`}>
                    {r.status === 'success'
                      ? `成功 · ${r.output_files.length} 个文件`
                      : '失败'}
                  </span>
                </div>
                {r.error && <div className="pf-result-error">{r.error}</div>}
                {r.output_files.length > 0 && (
                  <div className="pf-output-list">
                    {r.output_files.map((of, j) => (
                      <div key={j} className="pf-output-item">
                        <span className="pf-output-name">{of.name}</span>
                        {of.download_id
                          ? (
                            <a
                              className="pf-output-dl"
                              href={`/api/pdf/download?id=${of.download_id}`}
                              download={of.name}
                            >
                              下载
                            </a>
                          )
                          : <span className="pf-output-saved">已保存</span>
                        }
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
