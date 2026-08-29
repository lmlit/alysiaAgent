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

// ★ 8-29 cr-p0-webui-auth：Bearer token 持久化（localStorage）
const TOKEN_KEY = 'webui_token';
export function getWebuiToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function setWebuiToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getWebuiToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getWebuiToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch(path, {
      method: 'POST',
      headers,
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
