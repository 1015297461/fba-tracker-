/* eslint-disable no-undef */
// Sidebar + Top Bar
// STATUS_LABELS 定义在 data.jsx 中，此处直接使用全局声明

function useSyncLabel() {
  const ctx = useProducts ? useProducts() : null;
  const {
    syncMode,
    syncStatus,
    syncVersion
  } = ctx || {};
  if (!syncMode || syncMode === 'checking') {
    return {
      label: '检测中...',
      cls: '',
      icon: '…'
    };
  }
  if (syncMode === 'local') {
    return {
      label: '本地已保存',
      cls: 'sync-local',
      icon: '💾'
    };
  }
  // server mode
  if (syncStatus === 'saving') {
    return {
      label: '同步中...',
      cls: 'sync-saving',
      icon: '☁'
    };
  }
  if (syncStatus === 'conflict') {
    return {
      label: '已自动合并',
      cls: 'sync-conflict',
      icon: '⚠'
    };
  }
  if (syncStatus === 'offline') {
    return {
      label: '离线 (本地缓存)',
      cls: 'sync-offline',
      icon: '⚠'
    };
  }
  if (syncStatus === 'error') {
    return {
      label: '同步错误',
      cls: 'sync-error',
      icon: '⚠'
    };
  }
  // saved / idle
  const ctx2 = useProducts ? useProducts() : null;
  const savedAt = ctx2?.savedAt;
  const timeStr = savedAt ? savedAt.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }) : '';
  return {
    label: timeStr ? `已同步 ${timeStr}` : '已同步',
    cls: 'sync-online',
    icon: '☁'
  };
}
function Sidebar({
  view,
  setView,
  filter,
  setFilter,
  products
}) {
  const counts = {
    all: products.length,
    active: products.filter(p => p.status === 'active').length,
    hold: products.filter(p => p.status === 'hold').length,
    done: products.filter(p => p.status === 'done').length,
    cancel: products.filter(p => p.status === 'cancel').length
  };
  const {
    monthDone,
    overdue,
    due30
  } = computeStats(products);
  const ctx = useProducts ? useProducts() : null;
  const syncMode = ctx?.syncMode;
  const {
    label: syncLabel,
    cls: syncCls
  } = useSyncLabel();
  const modeText = syncMode === 'server' ? '局域网协作' : syncMode === 'local' ? '本地存储' : '检测中';
  return /*#__PURE__*/React.createElement("aside", {
    className: "sidebar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-brand"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-brand-icon"
  }, "F"), /*#__PURE__*/React.createElement("div", {
    className: "sb-brand-text"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-brand-title"
  }, "FBA Tracker"), /*#__PURE__*/React.createElement("span", {
    className: "sb-brand-sub"
  }, "v2.0 \xB7 ", modeText))), /*#__PURE__*/React.createElement("div", {
    className: "sb-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-section-label"
  }, "\u89C6\u56FE"), /*#__PURE__*/React.createElement("div", {
    className: "sb-view-tabs"
  }, [{
    k: 'list',
    ic: '📋',
    label: '产品列表'
  }, {
    k: 'progress',
    ic: '📊',
    label: '进度总览'
  }, {
    k: 'table',
    ic: '📐',
    label: '数据表格'
  }].map(v => /*#__PURE__*/React.createElement("button", {
    key: v.k,
    className: "sb-view-btn",
    "data-active": view === v.k,
    onClick: () => setView(v.k)
  }, /*#__PURE__*/React.createElement("span", {
    className: "ic"
  }, v.ic), /*#__PURE__*/React.createElement("span", null, v.label))))), /*#__PURE__*/React.createElement("div", {
    className: "sb-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-section-label"
  }, "\u72B6\u6001\u7B5B\u9009"), /*#__PURE__*/React.createElement("div", {
    className: "sb-filter"
  }, ['all', 'active', 'hold', 'done', 'cancel'].map(k => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: "sb-filter-btn",
    "data-active": filter === k,
    onClick: () => setFilter(k)
  }, /*#__PURE__*/React.createElement("span", {
    className: "left"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: STATUS_LABELS[k].color
    }
  }), /*#__PURE__*/React.createElement("span", null, STATUS_LABELS[k].label)), /*#__PURE__*/React.createElement("span", {
    className: "count"
  }, counts[k]))))), /*#__PURE__*/React.createElement("div", {
    className: "sb-stats"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-stat-v"
  }, counts.active), /*#__PURE__*/React.createElement("div", {
    className: "sb-stat-l"
  }, "\u8FDB\u884C\u4E2D")), /*#__PURE__*/React.createElement("div", {
    className: "sb-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-stat-v"
  }, monthDone), /*#__PURE__*/React.createElement("div", {
    className: "sb-stat-l"
  }, "\u672C\u6708\u5B8C\u6210")), /*#__PURE__*/React.createElement("div", {
    className: "sb-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-stat-v"
  }, due30), /*#__PURE__*/React.createElement("div", {
    className: "sb-stat-l"
  }, "30\u5929\u5230\u671F")), /*#__PURE__*/React.createElement("div", {
    className: "sb-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-stat-v",
    style: {
      color: overdue > 0 ? 'var(--red)' : undefined
    }
  }, overdue), /*#__PURE__*/React.createElement("div", {
    className: "sb-stat-l"
  }, "\u5DF2\u903E\u671F"))), /*#__PURE__*/React.createElement("div", {
    className: "sb-footer"
  }, /*#__PURE__*/React.createElement("span", null, modeText), /*#__PURE__*/React.createElement("span", {
    className: `pill ${syncCls}`
  }, syncLabel)));
}
function TopBar({
  view,
  product,
  theme,
  onToggleTheme,
  onNewProduct
}) {
  const titles = {
    list: '产品列表',
    progress: '进度总览',
    table: '数据表格'
  };
  const ctx = useProducts ? useProducts() : null;
  const {
    label: syncLabel,
    cls: syncCls,
    icon: syncIcon
  } = useSyncLabel();
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
  return /*#__PURE__*/React.createElement("div", {
    className: "topbar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "topbar-title"
  }, titles[view]), view === 'list' && product && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "topbar-crumb"
  }, "/"), /*#__PURE__*/React.createElement("span", {
    className: "topbar-crumb"
  }, product.name)), /*#__PURE__*/React.createElement("div", {
    className: "topbar-spacer"
  }), /*#__PURE__*/React.createElement("span", {
    className: `save-indicator ${syncCls}`,
    "data-flash": flash
  }, syncIcon, " ", syncLabel), currentUser && /*#__PURE__*/React.createElement("div", {
    className: "topbar-user"
  }, /*#__PURE__*/React.createElement("span", {
    className: "topbar-username"
  }, currentUser.name), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm topbar-logout",
    onClick: logout,
    title: "\u9000\u51FA\u767B\u5F55"
  }, "\u9000\u51FA")), /*#__PURE__*/React.createElement("div", {
    className: "topbar-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => ctx?.importJSON?.()
  }, /*#__PURE__*/React.createElement("span", null, "\u2191"), /*#__PURE__*/React.createElement("span", null, "\u5BFC\u5165")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => ctx?.exportJSON?.()
  }, /*#__PURE__*/React.createElement("span", null, "\u2193"), /*#__PURE__*/React.createElement("span", null, "\u5BFC\u51FA JSON")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => ctx?.resetToDefaults?.(),
    title: "\u6E05\u7A7A localStorage \u5E76\u6062\u590D\u793A\u4F8B\u6570\u636E"
  }, /*#__PURE__*/React.createElement("span", null, "\u27F2"), /*#__PURE__*/React.createElement("span", null, "\u91CD\u7F6E")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-icon",
    onClick: onToggleTheme,
    title: "\u5207\u6362\u4E3B\u9898"
  }, theme === 'dark' ? '☀️' : '🌙'), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: onNewProduct
  }, "+ \u65B0\u5EFA\u4EA7\u54C1")));
}
window.Sidebar = Sidebar;
window.TopBar = TopBar;