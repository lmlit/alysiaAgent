/**
 * 服务端响应类型 — 严格照 core 的真实返回定义（不是照 v0 的 mock 抄的）
 *
 * 来源核对：
 *   - LifeSnapshot      → MemoryManager.getLifeSnapshot() (MemoryManager.ts:356)
 *   - RawLifeEvent      → LifeStore.LifeEvent (LifeStore.ts:6)
 *   - ProfileResponse   → MemoryManager.getProfileSnapshot() (MemoryManager.ts:1006)
 *   - PersonaResponse   → MemoryManager.getPersonaSnapshot() (MemoryManager.ts:1065)
 *   - MemoryConfig      → PersonaStore.DEFAULT_MEMORY_CONFIG_JSON (PersonaStore.ts:5)
 *   - StatsResponse     → MemoryManager.getTokenStats() + listSessions
 *
 * ★ 声明式前端 mock 的历史遗留（2026-09-25 drop-electron-desktop 已删 `lib/mock-data.ts`）：
 *   v0 生成的样例数据里有臆造字段——说话风格/情感范围各多编了第 4 个参数
 *   （「口语化」「稳定性」），记忆旋钮编了「情绪记忆」「主动唤起」（core 里不存在）。
 *   本文件以 core 实际返回为准，未被那些臆造字段污染过。
 */

// ── AI 主动生活 ────────────────────────────────────────

/** 实时生活快照：她此刻在做什么、心情如何、亲密度多少 */
export type LifeSnapshot = {
  currentActivity: string;
  mood: string;
  intimacy: number;
  moodValue: number;
  moodNote: string;
  updatedAt: string;
};

/**
 * 一条生活事件。
 * type='chat'      → 推送给轻月的话（主动分享）
 * type='internal'  → 她的独处叙述，只入库不推送
 * origin='followup' → 对话余波，不推送只记录（8-27 事件来源）
 */
export type RawLifeEvent = {
  id: string;
  createdAt: string;
  type: 'chat' | 'internal';
  content: string;
  moodDelta?: string;
  referenceEventId?: string;
  wbEntryId?: string;
  delivered: number;
  origin?: 'regular' | 'followup';
};

export type LifeResponse = {
  snapshot: LifeSnapshot;
  events: RawLifeEvent[];
};

// ── 画像 ───────────────────────────────────────────────

export type ProfileFact = {
  fact: string;
  confidence: number;
  source: string;
  status: string;
  updatedAt: string;
  validFrom: string;
  category: string;
};

export type ProfileResponse = {
  /** 关于轻月的事实 */
  facts: ProfileFact[];
  /** 昔涟自己的事实（memory-character-perspective） */
  characterFacts: ProfileFact[];
  basics: string;
  preferences: string;
};

// ── 人格 ───────────────────────────────────────────────

export type MemoryConfig = {
  retention_bias: number;
  decay_rate: number;
  importance_threshold: number;
  recency_weight: number;
  confirmation_bias: number;
};

/** overlay 稳定演化记录（dimension/change/evidence/appliedAt） */
export type OverlayNote = {
  dimension: string;
  change: string;
  evidence: string;
  appliedAt: string;
};

export type PersonaResponse = {
  name: string;
  /** 语气：formality / warmth / humor / directness */
  tone: Record<string, number>;
  /** 说话风格：sentence_length / emoji_usage / code_heavy */
  speechStyle: Record<string, number>;
  /** 情感范围：expressiveness / empathy / playfulness */
  emotionalRange: Record<string, number>;
  memoryConfig: MemoryConfig;
  overlayNotes: OverlayNote[];
};

// ── 会话 / 统计 / 系统 ─────────────────────────────────

export type SessionSummary = {
  sessionId: string;
  messageCount: number;
  lastActive: string;
};

// ── 生活模板（她的生活素材库）────────────────────────────

/**
 * source='seed'  → 预设种子活动
 * source='self'  → 她自己创造的（content-self-evolution）
 * category       → 独处 / 互动 / 分享
 */
export type LifeTemplate = {
  id: string;
  activity: string;
  type: 'chat' | 'internal';
  weight: number;
  source: string;
  category: string;
  groupName: string;
};

export type LifeTemplatesResponse = { templates: LifeTemplate[] };

// ── 每日摘要 / 配角在场（9-25 add-life-readonly-endpoints）────────

export type LifeSummary = {
  /** YYYY-MM-DD */
  date: string;
  summary: string;
};

export type LifeSummariesResponse = { summaries: LifeSummary[] };

/**
 * 配角在场状态（HDSI ScenePresence 简化版）。
 * status: 'present' 在场 / 'expected' 期待中 / 'off-scene' 离场
 * basis:  判定依据（通常是提到 TA 的那句事件原文）
 */
export type CompanionPresence = {
  name: string;
  status: string;
  basis?: string;
  updatedAt: string;
};

export type LifeCompanionsResponse = { companions: CompanionPresence[] };

export type SessionsResponse = { sessions: SessionSummary[] };

// ── 聊天（9-25 wire-console-chat）───────────────────────

/** role: 'user' | 'assistant'（服务端由 payload.role 决定，缺失时按 sender_id 推断） */
export type SessionMessage = {
  role: string;
  content: string;
  senderName: string;
  createdAt?: string;
};

export type MessagesResponse = {
  ok: boolean;
  sessionId: string;
  /** ★ 时间**倒序**（最新在前）——展示前必须 reverse */
  messages: SessionMessage[];
  hasMore: boolean;
};

export type PendingResponse = { ok: boolean; inFlight: boolean };

export type SessionTokenStat = {
  recordCount: number;
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  messageCount?: number;
  lastActive?: string;
};

export type StatsResponse = {
  global: { input: number; output: number; tokens: number };
  perSession: Record<string, SessionTokenStat>;
};

export type HealthResponse = { status: string; uptime: number };
