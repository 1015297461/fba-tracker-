export const STAGES = [
  { key: 'initiation',  name: '选品立项',     short: '立项',  color: '#3b82f6', tab: 'eval' },
  { key: 'research',    name: '竞品调研',     short: '调研',  color: '#6366f1', tab: 'eval' },
  { key: 'profit',      name: '利润测算',     short: '利润',  color: '#8b5cf6', tab: 'eval' },
  { key: 'bom',         name: 'BOM成本拆解',  short: 'BOM',   color: '#a855f7', tab: 'eval' },
  { key: 'supplier',    name: '供应商开发',   short: '供应商', color: '#d946ef', tab: 'sup' },
  { key: 'sampling',    name: '打样/改版',    short: '打样',  color: '#ec4899', tab: 'sup' },
  { key: 'cert',        name: '认证合规',     short: '认证',  color: '#f43f5e', tab: 'sup' },
  { key: 'packaging',   name: '包装设计',     short: '包装',  color: '#f97316', tab: 'design' },
  { key: 'visuals',     name: '视觉素材',     short: '视觉',  color: '#f59e0b', tab: 'design' },
  { key: 'production',  name: '下单生产',     short: '生产',  color: '#eab308', tab: 'prod' },
  { key: 'qc',          name: '品控验货',     short: '品控',  color: '#84cc16', tab: 'prod' },
  { key: 'shipment',    name: '出货物流',     short: '出货',  color: '#22c55e', tab: 'prod' },
  { key: 'keywords',    name: '关键词研究',   short: '关键词', color: '#10b981', tab: 'ops' },
  { key: 'listing',     name: 'Listing上架',  short: '上架',  color: '#14b8a6', tab: 'ops' },
  { key: 'handover',    name: '产品交接',     short: '交接',  color: '#06b6d4', tab: 'ops' },
  { key: 'promotion',   name: '广告推广',     short: '推广',  color: '#0ea5e9', tab: 'ops' },
  { key: 'reorder',     name: '补货物流',     short: '补货',  color: '#0284c7', tab: 'review' },
  { key: 'review',      name: '产品复盘',     short: '复盘',  color: '#64748b', tab: 'review' },
];

export const TABS = [
  { key: 'eval',     icon: '📋', name: '立项评估' },
  { key: 'variants', icon: '🔢', name: 'SKU 变体' },
  { key: 'sup',      icon: '🏭', name: '供应商/打样' },
  { key: 'design',   icon: '🎨', name: '内容设计' },
  { key: 'prod',     icon: '📦', name: '生产出货' },
  { key: 'ops',      icon: '🛒', name: '上架运营' },
  { key: 'review',   icon: '🔄', name: '物流与复盘' },
];

export const STAGE_STATUSES = [
  { value: 'idle',   label: '未开始', color: '#9a9a96', bg: 'rgba(154,154,150,0.15)' },
  { value: 'active', label: '进行中', color: '#ea580c', bg: 'rgba(234,88,12,0.13)' },
  { value: 'done',   label: '已完成', color: '#16a34a', bg: 'rgba(22,163,74,0.13)' },
  { value: 'hold',   label: '暂停',   color: '#9333ea', bg: 'rgba(147,51,234,0.13)' },
];

export const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  all:     { label: '全部',   color: '#6b6b6b' },
  active:  { label: '开发中', color: '#2563eb' },
  pending: { label: '待上架', color: '#9a9a96' },
  done:    { label: '已上架', color: '#16a34a' },
  hold:    { label: '已暂停', color: '#9a9a96' },
  cancel:  { label: '已下架', color: '#9a9a96' },
};

export const VARIANT_STAGE_KEYS = ['profit', 'bom', 'sampling', 'listing', 'promotion'];

export const DEFAULT_FX = 7.20;
