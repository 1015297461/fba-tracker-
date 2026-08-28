import React from 'react';
import { createPortal } from 'react-dom';
import { STAGE_STATUSES } from '../data/constants';
import { useProducts } from '../context/ProductContext';
import type { StageDefinition } from '../data/types';

export function StatusChip({ status, size }: { status?: string; size?: string }) {
  const s = STAGE_STATUSES.find(x => x.value === (status || 'idle')) || STAGE_STATUSES[0];
  return (
    <span className={"status-chip" + (size === 'sm' ? ' sm' : '')}
      style={{ color: s.color, background: s.bg }}>
      <span className="dot" style={{ background: s.color }}></span>
      {s.label}
    </span>
  );
}

export function StatusSelect({ value, onChange, size }: { value?: string; onChange: (v: string) => void; size?: string }) {
  return (
    <span className={"status-select" + (size === 'sm' ? ' sm' : '')}>
      <StatusChip status={value} size={size} />
      <select value={value || 'idle'} onChange={e => onChange(e.target.value)}>
        {STAGE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </span>
  );
}

// 悬浮标题时显示计算过程说明（如"= 数量 × 单价 = ¥120.00"）
// 用 portal 挂到 body 上、position:fixed 定位：避免被折叠卡片等祖先元素的 overflow:hidden 裁切，
// 并在渲染后按视口边界收缩，防止在窄列/边缘时溢出屏幕。
// 鼠标从标题移到弹窗上时不能立即关闭（要能选中/复制文字），仿照 .shs-tooltip-inner 的桥接思路，
// 用短延时代替 CSS 的 padding-top 空隙桥接（弹窗是 portal 出去的，DOM 上不再是标题的子元素，CSS 那招用不了）。
export function FieldHint({ label, hint, placement = 'bottom' }: { label: React.ReactNode; hint?: string; placement?: 'bottom' | 'right' }) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  const popRef = React.useRef<HTMLSpanElement>(null);
  const closeTimer = React.useRef<number | null>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  const clearCloseTimer = () => {
    if (closeTimer.current != null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const handleEnter = () => { clearCloseTimer(); setOpen(true); };
  const scheduleClose = () => { clearCloseTimer(); closeTimer.current = window.setTimeout(() => setOpen(false), 200); };
  React.useEffect(() => () => clearCloseTimer(), []);

  React.useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const popW = popRef.current?.offsetWidth || 0;
    const popH = popRef.current?.offsetHeight || 0;
    const margin = 8;
    let top: number, left: number;
    if (placement === 'right') {
      left = a.right + 8;
      if (left + popW + margin > window.innerWidth) left = a.left - popW - 8; // 右侧放不下时翻到左侧
      top = a.top + a.height / 2 - popH / 2;
      top = Math.max(margin, Math.min(top, window.innerHeight - popH - margin));
    } else {
      top = a.bottom + 6;
      left = a.left + a.width / 2 - popW / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));
    }
    setPos({ top, left });
  }, [open, placement]);

  if (!hint) return <>{label}</>;
  return (
    <span ref={anchorRef} className="field-hint"
      onMouseEnter={handleEnter} onMouseLeave={scheduleClose}>
      {label}
      {open && createPortal(
        <span ref={popRef} className="field-hint-pop" style={{ top: pos.top, left: pos.left }}
          onMouseEnter={handleEnter} onMouseLeave={scheduleClose}>
          <span className="field-hint-pop-inner">{hint}</span>
        </span>,
        document.body
      )}
    </span>
  );
}

