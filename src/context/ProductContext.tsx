import React from 'react';
import { STAGES, VARIANT_STAGE_KEYS, STAGE_STATUSES } from '../data/constants';
import { PRODUCTS, uid } from '../data/products';
import type { Product, Variant } from '../data/types';

const AUTH_TOKEN_KEY = 'fba-auth-v1';
const AUTH_USER_KEY  = 'fba-auth-user-v1';
function getToken() { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; }
function getAuthHeaders() {
  const t = getToken();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}

export const ProductCtx = React.createContext<any>(null);

export function _variantProgress(variant: Variant): number {
  const keys = VARIANT_STAGE_KEYS;
  const done = keys.filter(k => variant?.stages?.[k]?.status === 'done').length;
  return Math.round((done / keys.length) * 100);
}

export function _variantInUse(p: Product, variantId: string): string | null {
  const batches  = p.stages?.production?.batches || [];
  if (batches.some((b: any) => (b.items  || []).some((i: any) => i.variantId === variantId))) return '生产订单';
  const ships    = p.stages?.shipment?.records  || [];
  if (ships.some((s: any)    => (s.items  || []).some((i: any) => i.variantId === variantId))) return '出货记录';
  const reorders = p.stages?.reorder?.records   || [];
  if (reorders.some((r: any) => (r.items  || []).some((i: any) => i.variantId === variantId))) return '返单';
  return null;
}

export function _buildBlankVariant(seed: Partial<Variant>): Variant {
  return {
    id:          'v' + uid(),
    name:        seed.name        || '新变体',
    sku:         seed.sku         || '',
    colorOrSize: seed.colorOrSize || '',
    stages: {
      profit:   { status: 'idle' },
      bom:      { status: 'idle', items: [] },
      sampling: { status: 'idle', rounds: [] },
      listing:  { status: 'idle' },
      promotion:{ status: 'idle' },
    },
  };
}

export function useProducts() {
  return React.useContext(ProductCtx);
}

const STORAGE_KEY = 'fba-tracker-v2';
const STORAGE_VERSION = 2;

