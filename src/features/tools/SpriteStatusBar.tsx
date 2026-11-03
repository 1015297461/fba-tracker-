/**
 * 上架时间取数状态条（两个模块共用）。
 *
 * 为什么需要：卖家精灵的取数可能是**后台**跑的（采集完自动补），前端并不知道失败了。
 * 这里读 `/api/asin-meta/status` 里后端记的「最近一次结果」：
 *   · status = need_login → 橙色提示 + 「重新登录」按钮（点开可见窗口，登录成功自动关）
 *   · status = error      → 红色提示
 *   · status = ok         → **不显示**（下次取到了提示自动消失）
 */
import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from './AiAnalyze';

interface SpriteStatus {
  running?: boolean;
  logged_in?: boolean;
  cred?: { configured: boolean; user?: string | null };
  loginBlocked?: boolean;
  last?: { at: string | null; status: string | null; message: string | null; got: number; asked: number };
}

export function SpriteStatusBar({ refreshKey = 0 }: { refreshKey?: number }) {
  const [st, setSt] = useState<SpriteStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/asin-meta/status', { headers: authHeaders() });
      if (!r.ok) return;
      setSt(await r.json());
    } catch { /* 状态查不到不影响主流程 */ }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const last = st?.last?.status ? st.last : null;
  const bad = !!last && last.status !== 'ok';

  // 出问题时 4 秒自检（登录完提示自动消失）；正常时 20 秒低频看一眼，
  // 这样「采集完后台自动补失败」也能被发现
  useEffect(() => {
    const t = window.setInterval(load, bad ? 4000 : 20000);
    return () => window.clearInterval(t);
  }, [bad, load]);

  const openLogin = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/asin-meta/login', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) window.alert('打开登录窗口失败：' + (j.detail || j.error || '未知原因'));
      else window.setTimeout(load, 1500);
    } catch (e: any) {
      window.alert('打开登录窗口失败：' + (e?.message || e));
    } finally { setBusy(false); }
  };

  if (!bad) return null;

  const needLogin = last!.status === 'need_login';
  const noCred = needLogin && st?.cred && !st.cred.configured;

  return (
    <div className={'sprite-note' + (needLogin ? ' warn' : ' err')}>
      <span className="sprite-note-ic">{needLogin ? '⚠' : '✕'}</span>
      <span className="sprite-note-msg">
        {last!.message || '上架时间取数失败'}
        {noCred && (
          <em className="sprite-note-hint">（未配置账号：在项目目录执行 <code>python3 -m backend.sprite_cred set</code>）</em>
        )}
      </span>
      {last!.at && <span className="sprite-note-at">{last!.at}</span>}
      <span style={{ flex: 1 }} />
      {needLogin && !noCred && (
        <button className="sprite-note-btn" onClick={openLogin} disabled={busy}>
          {busy ? '打开中…' : '重新登录'}
        </button>
      )}
      <button className="sprite-note-btn ghost" onClick={load}>刷新</button>
    </div>
  );
}
