// src/memory/types.ts

export type EventSource = 'chat' | 'tool' | 'system' | 'code';

export type EventType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'persona_change'
  | 'profile_hint'
  | 'session_summary';

export interface MemoryEvent {
  id: string;
  session_id: string;
  source: EventSource;
  type: EventType;
  payload: Record<string, unknown>;
  importance: number;
  created_at: string;
  processed: number; // bitmask: 1=profile, 2=summary, 4=persona, 8=knowledge
}

export interface UserProfile {
  id: number;
  basics: string;       // JSON
  preferences: string;  // JSON
  facts: string;        // JSON array
  updated_at: string;
}

export interface Persona {
  id: number;
  name: string;
  tone: string;             // JSON {formality, warmth, humor, directness}
  speech_style: string;     // JSON {sentence_length, emoji_usage, code_heavy}
  emotional_range: string;  // JSON {expressiveness, empathy, playfulness}
  memory_config: string;    // JSON {retention_bias, decay_rate, importance_threshold, recency_weight, confirmation_bias}
  adaptation_hints: string; // JSON array
  updated_at: string;
  /** v3 角色系统：角色唯一 ID */
  role?: string;
  /** v3 角色系统：主人格提示词（角色包导入） */
  system_prompt?: string;
  /** v3 角色系统：是否激活角色 */
  is_active?: number;
}

/** 记忆人格旋钮 — 不同角色有不同"记性" */
export interface MemoryConfig {
  /** 正负偏向: -1=只记坏, +1=只记好, 0=中性 */
  retention_bias: number;
  /** 遗忘速度: 0=不忘, 1=秒忘 */
  decay_rate: number;
  /** 敏感度阈值: 0=什么都记, 1=只记大事 */
  importance_threshold: number;
  /** 近期vs远期权重: 0=念旧, 1=只认最近 */
  recency_weight: number;
  /** 固执度: 0=随风倒, 1=从不改变看法 */
  confirmation_bias: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  retention_bias: 0.2,   // 昔涟：微微偏向正面
  decay_rate: 0.3,        // 慢慢忘
  importance_threshold: 0.4,
  recency_weight: 0.3,    // 有点念旧
  confirmation_bias: 0.3,  // 比较容易被改变
};

export interface Conversation {
  id: string;
  session_id: string;
  summary: string;
  participants: string;   // JSON array
  topics: string;         // JSON array
  key_decisions: string;  // JSON array
  message_count: number;
  started_at: string;
  ended_at: string | null;
  embedding_id: string | null;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  source: string;         // 'imported' | 'url' | 'note' | 'generated'
  file_path: string | null;
  content_hash: string;
  chunk_count: number;
  status: string;         // 'active' | 'archived'
  created_at: string;
  updated_at: string;
}

export interface WorldbookEntry {
  id: string;
  trigger_keys: string;   // JSON array
  trigger_mode: string;   // 'any' | 'all' | 'regex'
  content: string;
  scope: string;          // 'chat' | 'code' | 'both'
  priority: number;
  cooldown_sec: number;
  last_triggered: string | null;
  hit_count: number;
  created_at: string;
  updated_at: string;
  /** v3 角色系统：所属角色，匹配时按当前角色过滤 */
  role?: string;
  /** v3 角色系统：内容类型 'text' | 'life_event'（8-27 生活化种子）| 'image' | 'sticker'（表情包素材） */
  content_type?: string;
  /** ★ 8-14 内容自进化：条目来源 'seed'(角色包导入/seed) | 'self'(昔涟自写) */
  source?: string;
}

export interface CodeContext {
  id: string;
  project_name: string;
  project_path: string;
  tech_stack: string;       // JSON
  architecture_notes: string;
  recent_changes: string;   // JSON array
  decisions: string;        // JSON array
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface MemoryReadRequest {
  query: string;
  mode: 'chat' | 'code';
  limit: number;
}

export interface MemoryReadResult {
  context: string;
  persona_hint: string;
  retrieved: SearchResult[];
  worldbook_triggers: WorldbookEntry[];
}

export interface PersonaAdjustment {
  param: string;     // e.g. 'tone.formality'
  delta: number;     // e.g. -0.15
  reason: string;
  explicit?: boolean; // true = bypass cooldown/delta limits (user explicit directive)
}

export interface ProfileFact {
  fact: string;
  confidence: number;  // 0.0 - 1.0
  evidence: string;    // 原文引用
  source_event: string;
  updated_at: string;
  /** 来源类型: user=用户主动声明(最高可信), behavior=行为推断, inferred=LLM推断(最低可信) */
  source: 'user' | 'behavior' | 'inferred';
  /** 生效时间 (ISO) */
  valid_from: string;
  /** 失效时间 (ISO)，null=永不过期 */
  valid_until: string | null;
  /** 状态: active=有效, superseded=被新事实替代, expired=自然过期 */
  status: 'active' | 'superseded' | 'expired';
}

// Bitmask constants for MemoryEvent.processed
export const PROCESSED_NONE     = 0;
export const PROCESSED_PROFILE  = 1 << 0;  // 1
export const PROCESSED_SUMMARY  = 1 << 1;  // 2
export const PROCESSED_PERSONA  = 1 << 2;  // 4
export const PROCESSED_KNOWLEDGE = 1 << 3; // 8
