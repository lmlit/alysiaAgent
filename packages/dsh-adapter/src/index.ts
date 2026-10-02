/**
 * @alysia/dsh-adapter — 把昔涟人格/记忆接入 DeepSeek Harness 的插件。
 *
 * 挂载方式：由 bundle patch 的 `preset-alysia` 声明作为 **preset 插件**引用
 * （见 `../cordis.patch.yml`），注册落入该 agent 的 scoped layer，随会话卸载自动清理。
 *
 * ★ 人格走**变量**（`alysia_persona`）而不是写死在 preset 里 ——
 *   这样「原模式 / 昔涟模式」在**同一个 preset 内**可切换，不必做成两个并列模式。
 *   见 `persona.ts` 的文件头说明。
 */

import type { Context } from './types.ts'
import type { AssembleContext, SessionEvent } from './types.ts'
import { createRecallMemoryTool } from './recall-memory.ts'
import { AlysiaClient } from './alysia-client.ts'
import type { IngestEvent } from './alysia-client.ts'
import { sessionIdOf, toAlysiaSessionId } from './session-id.ts'
// PERSONA_VARIABLE 定义在 persona.ts（与变量注册处共用同一常量）
export { PERSONA_VARIABLE } from './persona.ts'

/** Cordis 插件名(composition 行的 name 字段按此解析) */
export const name = 'alysia-adapter'

/**
 * 注入的服务依赖。★ cordis 的 ctx 是 Proxy:未声明的服务访问即抛
 * "cannot get property X without inject"——必须在此声明。
 * systemPrompt = prompt 注册表(tools 服务自身也依赖它);tools = 工具注册表。
 */
export const inject = ['systemPrompt', 'tools']

/** 插件配置(二期:记忆旋钮等) */
export interface Config {
  /** dsh 侧日志级别:'info' 默认;'debug' 打开 session/event 明细 */
  logLevel?: 'info' | 'debug'
  /** alysia server 基址（缺省 `http://127.0.0.1:6185`） */
  alysiaBaseUrl?: string
  /** 关掉记忆回传（默认开）。alysia 不在时开着也无妨——一切调用都是 best-effort */
  bridge?: boolean
  /**
   * 预热结果的复用窗口（毫秒，默认 30000）。
   *
   * 桌面端启动会恢复多个会话 → 每个会话挂一个插件实例 → 各做一次预热。
   * 一个进程内共享一次就够（预热用空 query，结果与具体会话无关）。
   * **设 0 = 每次挂载都重新拉**（测试用；生产中这么做正是本项要消除的浪费）。
   */
  prewarmReuseMs?: number
}

/**
 * 插件应用入口。ctx 为挂载 scope 的上下文(preset 内 → 本 agent 层)。
 * 所有注册返回 exact disposer;ctx.on 随 ctx 卸载自动清理。
 */
