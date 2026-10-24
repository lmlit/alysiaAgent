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

/**
 * 鉴权 token 的环境变量名 —— 对应 alysia 的 `server.webuiToken`。
 *
 * ★ 2026-10-17（change: `connect-server-dsh-bridge`）：token **只经环境变量/config 传递**，
 *   源码与仓库内不得出现字面量。
 */
export const TOKEN_ENV_VAR = 'ALYSIA_WEBUI_TOKEN';

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

/**
 * 一次回传的结果 —— **判别式联合，不压成 `null`**。
 *
 * ★ 2026-10-16（change: `fix-dsh-ingest-and-settlement`，契约 3）：
 *   旧契约是 `IngestResult | null`，把「服务端明确拒收」和「根本连不上」压成同一个 `null`，
 *   **信息在传输层就丢了**——上层只能把 413 也当成「alysia 不可达」放回队列，
 *   于是**同样的输入永远重复同一个 413**，队列永久卡死（KI-24 的邻居缺陷）。
 *
 * 三类必须分开（契约 3）：
 *   - `ok`          服务端受理了。`rejected[]` 是**逐条**永久拒收（部分成功）
 *   - `permanent`   **4xx**：整批被拒，重试无用。**含 413** —— 它是**契约漂移**信号
 *                   （服务端上限被下调 / 适配器版本旧），必须响亮上报，不许降级处理
 *   - `unreachable` 连接失败 / 超时 / **5xx**：可重试，批次放回队列等下次触发
 */
export type IngestOutcome =
  | { kind: 'ok'; accepted: number; rejected: string[] }
  | { kind: 'permanent'; reason: string }
  | { kind: 'unreachable'; reason: string };

/** 内部：带失败分类的请求结果。`ok` 才带 data；其余两种情况由调用方各自映射 */
type RawRequestResult =
  | { kind: 'ok'; data: unknown }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'transport'; reason: string };

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
  /**
   * alysia WebUI 的 Bearer token。**缺省读环境变量 `ALYSIA_WEBUI_TOKEN`**。
   *
   * ★ 为什么需要它（2026-10-17，change: `connect-server-dsh-bridge`）：
   *   alysia 在**需要鉴权**的部署下（容器内绑非回环地址 ⇒ `requireAuth = true`）
   *   对 `/api/*` 强制 `Authorization: Bearer <token>`，**只有 `/api/health` 豁免**。
   *   此前本客户端不带任何鉴权头 ⇒ 桥接调用**全部 401**；而本文件按设计 best-effort 降级，
   *   于是症状只是「人设与记忆都是空的」——**不会响亮失败**，极难排查。
   *
   * 语义：传入 `''` 表示**显式不带 token**（不再回落到环境变量）；`undefined` 才读环境变量。
   */
  token?: string;
}

export class AlysiaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger?: ClientLogger;
  /** 已解析的 Bearer token（空串 = 不带鉴权头）。解析顺序：显式 config > 环境变量 */
  private readonly token: string;
  /** 连续失败计数——只用来把日志降噪（前几次 warn，之后闭嘴） */
  private failureStreak = 0;

  constructor(opts: AlysiaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_ALYSIA_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger;
    // `undefined` 才回落环境变量；显式 `''` = 明确不带 token
    const raw = opts.token !== undefined ? opts.token : process.env[TOKEN_ENV_VAR];
    this.token = (raw ?? '').trim();
  }

  /** 取动态人设文本（紧凑形式）。失败返回 null，调用方保留旧值 */
  async getPersonaPrompt(): Promise<string | null> {
    const data = await this.request('GET', '/api/persona/prompt');
    const prompt = (data as { prompt?: unknown } | null)?.prompt;
    return typeof prompt === 'string' && prompt.length > 0 ? prompt : null;
  }

  /**
   * 回传一批会话事件。
   *
   * ★ 仍**永不抛出**（见文件头）：失败只体现为 `unreachable` / `permanent`。
   * ★ 分批**不在这里**：切批是投递队列的职责（它要逐批归因、逐批决定重试与否）。
   *   调用方必须保证 `events.length` 不超过服务端单批上限（`MAX_INGEST_BATCH`，当前 200）。
   */
  async ingest(events: IngestEvent[]): Promise<IngestOutcome> {
    if (events.length === 0) return { kind: 'ok', accepted: 0, rejected: [] };

    const r = await this.requestRaw('POST', '/api/ingest', { events });

    if (r.kind === 'transport') return { kind: 'unreachable', reason: r.reason };
    if (r.kind === 'http') {
      const reason = `HTTP ${r.status}: ${r.body.slice(0, 200)}`;
      // 4xx = 永久拒收（含 413）；5xx = 服务端暂时故障，可重试
      return r.status >= 400 && r.status < 500
        ? { kind: 'permanent', reason }
        : { kind: 'unreachable', reason };
    }

    const d = r.data as { accepted?: unknown; rejected?: unknown };
    return {
      kind: 'ok',
      accepted: typeof d.accepted === 'number' ? d.accepted : 0,
      rejected: Array.isArray(d.rejected) ? (d.rejected as string[]) : [],
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
    // ★ 2026-10-24（change: align-dsh-memory-blocks-with-scope）：**必须显式给这两个字段**。
    //
    //   dsh 是编程环境，但我们要的是「聊天那块表」——人味块（关于你/偏好/事实/关于我/
    //   待确认/最近对话/说话的分寸）只在 chat 表里，code 表一个都没有。
    //   而世界书要 **code scope**：干活的对话不该触发闲聊条目。
    //
    //   不给会回到"mode 一词三义"的老问题：默认 chat ⇒ 世界书 triggers 匹配完被丢弃，
    //   于是 dsh 的世界书一条都进不了 prompt（2026-10-02 上线 → 2026-10-24 发现，22 天）。
    const data = await this.request('POST', '/api/memory/read', {
      query,
      sessionId,
      limit: 5,
      blocks: 'chat',
      worldbookScope: 'code',
    });
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

  /** 统一的请求入口。**任何失败都返回 `null`，绝不抛**（读路径用；写路径用 `requestRaw`） */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown | null> {
    const r = await this.requestRaw(method, path, body);
    return r.kind === 'ok' ? r.data : null;
  }

  /**
   * 带**失败分类**的请求入口。绝不抛。
   *
   * ★ 为什么不能只返回 `null`：`ingest` 必须区分「服务端拒收」（4xx，重试无用）
   *   与「连不上」（可重试）。压成一个 `null` 就再也分不出来（change:
   *   `fix-dsh-ingest-and-settlement` 契约 3）。
   */
  private async requestRaw(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<RawRequestResult> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // ★ 有 token 才带这个头：不带时行为与旧版逐字一致（本机免鉴权部署不受影响）
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const resp = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        // 把响应体读出来 —— 只说「HTTP 400」等于没说（本项目反复栽过的坑）
        const text = await resp.text().catch(() => '');
        const detail = `${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 200)}`;
        this.noteFailure(detail);
        return { kind: 'http', status: resp.status, body: text };
      }
      this.failureStreak = 0;
      return { kind: 'ok', data: await resp.json() };
    } catch (err: any) {
      // 连接被拒 / 超时 / 非 JSON 都归这里。ECONNREFUSED = alysia 没起，是常态不是异常
      const reason = `${method} ${path} → ${err?.name === 'AbortError' ? `超时(${this.timeoutMs}ms)` : err?.message ?? err}`;
      this.noteFailure(reason);
      return { kind: 'transport', reason };
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
