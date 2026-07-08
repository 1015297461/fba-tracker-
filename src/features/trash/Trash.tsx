import React, { useState } from 'react';
import { useProducts } from '../../context/ProductContext';
import type { TrashItem } from '../../data/types';

function fmtTime(iso: string): string {
  if (!iso) return '';
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, min] = m;
  const now = new Date();
  const isToday = now.getFullYear() === Number(y) && now.getMonth() + 1 === Number(mo) && now.getDate() === Number(d);
  return isToday ? `今天 ${h}:${min}` : `${mo}-${d} ${h}:${min}`;
}

export function Trash() {
  const ctx = useProducts() as any;
  const trash: TrashItem[] = ctx?.trash || [];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);

  const handleRestore = async (item: TrashItem) => {
    setBusyId(item.id);
    try { await ctx.restoreFromTrash(item.id); }
    finally { setBusyId(null); }
  };

  const handlePurge = async (item: TrashItem) => {
    if (!confirm(`确定要彻底删除「${item.name}」吗？此操作不可恢复。`)) return;
    setBusyId(item.id);
    try { await ctx.purgeFromTrash(item.id); }
    finally { setBusyId(null); }
  };

  const handleEmpty = async () => {
    if (trash.length === 0) return;
    if (!confirm(`确定要清空回收站吗？将彻底删除 ${trash.length} 个产品，此操作不可恢复。`)) return;
    setEmptying(true);
    try { await ctx.emptyTrash(); }
    finally { setEmptying(false); }
  };

  return (
    <div className="trash-root">
      <div className="trash-header">
        <span className="trash-title">回收站</span>
        <span className="trash-count">{trash.length} 个已删除产品</span>
        <div className="trash-header-spacer" />
        <button className="btn btn-sm trash-empty-btn" onClick={handleEmpty} disabled={trash.length === 0 || emptying}>
          {emptying ? '清空中…' : '清空回收站'}
        </button>
      </div>

      {trash.length === 0 && (
        <div className="trash-empty">
          <div className="trash-empty-icon">🗑️</div>
          <div>回收站是空的</div>
          <div className="trash-empty-sub">从产品列表删除的产品会先进入这里，可随时恢复或彻底删除</div>
        </div>
      )}

      {trash.length > 0 && (
        <div className="trash-list">
          {trash.map(item => (
            <div key={item.id} className="trash-card">
              <div className="trash-card-info">
                <span className="trash-card-name" title={item.name}>{item.name}</span>
                <span className="trash-card-meta">SKU {item.sku || '-'} · {item.deletedBy || '未知用户'} 删除于 {fmtTime(item.deletedAt)}</span>
              </div>
              <div className="trash-card-actions">
                <button className="btn btn-sm trash-restore-btn" onClick={() => handleRestore(item)} disabled={busyId === item.id}>
                  {busyId === item.id ? '处理中…' : '恢复'}
                </button>
                <button className="btn btn-sm trash-purge-btn" onClick={() => handlePurge(item)} disabled={busyId === item.id}>
                  彻底删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