export function apply(ctx: Context, config: Config = {}): void {
  // ★ 启动日志：插件挂没挂上**必须能观测**。
  //   否则「preset 没生效」时无法区分「插件没加载」和「加载了但注册没生效」。
  ctx.logger.info('[alysia-adapter] 已挂载（记忆 context + recall_memory + 会话钩子）');

  // ── 1. persona：由 **host 行** `@alysia/dsh-adapter/persona-variable` 注册变量 ──
  //   2026-10-01 两处修正：
  //   ① 原先手搓 `deployment:persona` + order 0 —— 该 section 名在 dsh 0.2 已失效
  //      （现为 `deployment:persona-prefix`），且要同时遮蔽 suffix 才完整，
  //      故改由 dsh 自带的 `@deepseek-ai/dsh-persona` 承担（见 cordis.patch.yml）。
  //   ② 人设文本改走模板变量 `{{alysia_persona}}`（同文件中常量），使
  //      「原版 / 昔涟」可在**同一个 preset 内**切换，而非两个并列模式。
  //
  //   ⚠️ 变量注册**不在这里**：本插件是 preset 插件，要等 preset 被选中才挂载，
  //     与 persona 模板的渲染时序绑在一起有硬失败风险（未知变量 → throw）。
  //     改由 host 行注册 —— 与 dsh 自己注册 `{{model}}`/`{{cwd}}` 的形态一致。
  //     见 `persona-variable.ts`。

  // ── 与 alysia 的通道（先建：记忆 context / 工具 / 回传三处都要用）──
  const client = new AlysiaClient({
    baseUrl: config.alysiaBaseUrl,
    logger: ctx.logger,
  })

  // ── 2. 记忆 context（缓存 + 后台刷新，change: bridge-memory-read）──
  //   ★ dsh 的 context provider **必须同步返回** —— `assemble()` 虽是 async，
  //     但 provider 调用点没有 await（`renderContextSections` 是同步 map）。
  //     所以只能给缓存，真正的检索在后台跑。
  //   ★ **挂载时预热一次**（query 为空）：`[关于你]`/`[你的偏好]`/`[关于你的事实]`
  //     等块**不依赖 query**（直接读 store），所以第一轮就有记忆——
  //     而不是从第二轮才开始想起你是谁。查询相关的 `[相关记忆]` 慢一拍可接受
  //     （相邻几轮通常同话题），要即时的让她调 `recall_memory`。
  let memoryContext = '';
  let memorySessionId: string | undefined;

  /**
   * 唯一的写入口——**预热与刷新都必须走它**。
   *
   * ⚠️ 曾经只有刷新走、预热直接赋值，于是**第一轮（靠预热的那轮）看不到引导提示**。
   *   两处收敛成一个，避免再分叉。
   */
  const setMemoryContext = (raw: string): void => {
    if (raw) memoryContext = withRecallHint(raw);
    // 空：保留旧值（失败时客户端已记日志，不抛）
  };

  const refreshMemory = async (query: string): Promise<void> => {
    const r = await client.readMemory(query, memorySessionId);
    if (r) setMemoryContext(r.context);
  };

  /**
   * 在记忆块末尾加一句「可以主动查」。
   *
   * ★ 为什么加在这里而不是只改工具描述：**这段文本是她每轮真正看到的东西**，
   *   而工具描述躺在工具目录里、不主动提示就去不到。
   *   实践中她倾向于用手上已有的信息直接回答，不会想到还有工具可查。
   *
   * ★ 只在**有内容时**加：上下文为空说明 alysia 没起（工具同样会失败），
   *   这时提示她去查等于让她白跑一趟。
   */
  const withRecallHint = (context: string): string =>
    `${context}\n\n（以上是自动带上的记忆概览。要回忆更具体的事，用 recall_memory 工具查。）`;

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'alysia:memory',
    order: -50,
    text: (): string => memoryContext,
  }), 'alysia-adapter.memory-context()')

  // ── 3. 生活事件 variable 骨架({{alysia_life}})──
  // dsh 对模板变量严格校验:section 未引用即安全;二期 provider 调
  // memory.getLifeEventInjection() 返回今日事件文本。
  ctx.effect(() => ctx.systemPrompt.variable(
    'alysia_life',
    (_context: AssembleContext): string | undefined => undefined,
  ), 'alysia-adapter.life-variable()')

  // ── 4. recall_memory 工具（实时、按需的准确路径）──
  ctx.effect(() => ctx.tools.register(createRecallMemoryTool(client)), 'alysia-adapter.recall-memory()')

  // ── 5. 记忆回传（2026-10-01，change: connect-dsh-alysia-bridge）──
  //   对话 → alysia 记忆库。**写操作的唯一入口是 server 的 POST /api/ingest**：
  //   提取 / 5 道护栏 / 事实去重 / supersede 冲突解决全在 server 侧做（双进程模型）。
  const debug = config.logLevel === 'debug'

  if (config.bridge === false) {
    ctx.logger.info('[alysia-adapter] 记忆通道已关闭（config.bridge=false）——只剩 recall_memory 工具');
  } else {
    // 预热（不 await：不能拖慢插件挂载）。★ 走模块级共享，多实例只发一次
    void sharedPrewarm(client, config.prewarmReuseMs).then(setMemoryContext);
    installBridge(ctx, client, debug, (text, alysiaSessionId) => {
      memorySessionId = alysiaSessionId;
      void refreshMemory(text);
    });
  }
}

