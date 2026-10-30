import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// 日期日历选择器（排名监测 / 类目榜单共用；类名 `rkd-*` 与既有 SnapPicker 的 `rk-cal-*` 隔离）。
// 只列 `dates` 里的"有数据日期"可选，无数据日期灰显不可点；弹层 portal + fixed，避免被容器裁剪。
export function DateCalendar({ value, dates, onChange }: {
  value: string; dates: string[]; onChange: (d: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [month, setMonth] = useState('2026-01');
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const avail = new Set(dates);

  const openCal = () => {
    const r = btnRef.current?.getBoundingClientRect();
    const H = 320, W = 252;
    let x = r ? r.left : 0;
    if (x + W > window.innerWidth - 8) x = window.innerWidth - W - 8;
    if (x < 8) x = 8;
    let y = r ? r.bottom + 4 : 0;
    if (r && y + H > window.innerHeight - 8) y = Math.max(8, r.top - H - 4);
    setPos({ x, y });
    setMonth((value || dates[0] || '').slice(0, 7) || new Date().toISOString().slice(0, 7));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const [y, m] = month.split('-').map(Number);
  const startDow = (new Date(y, (m || 1) - 1, 1).getDay() + 6) % 7;   // 周一开头
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  const shift = (n: number) => {
    const dt = new Date(y, (m - 1) + n, 1);
    setMonth(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  };

  return (
    <>
      <button type="button" ref={btnRef} className="rkd-trigger" onClick={openCal}>
        {value || '选择日期'} <span className="rkd-caret">▾</span>
      </button>
      {open && createPortal(
        <div ref={popRef} className="rkd-pop" style={{ left: pos.x, top: pos.y }}>
          <div className="rkd-nav">
            <button type="button" onClick={() => shift(-1)}>‹</button>
            <span>{y} 年 {m} 月</span>
            <button type="button" onClick={() => shift(1)}>›</button>
          </div>
          <div className="rkd-grid">
            {['一', '二', '三', '四', '五', '六', '日'].map(w => (
              <span key={w} className="rkd-dow">{w}</span>
            ))}
            {cells.map((ds, i) => ds === null ? <span key={'e' + i} /> : (() => {
              const has = avail.has(ds);
              const sel = ds === value;
              return (
                <button key={ds} type="button" disabled={!has}
                  className={'rkd-day' + (sel ? ' on' : '') + (has ? '' : ' off')}
                  onClick={() => { if (has) { onChange(ds); setOpen(false); } }}>
                  {Number(ds.slice(-2))}
                </button>
              );
            })())}
          </div>
        </div>, document.body)}
    </>
  );
}
