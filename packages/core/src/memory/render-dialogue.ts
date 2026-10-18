/**
 * 对话行的**说话人标签** —— 把"这句话是谁说的"做成一等公民。
 *
 * ★ 2026-10-18（change: `attribute-engine-receipts`）。用户原话：
 *   「我们工程的回执是不是要上下文带上，不如让自己调工程的回复，**她以为是我命令输出的**」。
 *
 * 起因是一个真 bug：委托任务的结果回执照着 `role: 'assistant'` 写进她的会话，
 * 而三处渲染器（`MemoryManager.getRecentDialogueBlock`、`memory-retrieval`、`llm-agent`）
 * 全都是「不是 user 就当成她」。于是 prompt 里出现了这样一行：
 *
 *     [23:41] 昔涟: （委托任务回执）项目 alysia-blog 第 1 轮已结束…
 *
 * —— **等于替她写了一段她没说过的话**。她读到会以为自己讲过；
 * 更糟的是她可能把那句机器口吻当成"用户命令的输出"，从而误判自己做过什么。
 *
 * ⇒ 归属必须显式：`user`（用户）/ `assistant`（她自己）/ **`engine`（执行端/系统，不是任何人）**。
 *   任何新渲染器都**用这个函数**，不要各自再写一个 `role === 'user' ? … : …`。
 */

/** 系统消息的说话人标签（不是用户，也不是她） */
export const ENGINE_SPEAKER = '工程端';

export interface SpeakerLabels {
  /** 用户（默认「你」；主动消息生成器用「伙伴」） */
  user?: string;
  /** 她自己（默认「昔涟」） */
  assistant?: string;
  /** 执行端/系统消息（默认「工程端」） */
  engine?: string;
}

/**
 * 给一条对话消息配上说话人标签。
 *
 * @param role 事件 payload 里的 `role`；**未知值一律当作她**（历史数据兼容），
 *             但 `engine` 必须显式标记 —— 见 {@link ENGINE_SPEAKER}
 */
export function dialogueSpeaker(role: unknown, labels: SpeakerLabels = {}): string {
  if (role === 'user') return labels.user ?? '你';
  if (role === 'engine') return labels.engine ?? ENGINE_SPEAKER;
  return labels.assistant ?? '昔涟';
}
