/**
 * 商品详情「按天快照」取数钩子（类目榜单监控 / 排名监测共用）。
 *
 * 语义（2026-11-03 改成与榜单快照一致的心智模型）：
 *   · 打开只看**已有快照**（默认最新一天），**不会自动抓** —— 免得你没注意时去撞 Amazon；
 *   · 一条快照都没有（首次点开）后端才会抓一次，落当天的快照；
 *   · 「重新获取」= 抓最新 → 覆盖**当天**快照（一天最多一条，旧的同天数据被替换）；
 *   · 日历选历史日期 → 读那天的快照，没有就明确报错，不会偷偷补一条。
 *
 * 后端接口：`GET /api/catmon/detail?asin=&marketplace=&date=&refresh=`
 *           `GET /api/catmon/detail/dates?asin=&marketplace=`
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders } from './AiAnalyze';

async function api(path: string) {
  const r = await fetch(path, { headers: authHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && (j.error || j.message)) || `HTTP ${r.status}`);
  return j;
}

export interface AsinDetailHook {
  data: any | null;
  loading: boolean;
  /** 正在「重新获取」（抓取通常几十秒，单独一个状态用于按钮文案） */
  refreshing: boolean;
  error: string;
  snapDate: string;
  fetchedAt: string;
  dates: string[];
  reload: () => void;
  /** 抓最新并覆盖当天快照 */
  refresh: () => Promise<void>;
  /** 切到某个历史日期（''= 最新一天） */
  pickDate: (date: string) => Promise<void>;
}

export function useAsinDetail(asin: string | null, marketplace = 'US', enabled = true): AsinDetailHook {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [snapDate, setSnapDate] = useState('');
  const [fetchedAt, setFetchedAt] = useState('');
  const [dates, setDates] = useState<string[]>([]);
  // 快速连点不同 ASIN 时，只让最后一次请求的结果落地
  const seq = useRef(0);

  const mk = (marketplace || 'US').toUpperCase();

  const loadDates = useCallback(async () => {
    if (!asin) return;
    try {
      const j = await api(`/api/catmon/detail/dates?asin=${encodeURIComponent(asin)}` +
                          `&marketplace=${encodeURIComponent(mk)}`);
      setDates(j.dates || []);
    } catch { /* 日历拿不到不影响看详情 */ }
  }, [asin, mk]);

  const load = useCallback(async (date = '', force = false) => {
    if (!asin || !enabled) return;
    const my = ++seq.current;
    if (force) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const qs = `asin=${encodeURIComponent(asin)}&marketplace=${encodeURIComponent(mk)}` +
                 (date ? `&date=${encodeURIComponent(date)}` : '') +
                 (force ? '&refresh=1' : '');
      const d = await api(`/api/catmon/detail?${qs}`);
      if (my !== seq.current) return;            // 已经切到别的 ASIN，丢弃
      setData(d);
      setSnapDate(d.snapDate || '');
      setFetchedAt(d.fetchedAt || '');
      loadDates();
    } catch (e: any) {
      if (my !== seq.current) return;
      const msg = String(e?.message || e);
      setError(msg === 'no_snapshot_for_date'
        ? `这一天（${date}）没有快照`
        : msg);
      // 刷新失败时**保留已有内容**，别把用户正在看的东西清掉
      if (!force) setData(null);
    } finally {
      if (my === seq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [asin, mk, enabled, loadDates]);

  // 切 ASIN 时重置并加载最新快照（首次没有快照时，后端会自动抓一次）
  useEffect(() => {
    seq.current++;
    setData(null); setError(''); setSnapDate(''); setFetchedAt(''); setDates([]);
    if (asin && enabled) load('', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asin, mk, enabled]);

  return {
    data, loading, refreshing, error, snapDate, fetchedAt, dates,
    reload: () => { load(snapDate || '', false); },
    refresh: () => load('', true),
    pickDate: (d: string) => load(d, false),
  };
}
