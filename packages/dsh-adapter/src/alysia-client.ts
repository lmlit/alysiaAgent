/**
 * alysia server 的 HTTP 客户端 —— dsh 侧的记忆/人格通道。
 *
 * ★★ **一切调用都是 best-effort**：alysia server 没起时，dsh **必须照常能用**。
 *    所以本文件的每个方法都**永不抛出**——失败只记日志并返回 `null`/`false`。
 *    理由：这是「锦上添花」的通道（记忆与动态人设），不是 dsh 的运行前提；
 *    让它的失败冒泡上去会让整个会话不可用。
 *
 * ★ 双进程模型（`openspec/specs/dsh-adapter/spec.md` §2）：alysia server 是记忆的
 *   **唯一写入者**。这里只回传原始事件，提取 / 5 道护栏 / 事实去重 / 冲突解决
 *   全在 server 侧做。
 */

/** 默认基址（alysia WebUI/server 的本地端口） */
export const DEFAULT_ALYSIA_BASE_URL = 'http://127.0.0.1:6185';

/** 单次请求超时。本地回环，慢于这个值说明对面不对劲，不拖住 dsh */
const DEFAULT_TIMEOUT_MS = 5000;

/** 回传事件的形状（与 alysia `/api/ingest` 的契约一致） */
export interface IngestEvent {
  id: string;
  session_id: string;
  /** ★ 2026-10-02：固定 `'code'` —— dsh 是编程环境，见 index.ts 的说明 */
  source: 'code';
  type: 'message';
  payload: { role: 'user' | 'assistant'; content: string };
  created_at: string;
}

export interface IngestResult {
  accepted: number;
  rejected: string[];
}

/** 一条召回的记忆（与 alysia 的 `SearchResult` 对齐） */
export interface RetrievedMemory {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface MemoryReadResult {
  /** **组装好的注入文本**（server 侧与聊天管线同一函数）——直接就是 memory context */
  context: string;
  /** 原始召回，供 `recall_memory` 工具渲染 */
  retrieved: RetrievedMemory[];
}

/** 极简日志接口（避免把 dsh 的 logger 类型拖进来） */
export interface ClientLogger {
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
}

export interface AlysiaClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  logger?: ClientLogger;
}

export class AlysiaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger?: ClientLogger;
  /** 连续失败计数——只用来把日志降噪（前几次 warn，之后闭嘴） */
  private failureStreak = 0;

  constructor(opts: AlysiaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_ALYSIA_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger;
  }

  /** 取动态人设文本（紧凑形式）。失败返回 null，调用方保留旧值 */
  async getPersonaPrompt(): Promise<string | null> {
    const data = await this.request('GET', '/api/persona/prompt');
    const prompt = (data as { prompt?: unknown } | null)?.prompt;
    return typeof prompt === 'string' && prompt.length > 0 ? prompt : null;
  }

  /** 回传一批会话事件。失败返回 null（调用方据此决定是否丢弃） */
  async ingest(events: IngestEvent[]): Promise<IngestResult | null> {
    if (events.length === 0) return { accepted: 0, rejected: [] };
    const data = await this.request('POST', '/api/ingest', { events });
    if (data === null) return null;
    const r = data as { accepted?: unknown; rejected?: unknown };
    return {
      accepted: typeof r.accepted === 'number' ? r.accepted : 0,
      rejected: Array.isArray(r.rejected) ? (r.rejected as string[]) : [],
    };
  }

  /**
   * 检索记忆。失败返回 null（调用方保留旧缓存）。
   *
   * ★ `query` 为空串也照常调用：`[关于你]`/`[你的偏好]` 等块**不依赖 query**，
   *   挂载预热正是靠这一点，否则第一轮会一片空白（provider 同步，等不到异步检索）。
   *
   * @param sessionId alysia 侧会话 id（已带前缀）。用于会话摘要的按类型过滤
   */
  async readMemory(query: string, sessionId?: string): Promise<MemoryReadResult | null> {
    const data = await this.request('POST', '/api/memory/read', { query, sessionId, limit: 5 });
    if (data === null) return null;
    const r = data as { context?: unknown; retrieved?: unknown };
    return {
      context: typeof r.context === 'string' ? r.context : '',
      retrieved: Array.isArray(r.retrieved) ? (r.retrieved as RetrievedMemory[]) : [],
    };
  }

  /**
   * 触发会话结算（摘要 + 画像提取 + 人格确认 + 固化）。
   *
   * 复用 alysia 现成的 `POST /api/sessions/:id/extract`
   * （= `sessionEndProcessor.process()`）——服务端不需要为此新增接口。
   *
   * @param alysiaSessionId 已带 `dsh:` 前缀的会话 id（**不要**在这里拼前缀）
   */
  async extractSession(alysiaSessionId: string): Promise<boolean> {
    const data = await this.request(
      'POST',
      `/api/sessions/${encodeURIComponent(alysiaSessionId)}/extract`,
      {},
    );
    return data !== null;
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 统一的请求入口。**任何失败都返回 null，绝不抛** */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown | null> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        // 把响应体读出来 —— 只说「HTTP 400」等于没说（本项目反复栽过的坑）
        const text = await resp.text().catch(() => '');
        this.noteFailure(`${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 200)}`);
        return null;
      }
      this.failureStreak = 0;
      return await resp.json();
    } catch (err: any) {
      // 连接被拒 / 超时 / 非 JSON 都归这里。ECONNREFUSED = alysia 没起，是常态不是异常
      this.noteFailure(`${method} ${path} → ${err?.name === 'AbortError' ? `超时(${this.timeoutMs}ms)` : err?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 失败降噪：连续失败只在前几次报 warn，之后静默。
   *
   * alysia 没起时每轮都会失败——每次都吼会把 dsh 自己的日志淹掉。
   */
  private noteFailure(detail: string): void {
    this.failureStreak++;
    if (this.failureStreak <= 3) {
      this.logger?.warn(`[alysia] ${detail}${this.failureStreak === 3 ? '（后续同类失败将静默）' : ''}`);
    }
  }
}
