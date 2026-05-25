/* eslint-disable no-undef */
const {
  useState,
  useEffect
} = React;
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "view": "list",
  "density": "comfortable",
  "showTimelineLegend": true
} /*EDITMODE-END*/;
function AppShell() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useState(t.view || 'list');
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState('p001');
  const [progressFocusId, setProgressFocusId] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const theme = t.theme || 'light';
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => {
    if (t.view && t.view !== view) setView(t.view);
  }, [t.view]);
  function changeView(v) {
    setView(v);
    setTweak('view', v);
  }
  function toggleTheme() {
    setTweak('theme', theme === 'dark' ? 'light' : 'dark');
  }
  const {
    products,
    createProduct
  } = useProducts();
  const filteredProducts = filter === 'all' ? products : products.filter(p => p.status === filter);
  const activeProduct = filteredProducts.find(p => p.id === activeId) || filteredProducts[0];
  return /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-view": view
  }, /*#__PURE__*/React.createElement(Sidebar, {
    view: view,
    setView: changeView,
    filter: filter,
    setFilter: setFilter,
    products: products
  }), /*#__PURE__*/React.createElement("div", {
    className: "main-area",
    style: view === 'list' ? {
      gridTemplateColumns: '320px 1fr',
      gridTemplateRows: 'auto 1fr'
    } : {
      gridTemplateRows: 'auto 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      gridColumn: view === 'list' ? '1 / -1' : 'auto'
    }
  }, /*#__PURE__*/React.createElement(TopBar, {
    view: view,
    product: view === 'list' ? activeProduct : null,
    theme: theme,
    onToggleTheme: toggleTheme,
    onNewProduct: () => setNewOpen(true)
  })), view === 'list' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ProductList, {
    products: filteredProducts,
    activeId: activeProduct?.id,
    setActiveId: setActiveId
  }), /*#__PURE__*/React.createElement(Detail, {
    p: activeProduct
  })), view === 'progress' && /*#__PURE__*/React.createElement(ProgressView, {
    products: filteredProducts,
    focusId: progressFocusId,
    setFocusId: setProgressFocusId
  }), view === 'table' && /*#__PURE__*/React.createElement(TableView, {
    filter: filter,
    onSelectProduct: id => {
      setActiveId(id);
      changeView('list');
    }
  })), /*#__PURE__*/React.createElement(TweaksPanel, {
    title: "Tweaks"
  }, /*#__PURE__*/React.createElement(TweakSection, {
    label: "\u4E3B\u9898"
  }), /*#__PURE__*/React.createElement(TweakRadio, {
    label: "\u6A21\u5F0F",
    value: theme,
    options: [{
      value: 'light',
      label: '☀️ 浅色'
    }, {
      value: 'dark',
      label: '🌙 深色'
    }],
    onChange: v => setTweak('theme', v)
  }), /*#__PURE__*/React.createElement(TweakSection, {
    label: "\u89C6\u56FE"
  }), /*#__PURE__*/React.createElement(TweakSelect, {
    label: "\u5F53\u524D\u89C6\u56FE",
    value: view,
    options: [{
      value: 'list',
      label: '📋 产品列表'
    }, {
      value: 'progress',
      label: '📊 进度总览'
    }, {
      value: 'table',
      label: '📐 数据表格'
    }],
    onChange: v => changeView(v)
  }), /*#__PURE__*/React.createElement(TweakSection, {
    label: "\u6837\u5F0F"
  }), /*#__PURE__*/React.createElement(TweakRadio, {
    label: "\u5BC6\u5EA6",
    value: t.density,
    options: ['紧凑', '舒适'],
    onChange: v => setTweak('density', v === '紧凑' ? 'compact' : 'comfortable')
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "\u65F6\u95F4\u7EBF\u56FE\u4F8B",
    value: t.showTimelineLegend,
    onChange: v => setTweak('showTimelineLegend', v)
  })), /*#__PURE__*/React.createElement(NewProductModal, {
    open: newOpen,
    onClose: () => setNewOpen(false),
    onCreate: seed => {
      const id = createProduct(seed);
      setNewOpen(false);
      setActiveId(id);
      changeView('list');
    }
  }));
}
function App() {
  return /*#__PURE__*/React.createElement(ProductsProvider, {
    initial: window.PRODUCTS
  }, /*#__PURE__*/React.createElement(AppShell, null));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));