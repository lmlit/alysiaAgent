// src/utils/channel.ts
// ★ 2026-10-16（change: `add-memory-channel-field`）：**记忆渠道**的显式标记。
//
// 为什么要有：
//   后续要让昔涟**从 QQ 侧调用 dsh 编程工具** ⇒ 两类记忆（QQ 日常对话 / dsh 编程会话）
//   会在同一套库里并存，且**将来要特殊处理**（不同召回策略、不同 prompt 注入等）。
//
//   在此之前，渠道只能靠 `session_id` 前缀**猜**：
//     - `session_id LIKE 'dsh:%'` → dsh
//     - `session_id LIKE 'qq%'`   → qq
//   而前缀是**脆的**：
//     ① dsh 拿不到 session.id 时会退化成 `dsh:unknown`，多个真实会话挤一个桶（KI-23）；
//     ② `events.source` **不能**当渠道用 —— 它是 `chat`/`code`（事件性质），
//        而 dsh 会话里**既有** code（她的编程回合）**也有** chat（用户消息），实测 730 条里
//        有 28 条是 `source='chat'`；用 `source='code'` 判 dsh 会漏掉这 28 条。
//     ③ facts / hints 连前缀都没有（`facts.source` 是 `user`/`inferred`＝提取方式，不是渠道）。
//
//   ⇒ 渠道必须是**写入时就显式记下来的字段**，不能事后反推。

/**
 * 记忆渠道。
 *
 * - `qq` / `dsh` / `webui`：三个**用户入口**（从 `session_id` 派生）
 * - `life`：**她自己的生活管线**（`adjustFromMood` 等由生活事件驱动、没有用户会话的写入）
 * - `system`：**系统发起**（如 24h 无信号的自动回归 `stale_regression`）
 * - `unknown`：**诚实**的兜底 —— 老数据判不出来就是判不出来，**不许猜**
 *
 * ⚠️ `life` / `system` 不是"用户渠道"，但它们**必须**是独立取值：
 * 否则"生活事件驱动的调整"和"判不出来的老数据"都会落进 `unknown`，
 * 而这两者的处理策略完全不同（前者是设计行为，后者是数据债）。
 */
export type MemoryChannel = 'qq' | 'dsh' | 'webui' | 'life' | 'system' | 'unknown';

/** 从 `session_id` 派生渠道（**只用于新写入**与老数据回填）。 */
export function channelOfSession(sessionId: unknown): MemoryChannel {
  const s = String(sessionId ?? '');
  // 判据来自实测的会话前缀家族：
  //   dsh:session-<uuid>（主会话）/ dsh:<uuid>（子会话）/ qq-official-1:<...> / webui:<...>
  if (s.startsWith('dsh:')) return 'dsh';
  if (s.startsWith('qq')) return 'qq';
  if (s.startsWith('webui:')) return 'webui';
  return 'unknown';
}

/** 校验一个值是否是合法渠道（**不**把无法识别的值悄悄当成 unknown）。 */
export function isMemoryChannel(v: unknown): v is MemoryChannel {
  return v === 'qq' || v === 'dsh' || v === 'webui' || v === 'life' || v === 'system' || v === 'unknown';
}

/**
 * dsh 的**子会话**（subagent）判据 —— 渠道同样是 `dsh`，但子会话是独立来源，
 * 本仓有过专门的净化 change（`purge-subagent-pollution`）。
 * 主会话形如 `dsh:session-<uuid>`；子会话是裸 uuid。
 */
export function isDshSubagentSession(sessionId: unknown): boolean {
  const s = String(sessionId ?? '');
  return s.startsWith('dsh:') && !s.startsWith('dsh:session-');
}
