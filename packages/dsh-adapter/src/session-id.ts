/**
 * dsh 会话 → alysia 会话 id 的映射。
 *
 * ★★ **跨包契约**：`DSH_SESSION_PREFIX` 必须与 alysia server 的
 *    `packages/server/src/ingest.ts` 里那份**完全一致**。
 *
 *    两边不能共享一个常量（插件不能依赖 server 包），所以靠两条守住：
 *    ① 本文件的注释 + 两处的测试都钉住同一个字面量；
 *    ② 万一漂移，**会响亮失败**——server 侧 `/api/ingest` 对非该前缀的会话
 *       一律拒收，且拒绝原因是具体的（不是静默丢弃）。
 *
 *    前缀同时是**来源标记**（与 `webui:` / `qq-official-1:` 同一约定），
 *    因此不必给 alysia 的 `EventSource` 加枚举值。
 */

/** 回传会话的 id 前缀。**必须与 `packages/server/src/ingest.ts` 一致** */
export const DSH_SESSION_PREFIX = 'dsh:';

/**
 * 取 dsh 会话 id。
 *
 * `session/event` 的第一个参数是 `Session` 实例（dsh 的 `callbackArgs = [this, event]`），
 * 它自带 `id` getter（读 `header.id`）。这里对两种形状都容错——
 * 本插件不控制 dsh 的实现，宁可退化到 `unknown` 也不要抛。
 */
export function sessionIdOf(session: unknown): string {
  const s = session as { id?: unknown; header?: { id?: unknown } } | null | undefined;
  const id = s?.id ?? s?.header?.id;
  return typeof id === 'string' && id ? id : 'unknown';
}

/** 拼 alysia 侧的会话 id（回传与结算都用它） */
export function toAlysiaSessionId(dshSessionId: string): string {
  return `${DSH_SESSION_PREFIX}${dshSessionId}`;
}

/**
 * 是否是**子 agent 会话**。
 *
 * ★★ 为什么必须判它（2026-10-02，change: exclude-subagent-sessions-from-bridge）：
 *   preset 是**一个 standing mount 被所有 agent 共享**——父 agent 与子 agent 的 scope key
 *   都直接绑到同一个 standing key，而 scope 事件**向上冒泡**
 *   （dsh `packages/core/scope/src/index.ts:170-185`）。
 *   所以本插件的 `session/event` / `session/disposed` **会收到全部子 agent 会话**，
 *   而子会话内容是**执行过程**（任务书 / 工具输出 / 审计报告），不是「她与用户的对话」——
 *   回传会污染人格与画像（实证：12 条人格化摘要、34 条 adaptation_hints、48 条 user facts，
 *   还有「注入的人设上下文被回吸成新事实」的回流闭环）。
 *
 * ★ 判据用 `header.origin === 'subagent'`——dsh 的**持久化**字段，resume 后也在
 *   （`packages/core/session/src/types.ts:85`；`Session.header` 是公开 readonly 属性）。
 *   **不用 `parentSession`**：`SessionStore.fork()` 也会设它、但不设 origin。
 *   **不用 id 形状**：主会话恰好是 `session-<uuid>`、子会话恰好是裸 uuid，那是命名巧合不是契约。
 */
export function isSubagentSession(session: unknown): boolean {
  const s = session as { header?: { origin?: unknown } } | null | undefined;
  return s?.header?.origin === 'subagent';
}
