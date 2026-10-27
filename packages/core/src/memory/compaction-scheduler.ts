/**
 * ★ 2026-10-28（change: `fix-long-session-compaction`）
 *
 * 压缩请求的**节流判定**（纯函数，便于穷举测试）。
 *
 * ## 为什么需要它
 *
 * 旧实现是「`usage.input > 8000` 就 fire-and-forget 一次 `onSessionEnd`」。
 * 线上单 QQ 会话永远不结束，摘要一次要 20–30 秒；下一条消息进来时又超阈值，
 * 于是每轮都请求一次，而 per-session mutex 把后来者判成 `in-flight` 跳过。
 * 跳过又被当成“压缩失败” ⇒ 暂停截断 ⇒ 上下文继续涨 ⇒ 下一轮再触发。
 *
 * 结果不是“摘要不够快”，而是**请求太密**：同一段窗口被反复请求，
 * 真正干活的只有第一次。冷却把“每轮请求”改成“按节奏请求”。
 *
 * ## 为什么是 10 分钟
 *
 * - 摘要本身 20–30s，10 分钟足够它完成并推进 `summaryAnchor`；
 * - 单用户聊天通常几分钟到几十分钟一轮，10 分钟不会漏掉真正的窗口；
 * - 比按消息条数/字符数简单，且不依赖还没统一的 token 估算。
 *
 * 这个值只控制**对话内联触发**；cron 的 `archiveStaleSessions` 仍是 6h 兜底，
 * 不在本函数管辖内。
 */
export const COMPACTION_COOLDOWN_MS = 10 * 60_000;

export interface CompactionRequestParams {
  /** 本轮真实 input tokens（`usage.input`，不是估算） */
  inputTokens: number;
  /** 触发阈值（当前 8000） */
  triggerTokens: number;
  /** 当前时间（毫秒） */
  now: number;
  /** 该 session 上次请求压缩的时间；从未请求过传 undefined */
  lastRequestAt?: number;
  /** 冷却时长（毫秒） */
  cooldownMs: number;
}

/** 是否应该发起一次新的压缩请求。 */
export function shouldRequestCompaction(params: CompactionRequestParams): boolean {
  if (params.inputTokens <= params.triggerTokens) return false;
  if (params.lastRequestAt === undefined) return true;
  return params.now - params.lastRequestAt >= params.cooldownMs;
}

/**
 * 摘要结果是否应该让 `truncation-policy` **暂停截断**。
 *
 * ★ 2026-10-28：只有 `failed` 才 hold。`skipped` 里的 `in-flight` 表示另一个摘要
 * 正在覆盖这段对话，`no-events`/`no-dialogue` 表示没有可丢的内容 —— 这两种都不该
 * 把上下文无限期留在“胖”状态。旧实现把 `skipped` 也 mark 成失败，是线上
 * “摘要永远在飞、截断永远暂停”循环的一半原因。
 */
export function shouldHoldTruncation(summary: 'ok' | 'failed' | 'skipped'): boolean {
  return summary === 'failed';
}
