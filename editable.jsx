/* eslint-disable no-undef */
// Shared editable primitives + product state context

const AUTH_TOKEN_KEY = 'fba-auth-v1';
const AUTH_USER_KEY  = 'fba-auth-user-v1';
function getToken() { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; }
function getAuthHeaders() {
  const t = getToken();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}

const ProductCtx = React.createContext(null);

function useProducts() {
  const ctx = React.useContext(ProductCtx);
  return ctx;
}

const STORAGE_KEY = 'fba-tracker-v2';
const STORAGE_VERSION = 2;

function loadFromStorage(fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.__v === STORAGE_VERSION && Array.isArray(parsed.products)) {
      return parsed.products;
    }
  } catch (e) { console.warn('[FBA] localStorage load failed', e); }
  return fallback;
}

function saveToStorage(products) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ __v: STORAGE_VERSION, savedAt: new Date().toISOString(), products }));
  } catch (e) { console.warn('[FBA] localStorage save failed', e); }
}

function ProductsProvider({ children, initial }) {
  const [products, setProducts] = React.useState(() => loadFromStorage(initial));
  const [savedAt, setSavedAt] = React.useState(null);
  const [syncMode, setSyncMode] = React.useState('checking'); // checking | server | local
  const [syncStatus, setSyncStatus] = React.useState('idle'); // idle | saving | saved | error | conflict | offline
  const versionRef = React.useRef(0);
  const lastSentRef = React.useRef(null);
  const skipNextPutRef = React.useRef(false);
  const [needLogin, setNeedLogin] = React.useState(false);
  const [currentUser, setCurrentUser] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || 'null'); }
    catch { return null; }
  });

  // ----- Server sync helpers -----
  const SYNC_URL = '/api/products';

  // Probe server — re-runs when syncMode becomes 'checking' (also after login)
  React.useEffect(() => {
    if (syncMode !== 'checking') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(SYNC_URL, {
          headers: { 'Accept': 'application/json', ...getAuthHeaders() },
        });
        if (res.status === 401) {
          if (!cancelled) { setNeedLogin(true); setSyncMode('local'); }
          return;
        }
        if (!res.ok) throw new Error('no server');
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data?.products) && data.products.length > 0) {
          versionRef.current = data.version || 0;
          skipNextPutRef.current = true;
          setProducts(data.products);
          lastSentRef.current = JSON.stringify(data.products);
        } else {
          // Server is empty — push our local copy as seed
          versionRef.current = data?.version || 0;
        }
        setSyncMode('server');
        setSyncStatus('saved');
      } catch (e) {
        if (!cancelled) setSyncMode('local');
      }
    })();
    return () => { cancelled = true; };
  }, [syncMode]);

  // Local debounced save (when not in server mode)
  React.useEffect(() => {
    if (syncMode !== 'local') return;
    const t = setTimeout(() => {
      saveToStorage(products);
      setSavedAt(new Date());
    }, 600);
    return () => clearTimeout(t);
  }, [products, syncMode]);

  // Server debounced PUT
  React.useEffect(() => {
    if (syncMode !== 'server') return;
    if (skipNextPutRef.current) { skipNextPutRef.current = false; return; }
    const serialized = JSON.stringify(products);
    if (serialized === lastSentRef.current) return;
    setSyncStatus('saving');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(SYNC_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ products, baseVersion: versionRef.current }),
        });
        if (res.status === 401) {
          setNeedLogin(true); setSyncMode('local'); return;
        }
        if (res.ok) {
          const data = await res.json().catch(() => ({ version: versionRef.current + 1 }));
          versionRef.current = data.version;
          lastSentRef.current = serialized;
          setSyncStatus('saved');
          setSavedAt(new Date());
          saveToStorage(products); // also cache locally
        } else if (res.status === 409) {
          // conflict — take server's state
          const data = await res.json();
          versionRef.current = data.version;
          skipNextPutRef.current = true;
          setProducts(data.products);
          lastSentRef.current = JSON.stringify(data.products);
          setSyncStatus('conflict');
        } else {
          setSyncStatus('error');
        }
      } catch (e) {
        setSyncStatus('offline');
        saveToStorage(products);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [products, syncMode]);

  // Polling for remote changes
  React.useEffect(() => {
    if (syncMode !== 'server') return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (syncStatus === 'saving') return;
      try {
        const res = await fetch(SYNC_URL, { headers: { ...getAuthHeaders() } });
        if (res.status === 401) {
          stopped = true; setNeedLogin(true); setSyncMode('local'); return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (data.version > versionRef.current && Array.isArray(data.products)) {
          versionRef.current = data.version;
          skipNextPutRef.current = true;
          setProducts(data.products);
          lastSentRef.current = JSON.stringify(data.products);
          setSyncStatus('saved');
        }
      } catch (e) {
        if (syncStatus !== 'offline') setSyncStatus('offline');
      }
    };
    const interval = setInterval(tick, 4000);
    return () => { stopped = true; clearInterval(interval); };
  }, [syncMode, syncStatus]);

  const resetToDefaults = React.useCallback(() => {
    if (confirm('确定要恢复初始示例数据吗？当前所有编辑将丢失。')) {
      localStorage.removeItem(STORAGE_KEY);
      setProducts(initial);
    }
  }, [initial]);

  const exportJSON = React.useCallback(() => {
    const blob = new Blob([JSON.stringify({ __v: STORAGE_VERSION, exportedAt: new Date().toISOString(), products }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fba-tracker-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [products]);

  // Export a single product
  const exportProduct = React.useCallback((id) => {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const blob = new Blob([JSON.stringify({ __v: STORAGE_VERSION, exportedAt: new Date().toISOString(), products: [p] }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.sku || p.name}-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [products]);

  const importJSON = React.useCallback(() => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json';
    inp.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (Array.isArray(data?.products)) {
          if (confirm(`导入 ${data.products.length} 个产品？\n点击"确定"=替换全部，"取消"=合并`)) {
            setProducts(data.products);
          } else {
            const existingIds = new Set(products.map(p => p.id));
            const merged = [...products, ...data.products.filter(p => !existingIds.has(p.id))];
            setProducts(merged);
          }
        } else { alert('JSON 格式不正确'); }
      } catch (err) { alert('导入失败: ' + err.message); }
    };
    inp.click();
  }, [products]);

  const login = React.useCallback(async (username, password) => {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem(AUTH_TOKEN_KEY, data.token);
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user));
        setCurrentUser(data.user);
        setNeedLogin(false);
        setSyncMode('checking'); // re-trigger probe
        return true;
      }
      return false;
    } catch { return false; }
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { ...getAuthHeaders() } });
    } catch { /* ignore */ }
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    setCurrentUser(null);
    setNeedLogin(true);
    setSyncMode('local');
  }, []);

  // Build a blank product with all 18 stages initialized
  const buildBlankProduct = React.useCallback((seed) => {
    const stages = {};
    window.STAGES.forEach(s => { stages[s.key] = { status:'idle' }; });
    // Multi-record arrays
    stages.bom.items = [];
    stages.supplier.suppliers = [];
    stages.sampling.rounds = [];
    stages.packaging.rounds = [];
    stages.visuals.rounds = [];
    stages.production.batches = [];
    stages.qc.records = [];
    stages.shipment.records = [];
    stages.reorder.records = [];
    // Mark initiation done with seed data
    const today = new Date().toISOString().slice(0,10);
    stages.initiation = {
      status:'done', startDate: today, endDate: today,
      lead: seed.lead, source: seed.source, market: seed.market, reason: seed.reason,
    };
    return {
      id: 'p' + window.uid(),
      name: seed.name,
      sku: seed.sku,
      category: seed.category,
      status: 'active',
      lead: seed.lead,
      createdAt: today,
      currentStage: 'research',
      progress: 5,
      stages,
      logs: [{ id: window.uid(), date: today, text: '产品已立项 · ' + seed.name }],
    };
  }, []);

  const createProduct = React.useCallback((seed) => {
    const np = buildBlankProduct(seed);
    setProducts(prev => [np, ...prev]);
    return np.id;
  }, [buildBlankProduct]);

  const removeProduct = React.useCallback((id) => {
    setProducts(prev => prev.filter(p => p.id !== id));
  }, []);

  const duplicateProduct = React.useCallback((id) => {
    let newId = null;
    setProducts(prev => {
      const src = prev.find(p => p.id === id);
      if (!src) return prev;
      newId = 'p' + window.uid();
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = newId;
      copy.name = src.name + ' (副本)';
      copy.sku = src.sku + '-COPY';
      return [copy, ...prev];
    });
    return newId;
  }, []);

  const update = React.useCallback((id, updater) => {
    setProducts(prev => prev.map(p => p.id === id ? updater(p) : p));
  }, []);
  const updateStage = React.useCallback((id, stageKey, patch) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const s = p.stages[stageKey] || {};
      const next = typeof patch === 'function' ? patch(s) : { ...s, ...patch };
      const newStages = { ...p.stages, [stageKey]: next };

      // 阶段 status 变化时，自动重算顶层 progress / currentStage，保持表格同步
      if (typeof patch === 'object' && patch !== null && 'status' in patch) {
        const keys = window.STAGES.map(st => st.key);
        const doneCount = keys.filter(k => newStages[k]?.status === 'done').length;
        const progress = Math.round((doneCount / keys.length) * 100);
        const activeKey   = keys.find(k => newStages[k]?.status === 'active');
        const holdKey     = keys.find(k => newStages[k]?.status === 'hold');
        const lastDoneIdx = keys.reduce((acc, k, i) => newStages[k]?.status === 'done' ? i : acc, -1);
        const nextStageKey = lastDoneIdx >= 0 && lastDoneIdx < keys.length - 1
          ? keys[lastDoneIdx + 1] : null;
        const currentStage = activeKey || holdKey || nextStageKey || keys[0];
        return { ...p, stages: newStages, progress, currentStage };
      }

      return { ...p, stages: newStages };
    }));
  }, []);
  const updateRecord = React.useCallback((id, stageKey, arrayKey, recId, patch) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const s = p.stages[stageKey] || {};
      const arr = (s[arrayKey] || []).map(r => r.id === recId ? { ...r, ...patch } : r);
      return { ...p, stages: { ...p.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
    }));
  }, []);
  const addRecord = React.useCallback((id, stageKey, arrayKey, record) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const s = p.stages[stageKey] || {};
      const arr = [...(s[arrayKey] || []), { id: window.uid(), status:'idle', ...record }];
      return { ...p, stages: { ...p.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
    }));
  }, []);
  const removeRecord = React.useCallback((id, stageKey, arrayKey, recId) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const s = p.stages[stageKey] || {};
      const arr = (s[arrayKey] || []).filter(r => r.id !== recId);
      return { ...p, stages: { ...p.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
    }));
  }, []);
  const updateSubShipment = React.useCallback((id, reorderId, ssId, patch) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const ro = (p.stages.reorder.records || []).map(r => {
        if (r.id !== reorderId) return r;
        const ss = (r.subShipments || []).map(x => x.id === ssId ? { ...x, ...patch } : x);
        return { ...r, subShipments: ss };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records: ro } } };
    }));
  }, []);
  const addSubShipment = React.useCallback((id, reorderId, sub) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const ro = (p.stages.reorder.records || []).map(r => {
        if (r.id !== reorderId) return r;
        const ss = [...(r.subShipments || []), { id: window.uid(), status:'idle', ...sub }];
        return { ...r, subShipments: ss };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records: ro } } };
    }));
  }, []);
  const removeSubShipment = React.useCallback((id, reorderId, ssId) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const ro = (p.stages.reorder.records || []).map(r => {
        if (r.id !== reorderId) return r;
        return { ...r, subShipments: (r.subShipments || []).filter(x => x.id !== ssId) };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records: ro } } };
    }));
  }, []);
  const addLog = React.useCallback((id, text) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const date = new Date().toISOString().slice(0,10);
      return { ...p, logs: [{ id: window.uid(), date, text }, ...(p.logs||[])] };
    }));
  }, []);

  const value = React.useMemo(() => ({
    products, setProducts, update, updateStage, updateRecord, addRecord, removeRecord,
    updateSubShipment, addSubShipment, removeSubShipment, addLog,
    savedAt, resetToDefaults, exportJSON, importJSON, exportProduct,
    createProduct, removeProduct, duplicateProduct,
    syncMode, syncStatus, syncVersion: versionRef.current,
    needLogin, currentUser, login, logout,
  }), [products, update, updateStage, updateRecord, addRecord, removeRecord, updateSubShipment, addSubShipment, removeSubShipment, addLog, savedAt, resetToDefaults, exportJSON, importJSON, exportProduct, createProduct, removeProduct, duplicateProduct, syncMode, syncStatus, needLogin, currentUser, login, logout]);

  return <ProductCtx.Provider value={value}>{children}</ProductCtx.Provider>;
}