export function EditField({ label, value, onChange, type, mono, placeholder, wide, multi, prefix, suffix, options, hint, hintPlacement }: {
  label?: string;
  value?: any;
  onChange: (v: any) => void;
  type?: string;
  mono?: boolean;
  placeholder?: string;
  wide?: boolean;
  multi?: boolean;
  prefix?: string;
  suffix?: string;
  options?: any[];
  hint?: string;
  hintPlacement?: 'bottom' | 'right';
}) {
  const [local, setLocal] = React.useState(value ?? '');
  React.useEffect(() => { setLocal(value ?? ''); }, [value]);
  const commit = () => {
    if (local === (value ?? '')) return;
    if (type === 'number') onChange(local === '' ? '' : Number(local));
    else onChange(local);
  };
  return (
    <div className={"field" + (wide ? " field-wide" : "")}>
      {label && <span className="lbl"><FieldHint label={label} hint={hint} placement={hintPlacement} /></span>}
      <div className={"input-wrap" + (prefix ? ' has-prefix' : '') + (suffix ? ' has-suffix' : '')}>
        {prefix && <span className="prefix">{prefix}</span>}
        {options ? (
          <select className={"input" + (mono ? ' mono' : '')}
            value={local} onChange={e => { setLocal(e.target.value); onChange(e.target.value); }}>
            {options.map((o: any) => typeof o === 'string'
              ? <option key={o} value={o}>{o}</option>
              : <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : multi ? (
          <textarea className="input"
            value={local} onChange={e => setLocal(e.target.value)} onBlur={commit}
            placeholder={placeholder} rows={3} />
        ) : (
          <input className={"input" + (mono ? ' mono' : '')}
            type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'}
            value={local}
            onChange={e => setLocal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && !multi) (e.target as HTMLInputElement).blur();
            }}
            placeholder={placeholder}
            step={type === 'number' ? 'any' : undefined} />
        )}
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
    </div>
  );
}

export function StageCard({ stage, productId, stageKey, stageData, children, extraHeader, titleExtra, defaultOpen = true }: {
  stage: StageDefinition;
  productId: string;
  stageKey: string;
  stageData: any;
  children?: React.ReactNode;
  extraHeader?: React.ReactNode;
  titleExtra?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const { updateStage } = useProducts();
  const [open, setOpen] = React.useState(defaultOpen);
  const status = stageData?.status || 'idle';
  return (
    <div className={"stage-card stage-" + status}>
      <div className="stage-card-hdr">
        <div className="stage-card-bar" style={{ background: stage.color }}></div>
        <button className="stage-collapse" onClick={() => setOpen(o => !o)}>
          {open ? '▾' : '▸'}
        </button>
        <span className="stage-card-title">{stage.name}</span>
        {titleExtra}

        <div className="stage-card-dates">
          <span className="dlbl">开始</span>
          <input type="date" className="date-input"
            value={stageData?.startDate || ''}
            onChange={e => updateStage(productId, stageKey, { startDate: e.target.value })} />
          <span className="dsep">→</span>
          <span className="dlbl">结束</span>
          <input type="date" className="date-input"
            value={stageData?.endDate || ''}
            onChange={e => updateStage(productId, stageKey, { endDate: e.target.value })} />
        </div>

        <StatusSelect value={status}
          onChange={v => {
            const patch: any = { status: v };
            if (v === 'done' && !stageData?.endDate) patch.endDate = new Date().toISOString().slice(0,10);
            if (v === 'active' && !stageData?.startDate) patch.startDate = new Date().toISOString().slice(0,10);
            updateStage(productId, stageKey, patch);
          }} />
        {extraHeader}
      </div>
      {open && <div className="stage-card-body">{children}</div>}
    </div>
  );
}

export function RecordCard({ index, title, status, onStatusChange, onRemove, isFinal, color, children, dates, meta, defaultOpen = true }: {
  index: number | string;
  title: string;
  status?: string;
  onStatusChange: (v: string) => void;
  onRemove: () => void;
  isFinal?: boolean;
  color?: string;
  children?: React.ReactNode;
  dates?: string;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const toggle = () => setOpen(o => !o);
  return (
    <div className={"record-card" + (isFinal ? ' final' : '')}>
      {/* 点击标题栏（空白区域/编号/标题）即可折叠展开；交互控件各自 stopPropagation 防止误触 */}
      <div className="record-hdr" onClick={toggle}>
        <div className="record-num" style={{ background: color, color:'#fff' }}>#{index}</div>
        <button className="record-collapse" onClick={e => { e.stopPropagation(); toggle(); }} title={open ? '折叠' : '展开'}>
          {open ? '▾' : '▸'}
        </button>
        <span className="record-title">{title}</span>
        {dates && <span className="record-dates">{dates}</span>}
        {meta && <span className="record-meta" onClick={e => e.stopPropagation()}>{meta}</span>}
        <span onClick={e => e.stopPropagation()}><StatusSelect value={status} size="sm" onChange={onStatusChange} /></span>
        {isFinal && <span className="record-final-badge">最终版</span>}
        <button className="record-remove" onClick={e => { e.stopPropagation(); onRemove(); }} title="删除">✕</button>
      </div>
      {open && <div className="record-body">{children}</div>}
    </div>
  );
}

export function AddRecordButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="btn btn-sm btn-add" onClick={onClick}>+ {label}</button>
  );
}

export function VariantSelector({ p, selectedId, onSelect }: { p: any; selectedId: string; onSelect: (id: string) => void }) {
  const variants = p.variants || [];
  if (!variants.length) return null;
  return (
    <div className="variant-selector">
      <span className="vs-label">变体：</span>
      {variants.map((v: any) => (
        <button key={v.id}
          className={'vs-tab' + (selectedId === v.id ? ' active' : '')}
          onClick={() => onSelect(v.id)}>
          {v.name || v.colorOrSize || v.sku || 'SKU'}
        </button>
      ))}
    </div>
  );
}