/**
 * 记忆回传：累积对话 → 轮结束批量回传 → 会话结束触发结算。
 *
 * 回传时机（2026-10-01 决策）：
 *   - **`turn/end`**：一轮说完就发。批量而非每条，减少请求数。
 *   - **`session/disposed`**：兜底把尾巴发出去，然后触发结算。
 *
 * 队列策略：回传失败**保留一批**等下次重试（容忍 alysia 短暂重启）；
 * 但设上限，长期不可用时丢最旧的并计数——不能无限涨内存。
 */
function installBridge(
  ctx: Context,
  client: AlysiaClient,
  debug: boolean,
  /** 用户消息到达时回调：`(原话, alysia 侧会话 id)` —— 用于刷新记忆缓存 */
  onUserMessage: (text: string, alysiaSessionId: string) => void,
): void {
  let pending: IngestEvent[] = [];
  let dropped = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const result = await client.ingest(batch);
    if (result === null) {
      // alysia 不可达 —— 放回队首等下次（有上限，不会无限涨）
      pending = [...batch, ...pending];
      if (pending.length > MAX_PENDING) {
        dropped += pending.length - MAX_PENDING;
        pending = pending.slice(pending.length - MAX_PENDING);
      }
      ctx.logger.warn(`[alysia-adapter] 回传失败，${batch.length} 条暂存（累计丢弃 ${dropped}）`);
      return;
    }
    if (result.rejected.length > 0) {
      // 拒收必须报出来 —— 静默丢弃会让「回传成功」和「其实没进库」长得一样
      ctx.logger.warn(
        `[alysia-adapter] 回传 ${result.accepted} 条，${result.rejected.length} 条被拒：${result.rejected.slice(0, 2).join(' | ')}`,
      );
    } else if (debug) {
      ctx.logger.info(`[alysia-adapter] 回传 ${result.accepted} 条`);
    }
  };

  ctx.on('session/event', (session, event: SessionEvent) => {
    const sid = sessionIdOf(session);
    if (event.type === 'user/message') {
      {
        const text = extractText(event.data).trim();
        if (text) {
          onUserMessage(text, toAlysiaSessionId(sid));
          push({ role: 'user', text });
        }
      }
    } else if (event.type === 'assistant/message') {
      const text = extractText(event.data).trim();
      if (text) push({ role: 'assistant', text });
    } else if (event.type === 'turn/end') {
      void flush();
    }

    if (debug || event.type === 'user/message' || event.type === 'assistant/message') {
      ctx.logger.info(`[alysia-adapter] session/event ${event.type}`);
    }

    /** 入队 + 超限丢弃最旧的 */
    function push(msg: { role: 'user' | 'assistant'; text: string }): void {
      pending.push({
        // ★ 去重键 = 会话 + seq：同一事件重传不会在记忆里产生两条
        id: `dsh-${sid}-${event.seq}`,
        session_id: toAlysiaSessionId(sid),
        // ★ 2026-10-02 record-dsh-as-coding-mode：**不是 'chat'**。
        //   `EventSource` 本来就有 'code'，且 `RealtimeProcessor:41` 已经按它分流：
        //     `const mode = event.source === 'code' ? 'code' : 'chat'`
        //     → `worldbookMatcher.match(text, mode)`
        //   标成 'chat' 会让 `scope: 'chat'` 的世界书条目在编程对话里**误触发**，
        //   而 `scope: 'code'` 的匹配不到。
        //   语义上 'code' 指**来源环境**（dsh 是编程环境），不是话题分类——
        //   在 dsh 里闲聊两句生活，仍然是编程环境里发生的。
        source: 'code',
        type: 'message',
        payload: { role: msg.role, content: msg.text },
        created_at: new Date(event.time || Date.now()).toISOString(),
      });
      if (pending.length > MAX_PENDING) {
        pending.shift();
        dropped++;
      }
    }
  });

  // 会话结束 → 先把尾巴发出去，再触发**结算**（摘要 + 画像 + 人格确认 + 固化）
  ctx.on('session/disposed', (session) => {
    const sid = sessionIdOf(session);
    ctx.logger.info(`[alysia-adapter] session/disposed → 结算 ${toAlysiaSessionId(sid)}`);
    void (async () => {
      await flush();
      await client.extractSession(toAlysiaSessionId(sid));
    })();
  });
}