// ===== Status chip (read-only display) =====
function StatusChip({ status, size }) {
  const s = STAGE_STATUSES.find(x => x.value === (status || 'idle')) || STAGE_STATUSES[0];
  return (
    <span className={"status-chip" + (size === 'sm' ? ' sm' : '')}
      style={{ color: s.color, background: s.bg }}>
      <span className="dot" style={{ background: s.color }}></span>
      {s.label}
    </span>
  );
}

// ===== Editable status (click to cycle / dropdown) =====
function StatusSelect({ value, onChange, size }) {
  return (
    <span className={"status-select" + (size === 'sm' ? ' sm' : '')}>
      <StatusChip status={value} size={size} />
      <select value={value || 'idle'} onChange={e => onChange(e.target.value)}>
        {STAGE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </span>
  );
}

// ===== Editable text/number input =====
function EditField({ label, value, onChange, type, mono, placeholder, wide, multi, prefix, suffix, options }) {
  const [local, setLocal] = React.useState(value ?? '');
  React.useEffect(() => { setLocal(value ?? ''); }, [value]);
  const commit = () => {
    if (local === (value ?? '')) return;
    if (type === 'number') onChange(local === '' ? '' : Number(local));
    else onChange(local);
  };
  return (
    <div className={"field" + (wide ? " field-wide" : "")}>
      {label && <span className="lbl">{label}</span>}
      <div className={"input-wrap" + (prefix ? ' has-prefix' : '') + (suffix ? ' has-suffix' : '')}>
        {prefix && <span className="prefix">{prefix}</span>}
        {options ? (
          <select className={"input" + (mono ? ' mono' : '')}
            value={local} onChange={e => { setLocal(e.target.value); onChange(e.target.value); }}>
            {options.map(o => typeof o === 'string'
              ? <option key={o} value={o}>{o}</option>
              : <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : multi ? (
          <textarea className="input"
            value={local} onChange={e => setLocal(e.target.value)} onBlur={commit}
            placeholder={placeholder} rows={3} />
        ) : (
          <input className={"input" + (mono ? ' mono' : '')}
            type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'}
            value={local}
            onChange={e => setLocal(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter' && !multi) e.target.blur(); }}
            placeholder={placeholder}
            step={type === 'number' ? 'any' : undefined} />
        )}
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
    </div>
  );
}

// ===== Stage card header with editable status + start/end dates =====
function StageCard({ stage, productId, stageKey, stageData, children, extraHeader, defaultOpen=true }) {
  const { updateStage } = useProducts();
  const [open, setOpen] = React.useState(defaultOpen);
  const status = stageData?.status || 'idle';
  return (
    <div className={"stage-card stage-" + status}>
      <div className="stage-card-hdr">
        <div className="stage-card-bar" style={{ background: stage.color }}></div>
        <button className="stage-collapse" onClick={() => setOpen(o => !o)}>
          {open ? '▾' : '▸'}
        </button>
        <span className="stage-card-title">{stage.name}</span>

        <div className="stage-card-dates">
          <span className="dlbl">开始</span>
          <input type="date" className="date-input"
            value={stageData?.startDate || ''}
            onChange={e => updateStage(productId, stageKey, { startDate: e.target.value })} />
          <span className="dsep">→</span>
          <span className="dlbl">结束</span>
          <input type="date" className="date-input"
            value={stageData?.endDate || ''}
            onChange={e => updateStage(productId, stageKey, { endDate: e.target.value })} />
        </div>

        <StatusSelect value={status}
          onChange={v => {
            const patch = { status: v };
            if (v === 'done' && !stageData?.endDate) patch.endDate = new Date().toISOString().slice(0,10);
            if (v === 'active' && !stageData?.startDate) patch.startDate = new Date().toISOString().slice(0,10);
            updateStage(productId, stageKey, patch);
          }} />
        {extraHeader}
      </div>
      {open && <div className="stage-card-body">{children}</div>}
    </div>
  );
}

// ===== Record card (for multi-record sections: sampling rounds, batches, etc.) =====
function RecordCard({ index, title, status, onStatusChange, onRemove, isFinal, color, children, dates }) {
  return (
    <div className={"record-card" + (isFinal ? ' final' : '')}>
      <div className="record-hdr">
        <div className="record-num" style={{ background: color, color:'#fff' }}>#{index}</div>
        <span className="record-title">{title}</span>
        {dates && <span className="record-dates">{dates}</span>}
        <StatusSelect value={status} size="sm" onChange={onStatusChange} />
        {isFinal && <span className="record-final-badge">最终版</span>}
        <button className="record-remove" onClick={onRemove} title="删除">✕</button>
      </div>
      <div className="record-body">{children}</div>
    </div>
  );
}

// ===== Inline addable list helper =====
function AddRecordButton({ label, onClick }) {
  return (
    <button className="btn btn-sm btn-add" onClick={onClick}>+ {label}</button>
  );
}

Object.assign(window, {
  ProductCtx, ProductsProvider, useProducts,
  StatusChip, StatusSelect, EditField, StageCard, RecordCard, AddRecordButton,
});
