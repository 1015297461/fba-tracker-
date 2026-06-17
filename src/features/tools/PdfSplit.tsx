import React, { useState, useRef, useCallback } from 'react';

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

export function PdfSplit() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [fileConfigs, setFileConfigs] = useState<Record<string, FileConfig>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  const [dirMode, setDirMode] = useState<'original' | 'custom'>('original');
  const [selectedPath, setSelectedPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SplitResult[]>([]);
  const [runErr, setRunErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const res = await fetch('/api/system/pick-directory', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (res.ok && !data.cancelled && data.path) {
        setSelectedPath(data.path);
      }
    } catch {
      // user cancelled or server error
    }
    setBrowsing(false);
  };

  const handleRun = async () => {
    if (!files.length) { setRunErr('请先添加 PDF 文件'); return; }
    if (!selectedPath.trim()) { setRunErr('请先选择输出目录'); return; }
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
        output_dir: selectedPath.trim(),
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

  const successCount = results.filter(r => r.status === 'success').length;
  const dirPlaceholder = dirMode === 'original'
    ? '请选择原 PDF 文件所在文件夹'
    : '请选择自定义输出文件夹';

  return (
    <div className="pf-root">

      {/* ===================== 左侧面板 ===================== */}
      <div className="pf-side">

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
                    <span className="pf-file-name" title={f.name}>{f.name}</span>
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

        {/* 底部固定：输出目录 + 运行按钮 */}
        <div className="pf-side-bottom">
          <div className="pf-section">
            <div className="pf-label">输出目录</div>
            <div className="pf-dir-radios">
              <label className="pf-dir-radio">
                <input
                  type="radio" name="dirMode"
                  checked={dirMode === 'original'}
                  onChange={() => setDirMode('original')}
                />
                <span>原文件目录</span>
              </label>
              <label className="pf-dir-radio">
                <input
                  type="radio" name="dirMode"
                  checked={dirMode === 'custom'}
                  onChange={() => setDirMode('custom')}
                />
                <span>自定义</span>
              </label>
            </div>
            <div className="pf-dir-picker">
              <div
                className={`pf-dir-path${selectedPath ? '' : ' pf-dir-path-empty'}`}
                title={selectedPath || dirPlaceholder}
              >
                {selectedPath || dirPlaceholder}
              </div>
              <button
                className="btn btn-sm pf-browse-btn"
                onClick={handleBrowse}
                disabled={browsing}
              >
                {browsing ? '…' : '浏览'}
              </button>
            </div>
            {selectedPath && (
              <button className="pf-clear-path" onClick={() => setSelectedPath('')}>
                ✕ 清除
              </button>
            )}
          </div>

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
              拆分完成 · {successCount}/{results.length} 个文件成功
              <span className="pf-results-dir" title={selectedPath}>→ {selectedPath}</span>
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
                        <span className="pf-output-saved">已保存</span>
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
