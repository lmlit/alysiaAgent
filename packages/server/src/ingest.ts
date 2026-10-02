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
 */
export function normalizeIngestEvent(e: MemoryEvent): MemoryEvent {
  return {
    ...e,
    importance: typeof e.importance === 'number' ? e.importance : 0.5,
    processed: 0,
    created_at: e.created_at || new Date().toISOString(),
  };
}
