/**
 * ★ 2026-10-20（change: `observe-and-hold-context-compaction`）
 *
 * **进程内的"压缩失败"登记表**（按 session）。
 *
 * 为什么是模块级而不是构造依赖：写入方是 pipeline 的 llm-agent（`onSessionEnd` 失败时），
 * 读取方是 `AgentRunner`（决定要不要截断）。两者**没有共享对象**，而给
 * `AgentRunner` 加一个 `memoryManager` 形参会牵动所有构造点与 30+ 个测试
 * —— 那是为一个小状态付大代价。
 *
 * 这与本项目既有的 `self-notice.ts` 是同一形状（模块级注册表 + 显式 clear）。
 *
 * 三条纪律：
 * ① **有界**：最多 `MAX_ENTRIES` 个 session，超出丢最旧（防长跑进程泄漏）
 * ② **会过期**：`TTL_MS` 后自动视为"没有失败"（否则一次偶发失败会让某会话永远不截断）
 * ③ **显式 clear**：摘要成功后必须清（见 llm-agent 的 `.then`）
 */

/** 失败标记的存活时间：超过它自动失效（一次偶发失败不该永久压制截断） */
export const COMPACTION_FAILED_TTL_MS = 30 * 60_000;
/** 上限：正常进程里同时"失败中"的会话不会多 */
const MAX_ENTRIES = 200;

const failedAt = new Map<string, number>();

/** 标记该会话的摘要压缩失败（llm-agent 的 catch 分支调用） */
export function markCompactionFailed(sessionId: string, now: number = Date.now()): void {
  // Map 保持插入顺序：超界时删最旧的那条
  if (!failedAt.has(sessionId) && failedAt.size >= MAX_ENTRIES) {
    const oldest = failedAt.keys().next().value;
    if (oldest !== undefined) failedAt.delete(oldest);
  }
  failedAt.set(sessionId, now);
}

/** 摘要成功 → 清掉失败标记（恢复截断） */
export function clearCompactionFailed(sessionId: string): void {
  failedAt.delete(sessionId);
}

/**
 * 该会话当前是否处于"压缩失败"状态。
 * 过期条目会被**当场清掉**（读取即回收，不需要额外定时器）。
 */
export function isCompactionFailed(sessionId: string, now: number = Date.now()): boolean {
  const at = failedAt.get(sessionId);
  if (at === undefined) return false;
  if (now - at > COMPACTION_FAILED_TTL_MS) {
    failedAt.delete(sessionId);
    return false;
  }
  return true;
}

/** 仅供测试：清空全部状态 */
export function _resetCompactionStatus(): void {
  failedAt.clear();
}

/** 仅供观测/测试：当前登记数 */
export function _compactionStatusSize(): number {
  return failedAt.size;
}
