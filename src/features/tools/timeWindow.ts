/**
 * 定时任务时段限制：08:30 ~ 21:00。
 *
 * 为什么有这条限制（2026-11-17 复盘数据后确定）：
 *   本机 DNS 走路由器 192.168.1.1，凌晨路由/宽带的定时动作会让 DNS 与出口
 *   短暂中断，恢复要等系统 DNS 负缓存过期（实测窗口 8~9 分钟）。
 *   按档位统计失败率：00:00 → 25.7%、05:00 → 44.6%、06:00 → 52.3%；
 *   08:00 之后降到 0~2%。详见 AGENTS.md「定时任务时段红线」。
 *
 * ⚠️ 关键词排名的档位按「任务自己的时区」解释（`keyword_tasks.timezone`）。
 *    当前所有任务都是 Asia/Shanghai，字面值即北京时间。若把任务切到美东等
 *    时区，08:30~21:00 换算到北京时间会跨越凌晨，需自行确认。
 */

export const TIME_MIN = '08:30';
export const TIME_MAX = '21:00';

/** 统一提示文案，避免各处措辞不一 */
export const TIME_WINDOW_HINT =
  `定时需在 ${TIME_MIN} ~ ${TIME_MAX} 之间（凌晨 00:00~07:00 是本机网络故障窗口）`;

/** 常用档位按钮（已剔除 06:00 与 22:00 这两个越界值） */
export const PRESET_TIMES = ['09:00', '12:00', '15:00', '18:00', '20:00'];

/** 关键词排名编辑弹窗的快捷整点（原 [0,6,12,18]，0 和 6 越界） */
export const QUICK_HOURS = [9, 12, 15, 18, 20];

/** 格式 + 范围校验；空值不算越界（由调用方按场景决定是否必填） */
export function inTimeWindow(t: string): boolean {
  const s = (t || '').trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return false;
  return s >= TIME_MIN && s <= TIME_MAX;
}

/** 把越界值夹到最近边界（用于「添加时间」这类自动取值） */
export function clampTime(t: string): string {
  const s = (t || '').trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return TIME_MIN;
  if (s < TIME_MIN) return TIME_MIN;
  if (s > TIME_MAX) return TIME_MAX;
  return s;
}

/** 保存前统一校验：返回第一个越界的时间点，全合规返回 null */
export function firstOutOfWindow(times: (string | null | undefined)[]): string | null {
  for (const t of times) {
    const s = (t || '').trim();
    if (!s) continue;
    if (/^\d{2}:\d{2}$/.test(s) && !inTimeWindow(s)) return s;
  }
  return null;
}
