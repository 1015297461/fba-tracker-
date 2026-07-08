export interface StageStatus {
  value: string;
  label: string;
  color: string;
  bg: string;
}

export interface StageDefinition {
  key: string;
  name: string;
  short: string;
  color: string;
  tab: string;
}

export interface StageData {
  status?: 'idle' | 'active' | 'done' | 'hold';
  startDate?: string;
  endDate?: string;
  [key: string]: any;
}

export interface LogEntry {
  id: string;
  date: string;
  text: string;
}

export interface BatchItem {
  id: string;
  variantId: string;
  variantName: string;
  qty: number;
  unitPrice: number;
}

export interface ExtraCost {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface ShipmentItem {
  id: string;
  variantId: string;
  variantName: string;
  qty: number;
}

export interface Shipment {
  id: string;
  status?: string;
  expectedShip: string;
  shipDate: string;
  qty: number;
  items: ShipmentItem[];
  method: string;
  carrier: string;
  tracking: string;
  fbaShipId: string;
  etaDate: string;
  note: string;
}

export interface BalancePayment {
  id: string;
  amount: number;
  date: string;
  shipmentRef?: string;
  note: string;
}

export interface ProductionBatch {
  id: string;
  batchNo: string;
  factory: string;
  orderDate: string;
  expectedShip: string;
  qty: number;
  unitPrice: number;
  depositPct: number;
  depositActual: number;
  depositDate: string;
  balancePct?: number;
  balanceAmt?: number;
  balanceDate?: string;
  status?: string;
  note: string;
  items: BatchItem[];
  extraCosts: ExtraCost[];
  shipments?: Shipment[];
  balancePayments?: BalancePayment[];
}

export interface Variant {
  id: string;
  name: string;
  sku: string;
  colorOrSize: string;
  stages: Record<string, any>;
}

export interface Product {
  id: string;
  name: string;
  sku: string;
  category: string;
  status: 'active' | 'pending' | 'done' | 'hold' | 'cancel';
  lead: string;
  createdAt: string;
  currentStage: string;
  progress: number;
  fxRate?: number;
  stages: Record<string, any>;
  variants?: Variant[];
  logs: LogEntry[];
}

export interface TrashItem {
  id: string;
  name: string;
  sku: string;
  deletedBy: string;
  deletedAt: string;
  product: Product;
}

export interface ProfitResult {
  price: number;
  cogsUsd: number;
  shipUsd: number;
  otherUsd: number;
  fbaFee: number;
  referral: number;
  adFee: number;
  returnCost: number;
  gross: number;
  net: number;
  margin: number;
}

export interface Stats {
  monthDone: number;
  due30: number;
  overdue: number;
}
