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
  status: 'active' | 'done' | 'hold' | 'cancel';
  lead: string;
  createdAt: string;
  currentStage: string;
  progress: number;
  fxRate?: number;
  stages: Record<string, any>;
  variants?: Variant[];
  logs: LogEntry[];
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
