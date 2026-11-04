/**
 * 商品详情「按天快照」取数钩子（类目榜单监控 / 排名监测共用）。
 *
 * 语义（2026-11-03 改成与榜单快照一致的心智模型）：
 *   · 打开只看**已有快照**（默认最新一天），**不会自动抓** —— 免得你没注意时去撞 Amazon；
 *   · 一条快照都没有（首次点开）后端才会抓一次，落当天的快照；
 *   · 「重新获取」= 抓最新 → 覆盖**当天**快照（一天最多一条，旧的同天数据被替换）；
 *   · 日历选历史日期 → 读那天的快照，没有就明确报错，不会偷偷补一条。
 *
 * 后台化（2026-11-04）：请求挂到 `detailJobs` 的模块级任务表上，
 * **关掉弹窗不会取消抓取**，抓完结果留在内存 30 分钟——再点开秒开；
 * 关着的时候抓完会弹一条小提示。
 *
 * 后端接口：`GET /api/catmon/detail?asin=&marketplace=&date=&refresh=`
 *           `GET /api/catmon/detail/dates?asin=&marketplace=`
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders } from './AiAnalyze';
import { ensureJob, getJob, jobKey, setDetailModalAsin } from './detailJobs';

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

  const apply = useCallback((d: any) => {
    setData(d);
    setSnapDate(d?.snapDate || '');
    setFetchedAt(d?.fetchedAt || '');
  }, []);

  const load = useCallback(async (date = '', force = false) => {
    if (!asin || !enabled) return;
    const my = ++seq.current;
    const qs = `asin=${encodeURIComponent(asin)}&marketplace=${encodeURIComponent(mk)}` +
               (date ? `&date=${encodeURIComponent(date)}` : '') +
               (force ? '&refresh=1' : '');
    const key = jobKey(mk, asin, date, force);
    // 任务挂在模块级：关弹窗不会中断，抓完结果留在内存里
    const job = ensureJob(key, () => api(`/api/catmon/detail?${qs}`), !force);

    if (job.status === 'done') {          // 已抓过（含刚才后台跑完的）→ 秒开
      apply(job.data);
      loadDates();
      return;
    }
    if (job.status === 'error') {
      setError(job.error === 'no_snapshot_for_date' ? `这一天（${date}）没有快照` : (job.error || ''));
      return;
    }

    if (force) setRefreshing(true); else setLoading(true);
    setError('');
    await job.promise;
    if (my !== seq.current) return;        // 已经切到别的 ASIN，丢弃
    const fin = getJob(key);
    if (fin?.status === 'done') {
      apply(fin.data);
      loadDates();
    } else if (fin?.status === 'error') {
      const msg = String(fin.error || '');
      setError(msg === 'no_snapshot_for_date' ? `这一天（${date}）没有快照` : msg);
      // 刷新失败时**保留已有内容**，别把用户正在看的东西清掉
      if (!force) setData(null);
    }
    setLoading(false);
    setRefreshing(false);
  }, [asin, mk, enabled, apply, loadDates]);

  // 切 ASIN 时重置并加载最新快照（首次没有快照时，后端会自动抓一次）
  useEffect(() => {
    seq.current++;
    setData(null); setError(''); setSnapDate(''); setFetchedAt(''); setDates([]);
    // 告诉 detailJobs「当前弹窗正开着看哪个商品」：关掉（asin 置空）后抓完就要弹提示。
    // 不能用「组件卸载」来判断——关弹窗只是把 asin 置空，承载页面并没有卸载（踩过）。
    setDetailModalAsin(asin && enabled ? asin : null);
    if (asin && enabled) load('', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asin, mk, enabled]);

  // 页面卸载时清掉标记，避免残留「弹窗还开着」的假象
  useEffect(() => () => setDetailModalAsin(null), []);

  return {
    data, loading, refreshing, error, snapDate, fetchedAt, dates,
    reload: () => { load(snapDate || '', false); },
    refresh: () => load('', true),
    pickDate: (d: string) => load(d, false),
  };
}
