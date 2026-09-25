/**
 * SSE 流式聊天 — `POST /api/chat/stream`
 *
 * 帧格式（见 packages/server/src/webui/chat.ts）：
 *   { type: 'connected', sessionId }
 *   { type: 'chunk', kind: 'text' | 'reasoning', text }
 *   { type: 'done', reply }
 *   { type: 'aborted', message }
 *   { type: 'error', message }
 *
 * ★ 与 webui 的关键差异：`AbortSignal` **真的接进了 fetch**。
 *   webui 的 ChatView 建了 AbortController 并 abort()，但 streamChat 的 fetch
 *   从未接收 signal —— 请求照跑，只是界面假装停了（停止按钮是坏的）。
 */
import { getApiToken } from './client';

export type ChatFrame =
  | { type: 'connected'; sessionId: string }
  | { type: 'chunk'; kind: 'text' | 'reasoning'; text: string }
  | { type: 'done'; reply?: string }
  | { type: 'aborted'; message?: string }
  | { type: 'error'; message?: string };

/** 被主动中止（用户点了停止）——与真实错误区分，调用方不该当失败处理 */
export class StreamAbortedError extends Error {
  constructor() {
    super('已停止');
    this.name = 'StreamAbortedError';
  }
}

export type StreamChatOptions = {
  signal?: AbortSignal;
  onFrame: (frame: ChatFrame) => void;
};

/**
 * 发起流式对话。返回 Promise：流正常结束 resolve；被中止 reject `StreamAbortedError`；
 * 网络/HTTP 失败 reject `Error`（已 console.error）。
 */
export async function streamChat(
  text: string,
  sessionId: string,
  { signal, onFrame }: StreamChatOptions,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getApiToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, sessionId }),
      signal, // ★ 关键：不传这个，停止按钮就是摆设
    });
  } catch (err) {
    if (isAbortError(err)) throw new StreamAbortedError();
    console.error('[stream] 连接失败', err);
    throw new Error('无法连接到服务端');
  }

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    console.error(`[stream] HTTP ${res.status}`, raw.slice(0, 300));
    throw new Error(`HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件；最后一段可能不完整，留在 buffer 里等下一块
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onFrame(JSON.parse(payload) as ChatFrame);
        } catch {
          // 单帧畸形不该炸掉整条流，但要留痕
          console.warn('[stream] 跳过畸形帧', payload.slice(0, 200));
        }
      }
    }
  } catch (err) {
    if (isAbortError(err)) throw new StreamAbortedError();
    console.error('[stream] 读取中断', err);
    throw err instanceof Error ? err : new Error('流读取失败');
  } finally {
    // 中止时释放 reader，避免连接悬挂
    reader.cancel().catch(() => {});
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException
      ? err.name === 'AbortError'
      : (err as { name?: string })?.name === 'AbortError'
  );
}
