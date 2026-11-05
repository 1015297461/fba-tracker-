/**
 * 趋势条（位次色块条）的自适应分桶。
 *
 * 问题：色块条是固定宽（320px）的一行，**每天一格**。天数一多就崩：
 *   30 天 → 每格 9.7px（还行）；90 天 → 2.6px（成了噪声）；
 *   160 天以上触到 `min-width:2px` → 总宽撑破 320px，把表格列顶开。
 * 同时每天一个真实 <i> 节点，200 行 × 365 天 = 7.3 万个 DOM，滚动会卡。
 *
 * 做法：超过 MAX_STRIP_CELLS 天就按「每格 N 天」合并，格数恒定；调用方自己决定
 * 怎么聚合（位次矩阵取区间内**最好**位次，排名监测还要带上对应的广告位信息）。
 *
 * 类目榜单「全部 ASIN 位次」与排名监测的位次矩阵都用它，保证两处行为一致。
 */

export const MAX_STRIP_CELLS = 40;

/** 一格对应的原序列下标区间 [begin, end)，以及它覆盖的日期范围 */
export interface StripBucket {
  begin: number;
  end: number;
  /** 该格第一天的日期（YYYY-MM-DD） */
  start: string;
  /** 该格最后一天的日期 */
  endDate: string;
  /** 该格代表几天（未聚合时为 1） */
  span: number;
}

export function bucketBounds(len: number, dates: string[]): StripBucket[] {
  if (len <= 0) return [];
  const size = len <= MAX_STRIP_CELLS ? 1 : Math.ceil(len / MAX_STRIP_CELLS);
  const out: StripBucket[] = [];
  for (let i = 0; i < len; i += size) {
    const e = Math.min(i + size, len);
    out.push({
      begin: i, end: e,
      start: dates[i] || '',
      endDate: dates[e - 1] || '',
      span: e - i,
    });
  }
  return out;
}

/** 取该桶内最小的位次（= 排名最好）。全是空则返回 null（区间内都掉榜）。 */
export function bucketMin(seq: (number | null)[], b: StripBucket): number | null {
  let m: number | null = null;
  for (let i = b.begin; i < b.end; i++) {
    const v = seq[i];
    if (v != null && (m == null || v < m)) m = v;
  }
  return m;
}

/** 该桶内最后一个「有排名」的下标（用于取对应的广告位等信息），没有则 -1 */
export function lastRankedIndex(seq: (number | null)[], b: StripBucket): number {
  for (let i = b.end - 1; i >= b.begin; i--) {
    if (seq[i] != null) return i;
  }
  return -1;
}

/** 悬浮窗标题：单日就显示日期，聚合后显示区间 */
export function bucketLabel(b: StripBucket): string {
  if (!b) return '';
  return b.span <= 1 || b.start === b.endDate ? b.start : `${b.start} ~ ${b.endDate}`;
}
