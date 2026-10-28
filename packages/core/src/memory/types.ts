// src/memory/types.ts
// ★ add-memory-channel-field：渠道类型（channel.ts 无依赖，不会成环）
import type { MemoryChannel } from '../utils/channel.js';

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
  /** ★ 8-28 视角标记（memory-character-perspective）：'interaction'(与用户互动) | 'self'(昔涟自己的生活) */
  perspective?: 'interaction' | 'self';
  /**
   * ★ 2026-10-16（change: `add-memory-channel-field`）：**记忆渠道**。
   * 不传则由 `session_id` 派生（`utils/channel.ts`）；派生不出来记 `'unknown'`，**不许猜**。
   * 用途：QQ 日常对话与 dsh 编程会话并存时做**差异化处理**。
   */
  channel?: MemoryChannel;
}

export interface UserProfile {
  id: number;
  basics: string;       // JSON
  preferences: string;  // JSON
  facts: string;        // JSON array
  updated_at: string;
  /** ★ 8-28 角色事实（memory-character-perspective）：昔涟自己的事（与 facts 用户事实并列） */
  character_facts?: string;
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
  /** ★ 2026-10-16（add-memory-channel-field）：记忆渠道（不传则由 session_id 派生） */
  channel?: MemoryChannel;
  /** ★ 8-28 角色视角（memory-character-perspective）：昔涟在这段对话中的感受/变化 */
  character_perspective?: string;
  /** ★ 9-25 fix-session-summary-silent-failure：摘要生成状态。
   *  - `'ok'`：摘要正常生成
   *  - `'failed'`：LLM 输出无法解析 → `summary` 为**空字符串**（绝不写占位符），
   *    且**不生成 embedding**（垃圾向量会被召回出来当真内容）。
   *    失败行可被 `getFailed()` 捞出，由 cron 补处理。
   *
   *  为什么要有这个字段：2026-09-04 ~ 09-25 摘要 100% 失败，
   *  但失败被"存一个占位符字符串"伪装成了成功，22 天无人发现。 */
  summary_status?: 'ok' | 'failed';
  /**
   * ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C4）：**事实提取**状态。
   *
   * 与 `summary_status` 并列、**互不冒充**：摘要成功不等于事实提取成功。
   * - `'ok'`：跑过提取且没出错（**可能 0 条**——"看了，确实没有新事实"）
   * - `'failed'`：跑过提取但失败（LLM 报错/空响应/形状不对）⇒ 可被补处理
   * - `'skipped'`：本窗口没有可提取的用户发言（一次 LLM 都没调）
   * - `'pending'`：还没跑（新行默认值；老库存量行也停在这里）
   */
  facts_status?: FactsStatus;
  /** ★ C4：事实提取的**自动重试**次数（D3：每窗口最多 1 次，用尽后留在 failed 可见） */
  facts_attempts?: number;
}

/** ★ 2026-10-21（C4）：事实提取的四种状态（见 `Conversation.facts_status`） */
export type FactsStatus = 'ok' | 'failed' | 'skipped' | 'pending';

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
  /** ★ 8-27 世界书 digest 简介（worldbook-digest-summary）：LLM 生成的 120-150 字角色简介，
   *  采样注入优先用 digest 而非截断正文；seed 重建时继承旧值不清空 */
  digest?: string | null;
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
  /** ★ 8-28 视角过滤（memory-character-perspective）：'self'=只召回昔涟自己的生活，'interaction'=只召回互动，缺省不过滤 */
  perspective?: 'interaction' | 'self';
  query: string;
  /**
   * ⚠️ **一词三义**（历史包袱）：既决定**世界书 scope**、又决定**提示块表**（chat 12 块 / code 6 块），
   * 还间接决定 token 预算（3200 / 2450）。三者想要不同值时，用下面两个字段单独覆盖。
   */
  mode: 'chat' | 'code';
  /**
   * ★ 同上：**只**覆盖"世界书匹配哪个 scope"。
   *
   * ⚠️ **显式给出 ⇒ 该 scope 的条目会注入 prompt**（仅 chat 块表时生效）；
   * 缺省 ⇒ 只匹配、不注入（= 2026-10-24 之前的行为，QQ/console 仍走 `lookup_worldbook` 工具）。
   *
   * 📌 **没有 `blocks` 字段**：`read()` 只负责"匹配"，它不需要知道用哪张块表。
   * 块表选择属于**组装**（`assembleWithReport(mode, …, { blocks })`）。
   * ★ 2026-10-24 曾在这里加过 `blocks`，但它**从头到尾没被 `read()` 读过** ——
   * 典型的"看着接上其实没接"，已删除（F10）。
   */
  worldbookScope?: 'chat' | 'code';
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

