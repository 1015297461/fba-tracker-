/**
 * 查询记录分类用的弹窗（新建/重命名、移动分类）。
 *
 * 为什么单独抽：之前是塞在左栏底部的小浮层（`.cm-pop` / `.rk-pop`），
 * 空间窄、容易被内容挤变形，两个模块还得各写一份。这里统一成居中模态，
 * 两个模块共用。
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { RecGroup } from './recordGroups';

function Modal({ title, sub, width = 400, onClose, children }: {
  title: string;
  sub?: string;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="rg-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rg-modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="rg-head">
          <span className="rg-title">{title}</span>
          {sub && <span className="rg-sub">{sub}</span>}
          <button className="rg-x" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** 新建 / 重命名分类 */
export function NameDialog({ open, title, sub, defaultValue = '', placeholder, onOk, onClose }: {
  open: boolean;
  title: string;
  sub?: string;
  defaultValue?: string;
  placeholder?: string;
  onOk: (name: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    // 弹窗刚挂载时 input 还没渲染完，延一帧再聚焦+全选（重命名时便于直接覆盖）
    const t = window.setTimeout(() => { ref.current?.focus(); ref.current?.select(); }, 30);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;
  const submit = () => {
    const v = (ref.current?.value || '').trim();
    if (v) onOk(v);
  };

  return (
    <Modal title={title} sub={sub} width={380} onClose={onClose}>
      <div className="rg-body">
        <input ref={ref} className="rg-input" defaultValue={defaultValue} maxLength={20}
               placeholder={placeholder || '分类名称，如「风扇类」'}
               onKeyDown={e => {
                 if (e.key === 'Enter') { e.preventDefault(); submit(); }
               }} />
        <div className="rg-tip">最多 20 个字，回车直接确定</div>
      </div>
      <div className="rg-foot">
        <button className="rg-btn" onClick={onClose}>取消</button>
        <button className="rg-btn primary" onClick={submit}>确定</button>
      </div>
    </Modal>
  );
}

/** 移动到分类（点一下就走，不需要二次确认） */
export function MoveDialog({ open, count, groups, counts, onPick, onNew, onClose }: {
  open: boolean;
  /** 本次要移动多少条 */
  count: number;
  groups: RecGroup[];
  /** 每个分类当前有多少条（只用于展示） */
  counts: Record<string, number>;
  onPick: (groupId: string | null) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Modal title="移动到分类" sub={`${count} 项`} width={420} onClose={onClose}>
      <div className="rg-body">
        {groups.length === 0 && (
          <div className="rg-empty">还没有分类，先建一个吧</div>
        )}
        <div className="rg-list">
          {groups.map(g => (
            <button key={g.id} className="rg-item" onClick={() => onPick(g.id)}>
              <span className="rg-dot" />
              <span className="rg-item-name">{g.name}</span>
              <span className="rg-item-n">{counts[g.id] || 0}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="rg-foot split">
        <button className="rg-btn" onClick={() => onPick(null)}>移出分类</button>
        <span style={{ flex: 1 }} />
        <button className="rg-btn" onClick={onNew}>+ 新建分类并移入</button>
      </div>
    </Modal>
  );
}
