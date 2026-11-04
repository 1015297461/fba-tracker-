/**
 * 详情抓取的「后台任务」注册表。
 *
 * 为什么需要它
 * ------------
 * 抓一个 Amazon 详情要 8~13 秒。原来请求是绑在弹窗组件上的：用户一关弹窗，
 * 组件卸载 → 结果被丢掉 → 下次点开又从零抓一遍，等于白等。
 * 现在把请求挂在**模块级**：关掉弹窗照样跑，跑完结果留在内存里（30 分钟），
 * 再点开同一个 ASIN 直接秒开；如果关掉时还没跑完，跑完会弹一条小提示。
 *
 * 约定
 * ----
 * · 同一个 key 同时只跑一个请求（连点不会重复抓 Amazon）。
 * · `promise` 永不 reject —— 成功/失败都反映在 `job.status` 上，避免组件卸载后
 *   留下「未处理的 Promise rejection」。
 * · 组件通过 `subscribeJob` 感知状态；没人订阅时（弹窗已关）才算「后台完成」，触发提示。
 */

export type DetailJobStatus = 'running' | 'done' | 'error';

export interface DetailJob {
  key: string;
  status: DetailJobStatus;
  data?: any;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  promise?: Promise<void>;
}

const jobs = new Map<string, DetailJob>();
const subs = new Map<string, Set<(j: DetailJob) => void>>();
const allSubs = new Set<(j: DetailJob) => void>();

/** 任务 key：站点 + ASIN + 快照日期 + 是否强制刷新 */
export function jobKey(marketplace: string, asin: string, date = '', force = false): string {
  return `${(marketplace || 'US').toUpperCase()}:${String(asin || '').toUpperCase()}:` +
         `${date || 'latest'}:${force ? 'r' : 's'}`;
}

export function getJob(key: string): DetailJob | undefined {
  return jobs.get(key);
}

/** 是否还有组件在等这个任务（弹窗开着）——没人的话完成时要弹提示 */
export function hasSubscribers(key: string): boolean {
  const s = subs.get(key);
  return !!s && s.size > 0;
}

export function subscribeJob(key: string, fn: (j: DetailJob) => void): () => void {
  let s = subs.get(key);
  if (!s) {
    s = new Set();
    subs.set(key, s);
  }
  s.add(fn);
  return () => {
    s!.delete(fn);
    if (!s!.size) subs.delete(key);
  };
}

/** 全局订阅：任何任务状态变化都会通知（提示条用） */
export function subscribeAllJobs(fn: (j: DetailJob) => void): () => void {
  allSubs.add(fn);
  return () => { allSubs.delete(fn); };
}

function emit(job: DetailJob) {
  subs.get(job.key)?.forEach(fn => { try { fn(job); } catch { /* 单个订阅者出错不影响其它 */ } });
  allSubs.forEach(fn => { try { fn(job); } catch { /* 同上 */ } });
}

/**
 * 取（或启动）一个详情任务。
 *
 * @param reuseDone true 时，已完成的结果直接复用（秒开）；「重新获取」要传 false。
 */
export function ensureJob(key: string, run: () => Promise<any>, reuseDone = true): DetailJob {
  const cur = jobs.get(key);
  if (cur && cur.status === 'running') return cur;      // 已在跑 → 复用，连点不重复抓
  if (cur && cur.status === 'done' && reuseDone) return cur;

  const job: DetailJob = { key, status: 'running', startedAt: Date.now() };
  jobs.set(key, job);
  emit(job);

  const finish = (next: DetailJob) => {
    jobs.set(key, next);
    emit(next);
    pruneJobs();
  };

  job.promise = run().then(
    data => { finish({ ...job, status: 'done', data, finishedAt: Date.now(), promise: undefined }); },
    e => {
      const msg = String((e && (e.message || e)) || '抓取失败');
      finish({ ...job, status: 'error', error: msg, finishedAt: Date.now(), promise: undefined });
    },
  );
  return job;
}

/** 丢掉已结束且超过 maxAgeMs 的任务，防止内存里越攒越多 */
export function pruneJobs(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  jobs.forEach((j, k) => {
    if (j.status !== 'running' && now - j.startedAt > maxAgeMs) jobs.delete(k);
  });
}
