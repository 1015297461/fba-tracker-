/* eslint-disable no-undef */
// Sidebar + Top Bar

const STATUS_LABELS = {
  all: { label: '全部', color: '#6b6b6b' },
  active: { label: '进行中', color: '#16a34a' },
  hold: { label: '已暂停', color: '#ea580c' },
  done: { label: '已完成', color: '#2563eb' },
  cancel: { label: '已取消', color: '#9a9a96' },
};

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

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-brand-icon">F</div>
        <div className="sb-brand-text">
          <span className="sb-brand-title">FBA Tracker</span>
          <span className="sb-brand-sub">v2.0 · standalone</span>
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
        <span>本地存储</span>
        <span className="pill">已保存</span>
      </div>
    </aside>
  );
}

function TopBar({ view, product, theme, onToggleTheme, onNewProduct }) {
  const titles = { list: '产品列表', progress: '进度总览', table: '数据表格' };
  const ctx = useProducts ? useProducts() : null;
  const savedAt = ctx?.savedAt;
  const [savedFlash, setSavedFlash] = React.useState(false);
  React.useEffect(() => {
    if (!savedAt) return;
    setSavedFlash(true);
    const t = setTimeout(() => setSavedFlash(false), 1200);
    return () => clearTimeout(t);
  }, [savedAt]);
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
      <span className="save-indicator" data-flash={savedFlash}>
        {savedFlash ? <><span className="dot"></span>已保存</> : savedAt ? <>✓ 已保存 {savedAt.toLocaleTimeString()}</> : '未保存'}
      </span>
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
window.STATUS_LABELS = STATUS_LABELS;
