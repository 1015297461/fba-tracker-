import React from 'react';
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

export function EditField({ label, value, onChange, type, mono, placeholder, wide, multi, prefix, suffix, options }: {
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
      {label && <span className="lbl">{label}</span>}
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

export function StageCard({ stage, productId, stageKey, stageData, children, extraHeader, defaultOpen = true }: {
  stage: StageDefinition;
  productId: string;
  stageKey: string;
  stageData: any;
  children?: React.ReactNode;
  extraHeader?: React.ReactNode;
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
  return (
    <div className={"record-card" + (isFinal ? ' final' : '')}>
      <div className="record-hdr">
        <div className="record-num" style={{ background: color, color:'#fff' }}>#{index}</div>
        <button className="record-collapse" onClick={() => setOpen(o => !o)} title={open ? '折叠' : '展开'}>
          {open ? '▾' : '▸'}
        </button>
        <span className="record-title">{title}</span>
        {dates && <span className="record-dates">{dates}</span>}
        {meta && <span className="record-meta">{meta}</span>}
        <StatusSelect value={status} size="sm" onChange={onStatusChange} />
        {isFinal && <span className="record-final-badge">最终版</span>}
        <button className="record-remove" onClick={onRemove} title="删除">✕</button>
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