/** 待回传队列上限。alysia 长期不可用时丢最旧的，不无限涨内存 */
const MAX_PENDING = 500;

/**
 * 模块级共享的「预热」结果。
 *
 * ★★ 为什么必须在**模块级**而不是实例里（2026-10-02 实测）：
 *   桌面端启动会恢复多个会话，**每个会话挂一个插件实例**，
 *   各做一次预热 → 实测一次启动打了 **9 次** `/api/memory/read`
 *   （9 次 HTTP + 9 次 embedding 调用，纯浪费）。
 *
 *   预热用的是**空 query**，结果与具体会话无关（`[关于你]` 那些块是全局画像），
 *   所以同一进程内共享一次就够。
 *
 * ★ 带 30 秒复用窗口：
 *   - 启动那一波（同一秒内挂载的 9 个实例）合并成一次；
 *   - 更晚挂载的新会话不会拿到几分钟前的旧数据，仍会自己去拉。
 *
 * ★ 只去重预热。**带 query 的刷新是逐会话的**（各实例在自己的用户消息到达后
 *   各自刷新，那次结果确实与会话相关），不去重。
 */
const PREWARM_REUSE_MS = 30_000;
let prewarmCache: { at: number; text: string } | null = null;
let prewarmInFlight: Promise<string> | null = null;

/**
 * 预热（空 query 检索）。同进程内并发调用、以及窗口期内的重复调用，都只发一次请求。
 *
 * @param reuseMs 复用窗口；`0` 表示每次都重拉
 */
function sharedPrewarm(client: AlysiaClient, reuseMs: number = PREWARM_REUSE_MS): Promise<string> {
  if (reuseMs > 0 && prewarmCache && Date.now() - prewarmCache.at < reuseMs) {
    return Promise.resolve(prewarmCache.text);
  }
  if (!prewarmInFlight) {
    prewarmInFlight = (async (): Promise<string> => {
      try {
        const r = await client.readMemory('');
        const text = r?.context ?? '';
        // ★ 成功就写缓存 —— 窗口只管「要不要读」，不管「要不要写」。
        //   （写反过一次：窗口=0 时连缓存都不写，于是紧接着用默认窗口的挂载又要重拉。）
        if (text) prewarmCache = { at: Date.now(), text };
        return text;
      } catch {
        return '';   // best-effort：预热失败就留空，第一轮没记忆不是什么大事
      } finally {
        prewarmInFlight = null;
      }
    })();
  }
  return prewarmInFlight;
}

/**
 * 从 dsh 消息事件 data 提取文本。
 *
 * ★★ 实测形状（2026-10-01，从 dsh 源码 `dsh-agent-loop` 的事件构造点读出）：
 *
 *     session.append('assistant/message', { turn, step, message: createAssistantMessage(...) })
 *                                                                 ↑ content 在这里面
 *
 *   即 **`data.message.content`（块数组，块为 `{type:'text', text}`）**，
 *   **不是** `data.content`。
 *
 *   原先只看 `data.content` —— 那是**错的**，会让每条消息都取到空串，
 *   于是回传静默变成「一条都没发」（队列永远为空，连日志都不会有）。
 *   顶层 `data.content` 作为兼容保留：dsh 若在某版本把 message 摊平也能取到。
 */
function extractText(data: unknown): string {
  const d = data as { message?: { content?: unknown }; content?: unknown } | null | undefined
  const content = d?.message?.content ?? d?.content
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text ?? '' : ''))
      .join('')
  }
  return typeof content === 'string' ? content : ''
}
