// src/memory/eligibility.ts
// ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C1）：**记忆资格的单一出处**。
//
// 存在的理由：这个问题（"这条内容允许用于这个用途吗"）此前被**四份代码各答一次**，
// 写法互不相同 ——
//   ① `EventStore.getLastUserMessageAt`（SQL：role=user + skip_profile=0 + synthetic=0）
//   ② `RealtimeProcessor.process`（只看 `skip_profile`，**不看 role** ⇒ E4）
//   ③ `ProfileExtractor.extract`（role + skip_profile，**不看 synthetic**）
//   ④ `SessionEndProcessor.processInner`（只看 `synthetic`，**不看 role**）
// 于是"能不能学"取决于你恰好走的是哪条路径：合成注入在正常摘要里被滤掉、
// 在补处理里又被收进去（E1）；她自己的话进了人格扫描（E4）。
//
// 所以本文件不是"再多一个 helper"，而是**把四份判据删成一份**：
// 处理器里不许再出现 `payload.synthetic` / `payload.skip_profile` / `role === ...` 的判定，
// 一律问 `isEligible()`（由 `scripts/check-memory-eligibility.cjs` 机器拦）。
//
// ⚠️ 本文件是**纯函数、无 I/O、无 logger**：
//   - 无 logger：日志文案由调用点拼（同一句话在四个调用点的前缀不同），
//     但"该不该出声"的判据在这里（`isMachineOrigin`），否则群聊 NPC 会把日志淹掉。
//   - 无 I/O：它要能在任何一层被调用（含将来的评测脚本与离线回放）。

import type { MemoryEvent } from './types.js';

/**
 * 用途 —— 一个动作问一次。
 *
 * 新增用途**必须先在这里登记**（矩阵少一格，`eligibility.test.ts` 的完整性用例会红）。
 * 这条纪律的意义：将来加第六种学习路径时，被迫看一眼"六个来源分别该怎么处理"，
 * 而不是在处理器里顺手写个 `if`。
 */
export type MemoryUse =
  /** 写进画像事实（`facts`）——**关于用户**的认知 */
  | 'profile-facts'
  /** 作为人格参数调整的证据（`PersonaAdapter.processSignal` 等） */
  | 'persona-evidence'
  /** 作为"用户在纠正旧事实"的候选文本 */
  | 'correction'
  /** 进会话摘要 */
  | 'summary'
  /** 生成向量（日后会被召回） */
  | 'embed'
  /** 世界书关键词匹配（纯读取，不改写任何学习状态） */
  | 'worldbook';

export const MEMORY_USES: readonly MemoryUse[] = [
  'profile-facts',
  'persona-evidence',
  'correction',
  'summary',
  'embed',
  'worldbook',
] as const;

/**
 * 来源 —— 这条内容**是谁产生的**。
 *
 * `unknown` 是**诚实兜底**：判不出来就是判不出来，不许猜成 `user`
 * （与 `utils/channel.ts` 的 `'unknown'` 同一条纪律）。
 */
export type EventOrigin =
  /** 用户本人发言 */
  | 'user'
  /** 昔涟自己的回复（`role: 'assistant'`） */
  | 'assistant'
  /** 她自己的生活事件（`perspective: 'self'`） */
  | 'self-life'
  /** 执行回执（`role: 'engine'`，如委托任务结果） */
  | 'engine'
  /** 委托任务会话（`dsh_origin`，机器发起） */
  | 'agent-delegated'
  /** 合成注入（`synthetic`，如 dsh runtime context 快照） */
  | 'synthetic'
  /** 群聊里非 owner 的消息（`skip_profile`） */
  | 'npc'
  /** 非 message 事件（`tool_call` / `tool_result` 等） */
  | 'tool'
  /** 判不出来 */
  | 'unknown';

export const EVENT_ORIGINS: readonly EventOrigin[] = [
  'user',
  'assistant',
  'self-life',
  'engine',
  'agent-delegated',
  'synthetic',
  'npc',
  'tool',
  'unknown',
] as const;

