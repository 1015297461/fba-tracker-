import { DEFAULT_FX } from './constants';
import type { Product, ProfitResult, Stats } from './types';

export function calcProfit(p: Product): ProfitResult | null {
  const pr = p.stages?.profit;
  if (!pr || !Number(pr.targetPrice)) return null;
  const fx        = Number(p.fxRate) || DEFAULT_FX;
  const price     = Number(pr.targetPrice)  || 0;
  const cogsUsd   = fx > 0 ? (Number(pr.cogs)      || 0) / fx : 0;
  const shipUsd   = fx > 0 ? (Number(pr.shipping)  || 0) / fx : 0;
  const otherUsd  = fx > 0 ? (Number(pr.otherCost) || 0) / fx : 0;
  const fbaFee    = Number(pr.fbaFee)       || 0;
  const referral  = price * (Number(pr.referralPct || 0) / 100);
  const adFee     = price * (Number(pr.adPct       || 0) / 100);
  const returnCost = price * (Number(pr.returnRate || 0) / 100);
  const gross     = price - fbaFee - shipUsd - cogsUsd;
  const net       = gross - referral - adFee - returnCost - otherUsd;
  const margin    = price ? (net / price * 100) : 0;
  return { price, cogsUsd, shipUsd, otherUsd, fbaFee, referral, adFee, returnCost, gross, net, margin };
}

export function calcVariantProfit(variant: any, fxRate?: number): ProfitResult | null {
  const pr = variant?.stages?.profit;
  if (!pr || !Number(pr.targetPrice)) return null;
  const fx        = Number(fxRate) || DEFAULT_FX;
  const price     = Number(pr.targetPrice)  || 0;
  const cogsUsd   = fx > 0 ? (Number(pr.cogs)      || 0) / fx : 0;
  const shipUsd   = fx > 0 ? (Number(pr.shipping)  || 0) / fx : 0;
  const otherUsd  = fx > 0 ? (Number(pr.otherCost) || 0) / fx : 0;
  const fbaFee    = Number(pr.fbaFee)       || 0;
  const referral  = price * (Number(pr.referralPct || 0) / 100);
  const adFee     = price * (Number(pr.adPct       || 0) / 100);
  const returnCost = price * (Number(pr.returnRate || 0) / 100);
  const gross     = price - fbaFee - shipUsd - cogsUsd;
  const net       = gross - referral - adFee - returnCost - otherUsd;
  const margin    = price ? (net / price * 100) : 0;
  return { price, cogsUsd, shipUsd, otherUsd, fbaFee, referral, adFee, returnCost, gross, net, margin };
}

export function _collectDeadlines(p: Product): string[] {
  const dates: string[] = [];
  (p.stages.production?.batches || []).forEach((b: any) => {
    if (b.expectedShip && b.status !== 'done') dates.push(b.expectedShip);
  });
  (p.stages.shipment?.records || []).forEach((r: any) => {
    if (r.status !== 'done') {
      if (r.etaFBA) dates.push(r.etaFBA);
      else if (r.etaPort) dates.push(r.etaPort);
    }
  });
  (p.stages.reorder?.records || []).forEach((r: any) => {
    if (r.etaDate && r.status !== 'done') dates.push(r.etaDate);
  });
  if (p.stages.listing?.launchDate && p.stages.listing?.status !== 'done') {
    dates.push(p.stages.listing.launchDate);
  }
  Object.values(p.stages || {}).forEach(s => {
    if (s?.status === 'active' && s?.endDate) dates.push(s.endDate);
  });
  return dates.filter(Boolean);
}

export function computeStats(products: Product[]): Stats {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const y = today.getFullYear(), mo = today.getMonth();
  const monthStart = new Date(y, mo, 1).toISOString().slice(0, 10);
  const monthEnd   = new Date(y, mo + 1, 0).toISOString().slice(0, 10);
  const plus30 = new Date(today); plus30.setDate(plus30.getDate() + 30);
  const plus30Str = plus30.toISOString().slice(0, 10);

  const monthDone = products.filter(p => {
    if (p.status !== 'done') return false;
    const ends = Object.values(p.stages || {}).map(s => s?.endDate || (s as any)?.doneDate).filter(Boolean);
    return ends.some(d => d >= monthStart && d <= monthEnd);
  }).length;

  const due30 = products.filter(p => {
    if (p.status !== 'active') return false;
    return _collectDeadlines(p).some(d => d >= todayStr && d <= plus30Str);
  }).length;

  const overdue = products.filter(p => {
    if (p.status !== 'active') return false;
    return _collectDeadlines(p).some(d => d < todayStr);
  }).length;

  return { monthDone, due30, overdue };
}
