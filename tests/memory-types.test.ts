import { describe, it, expect } from 'vitest';
import type {
  EventSource,
  EventType,
  MemoryEvent,
  UserProfile,
  Persona,
  Conversation,
  KnowledgeDoc,
  WorldbookEntry,
  CodeContext,
  SearchResult,
  MemoryReadRequest,
  MemoryReadResult,
  PersonaAdjustment,
  ProfileFact,
} from '../src/memory/types';
import {
  PROCESSED_NONE,
  PROCESSED_PROFILE,
  PROCESSED_SUMMARY,
  PROCESSED_PERSONA,
  PROCESSED_KNOWLEDGE,
} from '../src/memory/types';
import type { IVectorStore } from '../src/memory/interfaces/IVectorStore';
import type { IEmbedService } from '../src/memory/interfaces/IEmbedService';
import type { ILLMService } from '../src/memory/interfaces/ILLMService';

describe('Memory system types', () => {
  describe('Type aliases', () => {
    it('EventSource is a union of literals', () => {
      const source: EventSource = 'chat';
      expect(['chat', 'tool', 'system', 'code']).toContain(source);
    });

    it('EventType is a union of literals', () => {
      const eventType: EventType = 'message';
      expect([
        'message',
        'tool_call',
        'tool_result',
        'persona_change',
        'profile_hint',
        'session_summary',
      ]).toContain(eventType);
    });
  });

  describe('MemoryEvent', () => {
    it('can be constructed with required fields', () => {
      const event: MemoryEvent = {
        id: 'evt-001',
        session_id: 'sess-001',
        source: 'system',
        type: 'session_summary',
        payload: { summary: 'test' },
        importance: 5,
        created_at: '2026-06-28T00:00:00Z',
        processed: 0,
      };
      expect(event.id).toBe('evt-001');
      expect(event.payload).toEqual({ summary: 'test' });
    });
  });

  describe('UserProfile', () => {
    it('can be constructed', () => {
      const profile: UserProfile = {
        id: 1,
        basics: '{"name":"Alice"}',
        preferences: '{"theme":"dark"}',
        facts: '["likes cats"]',
        updated_at: '2026-06-28T00:00:00Z',
      };
      expect(profile.id).toBe(1);
      expect(profile.basics).toContain('Alice');
    });
  });

  describe('Persona', () => {
    it('can be constructed', () => {
      const persona: Persona = {
        id: 1,
        name: 'helper',
        tone: '{"formality":0.5}',
        speech_style: '{"sentence_length":"medium"}',
        emotional_range: '{"expressiveness":0.7}',
        adaptation_hints: '["prefer lists"]',
        updated_at: '2026-06-28T00:00:00Z',
      };
      expect(persona.name).toBe('helper');
    });
  });

  describe('Conversation', () => {
    it('can be constructed with null ended_at', () => {
      const conv: Conversation = {
        id: 'conv-001',
        session_id: 'sess-001',
        summary: 'test summary',
        participants: '["user","assistant"]',
        topics: '["greeting"]',
        key_decisions: '[]',
        message_count: 5,
        started_at: '2026-06-28T00:00:00Z',
        ended_at: null,
        embedding_id: null,
      };
      expect(conv.ended_at).toBeNull();
      expect(conv.message_count).toBe(5);
    });
  });

  describe('KnowledgeDoc', () => {
    it('can be constructed with null file_path', () => {
      const doc: KnowledgeDoc = {
        id: 'doc-001',
        title: 'Test Doc',
        source: 'note',
        file_path: null,
        content_hash: 'abc123',
        chunk_count: 3,
        status: 'active',
        created_at: '2026-06-28T00:00:00Z',
        updated_at: '2026-06-28T00:00:00Z',
      };
      expect(doc.file_path).toBeNull();
    });
  });

  describe('WorldbookEntry', () => {
    it('can be constructed with null last_triggered', () => {
      const entry: WorldbookEntry = {
        id: 'wb-001',
        trigger_keys: '["key1","key2"]',
        trigger_mode: 'any',
        content: 'world info',
        scope: 'chat',
        priority: 1,
        cooldown_sec: 300,
        last_triggered: null,
        hit_count: 0,
        created_at: '2026-06-28T00:00:00Z',
        updated_at: '2026-06-28T00:00:00Z',
      };
      expect(entry.last_triggered).toBeNull();
      expect(entry.hit_count).toBe(0);
    });
  });

  describe('CodeContext', () => {
    it('can be constructed', () => {
      const ctx: CodeContext = {
        id: 'cc-001',
        project_name: 'alysiaAgent',
        project_path: '/path/to/project',
        tech_stack: '{"runtime":"node"}',
        architecture_notes: 'Monorepo',
        recent_changes: '["Added types"]',
        decisions: '["Use TDD"]',
        is_active: 1,
        created_at: '2026-06-28T00:00:00Z',
        updated_at: '2026-06-28T00:00:00Z',
      };
      expect(ctx.is_active).toBe(1);
    });
  });

  describe('SearchResult and MemoryRead*', () => {
    it('SearchResult can be constructed', () => {
      const result: SearchResult = {
        id: 'res-001',
        score: 0.95,
        text: 'some content',
        metadata: { source: 'test' },
      };
      expect(result.score).toBeGreaterThan(0.9);
    });

    it('MemoryReadRequest can be constructed', () => {
      const req: MemoryReadRequest = {
        query: 'test query',
        mode: 'chat',
        limit: 10,
      };
      expect(req.limit).toBe(10);
    });

    it('MemoryReadResult can be constructed', () => {
      const result: MemoryReadResult = {
        context: 'some context',
        persona_hint: 'friendly',
        retrieved: [],
        worldbook_triggers: [],
      };
      expect(result.context).toBe('some context');
    });
  });

  describe('PersonaAdjustment and ProfileFact', () => {
    it('PersonaAdjustment can be constructed', () => {
      const adj: PersonaAdjustment = {
        param: 'tone.formality',
        delta: -0.15,
        reason: 'too formal',
      };
      expect(adj.delta).toBe(-0.15);
    });

    it('ProfileFact can be constructed', () => {
      const fact: ProfileFact = {
        fact: 'likes cats',
        confidence: 0.85,
        evidence: 'user said "I love cats"',
        source_event: 'evt-001',
        updated_at: '2026-06-28T00:00:00Z',
      };
      expect(fact.confidence).toBe(0.85);
    });
  });

  describe('Processed bitmask constants', () => {
    it('has correct values', () => {
      expect(PROCESSED_NONE).toBe(0);
      expect(PROCESSED_PROFILE).toBe(1);
      expect(PROCESSED_SUMMARY).toBe(2);
      expect(PROCESSED_PERSONA).toBe(4);
      expect(PROCESSED_KNOWLEDGE).toBe(8);
    });

    it('can be combined with bitwise OR', () => {
      const combined = PROCESSED_PROFILE | PROCESSED_SUMMARY;
      expect(combined & PROCESSED_PROFILE).toBeTruthy();
      expect(combined & PROCESSED_SUMMARY).toBeTruthy();
      expect(combined & PROCESSED_PERSONA).toBeFalsy();
    });
  });
});

describe('Memory system interfaces', () => {
  describe('IVectorStore', () => {
    it('has the correct method signatures', () => {
      // Type-level test: verify the interface is importable and shaped correctly
      const mockStore: IVectorStore = {
        insert: async (id: string, _vector: number[], _text: string, _metadata: Record<string, unknown>) => {
          expect(id).toBeDefined();
        },
        search: async (_vector: number[], _topK: number, _filter?: Record<string, unknown>) => {
          return [] as import('../src/memory/types').SearchResult[];
        },
        delete: async (id: string) => {
          expect(id).toBeDefined();
        },
        count: async () => 0,
      };
      expect(mockStore.count).toBeDefined();
    });
  });

  describe('IEmbedService', () => {
    it('has the correct method signatures', () => {
      const mockService: IEmbedService = {
        embed: async (_text: string) => [0.1, 0.2, 0.3],
        dimension: () => 3,
      };
      expect(mockService.dimension()).toBe(3);
    });
  });

  describe('ILLMService', () => {
    it('has the correct method signatures', () => {
      const mockService: ILLMService = {
        complete: async (_systemPrompt: string, _userPrompt: string) => 'response',
      };
      expect(mockService.complete).toBeDefined();
    });
  });
});
