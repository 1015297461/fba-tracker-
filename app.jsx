/* eslint-disable no-undef */
const { useState, useEffect } = React;

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    setError('');
    const ok = await onLogin(username.trim(), password);
    if (!ok) { setError('用户名或密码错误，请重试'); setLoading(false); }
  };

  return (
    <div className="login-overlay">
      <div className="login-card">
        <div className="login-logo">📦</div>
        <h1 className="login-title">FBA Tracker</h1>
        <p className="login-subtitle">产品开发全流程管理系统</p>
        <form className="login-form" onSubmit={submit}>
          <div className="login-field">
            <label>用户名</label>
            <input type="text" value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="请输入用户名" autoFocus autoComplete="username" />
          </div>
          <div className="login-field">
            <label>密码</label>
            <input type="password" value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码" autoComplete="current-password" />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
        <p className="login-hint">局域网协作模式 · 请联系管理员获取账号</p>
      </div>
    </div>
  );
}

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "view": "list",
  "density": "comfortable",
  "showTimelineLegend": true
}/*EDITMODE-END*/;

function AppShell() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useState(t.view || 'list');
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState('p001');
  const [progressFocusId, setProgressFocusId] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const theme = t.theme || 'light';

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  useEffect(() => { if (t.view && t.view !== view) setView(t.view); }, [t.view]);

  function changeView(v) { setView(v); setTweak('view', v); }
  function toggleTheme() { setTweak('theme', theme === 'dark' ? 'light' : 'dark'); }

  const { products, createProduct } = useProducts();
  const filteredProducts = filter === 'all' ? products : products.filter(p => p.status === filter);
  const activeProduct = filteredProducts.find(p => p.id === activeId) || filteredProducts[0];

  return (
    <div className="app" data-view={view}>
      <Sidebar
        view={view}
        setView={changeView}
        filter={filter}
        setFilter={setFilter}
        products={products}
      />
      <div className="main-area"
        style={view === 'list'
          ? { gridTemplateColumns:'320px 1fr', gridTemplateRows:'auto 1fr' }
          : { gridTemplateRows:'auto 1fr' }}>
        <div style={{ gridColumn: view === 'list' ? '1 / -1' : 'auto' }}>
          <TopBar
            view={view}
            product={view === 'list' ? activeProduct : null}
            theme={theme}
            onToggleTheme={toggleTheme}
            onNewProduct={() => setNewOpen(true)}
          />
        </div>
        {view === 'list' && (
          <>
            <ProductList
              products={filteredProducts}
              activeId={activeProduct?.id}
              setActiveId={setActiveId}
            />
            <Detail p={activeProduct} />
          </>
        )}
        {view === 'progress' && (
          <ProgressView
            products={filteredProducts}
            focusId={progressFocusId}
            setFocusId={setProgressFocusId}
          />
        )}
        {view === 'table' && (
          <TableView
            filter={filter}
            onSelectProduct={(id) => { setActiveId(id); changeView('list'); }}
          />
        )}
      </div>
      <TweaksPanel title="Tweaks">
        <TweakSection label="主题" />
        <TweakRadio
          label="模式"
          value={theme}
          options={[
            { value: 'light', label: '☀️ 浅色' },
            { value: 'dark', label: '🌙 深色' },
          ]}
          onChange={v => setTweak('theme', v)}
        />
        <TweakSection label="视图" />
        <TweakSelect
          label="当前视图"
          value={view}
          options={[
            { value: 'list', label: '📋 产品列表' },
            { value: 'progress', label: '📊 进度总览' },
            { value: 'table', label: '📐 数据表格' },
          ]}
          onChange={v => changeView(v)}
        />
        <TweakSection label="样式" />
        <TweakRadio
          label="密度"
          value={t.density}
          options={['紧凑', '舒适']}
          onChange={v => setTweak('density', v === '紧凑' ? 'compact' : 'comfortable')}
        />
        <TweakToggle
          label="时间线图例"
          value={t.showTimelineLegend}
          onChange={v => setTweak('showTimelineLegend', v)}
        />
      </TweaksPanel>
      <NewProductModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreate={(seed) => {
          const id = createProduct(seed);
          setNewOpen(false);
          setActiveId(id);
          changeView('list');
        }}
      />
    </div>
  );
}

// AuthGate: isolated component so AppShell hooks are always called unconditionally
function AuthGate({ children }) {
  const { needLogin, login } = useProducts();
  if (needLogin) return <LoginScreen onLogin={login} />;
  return children;
}

function App() {
  return (
    <ProductsProvider initial={window.PRODUCTS}>
      <AuthGate>
        <AppShell />
      </AuthGate>
    </ProductsProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
