/**
 * API client — unary RPC + SSE 流式(抄 dsh 传输思路,本地同源)
 * 业务错误统一 {ok:false, error} 信封;HTTP 非 2xx 抛错
 */

export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export const api = {
  get: <T = ApiResult>(path: string) => request<T>('GET', path),
  post: <T = ApiResult>(path: string, body?: unknown) => request<T>('POST', path, body),
  del: <T = ApiResult>(path: string) => request<T>('DELETE', path),
};

/** SSE 聊天流:解析 data: JSON 帧,回调逐帧;返回 Promise(流结束 resolve) */
export function streamChat(
  path: string,
  body: unknown,
  onFrame: (frame: Record<string, unknown>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          reject(new ApiError(res.status, `HTTP ${res.status}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith('data: ')) continue;
              try {
                onFrame(JSON.parse(line.slice(6)) as Record<string, unknown>);
              } catch { /* skip malformed */ }
            }
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}
