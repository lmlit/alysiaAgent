'use client';

import { useState, useSyncExternalStore } from 'react';
import { KeyRound } from 'lucide-react';
import {
  isUnauthorized,
  setApiToken,
  subscribeUnauthorized,
  clearUnauthorized,
  getApiToken,
} from '@/lib/api/client';
import { XilianAvatar } from '@/components/xilian-avatar';

/**
 * 服务端要求 Bearer token（cr-p0-webui-auth，fail closed：没配 token 时 /api/* 全 401）。
 * 任何请求收到 401 → 弹出本遮罩 → 存 token 到 localStorage（键 webui_token，与 webui 共用）
 * → 重载页面让所有已发请求重跑。
 */
export function TokenGate() {
  const locked = useSyncExternalStore(
    subscribeUnauthorized,
    isUnauthorized,
    () => false, // SSR 快照：服务端没有 localStorage，一律视为未锁定
  );
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!locked) return null;

  const submit = () => {
    const t = input.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    setApiToken(t);
    clearUnauthorized();
    // 重载让所有失败的请求重新发起（与 webui App.vue 同策略）
    window.location.reload();
  };

  const hasStaleToken = !!getApiToken();

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-background/85 p-5 backdrop-blur-md">
      <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-7 warm-glow">
        <div className="flex justify-center">
          <XilianAvatar size={72} intensity="soft" />
        </div>
        <h2 className="mt-5 text-center font-display text-2xl">需要访问凭据</h2>
        <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
          {hasStaleToken
            ? '已保存的凭据被服务端拒绝了，请重新输入。'
            : '服务端开启了鉴权。填入 ALYSIA_WEBUI_TOKEN 后即可进入。'}
        </p>

        <div className="mt-6 flex items-center gap-2 rounded-2xl border border-border bg-background/60 py-2 pl-4 pr-2 transition-colors focus-within:border-primary/50">
          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="password"
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="粘贴 token…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={submit}
            disabled={!input.trim() || submitting}
            className="shrink-0 rounded-xl bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-all hover:scale-[1.03] disabled:opacity-40"
          >
            进入
          </button>
        </div>

        <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
          token 存在本机浏览器，不会上传。服务器上见 <code className="text-foreground/70">~/alysia/.env</code> 的{' '}
          <code className="text-foreground/70">ALYSIA_WEBUI_TOKEN</code>。
        </p>
      </div>
    </div>
  );
}