function loadFromStorage(fallback: Product[]): Product[] {
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

function saveToStorage(products: Product[], syncedServerVersion?: number) {
  try {
    const record: any = { __v: STORAGE_VERSION, savedAt: new Date().toISOString(), products };
    if (typeof syncedServerVersion === 'number') record.syncedServerVersion = syncedServerVersion;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (e) { console.warn('[FBA] localStorage save failed', e); }
}

function loadSyncedVersion(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return -1;
    const p = JSON.parse(raw);
    return typeof p?.syncedServerVersion === 'number' ? p.syncedServerVersion : -1;
  } catch { return -1; }
}

export function ProductsProvider({ children, initial }: { children: React.ReactNode; initial: Product[] }) {
  const [products, setProducts] = React.useState<Product[]>(() => loadFromStorage(initial));
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [syncMode, setSyncMode] = React.useState('checking');
  const [syncStatus, setSyncStatus] = React.useState('idle');
  const versionRef = React.useRef(0);
  const lastSentRef = React.useRef<string | null>(null);
  const skipNextPutRef = React.useRef(false);
  const syncedVersionRef = React.useRef(loadSyncedVersion());
  const [needLogin, setNeedLogin] = React.useState(false);
  const [currentUser, setCurrentUser] = React.useState<any>(() => {
    try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || 'null'); }
    catch { return null; }
  });

  const SYNC_URL = '/api/products';

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
          const serverV = data.version || 0;
          const localSyncedV = syncedVersionRef.current;
          if (localSyncedV >= 0 && localSyncedV >= serverV) {
            versionRef.current = serverV;
            syncedVersionRef.current = serverV;
            lastSentRef.current = null;
          } else {
            versionRef.current = serverV;
            syncedVersionRef.current = serverV;
            skipNextPutRef.current = true;
            setProducts(data.products);
            lastSentRef.current = JSON.stringify(data.products);
          }
        } else {
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

  React.useEffect(() => {
    const sv = syncedVersionRef.current >= 0 ? syncedVersionRef.current : undefined;
    saveToStorage(products, sv);
  }, [products]);

  React.useEffect(() => {
    if (syncMode !== 'local') return;
    setSavedAt(new Date());
  }, [products, syncMode]);

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
          syncedVersionRef.current = data.version;
          lastSentRef.current = serialized;
          setSyncStatus('saved');
          setSavedAt(new Date());
        } else if (res.status === 409) {
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
      }
    }, 600);
    return () => clearTimeout(t);
  }, [products, syncMode]);

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

  React.useEffect(() => {
    if (syncMode !== 'server') return;
    const flush = () => {
      if (JSON.stringify(products) === lastSentRef.current) return;
      fetch(SYNC_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ products, baseVersion: versionRef.current }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [products, syncMode]);

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

  const exportProduct = React.useCallback((id: string) => {
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
    inp.onchange = async (e: any) => {
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
            const merged = [...products, ...data.products.filter((p: Product) => !existingIds.has(p.id))];
            setProducts(merged);
          }
        } else { alert('JSON 格式不正确'); }
      } catch (err: any) { alert('导入失败: ' + err.message); }
    };
    inp.click();
  }, [products]);

  const login = React.useCallback(async (username: string, password: string) => {
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
        setSyncMode('checking');
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

  const buildBlankProduct = React.useCallback((seed: any) => {
    const stages: Record<string, any> = {};
    STAGES.forEach(s => { stages[s.key] = { status:'idle' }; });
    stages.bom.items = [];
    stages.supplier.suppliers = [];
    stages.sampling.rounds = [];
    stages.packaging.rounds = [];
    stages.visuals.rounds = [];
    stages.production.batches = [];
    stages.qc.records = [];
    stages.shipment.records = [];
    stages.reorder.records = [];
    const today = new Date().toISOString().slice(0,10);
    stages.initiation = {
      status:'done', startDate: today, endDate: today,
      lead: seed.lead, source: seed.source, market: seed.market, reason: seed.reason,
    };
    return {
      id: 'p' + uid(),
      name: seed.name,
      sku: seed.sku,
      category: seed.category,
      status: 'active' as const,
      lead: seed.lead,
      createdAt: today,
      currentStage: 'research',
      progress: 5,
      stages,
      variants: [],
      logs: [{ id: uid(), date: today, text: '产品已立项 · ' + seed.name }],
    };
  }, []);

  const createProduct = React.useCallback((seed: any) => {
    const np = buildBlankProduct(seed);
    setProducts(prev => [np, ...prev]);
    return np.id;
  }, [buildBlankProduct]);

  const removeProduct = React.useCallback((id: string) => {
    setProducts(prev => prev.filter(p => p.id !== id));
  }, []);

  const duplicateProduct = React.useCallback((id: string) => {
    let newId: string | null = null;
    setProducts(prev => {
      const src = prev.find(p => p.id === id);
      if (!src) return prev;
      newId = 'p' + uid();
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = newId;
      copy.name = src.name + ' (副本)';
      copy.sku = src.sku + '-COPY';
      return [copy, ...prev];
    });
    return newId;
  }, []);

  const update = React.useCallback((id: string, updater: (p: Product) => Product) => {
    setProducts(prev => prev.map(p => p.id === id ? updater(p) : p));
  }, []);

  const updateStage = React.useCallback((id: string, stageKey: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const s = p.stages[stageKey] || {};
      const next = typeof patch === 'function' ? patch(s) : { ...s, ...patch };
      const newStages = { ...p.stages, [stageKey]: next };

      if (typeof patch === 'object' && patch !== null && 'status' in patch) {
        if ((p.variants || []).length > 0) {
          return { ...p, stages: newStages };
        }
        const keys = STAGES.map(st => st.key);
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

  const updateRecord = React.useCallback((id: string, stageKey: string, arrayKey: string, recId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const s = p.stages[stageKey] || {};
      const arr = (s[arrayKey] || []).map((r: any) => r.id === recId ? { ...r, ...patch } : r);
      return { ...p, stages: { ...p.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
    }));
  }, []);

  const addRecord = React.useCallback((id: string, stageKey: string, arrayKey: string, record: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const s = p.stages[stageKey] || {};
      const arr = [...(s[arrayKey] || []), { id: uid(), status:'idle', ...record }];
      return { ...p, stages: { ...p.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
    }));
  }, []);

  const removeRecord = React.useCallback((id: string, stageKey: string, arrayKey: string, recId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const s = p.stages[stageKey] || {};
      const arr = (s[arrayKey] || []).filter((r: any) => r.id !== recId);
      return { ...p, stages: { ...p.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
    }));
  }, []);

  const updateSubShipment = React.useCallback((id: string, reorderId: string, ssId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const ro = (p.stages.reorder.records || []).map((r: any) => {
        if (r.id !== reorderId) return r;
        const ss = (r.subShipments || []).map((x: any) => x.id === ssId ? { ...x, ...patch } : x);
        return { ...r, subShipments: ss };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records: ro } } };
    }));
  }, []);

  const addSubShipment = React.useCallback((id: string, reorderId: string, sub: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const ro = (p.stages.reorder.records || []).map((r: any) => {
        if (r.id !== reorderId) return r;
        const ss = [...(r.subShipments || []), { id: uid(), status:'idle', ...sub }];
        return { ...r, subShipments: ss };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records: ro } } };
    }));
  }, []);

  const removeSubShipment = React.useCallback((id: string, reorderId: string, ssId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const ro = (p.stages.reorder.records || []).map((r: any) => {
        if (r.id !== reorderId) return r;
        return { ...r, subShipments: (r.subShipments || []).filter((x: any) => x.id !== ssId) };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records: ro } } };
    }));
  }, []);

  const addLog = React.useCallback((id: string, text: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== id) return p;
      const date = new Date().toISOString().slice(0,10);
      return { ...p, logs: [{ id: uid(), date, text }, ...(p.logs||[])] };
    }));
  }, []);

  const updateLog = React.useCallback((productId: string, logId: string, patch: { text?: string; date?: string }) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      return { ...p, logs: (p.logs||[]).map(l => l.id === logId ? { ...l, ...patch } : l) };
    }));
  }, []);

  const removeLog = React.useCallback((productId: string, logId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      return { ...p, logs: (p.logs||[]).filter(l => l.id !== logId) };
    }));
  }, []);

  const addVariant = React.useCallback((productId: string, seed: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const v = _buildBlankVariant(seed);
      return { ...p, variants: [...(p.variants || []), v] };
    }));
  }, []);

  const updateVariant = React.useCallback((productId: string, variantId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const variants = (p.variants || []).map(v =>
        v.id === variantId ? { ...v, ...patch } : v
      );
      return { ...p, variants };
    }));
  }, []);

  const updateVariantStage = React.useCallback((productId: string, variantId: string, stageKey: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const variants = (p.variants || []).map(v => {
        if (v.id !== variantId) return v;
        const s    = v.stages?.[stageKey] || {};
        const next = typeof patch === 'function' ? patch(s) : { ...s, ...patch };
        return { ...v, stages: { ...v.stages, [stageKey]: next } };
      });
      return { ...p, variants };
    }));
  }, []);

  const removeVariant = React.useCallback((productId: string, variantId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const inUse = _variantInUse(p, variantId);
      if (inUse) {
        alert(`该变体已在「${inUse}」中被引用，请先删除相关订单的该 SKU 明细后再操作。`);
        return p;
      }
      const variants = (p.variants || []).filter(v => v.id !== variantId);
      return { ...p, variants };
    }));
  }, []);

  const addVariantRecord = React.useCallback((productId: string, variantId: string, stageKey: string, arrayKey: string, record: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const variants = (p.variants || []).map(v => {
        if (v.id !== variantId) return v;
        const s   = v.stages?.[stageKey] || {};
        const arr = [...(s[arrayKey] || []), { id: uid(), status: 'idle', ...record }];
        return { ...v, stages: { ...v.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
      });
      return { ...p, variants };
    }));
  }, []);

  const updateVariantRecord = React.useCallback((productId: string, variantId: string, stageKey: string, arrayKey: string, recId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const variants = (p.variants || []).map(v => {
        if (v.id !== variantId) return v;
        const s   = v.stages?.[stageKey] || {};
        const arr = (s[arrayKey] || []).map((r: any) => r.id === recId ? { ...r, ...patch } : r);
        return { ...v, stages: { ...v.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
      });
      return { ...p, variants };
    }));
  }, []);

  const removeVariantRecord = React.useCallback((productId: string, variantId: string, stageKey: string, arrayKey: string, recId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const variants = (p.variants || []).map(v => {
        if (v.id !== variantId) return v;
        const s   = v.stages?.[stageKey] || {};
        const arr = (s[arrayKey] || []).filter((r: any) => r.id !== recId);
        return { ...v, stages: { ...v.stages, [stageKey]: { ...s, [arrayKey]: arr } } };
      });
      return { ...p, variants };
    }));
  }, []);

  const addBatchItem = React.useCallback((productId: string, batchId: string, item: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, items: [...(b.items || []), { id: uid(), ...item }] };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const updateBatchItem = React.useCallback((productId: string, batchId: string, itemId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, items: (b.items || []).map((i: any) => i.id === itemId ? { ...i, ...patch } : i) };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const removeBatchItem = React.useCallback((productId: string, batchId: string, itemId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, items: (b.items || []).filter((i: any) => i.id !== itemId) };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const addBatchExtra = React.useCallback((productId: string, batchId: string, item: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, extraCosts: [...(b.extraCosts || []), { id: uid(), ...item }] };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const updateBatchExtra = React.useCallback((productId: string, batchId: string, itemId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, extraCosts: (b.extraCosts || []).map((c: any) => c.id === itemId ? { ...c, ...patch } : c) };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const removeBatchExtra = React.useCallback((productId: string, batchId: string, itemId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, extraCosts: (b.extraCosts || []).filter((c: any) => c.id !== itemId) };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const addBatchShipment = React.useCallback((productId: string, batchId: string, data: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, shipments: [...(b.shipments || []), { id: uid(), status: 'idle', ...data }] };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const updateBatchShipment = React.useCallback((productId: string, batchId: string, shipmentId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, shipments: (b.shipments || []).map((s: any) => s.id === shipmentId ? { ...s, ...patch } : s) };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const removeBatchShipment = React.useCallback((productId: string, batchId: string, shipmentId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const batches = (p.stages?.production?.batches || []).map((b: any) => {
        if (b.id !== batchId) return b;
        return { ...b, shipments: (b.shipments || []).filter((s: any) => s.id !== shipmentId) };
      });
      return { ...p, stages: { ...p.stages, production: { ...p.stages.production, batches } } };
    }));
  }, []);

  const addShipmentItem = React.useCallback((productId: string, recordId: string, item: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.shipment?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        return { ...r, items: [...(r.items || []), { id: uid(), ...item }] };
      });
      return { ...p, stages: { ...p.stages, shipment: { ...p.stages.shipment, records } } };
    }));
  }, []);

  const updateShipmentItem = React.useCallback((productId: string, recordId: string, itemId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.shipment?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        return { ...r, items: (r.items || []).map((i: any) => i.id === itemId ? { ...i, ...patch } : i) };
      });
      return { ...p, stages: { ...p.stages, shipment: { ...p.stages.shipment, records } } };
    }));
  }, []);

  const removeShipmentItem = React.useCallback((productId: string, recordId: string, itemId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.shipment?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        return { ...r, items: (r.items || []).filter((i: any) => i.id !== itemId) };
      });
      return { ...p, stages: { ...p.stages, shipment: { ...p.stages.shipment, records } } };
    }));
  }, []);

  const addReorderItem = React.useCallback((productId: string, recordId: string, item: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.reorder?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        return { ...r, items: [...(r.items || []), { id: uid(), ...item }] };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records } } };
    }));
  }, []);

  const updateReorderItem = React.useCallback((productId: string, recordId: string, itemId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.reorder?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        return { ...r, items: (r.items || []).map((i: any) => i.id === itemId ? { ...i, ...patch } : i) };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records } } };
    }));
  }, []);

  const removeReorderItem = React.useCallback((productId: string, recordId: string, itemId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.reorder?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        return { ...r, items: (r.items || []).filter((i: any) => i.id !== itemId) };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records } } };
    }));
  }, []);

  const addSubShipmentItem = React.useCallback((productId: string, recordId: string, ssId: string, item: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.reorder?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        const ss = (r.subShipments || []).map((s: any) => {
          if (s.id !== ssId) return s;
          return { ...s, items: [...(s.items || []), { id: uid(), ...item }] };
        });
        return { ...r, subShipments: ss };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records } } };
    }));
  }, []);

  const updateSubShipmentItem = React.useCallback((productId: string, recordId: string, ssId: string, itemId: string, patch: any) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.reorder?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        const ss = (r.subShipments || []).map((s: any) => {
          if (s.id !== ssId) return s;
          return { ...s, items: (s.items || []).map((i: any) => i.id === itemId ? { ...i, ...patch } : i) };
        });
        return { ...r, subShipments: ss };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records } } };
    }));
  }, []);

  const removeSubShipmentItem = React.useCallback((productId: string, recordId: string, ssId: string, itemId: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      const records = (p.stages?.reorder?.records || []).map((r: any) => {
        if (r.id !== recordId) return r;
        const ss = (r.subShipments || []).map((s: any) => {
          if (s.id !== ssId) return s;
          return { ...s, items: (s.items || []).filter((i: any) => i.id !== itemId) };
        });
        return { ...r, subShipments: ss };
      });
      return { ...p, stages: { ...p.stages, reorder: { ...p.stages.reorder, records } } };
    }));
  }, []);

  const value = React.useMemo(() => ({
    products, setProducts, update, updateStage, updateRecord, addRecord, removeRecord,
    updateSubShipment, addSubShipment, removeSubShipment, addLog, updateLog, removeLog,
    savedAt, resetToDefaults, exportJSON, importJSON, exportProduct,
    createProduct, removeProduct, duplicateProduct,
    syncMode, syncStatus, syncVersion: versionRef.current,
    needLogin, currentUser, login, logout,
    addVariant, updateVariant, updateVariantStage, removeVariant,
    addVariantRecord, updateVariantRecord, removeVariantRecord,
    addBatchItem, updateBatchItem, removeBatchItem,
    addBatchExtra, updateBatchExtra, removeBatchExtra,
    addBatchShipment, updateBatchShipment, removeBatchShipment,
    addShipmentItem, updateShipmentItem, removeShipmentItem,
    addReorderItem, updateReorderItem, removeReorderItem,
    addSubShipmentItem, updateSubShipmentItem, removeSubShipmentItem,
  }), [products, update, updateStage, updateRecord, addRecord, removeRecord,
    updateSubShipment, addSubShipment, removeSubShipment, addLog, updateLog, removeLog,
    savedAt, resetToDefaults, exportJSON, importJSON, exportProduct,
    createProduct, removeProduct, duplicateProduct,
    syncMode, syncStatus, needLogin, currentUser, login, logout,
    addVariant, updateVariant, updateVariantStage, removeVariant,
    addVariantRecord, updateVariantRecord, removeVariantRecord,
    addBatchItem, updateBatchItem, removeBatchItem,
    addBatchExtra, updateBatchExtra, removeBatchExtra,
    addBatchShipment, updateBatchShipment, removeBatchShipment,
    addShipmentItem, updateShipmentItem, removeShipmentItem,
    addReorderItem, updateReorderItem, removeReorderItem,
    addSubShipmentItem, updateSubShipmentItem, removeSubShipmentItem,
  ]);

  return <ProductCtx.Provider value={value}>{children}</ProductCtx.Provider>;
}
