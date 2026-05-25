/* eslint-disable no-undef */
// Sidebar + Top Bar
// STATUS_LABELS 定义在 data.jsx 中，此处直接使用全局声明

function useSyncLabel() {
  const ctx = useProducts ? useProducts() : null;
  const { syncMode, syncStatus, syncVersion } = ctx || {};

  if (!syncMode || syncMode === 'checking') {
    return { label: '检测中...', cls: '', icon: '…' };
  }
  if (syncMode === 'local') {
    return { label: '本地已保存', cls: 'sync-local', icon: '💾' };
  }
  // server mode
  if (syncStatus === 'saving') {
    return { label: '同步中...', cls: 'sync-saving', icon: '☁' };
  }
  if (syncStatus === 'conflict') {
    return { label: '已自动合并', cls: 'sync-conflict', icon: '⚠' };
  }
  if (syncStatus === 'offline') {
    return { label: '离线 (本地缓存)', cls: 'sync-offline', icon: '⚠' };
  }
  if (syncStatus === 'error') {
    return { label: '同步错误', cls: 'sync-error', icon: '⚠' };
  }
  // saved / idle
  const ctx2 = useProducts ? useProducts() : null;
  const savedAt = ctx2?.savedAt;
  const timeStr = savedAt ? savedAt.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
  return { label: timeStr ? `已同步 ${timeStr}` : '已同步', cls: 'sync-online', icon: '☁' };
}

function Sidebar({ view, setView, filter, setFilter, products }) {
  const counts = {
    all: products.length,
    active: products.filter(p => p.status === 'active').length,
    hold: products.filter(p => p.status === 'hold').length,
    done: products.filter(p => p.status === 'done').length,
    cancel: products.filter(p => p.status === 'cancel').length,
  };
  const monthDone = 2; // mock
  const overdue = 1;
  const due30 = 4;

  const ctx = useProducts ? useProducts() : null;
  const syncMode = ctx?.syncMode;
  const { label: syncLabel, cls: syncCls } = useSyncLabel();
  const modeText = syncMode === 'server' ? '局域网协作' : syncMode === 'local' ? '本地存储' : '检测中';

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-brand-icon">F</div>
        <div className="sb-brand-text">
          <span className="sb-brand-title">FBA Tracker</span>
          <span className="sb-brand-sub">v2.0 · {modeText}</span>
        </div>
      </div>

      <div className="sb-section">
        <div className="sb-section-label">视图</div>
        <div className="sb-view-tabs">
          {[
            { k: 'list',     ic: '📋', label: '产品列表' },
            { k: 'progress', ic: '📊', label: '进度总览' },
            { k: 'table',    ic: '📐', label: '数据表格' },
          ].map(v => (
            <button key={v.k} className="sb-view-btn"
              data-active={view === v.k}
              onClick={() => setView(v.k)}>
              <span className="ic">{v.ic}</span>
              <span>{v.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sb-section">
        <div className="sb-section-label">状态筛选</div>
        <div className="sb-filter">
          {['all', 'active', 'hold', 'done', 'cancel'].map(k => (
            <button key={k} className="sb-filter-btn"
              data-active={filter === k}
              onClick={() => setFilter(k)}>
              <span className="left">
                <span className="dot" style={{background: STATUS_LABELS[k].color}}></span>
                <span>{STATUS_LABELS[k].label}</span>
              </span>
              <span className="count">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sb-stats">
        <div className="sb-stat">
          <div className="sb-stat-v">{counts.active}</div>
          <div className="sb-stat-l">进行中</div>
        </div>
        <div className="sb-stat">
          <div className="sb-stat-v">{monthDone}</div>
          <div className="sb-stat-l">本月完成</div>
        </div>
        <div className="sb-stat">
          <div className="sb-stat-v">{due30}</div>
          <div className="sb-stat-l">30天到期</div>
        </div>
        <div className="sb-stat">
          <div className="sb-stat-v" style={{color: overdue > 0 ? 'var(--red)' : undefined}}>{overdue}</div>
          <div className="sb-stat-l">已逾期</div>
        </div>
      </div>

      <div className="sb-footer">
        <span>{modeText}</span>
        <span className={`pill ${syncCls}`}>{syncLabel}</span>
      </div>
    </aside>
  );
}

function TopBar({ view, product, theme, onToggleTheme, onNewProduct }) {
  const titles = { list: '产品列表', progress: '进度总览', table: '数据表格' };
  const ctx = useProducts ? useProducts() : null;
  const { label: syncLabel, cls: syncCls, icon: syncIcon } = useSyncLabel();
  const currentUser = ctx?.currentUser;
  const logout = ctx?.logout;

  // 保存成功时短暂闪烁绿色
  const syncStatus = ctx?.syncStatus;
  const [flash, setFlash] = React.useState(false);
  React.useEffect(() => {
    if (syncStatus !== 'saved') return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [ctx?.savedAt]);

  return (
    <div className="topbar">
      <span className="topbar-title">{titles[view]}</span>
      {view === 'list' && product && (
        <>
          <span className="topbar-crumb">/</span>
          <span className="topbar-crumb">{product.name}</span>
        </>
      )}
      <div className="topbar-spacer"></div>
      <span className={`save-indicator ${syncCls}`} data-flash={flash}>
        {syncIcon} {syncLabel}
      </span>
      {currentUser && (
        <div className="topbar-user">
          <span className="topbar-username">{currentUser.name}</span>
          <button className="btn btn-sm topbar-logout" onClick={logout} title="退出登录">退出</button>
        </div>
      )}
      <div className="topbar-actions">
        <button className="btn btn-sm" onClick={() => ctx?.importJSON?.()}><span>↑</span><span>导入</span></button>
        <button className="btn btn-sm" onClick={() => ctx?.exportJSON?.()}><span>↓</span><span>导出 JSON</span></button>
        <button className="btn btn-sm" onClick={() => ctx?.resetToDefaults?.()} title="清空 localStorage 并恢复示例数据"><span>⟲</span><span>重置</span></button>
        <button className="btn btn-icon" onClick={onToggleTheme} title="切换主题">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button className="btn btn-primary btn-sm" onClick={onNewProduct}>+ 新建产品</button>
      </div>
    </div>
  );
}

window.Sidebar = Sidebar;
window.TopBar = TopBar;
