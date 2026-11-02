/**
 * 查询记录分类 —— 前端共用（类目榜单监控 / 排名监测）。
 *
 * 后端见 `backend/routes/record_groups.py`；两边靠 `scope` 区分，接口路径只差前缀。
 * 这里只做三件事：调接口、把「平铺列表」按分类分组排序、维护一份本地视图状态。
 */
import { authHeaders } from './AiAnalyze';

export interface RecGroup {
  id: string;
  scope?: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt?: string;
}
/** 成员 = 归属 + 组内顺序（没有行 = 还没归过类，用列表默认顺序兜底） */
export interface RecMember { group_id: string | null; sort_order: number }
export interface RecGroupsPayload {
  groups: RecGroup[];
  members: Record<string, RecMember>;
}

async function req<T>(path: string, method = 'GET', body?: any): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: {
      ...authHeaders(),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (j && j.error) msg = String(j.error);
    } catch { /* 非 JSON 就沿用状态码 */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const groupsApi = (base: string) => ({
  list: () => req<RecGroupsPayload>(`${base}/groups`),
  create: (name: string) => req<RecGroupsPayload>(`${base}/groups`, 'POST', { name }),
  update: (id: string, fields: { name?: string; collapsed?: boolean }) =>
    req<RecGroupsPayload>(`${base}/groups`, 'PUT', { id, ...fields }),
  remove: (id: string) =>
    req<RecGroupsPayload>(`${base}/groups?id=${encodeURIComponent(id)}`, 'DELETE'),
  reorderGroups: (ids: string[]) =>
    req<RecGroupsPayload>(`${base}/groups/order`, 'PUT', { ids }),
  /** groupId=null → 移出分类 */
  assign: (keys: string[], groupId: string | null) =>
    req<RecGroupsPayload>(`${base}/items/group`, 'PUT', { keys, groupId }),
  reorderItems: (groupId: string | null, keys: string[]) =>
    req<RecGroupsPayload>(`${base}/items/order`, 'PUT', { groupId, keys }),
});

/** 分组后的视图：groups 顺序 = 后端顺序，未分类固定最后 */
export interface GroupedBucket<T> { group: RecGroup | null; items: T[] }

export function groupItems<T>(
  items: T[],
  keyOf: (t: T) => string,
  groups: RecGroup[],
  members: Record<string, RecMember>,
): GroupedBucket<T>[] {
  const gids = new Set(groups.map(g => g.id));
  const buckets = new Map<string | null, { it: T; order: number }[]>();

  items.forEach((it, idx) => {
    const m = members[keyOf(it)];
    const gid = m && m.group_id && gids.has(m.group_id) ? m.group_id : null;
    // 有 member 行就按它的 sort_order；没有就按原始顺序排在组尾
    const order = m && m.sort_order != null ? m.sort_order : 1e6 + idx;
    if (!buckets.has(gid)) buckets.set(gid, []);
    buckets.get(gid)!.push({ it, order });
  });

  const out: GroupedBucket<T>[] = [];
  for (const g of groups) {
    const arr = buckets.get(g.id) || [];
    arr.sort((a, b) => a.order - b.order);
    out.push({ group: g, items: arr.map(x => x.it) });
  }
  const rest = buckets.get(null) || [];
  rest.sort((a, b) => a.order - b.order);
  if (rest.length || !groups.length) {
    out.push({ group: null, items: rest.map(x => x.it) });
  }
  return out;
}

/** 在数组里把 from 移到 to 之前（返回新数组；用于组内拖拽排序） */
export function moveBefore<T>(arr: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from === to) return arr;
  const copy = arr.slice();
  const [x] = copy.splice(from, 1);
  copy.splice(to, 0, x);
  return copy;
}
