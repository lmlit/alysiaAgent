/**
 * API 客户端 — 同源 /api（dev 经 next.config rewrites 代理到 6185）
 *
 * ★ 与 packages/webui/src/api/client.ts 保持一致的关键约定（见 spec: alysia-console §3）：
 *   - Bearer token 存 localStorage，键 `webui_token`（两个前端共用，token 不用配两遍）
 *   - 401 视为"未鉴权"，由 TokenGate 弹出输入框，不在这里静默重试
 *   - 非 2xx 一律抛 ApiError（带 status + 响应体片段），绝不吞错
 */

const TOKEN_KEY = 'webui_token';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** 响应体片段（已截断），排查用 */
    public body?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── token 存取 ─────────────────────────────────────────

export function getApiToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    // 隐私模式下 localStorage 可能不可用——不静默：打日志，按未配置处理
    console.warn('[api] localStorage 不可读，按未配置 token 处理');
    return '';
  }
}

export function setApiToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (err) {
    console.error('[api] 保存 token 失败', err);
  }
}

// ── 鉴权状态（供 TokenGate 订阅）────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();
let unauthorized = false;

export function subscribeUnauthorized(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isUnauthorized(): boolean {
  return unauthorized;
}

/** 收到 401 时调用：标记未鉴权并通知订阅者 */
function markUnauthorized(): void {
  if (unauthorized) return;
  unauthorized = true;
  listeners.forEach((fn) => fn());
}

/** 配好 token 后调用，清除未鉴权标记 */
export function clearUnauthorized(): void {
  if (!unauthorized) return;
  unauthorized = false;
  listeners.forEach((fn) => fn());
}

// ── 请求 ───────────────────────────────────────────────

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getApiToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // 网络层失败（server 没起 / 代理不通）——必须可见
    console.error(`[api] ${method} ${path} 网络失败`, err);
    throw new ApiError(0, '无法连接到服务端，请确认 alysia server 已启动（默认 6185）');
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    const snippet = raw.slice(0, 300);
    console.error(`[api] ${method} ${path} → HTTP ${res.status}`, snippet);
    if (res.status === 401) markUnauthorized();
    throw new ApiError(res.status, `HTTP ${res.status}`, snippet);
  }

  // 检查响应体：服务端可能是空体（204）或非 JSON
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    console.error(`[api] ${method} ${path} 响应不是合法 JSON`, text.slice(0, 300));
    throw new ApiError(res.status, '服务端返回了非 JSON 响应', text.slice(0, 300));
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
