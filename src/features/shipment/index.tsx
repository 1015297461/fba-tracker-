/**
 * 货件跟踪（由独立项目 shipment-tracker 迁移）
 *
 * 原项目是原生 JS + innerHTML 模板；这里重写为 React，但**业务规则一字未改**：
 * - shipKind / detectStore / classify 的判定顺序与阈值
 * - generateSummary 的「按渠道分组 → 按 LCL 聚合」算法
 * - 表单字段顺序（物流进度 / 报关财务两段）
 *
 * 接口：/api/shipment/*（camelCase，与后端一致）
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

// ---------------------------------------------------------------- 常量

type Row = Record<string, any>;

const FIELDS: { section?: string; key?: string; label?: string; type?: string; req?: boolean; textarea?: boolean; rows?: number }[] = [
  { section: '物流进度' },
  { key: 'shipmentId', label: 'FBA货件号' },
  { key: 'orderNo', label: 'LCL单号' },
  { key: 'channel', label: '渠道' },
  { key: 'progress', label: '当前进度' },
  { key: 'shipDate', label: '发货时间', type: 'date' },
  { key: 'etaDate', label: '预计送达时间', type: 'date', req: true },
  { key: 'forwarderEta', label: '货代预计送达时间', type: 'date' },
  { key: 'actualDate', label: '实际送达/入库', type: 'date' },
  { key: 'trackingNo', label: '追踪编号' },
  { key: 'warehouse', label: '仓库' },
  { key: 'site', label: '站点' },
  { key: 'store', label: '店铺' },
  { key: 'product', label: '产品', textarea: true, rows: 4 },
  { section: '报关/财务资料' },
  { key: 'supplier', label: '厂家' },
  { key: 'declarationName', label: '品名' },
  { key: 'invoiceName', label: '开票名称' },
  { key: 'msku', label: 'MSKU' },
  { key: 'fnsku', label: 'FNSKU' },
  { key: 'categoryEn', label: '产品英文类别' },
  { key: 'categoryCn', label: '产品中文类别' },
  { key: 'material', label: '材质含量' },
  { key: 'invoiceUnit', label: '开票单位' },
  { key: 'length', label: '长(cm)' },
  { key: 'width', label: '宽(cm)' },
  { key: 'height', label: '高(cm)' },
  { key: 'volume', label: '体积(长*宽*高)' },
  { key: 'singleBoxWeight', label: '单箱重量(kg)' },
  { key: 'totalWeight', label: '总重量(kg)' },
  { key: 'totalVolume', label: '总体积(m³)' },
  { key: 'qtyPerBox', label: '每箱数量' },
  { key: 'boxCount', label: '箱子总数' },
  { key: 'totalQty', label: '数量总计' },
  { key: 'boxNo', label: '箱子号' },
  { key: 'taxCompany', label: '退税公司' },
  { key: 'taxType', label: '退税/买单' },
  { key: 'taxRate', label: '税点' },
  { key: 'specialInvoice', label: '能否开专票' },
  { key: 'note', label: '备注', textarea: true },
];

const PRODUCT_FIELDS: { key: string; label: string; req?: boolean }[] = [
  { key: 'product', label: '产品', req: true },
  { key: 'msku', label: 'msku' },
  { key: 'categoryEn', label: '产品英文类别' },
  { key: 'categoryCn', label: '产品中文类别' },
  { key: 'qtyPerBox', label: '每箱商品数量' },
  { key: 'singleBoxWeight', label: '单箱重量(kg)' },
  { key: 'length', label: '长(cm)' },
  { key: 'width', label: '宽(cm)' },
  { key: 'height', label: '高(cm)' },
  { key: 'volume', label: '体积(长×宽×高)' },
  { key: 'supplier', label: '厂家' },
  { key: 'fnsku', label: 'FNSKU' },
];

const BADGE: Record<string, [string, string]> = {
  overdue: ['逾期', 'bad'],
  thisweek: ['本周到货', 'warn'],
  upcoming: ['近期到货', 'info'],
  checkup: ['下周到货', 'mute'],
  awd: ['卫星仓', 'awd'],
  walmart: ['沃尔玛', 'wm'],
  future: ['在途', 'info'],
  done: ['已入库', 'ok'],
  cancel: ['已取消', 'mute'],
  none: ['无日期', 'mute'],
};

const CHANNEL_CLASS: Record<string, string> = {
  '普船': 'ch-regular', '加班': 'ch-overtime', '正班': 'ch-scheduled', '空派': 'ch-air',
};

const TRANSIT: Record<string, number> = { '普船': 45, '加班': 38, '正班': 36, '空派': 14 };

const DASHBOARD_SECTIONS = [
  { key: 'overdue', label: '逾期未入库' },
  { key: 'thisweek', label: '本周到货' },
  { key: 'upcoming', label: '未来 7 天' },
  { key: 'checkup', label: '下周（核对货代）' },
  { key: 'future', label: '在途' },
  { key: 'awd', label: '卫星仓' },
  { key: 'walmart', label: '沃尔玛' },
  { key: 'done', label: '已入库' },
  { key: 'none', label: '未填预计送达' },
  { key: 'cancel', label: '已取消' },
] as const;
// 默认折叠的分区（预警类展开，其余折叠 —— 否则 84 张卡片会淹没预警）
const DEFAULT_COLLAPSED_SECTIONS = ['future', 'awd', 'walmart', 'done', 'none', 'cancel'];

// KPI 卡片 → classify 的 key（'' = 全部）；点击即筛选
const KPI_DEFS = [
  { key: '', label: '全部货件', cls: '' },
  { key: 'overdue', label: '逾期未入库', cls: 'ss-kpi-bad' },
  { key: 'thisweek', label: '本周到货', cls: 'ss-kpi-warn' },
  { key: 'upcoming', label: '未来 7 天', cls: '' },
  { key: 'checkup', label: '下周核对', cls: '' },
  { key: 'future', label: '在途', cls: '' },
  { key: 'done', label: '已入库', cls: 'ss-kpi-ok' },
] as const;
const KPI_LABEL: Record<string, string> = Object.fromEntries(
  KPI_DEFS.filter(k => k.key).map(k => [k.key, k.label]));
// 非看板分区（在途/已入库/无日期）单独筛选时的标题
const STATUS_LABEL: Record<string, string> = {
  ...KPI_LABEL, none: '未填预计送达时间', future: '在途（14 天以后）',
  awd: '卫星仓', walmart: '沃尔玛', cancel: '已取消',
};

// ---------------------------------------------------------------- 日期与分类工具

const parseDate = (s?: string): Date | null => {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
};
const today = (): Date => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sundayOf = (d: Date): Date => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); return x; };
const fmtD = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const diffDays = (a: Date, b: Date): number => Math.round((a.getTime() - b.getTime()) / 86400000);

// 货件类型：FBA / AL0(卫星仓AWD) / 沃尔玛等；非 FBA 不跟踪到货时间
function shipKind(s: Row): 'fba' | 'awd' | 'walmart' {
  const id = String(s.shipmentId || '');
  if (!id) return 'fba';
  if (/^FBA/i.test(id)) return 'fba';
  if (/^AL0/i.test(id)) return 'awd';
  return 'walmart';
}

// 店铺归属：钻石画 → 宁熙，其它 FBA → 谛听
function detectStore(s: Row): string {
  if (!/^FBA/i.test(String(s.shipmentId || ''))) return '';
  return /钻石画/.test(String(s.product || '')) ? '宁熙' : '谛听';
}

// 状态分类（判定顺序即优先级，勿改）
function classify(s: Row): string {
  if (s.cancelled) return 'cancel';
  const kind = shipKind(s);
  if (kind === 'awd') return 'awd';
  if (kind === 'walmart') return 'walmart';
  if (s.actualDate) return 'done';
  if (!s.etaDate) return 'none';
  const eta = parseDate(s.etaDate);
  const t = today();
  if (!eta) return 'none';
  const end = parseDate(s.etaEndDate) || eta;   // 送达是一个区间，逾期按结束日判断
  if (diffDays(end, t) < 0) return 'overdue';
  const diff = diffDays(eta, t);
  if (eta <= addDays(sundayOf(t), 6)) return 'thisweek';
  if (diff <= 6) return 'upcoming';
  if (diff <= 13) return 'checkup';
  return 'future';
}

function etaRange(s: Row): string {
  if (!s.etaDate) return '';
  if (!s.etaEndDate || s.etaEndDate === s.etaDate) return fmtShort(s.etaDate);
  return `${fmtShort(s.etaDate)} ~ ${fmtShort(s.etaEndDate)}`;
}
function fmtShort(d?: string): string {
  const x = parseDate(d);
  return x ? `${x.getMonth() + 1}/${x.getDate()}` : '';
}
// 2026-10-25 → 2026.10.25（发货日期带年；月日补零，列表左对齐等宽更整齐）
function fmtShipDate(d?: string): string {
  const m = String(d || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return String(d || '');
  return `${m[1]}.${String(m[2]).padStart(2, '0')}.${String(m[3]).padStart(2, '0')}`;
}
const num = (n: any): number => Number((Number(n) || 0).toFixed(2));

// 实际送达天数 = 实收日期 − 发货日期（自然日）。缺任一日期返回 null。
function deliverDays(s: Row): number | null {
  const a = parseDate(s.shipDate);
  const b = parseDate(s.actualDate);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// 已用时间 = 今天 − 发货日期（自然日）。只对「还没入库」的货件有意义。
function elapsedDays(s: Row): number | null {
  const a = parseDate(s.shipDate);
  if (!a) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);        // 只比日期，避免当天因时分秒差出 1 天
  return Math.round((t.getTime() - a.getTime()) / 86400000);
}

// 某月按渠道统计：票数 + 平均送达天数
function channelStats(list: Row[]): Array<{ ch: string; n: number; avg: number }> {
  const map = new Map<string, number[]>();
  for (const s of list) {
    const d = deliverDays(s);
    if (d === null) continue;
    const ch = s.channel || '未填渠道';
    if (!map.has(ch)) map.set(ch, []);
    map.get(ch)!.push(d);
  }
  return [...map.entries()]
    .map(([ch, ds]) => ({ ch, n: ds.length, avg: ds.reduce((a, b) => a + b, 0) / ds.length }))
    .sort((a, b) => b.n - a.n);
}

// 按发货时间生成汇总文字（按渠道分组，按 LCL 聚合）—— 与原 generateSummary 一致
function generateSummary(list: Row[], shipDate: string): string {
  const rows = list.filter(s => !s.cancelled && s.shipDate === shipDate && shipKind(s) === 'fba');
  if (!rows.length) return '';
  const order: string[] = [];
  const byCh: Record<string, Row[]> = {};
  for (const s of rows) {
    const ch = s.channel || '未填渠道';
    if (!byCh[ch]) { byCh[ch] = []; order.push(ch); }
    byCh[ch].push(s);
  }
  const lines: string[] = [];
  for (const ch of order) {
    const lclOrder: string[] = [];
    const byLcl: Record<string, { s: Row; box: number; vol: number; wt: number }> = {};
    for (const s of byCh[ch]) {
      const k = s.orderNo || '无LCL';
      if (!byLcl[k]) { byLcl[k] = { s, box: 0, vol: 0, wt: 0 }; lclOrder.push(k); }
      byLcl[k].box += Number(s.boxCount) || 0;
      byLcl[k].vol += Number(s.totalVolume) || 0;
      byLcl[k].wt += Number(s.totalWeight) || 0;
    }
    for (const k of lclOrder) {
      const g = byLcl[k];
      const rawCh = g.s.channel || '';
      // channel 可能是完整 'dtXXX普船退税'，也可能是短 '普船'
      const dt = rawCh.startsWith('dt') ? rawCh : 'dt' + (g.s.warehouse || '') + rawCh + (g.s.taxType || '');
      lines.push(`${dt}，${num(g.box)}箱，${num(g.vol)}方，${num(g.wt)}kg——${k}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- API

const AUTH_TOKEN_KEY = 'fba-auth-v1';
const authHeaders = (): Record<string, string> => {
  const t = localStorage.getItem(AUTH_TOKEN_KEY) || '';
  return t ? { Authorization: 'Bearer ' + t } : {};
};
async function api(path: string, opts: { method?: string; body?: any } = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ---------------------------------------------------------------- 主组件

export function ShipmentTracker() {
  const [tab, setTab] = useState<'dashboard' | 'products'>('dashboard');
  const [ships, setShips] = useState<Row[]>([]);
  const [products, setProducts] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Row | null>(null);
  const [editingProduct, setEditingProduct] = useState<Row | null>(null);
  const [summaryDate, setSummaryDate] = useState<string>('');
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 视图：状态看板 / 按发货时间（对齐原项目左侧「🚚 按发货时间」）
  const [viewMode, setViewMode] = useState<'status' | 'byDate'>('status');
  // KPI 点击筛选：'' = 全部，其余为 classify 的 key
  const [statusFilter, setStatusFilter] = useState<string>('');
  // 按发货时间视图当前选中的发货日期（'' 表示未填发货时间那组）
  const [activeDate, setActiveDate] = useState<string>('');
  // 按发货时间视图里折叠的产品分组
  const [collapsedProducts, setCollapsedProducts] = useState<Set<string>>(new Set());
  // 状态视图中折叠的分区（默认只展开预警类）
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set(DEFAULT_COLLAPSED_SECTIONS));
  // 发货汇总的可编辑文本（按发货日期缓存）
  const [summaryEdits, setSummaryEdits] = useState<Record<string, string>>({});
  const importRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<any[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const [a, b] = await Promise.all([
        api('/api/shipment/shipments'),
        api('/api/shipment/products'),
      ]);
      setShips(a.shipments || []);
      setProducts(b.products || []);
    } catch (e: any) {
      setErr(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2600); };

  // 搜索过滤（货件号/产品/单号/厂家/仓库）
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return ships;
    return ships.filter(s =>
      ['shipmentId', 'product', 'orderNo', 'supplier', 'warehouse', 'trackingNo', 'progress']
        .some(k => String(s[k] || '').toLowerCase().includes(kw)));
  }, [ships, q]);

  // 看板分区
  const groups = useMemo(() => {
    const g: Record<string, Row[]> = {};
    for (const s of filtered) {
      const c = classify(s);
      (g[c] ||= []).push(s);
    }
    for (const k of Object.keys(g)) {
      g[k].sort((a, b) => String(a.etaDate || '9999').localeCompare(String(b.etaDate || '9999')));
    }
    return g;
  }, [filtered]);

  const counts = useMemo(() => {
    const n = (k: string) => (groups[k] || []).length;
    return {
      total: filtered.length,
      overdue: n('overdue'),
      thisweek: n('thisweek'),
      upcoming: n('upcoming'),
      checkup: n('checkup'),
      future: n('future'),
      done: n('done'),
      none: n('none'),
    };
  }, [filtered, groups]);

  // 按发货时间分组（对齐原 groupByShip：排除已取消、日期倒序、未填排最后）
  const byShipDate = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const s of ships) {
      if (s.cancelled) continue;
      const k = s.shipDate || '';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(s);
    }
    const order = [...map.keys()].sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a < b ? 1 : -1;
    });
    return { map, order };
  }, [ships]);

  // 切到「按发货时间」时，若当前选中日期失效则落到第一个
  useEffect(() => {
    if (viewMode !== 'byDate') return;
    const { order } = byShipDate;
    if (order.length && !order.includes(activeDate)) setActiveDate(order[0]);
  }, [viewMode, byShipDate, activeDate]);

  // 当前要展示的货件（状态视图受 KPI 筛选影响）
  const visible = useMemo(() => {
    if (!statusFilter) return filtered;
    return filtered.filter(s => classify(s) === statusFilter);
  }, [filtered, statusFilter]);

  // 渲染用分组（基于 visible，这样筛选后分区标题与数量一致）
  const visibleGroups = useMemo(() => {
    const g: Record<string, Row[]> = {};
    for (const s of visible) (g[classify(s)] ||= []).push(s);
    for (const k of Object.keys(g)) {
      g[k].sort((a, b) => String(a.etaDate || '9999').localeCompare(String(b.etaDate || '9999')));
    }
    return g;
  }, [visible]);

  // ---- 操作 ----
  const saveShipment = async (data: Row) => {
    setBusy(true);
    try {
      if (data.id) await api('/api/shipment/shipments', { method: 'PUT', body: data });
      else await api('/api/shipment/shipments', { method: 'POST', body: data });
      setEditing(null);
      flash('已保存');
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const removeShipment = async (id: string) => {
    if (!confirm('确定删除这条货件？')) return;
    setBusy(true);
    try {
      await api(`/api/shipment/shipments?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      flash('已删除');
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const runAutoEta = async () => {
    setBusy(true);
    try {
      const r = await api('/api/shipment/shipments/auto-calc-eta', { method: 'POST', body: {} });
      flash(`自动算 ETA：更新 ${r.updated} 条，跳过 ${r.skipped} 条`);
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const batchEta = async (ids?: string[]) => {
    const target = ids || [...selected];
    if (!target.length) return;
    const etaDate = prompt('预计送达时间（YYYY-MM-DD，留空则清空）', '');
    if (etaDate === null) return;
    setBusy(true);
    try {
      const r = await api('/api/shipment/shipments/batch-update', {
        method: 'POST',
        body: { ids: target, etaDate, etaEndDate: etaDate },
      });
      flash(`批量更新 ${r.updated} 条`);
      setSelected(new Set());
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const saveProduct = async (data: Row) => {
    setBusy(true);
    try {
      if (data.id) await api('/api/shipment/products', { method: 'PUT', body: data });
      else await api('/api/shipment/products', { method: 'POST', body: data });
      setEditingProduct(null);
      flash('已保存');
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const removeProduct = async (id: string) => {
    if (!confirm('确定删除这个产品？')) return;
    setBusy(true);
    try {
      await api(`/api/shipment/products?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      flash('已删除');
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  // Excel 导入：上传 → 后端转 TSV → 前端解析预览 → 确认导入
  const onPickFile = async (f: File | null) => {
    if (!f) return;
    setBusy(true); setErr('');
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsDataURL(f);
      });
      const r = await api('/api/shipment/import/xlsx', { method: 'POST', body: { data: b64 } });
      const sheets: { name: string; text: string }[] = r.sheets || [];
      // 取第一个非空 sheet，按表头映射列 → 货件字段
      const sh = sheets.find(s => s.text.trim()) || sheets[0];
      if (!sh) throw new Error('工作簿里没有数据');
      const rows = sh.text.split('\n').map(l => l.split('\t'));
      if (rows.length < 2) throw new Error('表格至少需要表头 + 1 行数据');
      const head = rows[0].map(h => String(h || '').trim());
      const map: Record<string, string> = {
        '发货时间': 'shipDate', '货件号': 'shipmentId', '厂家': 'supplier', '产品': 'product',
        '仓库': 'warehouse', '长': 'length', '宽': 'width', '高': 'height',
        '总重': 'totalWeight', '数量': 'totalQty', '预计到货': 'etaDate', '实际送达': 'actualDate',
      };
      const preview = rows.slice(1).filter(r => r.some(c => String(c).trim())).map(r => {
        const o: Row = {};
        head.forEach((h, i) => {
          const k = map[h];
          if (k) o[k] = String(r[i] ?? '').trim();
        });
        return o;
      }).filter(o => o.shipmentId);
      if (!preview.length) throw new Error('没解析出有效行（需要「货件号」列）');
      setImportPreview(preview);
    } catch (e: any) {
      setErr('导入失败：' + (e.message || '未知错误'));
    } finally { setBusy(false); }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setBusy(true);
    try {
      const r = await api('/api/shipment/shipments/import', { method: 'POST', body: { items: importPreview } });
      flash(`导入完成：新增 ${r.added}，重复 ${r.duplicated}，跳过 ${r.skipped}`);
      setImportPreview(null);
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  // ---- 渲染 ----
  const toggleSel = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  return (
    <div className="ss-wrap" data-viewmode={tab === 'dashboard' ? viewMode : 'products'}>
      <div className="ss-topbar">
        <div className="ss-tabs">
          <button type="button" className="ss-tab" data-active={tab === 'dashboard'} onClick={() => setTab('dashboard')}>
            货件看板 <span className="ss-tab-n">{ships.length}</span>
          </button>
          <button type="button" className="ss-tab" data-active={tab === 'products'} onClick={() => setTab('products')}>
            产品库 <span className="ss-tab-n">{products.length}</span>
          </button>
        </div>
        <div className="ss-actions">
          <div className="ss-search-wrap">
            <input className="ss-search" placeholder="搜索货件号 / 产品 / LCL / 厂家…" value={q}
              onChange={e => setQ(e.target.value)} />
            {q && (
              <button type="button" className="ss-search-x" title="清空搜索"
                onClick={() => setQ('')}>✕</button>
            )}
          </div>
          {selected.size > 0 && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => batchEta()}>
              批量改送达（{selected.size}）
            </button>
          )}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={runAutoEta} title="按渠道时效推算，只填空缺">
            自动算 ETA
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => importRef.current?.click()}>
            导入 Excel
          </button>
          <input ref={importRef} type="file" accept=".xlsx,.xls" hidden
            onChange={e => { onPickFile(e.target.files?.[0] || null); e.target.value = ''; }} />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setEditing({})}>
            + 新增货件
          </button>
        </div>
      </div>

      {err && <div className="ss-alert ss-alert-err" onClick={() => setErr('')}>{err}（点击关闭）</div>}
      {msg && <div className="ss-alert ss-alert-ok">{msg}</div>}

      {importPreview && (
        <div className="ss-import-panel">
          <div className="ss-import-head">
            <strong>导入预览</strong>
            <span>解析到 {importPreview.length} 条（按「货件号+产品+发货时间+仓库」去重）</span>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={confirmImport}>确认导入</button>
            <button type="button" className="btn btn-sm" onClick={() => setImportPreview(null)}>取消</button>
          </div>
          <div className="ss-import-body">
            <table className="ss-table">
              <thead>
                <tr><th>货件号</th><th>产品</th><th>发货</th><th>仓库</th><th>数量</th><th>预计到货</th></tr>
              </thead>
              <tbody>
                {importPreview.slice(0, 30).map((r, i) => (
                  <tr key={i}>
                    <td>{r.shipmentId}</td><td>{r.product || '—'}</td><td>{r.shipDate || '—'}</td>
                    <td>{r.warehouse || '—'}</td><td>{r.totalQty || '—'}</td><td>{r.etaDate || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {loading ? (
        <div className="ss-empty">加载中…</div>
      ) : tab === 'dashboard' ? (
        <>
          {/* 视图切换：状态看板 / 按发货时间（对齐原项目左侧导航的两种维度） */}
          <div className="ss-viewbar">
            <div className="ss-seg">
              <button type="button" className="ss-seg-btn" data-active={viewMode === 'status'}
                onClick={() => setViewMode('status')}>状态看板</button>
              <button type="button" className="ss-seg-btn" data-active={viewMode === 'byDate'}
                onClick={() => setViewMode('byDate')}>按发货时间</button>
            </div>
            {viewMode === 'status' && statusFilter && (
              <button type="button" className="ss-clear" onClick={() => setStatusFilter('')}>
                筛选：{STATUS_LABEL[statusFilter] || statusFilter} ✕
              </button>
            )}
            <span className="ss-spacer" />
            <span className="ss-hint">
              {q.trim() ? `搜索命中 ${filtered.length} / ${ships.length} 票` : `共 ${ships.length} 票`}
            </span>
          </div>

          {/* KPI 卡片：点击筛选（再点一次取消） */}
          <div className="ss-kpis">
            {KPI_DEFS.map(k => (
              <button key={k.key || 'all'} type="button"
                className={`ss-kpi ${k.cls}`}
                data-active={viewMode === 'status' && statusFilter === k.key}
                onClick={() => {
                  setViewMode('status');
                  setStatusFilter(prev => (prev === k.key ? '' : k.key));
                }}
                title={k.key ? `只看「${k.label}」` : '显示全部货件'}>
                <b>{(counts as any)[k.key || 'total']}</b><span>{k.label}</span>
              </button>
            ))}
          </div>

          {viewMode === 'status' ? (
            <>
              {(statusFilter
                ? [{ key: statusFilter, label: STATUS_LABEL[statusFilter] || statusFilter }]
                : DASHBOARD_SECTIONS
              ).map(sec => {
                const rows = visibleGroups[sec.key] || [];
                if (!rows.length) return null;
                // 筛选某一类时强制展开；否则按用户折叠状态
                const folded = !statusFilter && collapsedSections.has(sec.key);
                return (
                  <section key={sec.key} className="ss-section">
                    <div className="ss-section-head ss-section-toggle"
                      onClick={() => setCollapsedSections(prev => {
                        const n = new Set(prev);
                        n.has(sec.key) ? n.delete(sec.key) : n.add(sec.key);
                        return n;
                      })}>
                      <span className="ss-sec-arrow">{folded ? '▸' : '▾'}</span>
                      <h4>{sec.label}</h4>
                      <span className="ss-section-n">{rows.length} 票</span>
                    </div>
                    {!folded && (
                      <>
                        {/* 筛选某个状态时，卡片上方给一张汇总表（可复制 FBA/LCL 号发给货代） */}
                        {statusFilter && sec.key !== 'done' && <CategorySummary rows={rows} />}
                        {sec.key === 'done' ? (
                          <DoneMonthly rows={rows} selected={selected}
                            onSel={toggleSel}
                            onEdit={s => setEditing({ ...s })}
                            onDelete={id => removeShipment(id)} />
                        ) : (
                          <div className="ss-cards">
                            {rows.map(s => (
                              <ShipCard key={s.id} s={s} selected={selected.has(s.id)}
                                onSel={() => toggleSel(s.id)}
                                onEdit={() => setEditing({ ...s })}
                                onDelete={() => removeShipment(s.id)} />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </section>
                );
              })}
              {!visible.length && (statusFilter || q.trim()) && (
                <div className="ss-empty">没有符合条件的货件</div>
              )}
            </>
          ) : (
            <ByDateView
              order={byShipDate.order}
              map={byShipDate.map}
              activeDate={activeDate}
              onPickDate={setActiveDate}
              selected={selected}
              onSel={toggleSel}
              onEdit={s => setEditing({ ...s })}
              onDelete={id => removeShipment(id)}
              onBatchEta={ids => batchEta(ids)}
              ships={ships}
              collapsed={collapsedProducts}
              onToggleProduct={p => setCollapsedProducts(prev => {
                const n = new Set(prev);
                n.has(p) ? n.delete(p) : n.add(p);
                return n;
              })}
              summaryEdits={summaryEdits}
              onEditSummary={(d, v) => setSummaryEdits(prev => ({ ...prev, [d]: v }))}
              onResetSummary={d => setSummaryEdits(prev => {
                const n = { ...prev };
                delete n[d];
                return n;
              })}
            />
          )}

          {!ships.length && <div className="ss-empty">还没有货件，点右上角「+ 新增货件」或「导入 Excel」</div>}
        </>
      ) : (
        <ProductsView products={products} onEdit={p => setEditingProduct({ ...p })}
          onNew={() => setEditingProduct({})} onDelete={removeProduct} busy={busy} />
      )}

      {editing && (
        <ShipmentForm initial={editing} busy={busy} onCancel={() => setEditing(null)} onSave={saveShipment}
          summaryText={editing.shipDate ? generateSummary(ships, editing.shipDate) : ''} />
      )}
      {editingProduct && (
        <ProductForm initial={editingProduct} busy={busy} onCancel={() => setEditingProduct(null)} onSave={saveProduct} />
      )}

      {summaryOpen && (
        <div className="modal-backdrop" onClick={() => setSummaryOpen(false)}>
          <div className="modal ss-modal" onClick={e => e.stopPropagation()}>
            <div className="ss-modal-head"><strong>发货汇总</strong>
              <button className="btn btn-sm" onClick={() => setSummaryOpen(false)}>关闭</button></div>
            <pre className="ss-summary-pre">{summaryDate ? generateSummary(ships, summaryDate) : ''}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 状态汇总表

/** 筛选某个状态时，在卡片上方列出该组货件的汇总表（对齐原项目 categorySummary）。 */
function CategorySummary({ rows }: { rows: Row[] }) {
  const [copied, setCopied] = useState('');
  // 与原项目一致：按发货日期倒序
  const sorted = [...rows].sort((a, b) =>
    String(b.shipDate || '').localeCompare(String(a.shipDate || '')));
  const fbaList = [...new Set(sorted.map(s => s.shipmentId).filter(Boolean))] as string[];
  const lclList = [...new Set(sorted.map(s => s.orderNo).filter(Boolean))] as string[];

  const copy = async (text: string, tag: string) => {
    let ok = false;
    // 局域网 http 不是安全上下文 → navigator.clipboard 不可用，用隐藏 textarea 兜底
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    setCopied(ok ? tag : '复制失败，请手动选中');
    setTimeout(() => setCopied(''), ok ? 1500 : 2400);
  };

  return (
    <div className="ss-sumbox">
      <div className="ss-sumhead">
        <span>📋 汇总</span>
        <span className="ss-spacer" />
        {copied && (
          <span className="ss-copied">
            {copied === 'fba' ? '已复制 FBA 号' : copied === 'lcl' ? '已复制 LCL 号' : copied}
          </span>
        )}
        <span className="ss-sum-n">{rows.length} 票</span>
        <button type="button" className="btn btn-sm" disabled={!fbaList.length}
          onClick={() => copy(fbaList.join('\n'), 'fba')}>复制 FBA 号</button>
        <button type="button" className="btn btn-sm" disabled={!lclList.length}
          onClick={() => copy(lclList.join('\n'), 'lcl')}>复制 LCL 号</button>
      </div>
      <div className="ss-sumtable-wrap">
        <table className="ss-sumtable">
          <thead>
            <tr>
              <th>FBA 号</th>
              <th>LCL 号</th>
              <th>发货日期</th>
              <th>产品</th>
              <th>当前状态</th>
              <th>预计送达</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(s => (
              <tr key={s.id}>
                <td className="ss-mono">{s.shipmentId || '—'}</td>
                <td className="ss-mono">{s.orderNo || '—'}</td>
                <td>{s.shipDate ? fmtShipDate(s.shipDate) : '—'}</td>
                <td><span className="ss-sum-ell" title={s.product || ''}>{s.product || '—'}</span></td>
                <td><span className="ss-sum-ell" title={s.progress || ''}>{s.progress || '—'}</span></td>
                <td>{s.etaDate ? etaRange(s) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 已入库 · 月维度

/** 已入库按【发货月】折叠。月份行汇总：总票数 + 各渠道票数与平均送达天数 + 整体平均。 */
function DoneMonthly({ rows, selected, onSel, onEdit, onDelete }: {
  rows: Row[]; selected: Set<string>;
  onSel: (id: string) => void; onEdit: (s: Row) => void; onDelete: (id: string) => void;
}) {
  // 默认全部折叠：先看月度汇总，想看细节再点开
  const [open, setOpen] = useState<Set<string>>(new Set());

  const months = (() => {
    const map = new Map<string, Row[]>();
    for (const s of rows) {
      const m = String(s.shipDate || '').slice(0, 7) || '未填发货月';
      if (!map.has(m)) map.set(m, []);
      map.get(m)!.push(s);
    }
    return [...map.entries()]
      .map(([month, list]) => ({ month, list }))
      .sort((a, b) => {
        if (a.month === '未填发货月') return 1;
        if (b.month === '未填发货月') return -1;
        return a.month < b.month ? 1 : -1;
      });
  })();

  return (
    <div className="ss-months">
      {months.map(({ month, list }) => {
        const isOpen = open.has(month);
        const stats = channelStats(list);
        const allDays = list.map(deliverDays).filter((d): d is number => d !== null);
        const overall = allDays.length
          ? allDays.reduce((a, b) => a + b, 0) / allDays.length
          : null;
        return (
          <div key={month} className="ss-month">
            <button type="button" className="ss-month-head"
              onClick={() => setOpen(prev => {
                const n = new Set(prev);
                n.has(month) ? n.delete(month) : n.add(month);
                return n;
              })}>
              <span className="ss-month-arrow">{isOpen ? '▾' : '▸'}</span>
              <span className="ss-month-label">{month}</span>
              <span className="ss-month-n">{list.length} 票</span>
              <span className="ss-month-chs">
                {stats.map(st => (
                  <span key={st.ch} className="ss-month-ch">
                    {st.ch} <b>{st.n}</b> 票 · 均 <b>{st.avg.toFixed(1)}</b> 天
                  </span>
                ))}
              </span>
              {overall !== null && (
                <span className="ss-month-total">整体均 {overall.toFixed(1)} 天</span>
              )}
            </button>
            {isOpen && (
              <div className="ss-month-body">
                <div className="ss-cards">
                  {list.map(s => (
                    <ShipCard key={s.id} s={s} selected={selected.has(s.id)}
                      onSel={() => onSel(s.id)}
                      onEdit={() => onEdit(s)}
                      onDelete={() => onDelete(s.id)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- 按发货时间视图

function ByDateView({
  order, map, activeDate, onPickDate, selected, onSel, onEdit, onDelete,
  onBatchEta, ships, collapsed, onToggleProduct, summaryEdits, onEditSummary, onResetSummary,
}: {
  order: string[]; map: Map<string, Row[]>; activeDate: string;
  onPickDate: (d: string) => void;
  selected: Set<string>; onSel: (id: string) => void;
  onEdit: (s: Row) => void; onDelete: (id: string) => void;
  onBatchEta: (ids: string[]) => void;
  ships: Row[];
  collapsed: Set<string>; onToggleProduct: (p: string) => void;
  summaryEdits: Record<string, string>;
  onEditSummary: (d: string, v: string) => void;
  onResetSummary: (d: string) => void;
}) {
  const [copied, setCopied] = useState('');
  const list = map.get(activeDate) || [];

  // 按产品名分组（同产品多条，原项目用 project 名折叠）
  const prodGroups: Array<[string, Row[]]> = [];
  {
    const idx = new Map<string, Row[]>();
    for (const s of list) {
      const p = s.product || '（未填产品）';
      if (!idx.has(p)) { idx.set(p, []); prodGroups.push([p, idx.get(p)!]); }
      idx.get(p)!.push(s);
    }
    prodGroups.sort((a, b) => a[0].localeCompare(b[0]));
  }

  const summaryText = activeDate in summaryEdits
    ? summaryEdits[activeDate]
    : generateSummary(ships, activeDate);

  const fbaIds = list.filter(s => shipKind(s) === 'fba').map(s => s.id);

  const copy = async (text: string, tag: string) => {
    let ok = false;
    // 局域网 http 访问不是「安全上下文」，navigator.clipboard 不可用 → 用隐藏 textarea 兜底
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    setCopied(ok ? tag : '复制失败，请手动选中文本复制');
    setTimeout(() => setCopied(''), ok ? 1500 : 2400);
  };

  if (!order.length) return <div className="ss-empty">还没有可用的货件</div>;

  return (
    <div className="ss-bydate">
      <aside className="ss-datelist">
        <div className="ss-datelist-head">按发货时间</div>
        {order.map(d => {
          const n = (map.get(d) || []).length;
          return (
            <button key={d || '__none'} type="button" className="ss-dateitem"
              data-active={activeDate === d} onClick={() => onPickDate(d)}>
              <span className="ss-dateitem-d">{d ? fmtShipDate(d) : '未填发货时间'}</span>
              <span className="ss-dateitem-n">{n}</span>
            </button>
          );
        })}
      </aside>

      <div className="ss-bydate-main">
        {/* 发货汇总：默认按渠道/LCL 自动生成，可手改，可重新生成 */}
        <div className="ss-summary-box">
          <div className="ss-summary-head">
            <span>📋 发货汇总</span>
            <span className="ss-spacer" />
            {copied && <span className="ss-copied">{copied === 'ok' ? '已复制' : copied}</span>}
            <button type="button" className="btn btn-sm" onClick={() => onResetSummary(activeDate)}>
              重新生成
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => copy(summaryText, 'ok')}>
              复制
            </button>
          </div>
          <textarea className="ss-summary-text" rows={Math.min(10, Math.max(4, summaryText.split('\n').length + 1))}
            value={summaryText}
            placeholder="（该批次暂无 FBA 货件）"
            onChange={e => onEditSummary(activeDate, e.target.value)} />
        </div>

        <div className="ss-date-head">
          <h4>
            🚚 {activeDate ? fmtShipDate(activeDate) : '未填发货时间'}
            <span className="ss-section-n">{list.length} 票</span>
          </h4>
          {fbaIds.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => onBatchEta(fbaIds)}>
              整批改送达（{fbaIds.length}）
            </button>
          )}
        </div>

        {/* 产品分组：固定区域内滚动（汇总框与标题常驻可见） */}
        <div className="ss-prodlist">
          {prodGroups.map(([p, plist]) => {
            const isCollapsed = collapsed.has(p);
            const subFba = plist.filter(s => shipKind(s) === 'fba').map(s => s.id);
            return (
              <div key={p} className="ss-prodgroup" data-collapsed={isCollapsed}>
                <div className="ss-prodhead" onClick={() => onToggleProduct(p)}>
                  <span className="ss-prodhead-arrow">{isCollapsed ? '▸' : '▾'}</span>
                  <span className="ss-prodhead-name">{p}</span>
                  <span className="ss-prodhead-n">{plist.length}</span>
                  {subFba.length > 0 && (
                    <button type="button" className="btn btn-sm" onClick={e => { e.stopPropagation(); onBatchEta(subFba); }}>
                      改送达
                    </button>
                  )}
                </div>
                {!isCollapsed && (
                  <div className="ss-cards">
                    {plist.map(s => (
                      <ShipCard key={s.id} s={s} selected={selected.has(s.id)}
                        onSel={() => onSel(s.id)}
                        onEdit={() => onEdit(s)}
                        onDelete={() => onDelete(s.id)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {!list.length && <div className="ss-empty">该发货时间下没有货件</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 货件卡片

function ShipCard({ s, selected, onSel, onEdit, onDelete }: {
  s: Row; selected: boolean; onSel: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const cls = classify(s);
  const [txt, tone] = BADGE[cls] || BADGE.none;
  const chCls = CHANNEL_CLASS[s.channel] || '';
  const dDays = deliverDays(s);          // 实际送达天数（实收 − 发货），未入库为 null
  const eDays = dDays === null ? elapsedDays(s) : null;   // 未入库：已用时间（今天 − 发货）

  // 整卡可点打开编辑；但三件事必须让路：
  //   ① 正在卡片内拖选文字（用户想复制 FBA 号/LCL 号）→ 不弹窗
  //      注意要判断选区是否落在本卡片内，否则页面别处有残留选区时会误伤
  //   ② 点在 input/button/a/label 上 → 交给元素自己处理（复选框、编辑、删除）
  //   ③ 其余空白处 → 打开编辑
  const onCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (sel && sel.toString() && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return;
    const el = e.target as HTMLElement;
    if (el.closest('input, button, a, label, textarea, select')) return;
    onEdit();
  };

  return (
    <div className="ss-card" data-tone={tone} data-selected={selected} onClick={onCardClick}>
      <div className="ss-card-top">
        <input type="checkbox" checked={selected} onChange={onSel} title="勾选后可批量改送达" />
        <span className="ss-badge" data-tone={tone}>{txt}</span>
        {s.channel && <span className={`ss-chip ${chCls}`}>{s.channel}</span>}
        {s.store && <span className="ss-chip ss-chip-store">{s.store}</span>}
        <span className="ss-spacer" />
        <button type="button" className="ss-link" onClick={onEdit}>编辑</button>
        <button type="button" className="ss-link ss-link-danger" onClick={onDelete}>删除</button>
      </div>
      <div className="ss-card-title">{(s.product || '（未填产品）').slice(0, 80)}</div>
      <div className="ss-card-meta">
        <span className="ss-mono">{s.shipmentId || '—'}</span>
        {s.orderNo && <span className="ss-dim">LCL {s.orderNo}</span>}
      </div>
      <div className="ss-card-dates">
        <span>发货 {s.shipDate || '—'}</span>
        <span className="ss-arrow">→</span>
        <span className={cls === 'overdue' ? 'ss-bad' : ''}>{s.etaDate ? etaRange(s) : '未定'}</span>
        {s.actualDate && <span className="ss-ok">实收 {s.actualDate}</span>}
        {dDays !== null ? (
          <span className="ss-days">{dDays} 天</span>
        ) : eDays !== null ? (
          <span className="ss-days ss-days-running">已用 {eDays} 天</span>
        ) : null}
      </div>
      {s.progress && <div className="ss-card-progress">{s.progress}</div>}
      <div className="ss-card-foot">
        <span>{s.warehouse || '—'}</span>
        <span>{s.boxCount ? `${s.boxCount} 箱` : ''}</span>
        <span>{s.totalQty ? `${s.totalQty} 件` : ''}</span>
        <span>{s.totalWeight ? `${s.totalWeight} kg` : ''}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 货件表单

function ShipmentForm({ initial, busy, onCancel, onSave, summaryText }: {
  initial: Row; busy: boolean; onCancel: () => void; onSave: (d: Row) => void; summaryText: string;
}) {
  const [form, setForm] = useState<Row>({ ...initial });
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="ss-drawer-backdrop" onClick={onCancel}>
      <aside className="ss-drawer" onClick={e => e.stopPropagation()}>
        <div className="ss-drawer-head">
          <strong>{form.id ? '编辑货件' : '新增货件'}</strong>
          {form.shipmentId && <span className="ss-drawer-sub">{form.shipmentId}</span>}
          <span className="ss-spacer" />
          <button type="button" className="ss-drawer-x" title="关闭" onClick={onCancel}>✕</button>
        </div>
        <div className="ss-form-body">
          <label className="ss-check">
            <input type="checkbox" checked={!!form.cancelled}
              onChange={e => set('cancelled', e.target.checked)} /> 已取消（不参与提醒）
          </label>
          {FIELDS.map((f, i) => {
            if (f.section) {
              return <div key={'sec' + i} className="ss-form-section">{f.section}</div>;
            }
            const k = f.key as string;
            const val = form[k] ?? '';
            return (
              <label key={k} className="ss-field">
                <span>{f.label}{f.req && <em className="ss-req">*</em>}</span>
                {f.textarea ? (
                  <textarea rows={f.rows || 3} value={val} onChange={e => set(k, e.target.value)} />
                ) : (
                  <input type={f.type || 'text'} value={val} onChange={e => set(k, e.target.value)} />
                )}
              </label>
            );
          })}
          {summaryText && (
            <div className="ss-form-section">发货汇总（同发货日期的 FBA 货件，可复制）</div>
          )}
          {summaryText && <pre className="ss-summary-pre">{summaryText}</pre>}
        </div>
        <div className="ss-drawer-foot">
          <button type="button" className="btn btn-sm" onClick={onCancel}>取消</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy}
            onClick={() => onSave(form)}>保存</button>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- 产品库

function ProductsView({ products, onEdit, onNew, onDelete, busy }: {
  products: Row[]; onEdit: (p: Row) => void; onNew: () => void;
  onDelete: (id: string) => void; busy: boolean;
}) {
  return (
    <div className="ss-products">
      <div className="ss-section-head">
        <h4>产品库（{products.length}）</h4>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onNew}>+ 新增产品</button>
      </div>
      <div className="ss-table-wrap">
        <table className="ss-table">
          <thead>
            <tr>
              <th>产品</th><th>MSKU</th><th>英文类别</th><th>中文类别</th>
              <th>每箱数量</th><th>单箱重量</th><th>尺寸</th><th>厂家</th><th>FNSKU</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {products.map(p => (
              <tr key={p.id}>
                <td>{p.product || '—'}</td>
                <td className="ss-mono">{p.msku || '—'}</td>
                <td>{p.categoryEn || '—'}</td>
                <td>{p.categoryCn || '—'}</td>
                <td>{p.qtyPerBox || '—'}</td>
                <td>{p.singleBoxWeight || '—'}</td>
                <td>{p.length && p.width && p.height ? `${p.length}×${p.width}×${p.height}` : '—'}</td>
                <td>{p.supplier || '—'}</td>
                <td className="ss-mono">{p.fnsku || '—'}</td>
                <td>
                  <button type="button" className="ss-link" onClick={() => onEdit(p)}>编辑</button>
                  <button type="button" className="ss-link ss-link-danger" onClick={() => onDelete(p.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!products.length && <div className="ss-empty">产品库为空</div>}
      </div>
    </div>
  );
}

function ProductForm({ initial, busy, onCancel, onSave }: {
  initial: Row; busy: boolean; onCancel: () => void; onSave: (d: Row) => void;
}) {
  const [form, setForm] = useState<Row>({ ...initial });
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal ss-modal" onClick={e => e.stopPropagation()}>
        <div className="ss-modal-head">
          <strong>{form.id ? '编辑产品' : '新增产品'}</strong>
          <span className="ss-spacer" />
          <button type="button" className="btn btn-sm" onClick={onCancel}>取消</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy}
            onClick={() => onSave(form)}>保存</button>
        </div>
        <div className="ss-form-body">
          {PRODUCT_FIELDS.map(f => (
            <label key={f.key} className="ss-field">
              <span>{f.label}{f.req && <em className="ss-req">*</em>}</span>
              <input value={form[f.key] ?? ''} onChange={e => set(f.key, e.target.value)} />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
