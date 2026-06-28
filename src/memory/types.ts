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
  adaptation_hints: string; // JSON array
  updated_at: string;
}

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
}

// Bitmask constants for MemoryEvent.processed
export const PROCESSED_NONE     = 0;
export const PROCESSED_PROFILE  = 1 << 0;  // 1
export const PROCESSED_SUMMARY  = 1 << 1;  // 2
export const PROCESSED_PERSONA  = 1 << 2;  // 4
export const PROCESSED_KNOWLEDGE = 1 << 3; // 8