export type ProfileFactCategory = 'identity' | 'preference' | 'status' | 'relationship' | 'general';

export interface ProfileFact {
  fact: string;
  confidence: number;  // 0.0 - 1.0
  evidence: string;    // 原文引用
  source_event: string;
  updated_at: string;
  /**
   * 来源类型: user=用户主动声明(最高可信), behavior=行为推断, inferred=LLM推断(最低可信),
   * ★ 2026-10-21（change: `unify-memory-eligibility`，D2）：reflection=**她自己反思产出的自述**。
   *
   * 为什么要单独一个值：`reflection` 只能进【关于我】（自我叙事），**不能作为人格证据**（D2）。
   * 混进 `inferred` 就分不出"从对话里推断的"和"她自己想出来的"——
   * 而后者一旦被当成证据，就是"她认为的你"由"她说过的你"自己长出来（自证闭环）。
   */
  source: 'user' | 'behavior' | 'inferred' | 'reflection';
  /** 生效时间 (ISO) */
  valid_from: string;
  /** 失效时间 (ISO)，null=永不过期 */
  valid_until: string | null;
  /** 状态: active=有效, superseded=被新事实替代, expired=自然过期 */
  status: 'active' | 'superseded' | 'expired';
  /** ★ 8-28 分类（profile-facts-classification-confirm）：身份/偏好/状态/关系/默认——决定过期时长 */
  category: ProfileFactCategory;
  /**
   * ★ 2026-10-16（add-memory-channel-field）：记忆渠道。
   * ⚠️ 与上面的 `source` **不是一回事**：`source` 是**提取方式**（user/behavior/inferred），
   * `channel` 是**这条记忆从哪个入口来的**（qq/dsh/webui/life/system）。
   * 用途：QQ 日常对话与 dsh 编程会话并存时做差异化处理。
   * 老数据可能缺这个字段（判不出来就是 `'unknown'`，**不许猜**）。
   */
  channel?: MemoryChannel;
  /**
   * ★ 2026-10-28（resolve-fact-conflicts）：**提取期的冲突标记**，不是持久字段。
   * 指向【已有事实】里与新事实语义冲突的那条原文；只用于 addFacts 分流，
   * 落库前会被剥掉（避免把“候选关系”写进当前认知）。
   */
  conflicts_with?: string | null;
  /**
   * ★ 2026-10-28：用户裁决“保留新说法”的时间。
   * 存在时即使 `source=inferred` 也不再显示“（待确认）”——因为它已经被用户确认过。
   */
  confirmed_at?: string;
}

/** ★ 8-28 分类过期时长（ms）：identity 365 天 / preference 90 天 / status 14 天 /
 *  relationship 90 天 / general 60 天。写入时按分类设 valid_until（显式传入优先） */
export const FACT_TTL_BY_CATEGORY: Record<ProfileFactCategory, number> = {
  identity: 365 * 86_400_000,
  preference: 90 * 86_400_000,
  status: 14 * 86_400_000,
  relationship: 90 * 86_400_000,
  general: 60 * 86_400_000,
};

/** ★ 8-28 过期确认窗口：valid_until 在过去 N 天内且 active → 待确认（超窗口自动 expired） */
export const FACT_CONFIRM_WINDOW_MS = 3 * 86_400_000;

// ★ 2026-10-26（retire-processed-bitmask，KI-27）：`PROCESSED_*` 位掩码已删除。
//   它只写不读（唯一读者 `getUnprocessed` 只被 compaction 自己调用），是"看起来在工作"的典型。
//   真实状态在 `summary_status` / `facts_status`/`archived` —— 不需要第二套。