/** 用途的中文标签（只用于日志/错误信息，不参与判定） */
export const USE_LABEL: Record<MemoryUse, string> = {
  'profile-facts': '画像事实',
  'persona-evidence': '人格证据',
  correction: '纠正判定',
  summary: '会话摘要',
  embed: '向量嵌入',
  worldbook: '世界书匹配',
};

/**
 * ★ 判据矩阵（唯一出处）。`true` = 该来源的内容允许用于该用途。
 *
 * 关键取舍（都写在这里，别在别处再解释一遍）：
 * - **assistant 允许 summary / embed，禁止 profile-facts / persona-evidence / correction**：
 *   她说过的话是**对话历史**（要能回忆"我们聊过什么"），
 *   但**不是关于用户的证据**，更不是"用户对她的反馈"（E4 / D1）。
 * - **机器来源（synthetic / agent-delegated / engine）只允许 worldbook**：
 *   worldbook 匹配是纯读取，不改写任何学习状态；其余一律不学（KI-20 的教训）。
 * - **npc 允许 summary**：群聊 NPC 消息进摘要是**既有行为**，
 *   改它属于另一个决定（见 `filter-synthetic-context-inflow` 的注释），本 change 不动。
 * - **self-life 禁止 persona-evidence**（D2）：她自己产出的内容可以形塑表达，
 *   不可以形塑权威 —— 否则"她认为的你"会由"她说过的你"自己长出来。
 * - **unknown 允许 embed**：老数据判不出来源时，仍可被检索（与现状一致）；
 *   但它**不参与学习**。宁可召回一条来源不明的话，也不静默让它消失。
 */
export const ELIGIBILITY: Record<EventOrigin, Record<MemoryUse, boolean>> = {
  user: {
    'profile-facts': true, 'persona-evidence': true, correction: true,
    summary: true, embed: true, worldbook: true,
  },
  assistant: {
    'profile-facts': false, 'persona-evidence': false, correction: false,
    summary: true, embed: true, worldbook: true,
  },
  'self-life': {
    'profile-facts': false, 'persona-evidence': false, correction: false,
    summary: false, embed: true, worldbook: true,
  },
  engine: {
    'profile-facts': false, 'persona-evidence': false, correction: false,
    summary: false, embed: false, worldbook: true,
  },
  'agent-delegated': {
    'profile-facts': false, 'persona-evidence': false, correction: false,
    summary: false, embed: false, worldbook: true,
  },
  synthetic: {
    'profile-facts': false, 'persona-evidence': false, correction: false,
    summary: false, embed: false, worldbook: true,
  },
  npc: {
    'profile-facts': false, 'persona-evidence': false, correction: false,
    summary: true, embed: false, worldbook: true,
  },
  tool: {
    'profile-facts': false, 'persona-evidence': false, correction: false,
    summary: false, embed: true, worldbook: true,
  },
  unknown: {
    'profile-facts': false, 'persona-evidence': false, correction: false,
    summary: false, embed: true, worldbook: true,
  },
};

/** 来源判定结果：来源 + **为什么**（理由进日志，`ok=false` 时必有） */
export interface OriginVerdict {
  origin: EventOrigin;
  because: string;
}

/** 资格判定结果 */
export interface EligibilityVerdict extends OriginVerdict {
  ok: boolean;
  use: MemoryUse;
  /** 为什么被拒（`ok=true` 时为 `undefined`） */
  reason?: string;
}

/**
 * 判定一条事件的来源。
 *
 * ⚠️ **判定顺序即优先级**，不要随手调换：
 *   1. 非 `message` → `tool`（工具输出连"谁说的"都不成立）
 *   2. `synthetic` → `agent-delegated` / `synthetic`（**机器标记优先于 role**：
 *      合成注入恰好以 `role:'user'` 入库，这就是 KI-20 的成因）
 *   3. `role:'engine'` → `engine`（回执不是她说的）
 *   4. `skip_profile` → `npc`
 *   5. `role:'user'` 或（无 role + `sender_id`）→ `user`（兼容老数据）
 *   6. `perspective:'self'` → `self-life`（放在 user 之后：用户消息永远不是"她的生活"）
 *   7. `role:'assistant'` → `assistant`
 *   8. 其余 → `unknown`
 */
