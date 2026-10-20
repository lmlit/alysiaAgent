/**
 * ★ 2026-10-20（change: `observe-and-hold-context-compaction`）
 *
 * 会话上下文的**截断判定**。抽成纯函数有两个理由：
 *   1. 这是"要不要丢掉对话"的决策，必须能穷举测试（不是靠读代码相信）
 *   2. 它现在有**三种**结局，其中两种以前根本不存在（以前只有"截断"）
 *
 * ## 背景：为什么会有"不截断"这个选项
 *
 * 压缩（`usage.input > 8000` → `onSessionEnd` 生成摘要）与截断
 * （`ctx.truncate(maxTokens)` 丢最旧 turn）是**两套机制**，中间没有联动。
 * 于是存在这个组合：
 *
 *   ① 某轮 input > 8000 → 触发摘要（fire-and-forget）
 *   ② 下一轮 `truncate` 把最早几轮 splice 掉
 *   ③ 摘要**失败了**（LLM 超时 / 空响应 —— 本项目在这上面栽过三次）
 *
 * ⇒ 那几轮从上下文消失、也没变成摘要。它们还在 DB 里（会话结束能摘到），
 *   但在**当下这个会话里**她真的不记得了，日志上只有一行 error。
 *
 * 所以：**摘要失败时暂停截断**，宁可让上下文胖一点。
 * 但必须有硬上限 —— 不截断会导致 API 400（超模型上下文），那是另一种崩。
 */

/** 硬上限倍数：失败时允许上下文涨到 `maxTokens × 这个值`，再多就必须截断 */
export const HARD_CEILING_FACTOR = 2;

export type TruncationDecision =
  /** 正常截断（压缩没出问题） */
  | { action: 'truncate'; reason: 'normal' }
  /** 压缩失败 → **本轮不截断**，保住还没被摘要覆盖的对话 */
  | { action: 'hold'; reason: 'compaction-failed' }
  /** 压缩失败但已超硬上限 → 只能截断（超模型上下文会直接 400） */
  | { action: 'truncate'; reason: 'over-hard-ceiling' };

export function decideTruncation(params: {
  maxTokens: number;
  estimatedTokens: number;
  compactionFailed: boolean;
}): TruncationDecision {
  if (!params.compactionFailed) return { action: 'truncate', reason: 'normal' };
  // 硬上限：估算再不准，2 倍也该兜得住（估算本身低估，所以这实际是个更宽的网）
  if (params.estimatedTokens > params.maxTokens * HARD_CEILING_FACTOR) {
    return { action: 'truncate', reason: 'over-hard-ceiling' };
  }
  return { action: 'hold', reason: 'compaction-failed' };
}
