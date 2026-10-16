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
import { IngestDelivery } from './delivery.ts'
import { isSubagentSession, sessionIdOf, toAlysiaSessionId } from './session-id.ts'
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
   * ★ 第三批（2026-10-16）· 缓存乱序：**按序号落地，后发起的永远赢**。
   *
   * 记忆检索有**两条链**，各自 `.then(setMemoryContext)`：
   *   - 挂载时的**预热**（空 query —— 启动那一波，通常最慢）
   *   - 用户消息到达后的**刷新**（原话 query —— 话题相关）
   *
   * 预热**更早发起、可能更晚返回**，于是它落地时把话题刷新的结果**覆盖掉**：
   * 那一轮她看到的记忆比上一轮**还旧**（而且是"没话题的上古快照"，不是最新话题）。
   * 这属于典型的**乱序响应**缺陷，只按"谁先回来谁生效"写就必然中招。
   *
   * 修法：每次**发起**检索时领一个单调递增的序号；结果落地时，
   * **不比已应用的更旧才允许写入**（`>=` 允许"同一批里较新的那次"覆盖自身）。
   */
  let issuedSeq = 0;
  let appliedSeq = 0;

  /**
   * 唯一的写入口——**预热与刷新都必须走它**。
   *
   * ⚠️ 曾经只有刷新走、预热直接赋值，于是**第一轮（靠预热的那轮）看不到引导提示**。
   *   两处收敛成一个，避免再分叉。
   *
   * @param seq 发起该次检索时领的序号（见 `issuedSeq`）；乱序晚归的旧结果会被丢弃
   */
  const setMemoryContext = (raw: string, seq: number): void => {
    if (seq < appliedSeq) return;   // 乱序晚归的**旧**结果：丢弃（本轮保持更新的那份）
    if (raw) {
      memoryContext = withRecallHint(raw);
      appliedSeq = seq;
    }
    // 空：保留旧值（失败时客户端已记日志，不抛），也不推进 appliedSeq
  };

  const refreshMemory = async (query: string): Promise<void> => {
    const mySeq = ++issuedSeq;
    const r = await client.readMemory(query, memorySessionId);
    if (r) setMemoryContext(r.context, mySeq);
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
    // ★ 序号在**发起时**领（不是返回时）—— 否则晚归的预热会拿着"最新号"把刷新盖掉。
    const prewarmSeq = ++issuedSeq;
    void sharedPrewarm(client, config.prewarmReuseMs).then(t => setMemoryContext(t, prewarmSeq));
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
 * 队列策略（★ 2026-10-16 重做，change: `fix-dsh-ingest-and-settlement`）：
 *   分批 / 串行化 / 故障分类 / 不静默丢弃 都收敛到 `delivery.ts`（契约 1–4）；
 *   结算**必须等消息确认落库**（契约 5）并有**再次结算入口**（契约 6）；
 *   取不到会话 id 时 **fail closed**（契约 7）。契约全文见
 *   `openspec/specs/dsh-adapter/spec.md` §2.5.1。
 *
 * ★ **子 agent 会话一律跳过**（2026-10-02，change: exclude-subagent-sessions-from-bridge）：
 *   preset 是 standing mount 被父子 agent 共享，本插件的 scoped 监听**会**收到子会话事件
 *   （spec §2.5 原句「天然只收本 agent 事件」已被实证推翻）。判据见 `session-id.ts`。
 */
function installBridge(
  ctx: Context,
  client: AlysiaClient,
  debug: boolean,
  /** 用户消息到达时回调：`(原话, alysia 侧会话 id)` —— 用于刷新记忆缓存 */
  onUserMessage: (text: string, alysiaSessionId: string) => void,
): void {
  /**
   * 投递队列 —— 分批（≤ 服务端上限）、串行化、故障分类、不静默丢弃。
   * ★ 以前这里是一个内联的 `flush()` + `let pending`，在途批次对后来的调用方**不可见**
   *   （`flush` 开头即 `pending = []`）—— 那正是 KI-24 的根。
   */
  const delivery = new IngestDelivery({
    send: (events) => client.ingest(events),
    logger: ctx.logger,
  });

  /** 已提示过的子 agent 会话——每个只打一行 info，避免刷屏 */
  const notedSubagents = new Set<string>();
  /** 身份缺失的诊断：按**事件类型**限频（坏上游不许刷爆日志） */
  const notedMissingId = new Set<string>();
  /** 合成注入的诊断：同样限频（**不许静默** —— 否则"滤掉了"与"本来没采到"同形） */
  const notedSynthetic = new Set<string>();
  /** 因回传未完成 / 结算失败而**挂起**的会话：sid → 已尝试结算次数（去重，防 KI-19 式重复摘要） */
  const pendingSettlements = new Map<string, number>();

  /** 结算尝试上限：耗尽后**明确失败**，不再静默挂起 */
  const MAX_SETTLE_ATTEMPTS = 3;

  /**
   * 身份缺失 → **fail closed**（契约 7 / KI-23）。
   *
   * 与「子 agent 会话」同一条纪律：不回传、不结算，但**必须留痕**（限频）。
   * 静默跳过会让「上游契约破了」和「这轮本来没消息」长得一样。
   */
  const noteMissingId = (kind: string): void => {
    if (notedMissingId.has(kind)) return;
    notedMissingId.add(kind);
    ctx.logger.warn(
      `[alysia-adapter] ${kind}：取不到 dsh 会话 id —— **不回传、不结算**` +
        `（身份不明会把多个真实会话混进同一个桶；同类诊断此后静默）`,
    );
  };

  /**
   * 合成注入（runtime context 快照）→ 仍回传入库，但**不算用户发言**。
   *
   * 限频也**必须喊一次**：这是 KI-20 那个「画像回吸 / 记忆触发记忆」回路的入口，
   * 静默掉它，将来出问题时就分不清「滤掉了」和「本来就没采到」。
   */
  const noteSynthetic = (kind: string): void => {
    if (notedSynthetic.has(kind)) return;
    notedSynthetic.add(kind);
    ctx.logger.info(
      `[alysia-adapter] ${kind}：dsh 合成注入（source.kind=runtime-context）—— ` +
        `**不算用户发言**（不触发话题刷新；回传给服务端时打 skip_profile，见 ingest.ts）`,
    );
  };

  /** 结算一次。失败则**挂起**（下次成功排空后重试），尝试次数用尽后明确失败 */
  const trySettle = async (sid: string): Promise<void> => {
    const alysiaId = toAlysiaSessionId(sid);
    if (await client.extractSession(alysiaId)) {
      pendingSettlements.delete(sid);
      return;
    }
    const tried = (pendingSettlements.get(sid) ?? 0) + 1;
    if (tried >= MAX_SETTLE_ATTEMPTS) {
      pendingSettlements.delete(sid);
      ctx.logger.warn(`[alysia-adapter] 结算**失败**（已试 ${tried} 次，不再重试）：${alysiaId}`);
      return;
    }
    pendingSettlements.set(sid, tried);
    ctx.logger.warn(`[alysia-adapter] 结算未成功，挂起待重试（第 ${tried} 次）：${alysiaId}`);
  };

  /**
   * 排空 → **成功才**结算（契约 5 / KI-24）。
   *
   * ★ `delivery.drain()` 返回的是**覆盖在途批次**的链（契约 2），所以 await 完
   *   即代表该会话已排队与在途的消息都拿到了服务端确认。
   *
   * ★ 回传未完成时**不**宣布结算完成 —— 旧实现在这里无条件继续 extract：
   *   迟到事件的 `created_at`（dsh 事件时间）早于新摘要的 `ended_at`（服务端时间），
   *   会**永久**落在结算窗口之外，且摘要是 `summary_status='ok'`，补处理不会捡。
   */
  const drainThenSettle = async (sid: string): Promise<void> => {
    const r = await delivery.drain();
    if (!r.drained) {
      if (!pendingSettlements.has(sid)) pendingSettlements.set(sid, 0);
      ctx.logger.warn(
        `[alysia-adapter] 回传未完成（仍有 ${r.remaining} 条待发），结算**挂起**：${toAlysiaSessionId(sid)}`,
      );
      return;
    }
    await trySettle(sid);
  };

  /**
   * `turn/end` 的排空 + **补做挂起的结算**（契约 6：再次结算入口）。
   *
   * 不依赖「下一次刚好有消息」——只要还有成功排空的机会，挂起的结算就会被重试。
   * ⚠️ 已知边界：若插件实例在排空成功前就被卸载，这条重试链随之消失，
   *    此时只保证「**不结算 + 响亮失败**」（不写一个假的完成态），不保证补上。
   */
  const drainAndRetrySettlements = async (): Promise<void> => {
    const r = await delivery.drain();
    if (!r.drained) return;
    if (pendingSettlements.size === 0) return;
    for (const sid of [...pendingSettlements.keys()]) await trySettle(sid);
  };

  /**
   * 子 agent 会话 → 跳过（返回 true），**不回传、不结算**。
   *
   * ★ 跳过**必须可观测**：静默丢弃会让「子 agent 没进来」和「回传坏了」
   *   在日志里长得一样（本项目栽过三次的那类伪装）。
   */
  const skipSubagentSession = (session: unknown): boolean => {
    if (!isSubagentSession(session)) return false;
    const sid = sessionIdOf(session) ?? '(无 id)';
    if (!notedSubagents.has(sid)) {
      notedSubagents.add(sid);
      ctx.logger.info(`[alysia-adapter] 跳过子 agent 会话 ${sid}（origin=subagent）——不回传、不结算`);
    }
    return true;
  };

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (skipSubagentSession(session)) return;
    const sid = sessionIdOf(session);
    // ★ 契约 7：没有 id 就是「没有 id」——不回传、不结算，且留痕（限频）
    if (!sid) {
      noteMissingId(`session/event ${event.type}`);
      return;
    }
    /** 入队（上限与丢弃规则在 delivery 里，且**必须留痕**） */
    //   ★ 用箭头函数常量而不是 `function push()`，且**定义在调用点之前**：
    //     函数声明会把上面 `sid` 的收窄丢掉（TS 认为它可能被更晚调用），
    //     于是 `toAlysiaSessionId(sid)` 报 `string | null`。
    const push = (msg: { role: 'user' | 'assistant'; text: string; sourceKind?: string }): void => {
      delivery.enqueue({
        // ★ 去重键 = 会话 + seq：同一事件重传不会在记忆里产生两条。
        //   ⚠️ `seq` 跨 restart/resume 是否重数**尚未证实**（KI-25）——
        //      按「先取证再改」的纪律不在这里换成时间戳+内容哈希。
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
        payload: {
          role: msg.role,
          content: msg.text,
          // ★ change: filter-synthetic-context-inflow —— 把 dsh 的**来源标记**透传给服务端
          //   （证据留在事件里，将来复盘要靠它；"要不要跳过学习"由服务端判）。
          ...(msg.sourceKind ? { dsh_source: msg.sourceKind } : {}),
        },
        created_at: new Date(event.time || Date.now()).toISOString(),
      });
    };

    if (event.type === 'user/message') {
      const text = extractText(event.data).trim();
      if (text) {
        const sourceKind = sourceKindOf(event.data);
        if (sourceKind === RUNTIME_CONTEXT_SOURCE) {
          // ★ 合成注入（runtime context 快照）**不是用户发言**：
          //   - **不触发话题刷新**（`onUserMessage` 是为"用户刚说了什么"准备的）
          //   - **但仍然回传入库** —— 事件日志要不可变，且复盘要靠它；
          //     拦的是"它进学习管道"，由服务端打 `skip_profile` 实现
          // ⚠️ 限频键**不能带 seq**（带了就每条都不同 ⇒ 等于没限频）。
          noteSynthetic('user/message');
        } else {
          onUserMessage(text, toAlysiaSessionId(sid));
        }
        push({ role: 'user', text, sourceKind });
      }
    } else if (event.type === 'assistant/message') {
      const text = extractText(event.data).trim();
      if (text) push({ role: 'assistant', text, sourceKind: sourceKindOf(event.data) });
    } else if (event.type === 'turn/end') {
      // 排空 + 补做挂起的结算（契约 6）。不 await：turn/end 不该阻塞 dsh 这一轮。
      void drainAndRetrySettlements().then(() => {
        if (debug && delivery.queued === 0) {
          ctx.logger.info(`[alysia-adapter] 回传排空完成（累计受理 ${delivery.stats().accepted} 条）`);
        }
      });
    }

    if (debug || event.type === 'user/message' || event.type === 'assistant/message') {
      ctx.logger.info(`[alysia-adapter] session/event ${event.type}`);
    }
  });

  // 会话结束 → 先把尾巴发出去（**等确认落库**），再触发**结算**（摘要 + 画像 + 人格确认 + 固化）
  ctx.on('session/disposed', (session) => {
    if (skipSubagentSession(session)) return;
    const sid = sessionIdOf(session);
    if (!sid) {
      noteMissingId('session/disposed');
      return;
    }
    ctx.logger.info(`[alysia-adapter] session/disposed → 结算 ${toAlysiaSessionId(sid)}`);
    void drainThenSettle(sid);
  });
}

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
 * dsh 消息的**来源标记** —— `data.message.source.kind`。
 *
 * ★★ 实测（2026-10-16，从 dsh 产物 `app.asar` 读出）：
 *   `RuntimeContextProjection.project()` 造 runtime context 快照时用的是
 *
 *     createUserMessage({ content: [{type:'text', text: snapshot}],
 *                         source: { kind: 'runtime-context', form: 'snapshot', sections } })
 *
 *   而 dsh **自己**就是靠 `message.source.kind === 'runtime-context'`
 *   从**已提交事件**里回溯这个快照的（`isOwned()` + `session.snapshotEvents()`）
 *   ⇒ 该字段**能挺过序列化**，是**可靠判据**（不是文本前缀那种脆弱判据）。
 *
 * 这里**只上报事实**，不决定策略：要不要跳过学习由服务端判定（见 `ingest.ts`）。
 */
const RUNTIME_CONTEXT_SOURCE = 'runtime-context'

function sourceKindOf(data: unknown): string | undefined {
  const kind = (data as { message?: { source?: { kind?: unknown } } } | null | undefined)
    ?.message?.source?.kind
  return typeof kind === 'string' && kind ? kind : undefined
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