export function originOf(event: MemoryEvent): OriginVerdict {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (event.type !== 'message') {
    return { origin: 'tool', because: `非消息事件（${event.type}）` };
  }

  const synthetic = payload.synthetic;
  if (synthetic) {
    const dshOrigin = typeof payload.dsh_origin === 'string' ? payload.dsh_origin.trim() : '';
    if (dshOrigin) {
      // 委托任务会话：机器发起，但**不是**合成注入 —— 日志里要说清是哪一种，
      // 否则排查时会以为是 runtime-context 又漏了（KI-20 的复盘成本）。
      return { origin: 'agent-delegated', because: `机器发起的会话（${dshOrigin}）` };
    }
    return {
      origin: 'synthetic',
      because: `非用户发言（${synthetic === true ? 'synthetic' : String(synthetic)}）`,
    };
  }

  const role = typeof payload.role === 'string' ? payload.role : '';

  if (role === 'engine') {
    return { origin: 'engine', because: '执行回执（role=engine），不是她说过的话' };
  }
  if (payload.skip_profile === true) {
    // ⚠️ 措辞**不要**写成"非用户发言"：群聊 NPC 量很大，这句一进日志就会淹掉
    //   真正要看的合成注入记录（`isMachineOrigin` 决定要不要出声）。
    return { origin: 'npc', because: '非 owner 的消息（skip_profile）' };
  }
  if (role === 'user' || (role === '' && payload.sender_id)) {
    return { origin: 'user', because: '用户本人发言' };
  }
  if (event.perspective === 'self') {
    return { origin: 'self-life', because: '她自己的生活事件（perspective=self）' };
  }
  if (role === 'assistant') {
    return { origin: 'assistant', because: '她自己说过的话（role=assistant）' };
  }
  return {
    origin: 'unknown',
    because: role ? `未知 role（${role}）` : '来源不明（既无 role 也无 sender_id）',
  };
}

/**
 * **唯一**的资格判据。
 *
 * @example
 *   const v = isEligible(event, 'persona-evidence');
 *   if (!v.ok) { if (isMachineOrigin(v.origin)) warnThrottled(...); return; }
 */
export function isEligible(event: MemoryEvent, use: MemoryUse): EligibilityVerdict {
  const { origin, because } = originOf(event);
  const ok = ELIGIBILITY[origin][use];
  return ok ? { ok, origin, because, use } : { ok, origin, because, use, reason: because };
}

/** 过滤出**允许**用于某用途的事件（处理器里唯一该用的筛子） */
export function filterEligible(events: readonly MemoryEvent[], use: MemoryUse): MemoryEvent[] {
  return events.filter(e => ELIGIBILITY[originOf(e).origin][use]);
}

/**
 * 机器来源（合成注入 / 委托会话 / 执行回执）——**只有这三种值得为"跳过"出声**。
 *
 * 依据：群聊 NPC 的 `skip_profile` 量非常大（本项目曾因 96.6% QQ 噪声吃过一次亏），
 * 给它也打一条 warn 等于把真正要看的合成注入记录淹掉。
 */
export function isMachineOrigin(origin: EventOrigin): boolean {
  return origin === 'synthetic' || origin === 'agent-delegated' || origin === 'engine';
}

/** 统一的跳过日志文案（拼接口径只此一处，改动不会在各调用点漂移） */
export function describeSkip(verdict: EligibilityVerdict): string {
  return `跳过学习：${verdict.reason ?? verdict.because} —— 不进${USE_LABEL[verdict.use]}`;
}
