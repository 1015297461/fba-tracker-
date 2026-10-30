import React, { useRef, useState } from 'react';

// 通用「可拖拽列宽」：事件委托到 thead，避免给每个 <th> 都塞手柄。
// 用法：
//   const { colgroup, thProps, active } = useColResize('rank-competitor');
//   <table className={'tf-table col-rsz' + (active ? ' cw-fixed' : '')}>
//     {colgroup}
//     <thead {...thProps}> ... </thead>
//   </table>
//
// 要点：
//  · 拖动某列时，其余列按比例缩放，**总宽保持恒定** → 不会把表格/页面撑出横向溢出。
//  · 所有列（含最后一列、自动列）都能拖：首次拖拽按各列实际像素宽初始化。
//  · 鼠标靠近列边界时，该列显蓝色手柄 + col-resize 光标（`.col-grip`）。
//  · 宽度数组：number = 固定像素；null 仅用于「初始默认」里希望自适应的列，一旦拖动即转为数值。
//  · 语义：storage key = fba-colw-v1:<key>。

const PREFIX = 'fba-colw-v1:';
const MIN_W = 36;

type W = (number | null)[];

function load(key: string): W | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a) && a.length && a.every(n => n === null || typeof n === 'number')) return a as W;
    }
  } catch { /* 忽略损坏存储 */ }
  return null;
}

export function useColResize(key: string, defaults?: W, cols?: number) {
  const storageKey = PREFIX + key;
  const [widths, setWidths] = useState<W | null>(() => load(key) || defaults || null);
  const widthsRef = useRef<W | null>(widths);
  widthsRef.current = widths;
  const baseRef = useRef<number[] | null>(null);

  // 列数会变（如矩阵日期列随区间变化）：宽度数量对不上时回退自动布局，避免 colgroup 错位
  const valid = !cols || !widths || widths.length === cols;
  const colgroup = widths && valid ? (
    <colgroup>
      {widths.map((w, i) => <col key={i} style={w != null ? { width: w } : undefined} />)}
    </colgroup>
  ) : null;

  const measure = (heads: HTMLElement[]) =>
    heads.map(h => Math.max(MIN_W, Math.round(h.getBoundingClientRect().width)));

  // 返回鼠标 x 最近的「列右边界」下标（0..n-1，含最后一列），超过阈值 -1。
  // 命中点取 right-3：向外挪到表格外缘会让 mousedown 落到表格外（thead 收不到），
  // 导致「最后一列拖不动」，内移 3px 后每列都能拖。
  const nearBoundary = (heads: HTMLElement[], x: number, tol: number): number => {
    let hit = -1, best = Infinity;
    for (let i = 0; i < heads.length; i++) {
      const d = Math.abs(x - (heads[i].getBoundingClientRect().right - 3));
      if (d < best) { best = d; hit = i; }
    }
    return best <= tol ? hit : -1;
  };

  const clearGrip = (heads: HTMLElement[]) => heads.forEach(h => h.classList.remove('col-grip'));

  const thProps = {
    onMouseDown: (e: React.MouseEvent<HTMLTableSectionElement>) => {
      const table = (e.target as HTMLElement).closest('table') as HTMLTableElement | null;
      if (!table) return;
      const heads = Array.from(table.querySelectorAll('thead th')) as HTMLElement[];
      if (heads.length < 1) return;
      const hit = nearBoundary(heads, e.clientX, 8);
      if (hit < 0) return;
      e.preventDefault();
      e.stopPropagation();
      clearGrip(heads);

      const cur = widthsRef.current;
      // 首次 / 有自动列 / 数量不符 → 按实际像素宽全部测量（保证每列都有明确宽度、可精确再分配）
      const base = (!cur || cur.length !== heads.length || cur.some(w => w == null))
        ? measure(heads)
        : cur.map(w => w as number);
      baseRef.current = base;
      const total = base.reduce((a, b) => a + b, 0);   // 总宽保持不变
      const startX = e.clientX;
      const w0 = base[hit];

      const move = (ev: MouseEvent) => {
        const nw = Math.max(MIN_W, Math.round(w0 + (ev.clientX - startX)));
        const factor = (total - nw) / Math.max(1, total - w0);   // 其余列按比例缩放
        const out: W = base.map((w, i) => i === hit ? nw : Math.max(MIN_W, Math.round(w * factor)));
        setWidths(out);
      };
      const stopClick = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.addEventListener('click', stopClick, true);
        window.setTimeout(() => document.removeEventListener('click', stopClick, true), 260);
        try {
          if (widthsRef.current) localStorage.setItem(storageKey, JSON.stringify(widthsRef.current));
        } catch { /* 存储满/禁用则忽略 */ }
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    },

    onMouseMove: (e: React.MouseEvent<HTMLTableSectionElement>) => {
      const el = e.currentTarget as HTMLElement;
      const table = (e.target as HTMLElement).closest('table') as HTMLTableElement | null;
      if (!table) { el.style.cursor = ''; return; }
      const heads = Array.from(table.querySelectorAll('thead th')) as HTMLElement[];
      const hit = nearBoundary(heads, e.clientX, 8);
      heads.forEach((h, i) => h.classList.toggle('col-grip', i === hit));
      el.style.cursor = hit >= 0 ? 'col-resize' : '';
    },

    onMouseLeave: (e: React.MouseEvent<HTMLTableSectionElement>) => {
      const el = e.currentTarget as HTMLElement;
      el.style.cursor = '';
      const table = (e.target as HTMLElement).closest('table') as HTMLTableElement | null;
      if (table) clearGrip(Array.from(table.querySelectorAll('thead th')) as HTMLElement[]);
    },
  };

  return { colgroup, thProps, active: !!widths && valid };
}
