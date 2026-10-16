/**
 * `/api/ingest` 的事件校验 —— dsh 记忆回传的写通道入口。
 *
 * ★ 单独成文件（不从 `webui/server.ts` 内联）：那里 `main()` 一 import 就起服务器，
 *   没法单测。与 `net.ts` 从 bootstrap 抽出来是同一个理由。
 *
 * 设计取向：**严进宽出**。写接口是攻击面，宁可拒收也不能让畸形事件进记忆库；
 * 但每条拒绝都给得出**具体原因**，否则回传方只会看到「没生效」。
 */

import type { MemoryEvent } from '@alysia/core/memory';

/** 单批上限。dsh 侧应分批回传；给大值是为了容纳一次会话结束的尾巴。 */
export const MAX_INGEST_BATCH = 200;

/**
 * 回传会话的 id 前缀。
 *
 * ★ 它同时是**来源标记**：alysia 现有约定就是靠 session 前缀区分来源
 *   （`webui:private:…` / `qq-official-1:private:…`），沿用即可，
 *   **不必给 `EventSource` 加枚举值**（加了会让所有 switch 它的下游出现未覆盖分支）。
 */
export const DSH_SESSION_PREFIX = 'dsh:';

/**
 * 身份不明时适配器会退化出的字面量会话 id —— **这里明确拒收**。
 *
 * ★ 2026-10-16（change: `fix-dsh-ingest-and-settlement` 契约 7；KI-23 的**第二道闸**）：
 *   适配器侧已改成 fail closed（取不到 id 就不回传），但只靠一道闸不够——
 *   一旦上游 `Session` 形状再变（dsh 已换过一次插件机制），
 *   多个**不同真实会话**的事件就会全部落进 `dsh:unknown` 一个桶：
 *   跨会话内容混进同一份摘要与画像，`summaryAnchor()` 还会拿该桶的最新摘要当锚点。
 *   两道闸分工：适配器**不产生**，服务端**不接受**。
 *
 *   `'unknown'` 永远不是真实 dsh 会话 id，所以这条拒收不会误伤合法回传。
 */
export const UNKNOWN_SESSION_ID = `${DSH_SESSION_PREFIX}unknown`;

/**
 * dsh 的 **runtime context 快照**来源标记（`data.message.source.kind`）。
 *
 * ★ 2026-10-16（change: `filter-synthetic-context-inflow`；KI-20）：
 *   dsh 每一步之前会把「动态运行时上下文」投影成一条 **user 消息**塞进会话
 *   （`RuntimeContextProjection.project()`，`source: { kind: 'runtime-context' }`），
 *   adapter 的「用户消息」监听器**照单全收** ⇒ 这段文本以 `role:'user'` 入库
 *   ⇒ 画像从此文本里「重新学」出画像（**画像回吸**）、人格从中再触发 hints
 *   （**记忆触发记忆**）—— 两条自指回路。
 *
 * 判定**只认结构化来源**，不认文本前缀：
 * - 结构化标记已被 dsh 自己证明**能挺过序列化**（它就是用 `source.kind`
 *   从 `session.snapshotEvents()` 里回溯快照的）；
 * - 文本前缀判据会**误伤**「用户自己粘贴了类似文本」这一真实场景（change R6），
 *   而结构化判据**按定义不会**：真用户消息带的是别的 `source.kind`。
 */
export const RUNTIME_CONTEXT_SOURCE = 'runtime-context';

const EVENT_SOURCES = new Set(['chat', 'tool', 'system', 'code']);
const MESSAGE_ROLES = new Set(['user', 'assistant']);

/**
 * 校验一条回传事件。
 *
 * @returns 通过返回 `null`；不通过返回**人话原因**（会被汇总进响应体的 `rejected`）
 */
export function validateIngestEvent(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return '不是对象';
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.id !== 'string' || e.id === '') return 'id 缺失或非字符串';

  if (typeof e.session_id !== 'string' || !e.session_id.startsWith(DSH_SESSION_PREFIX)) {
    // 写接口不该能往 QQ / WebUI 会话里注入消息
    return `${e.id}: session_id 必须以 "${DSH_SESSION_PREFIX}" 开头（拒绝写入其它来源的会话）`;
  }

  // ★ 第二道闸（KI-23）：身份不明的退化 id 不是合法会话 —— 放它进来等于把
  //   多个真实会话混成一个。适配器侧已 fail closed，这条防的是上游契约再次变化。
  if (e.session_id === UNKNOWN_SESSION_ID) {
    return `${e.id}: session_id 是 "${UNKNOWN_SESSION_ID}" —— 身份不明的会话不许入库（会把多个会话混成一个桶）`;
  }

  if (typeof e.type !== 'string' || e.type === '') return `${e.id}: type 缺失`;
  if (typeof e.source !== 'string' || !EVENT_SOURCES.has(e.source)) {
    return `${e.id}: source 必须是 ${[...EVENT_SOURCES].join('/')} 之一`;
  }

  const payload = e.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return `${e.id}: payload 必须是对象`;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.content !== 'string' || p.content.trim() === '') {
    return `${e.id}: payload.content 缺失或为空`;
  }
  // role 决定提取器把它当用户还是昔涟 —— 判错会把画像写反
  if (typeof p.role !== 'string' || !MESSAGE_ROLES.has(p.role)) {
    return `${e.id}: payload.role 必须是 user/assistant`;
  }

  const importance = e.importance;
  if (importance !== undefined && (typeof importance !== 'number' || !Number.isFinite(importance))) {
    return `${e.id}: importance 必须是数字`;
  }

  return null;
}

/**
 * 把通过校验的事件补成完整的 `MemoryEvent`。
 *
 * 只补**可安全默认**的字段：`importance` / `processed` / `created_at`。
 * 不补 `id` —— 它是去重键，必须由回传方给（同一事件重传不该产生两条记忆）。
 *
 * ★ 2026-10-16（`filter-synthetic-context-inflow`，KI-20）：**合成的 runtime context
 *   snapshot 不当用户发言** —— 打上 `skip_profile`（RealtimeProcessor 与
 *   ProfileExtractor 都遵守它），并记下 `synthetic` 作为**跳过原因**（供留痕与复盘）。
 *
 *   ★ **事件照常入库**：它是真实发生过的一次注入，删掉会破坏事件日志的不可变性，
 *     而且这类注入的频率与形态将来还要复盘。这里拦的是「**它进学习管道**」，
 *     不是「它入库」。
 *
 *   ⚠️ **没有用文本前缀兜底**（与 change proposal 原措辞的**有意偏离**）：
 *     前缀判据与 R6「用户粘贴类似文本不得被误判」**直接冲突**，
 *     而结构化判据按定义不会误伤；且它已被证明覆盖全部已知样本
 *     （那 116 条都出自同一个 `project()` 调用点）。前缀只保留在
 *     **观察**层面（见 adapter 的注释），不作判据。
 */
export function normalizeIngestEvent(e: MemoryEvent): MemoryEvent {
  const payload: Record<string, unknown> = { ...(e.payload as Record<string, unknown>) };
  if (payload.dsh_source === RUNTIME_CONTEXT_SOURCE) {
    payload.skip_profile = true;
    payload.synthetic = RUNTIME_CONTEXT_SOURCE;
  }
  return {
    ...e,
    payload: payload as MemoryEvent['payload'],
    importance: typeof e.importance === 'number' ? e.importance : 0.5,
    processed: 0,
    created_at: e.created_at || new Date().toISOString(),
  };
}
