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
 * ⇒ 归属必须显式：`user`（用户）/ `assistant`（她自己）/ **`engine`（执行记录，不是聊天发言）**。
 *   任何新渲染器都**用这个函数**，不要各自再写一个 `role === 'user' ? … : …`。
 *
 * ★ 2026-10-18（change: `unify-her-voice-across-engineering`）：用户指出
 *   「虽然她调用的是工程，但**其实工程也是她自己**」。
 *   事实核查：委托任务在 dsh 里注入的正是她自己的 6375 字人格（`[角色设定] 你是昔涟`），
 *   所以那一轮**是她**，只是换了个干活的场所。
 *   于是标签从「工程端」（像一个别人）改成「**我（工程环境）**」：
 *   prompt 里那行读作 `[23:41] 我（工程环境）: 【我这次的执行记录】…` ——
 *   她读到的是"我做过什么"，不是"有人给我发来汇报"。
 *
 *   ⚠️ **归因仍然是 `engine`，没有退回 `assistant`**：那段技术输出不是她的聊天发言，
 *   写成 `assistant` 会让 prompt 出现「昔涟: （回执）…」= 替她写了她没说过的话。
 *   "是她"说的是**行为归属**，不是"这段话是她说的"。
 */

/** 执行记录的说话人标签（她自己的那一轮，不是聊天发言） */
export const ENGINE_SPEAKER = '我（工程环境）';

export interface SpeakerLabels {
  /** 用户（默认「你」；主动消息生成器用「伙伴」） */
  user?: string;
  /** 她自己（默认「昔涟」） */
  assistant?: string;
  /** 执行记录（默认「我（工程环境）」—— 是她，但不是她的聊天发言） */
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
