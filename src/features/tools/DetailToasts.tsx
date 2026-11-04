/**
 * 详情抓取完成提示。
 *
 * 场景：用户点开详情 → 要等 8~13 秒 → 他不想干等，把弹窗关了去干别的。
 * 这时抓取在后台继续（见 detailJobs），跑完在这里弹一条小提示：
 * 「B0XXXXXX 详情已获取 · 再点开这个商品会直接显示」。
 * 弹窗还开着（有人在等）就不弹 —— 那种情况内容会直接刷进弹窗。
 */
import { useEffect, useState } from 'react';
import { isDetailModalOpenFor, subscribeAllJobs } from './detailJobs';
import type { DetailJob } from './detailJobs';

interface Item { id: number; asin: string; title: string; sub: string; ok: boolean }

let seed = 0;

export function DetailToasts() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => subscribeAllJobs((j: DetailJob) => {
    if (j.status === 'running') return;
    const parts = j.key.split(':');
    const asin = parts[1] || '';
    if (isDetailModalOpenFor(asin)) return;      // 弹窗正开着看这个商品 → 内容会自己刷进去
    const date = parts[2] || 'latest';
    const ok = j.status === 'done';
    const id = ++seed;
    setItems(list => [...list, {
      id, asin, ok,
      title: ok ? `${asin} 详情已获取` : `${asin} 详情获取失败`,
      sub: ok
        ? `快照 ${date === 'latest' ? '今天' : date} · 再点开这个商品会直接显示`
        : (j.error || '稍后可重试'),
    }]);
    setTimeout(() => setItems(l => l.filter(x => x.id !== id)), ok ? 4500 : 7000);
  }), []);

  if (!items.length) return null;
  return (
    <div className="dt-toasts" role="status" aria-live="polite">
      {items.map(it => (
        <div key={it.id} className="dt-toast" data-ok={it.ok}>
          <span className="dt-toast-dot" />
          <div>
            <div className="dt-toast-title">{it.title}</div>
            <div className="dt-toast-sub">{it.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
