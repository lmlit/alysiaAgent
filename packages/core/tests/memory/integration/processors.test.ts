// tests/memory/integration/processors.test.ts
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';
import { EventStore } from '../../../src/memory/stores/EventStore';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { KnowledgeStore } from '../../../src/memory/stores/KnowledgeStore';
import { WorldbookMatcher } from '../../../src/memory/engines/WorldbookMatcher';
import { PersonaAdapter } from '../../../src/memory/engines/PersonaAdapter';
import { ProfileExtractor } from '../../../src/memory/engines/ProfileExtractor';
import { RealtimeProcessor } from '../../../src/memory/processors/RealtimeProcessor';
import { SessionEndProcessor } from '../../../src/memory/processors/SessionEndProcessor';
import { CronProcessor } from '../../../src/memory/processors/CronProcessor';
import type { MemoryEvent } from '../../../src/memory/types';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';
import type { IEmbedService } from '../../../src/memory/interfaces/IEmbedService';
import type { IVectorStore } from '../../../src/memory/interfaces/IVectorStore';
import {
  PROCESSED_PROFILE,
  PROCESSED_SUMMARY,
  PROCESSED_PERSONA,
  PROCESSED_KNOWLEDGE,
} from '../../../src/memory/types';

// ── Mock services ──────────────────────────────────────────────────────────

const mockLLM: ILLMService = {
  complete: async (_system: string, _user: string) => {
    // Return different responses based on the prompt content
    if (_system.includes('会话总结')) {
      return JSON.stringify({
        summary: '用户询问了关于项目架构的问题',
        participants: ['user', 'assistant'],
        topics: ['架构', '项目'],
        key_decisions: ['采用微服务架构'],
      });
    }
    if (_system.includes('深度画像总结')) {
      return '用户是一名有5年经验的全栈工程师，擅长TypeScript和React';
    }
    if (_system.includes('用户画像提取器')) {
      return JSON.stringify({
        facts: [
          { fact: '用户是全栈工程师', confidence: 0.85, evidence: '我在全栈开发方面有经验' },
        ],
      });
    }
    if (_system.includes('人格参数调节器')) {
      return JSON.stringify({
        adjustments: [{ param: 'tone.formality', delta: -0.05, reason: '用户希望更随意' }],
      });
    }
    return '{}';
  },
};

const mockEmbed: IEmbedService = {
  embed: async (_text: string) => [0.1, 0.2, 0.3, 0.4, 0.5],
  dimension: () => 5,
};

// ── Helpers ────────────────────────────────────────────────────────────────

const makeEvent = (overrides: Partial<MemoryEvent> & { payload?: Record<string, unknown> }): MemoryEvent => ({
  id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  session_id: 'sess-integ-1',
  source: 'chat',
  type: 'message',
  payload: { role: 'user', content: '测试消息' },
  importance: 0.5,
  created_at: new Date().toISOString(),
  processed: 0,
  ...overrides,
});

describe('RealtimeProcessor', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let worldbookStore: WorldbookStore;
  let worldbookMatcher: WorldbookMatcher;
  let personaStore: PersonaStore;
  let personaAdapter: PersonaAdapter;
  let profileStore: ProfileStore;
  let vectorStore: IVectorStore;
  let processor: RealtimeProcessor;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);

    // Seed default persona row
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);

    // Seed default user_profile row
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);

    // Seed a worldbook entry
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at)
      VALUES ('wb-1', '["测试","worldbook"]', 'any', '这是测试worldbook条目', 'chat', 10, 300, NULL, 0, ?, ?)`).run(now, now);

    eventStore = new EventStore(db);
    worldbookStore = new WorldbookStore(db);
    worldbookMatcher = new WorldbookMatcher(worldbookStore);
    personaStore = new PersonaStore(db);
    personaAdapter = new PersonaAdapter(personaStore, mockLLM);
    profileStore = new ProfileStore(db);
    vectorStore = {
      insert: async () => {},
      search: async () => [],
      delete: async () => {},
      count: async () => 0,
    };

    processor = new RealtimeProcessor(
      eventStore,
      worldbookMatcher,
      personaAdapter,
      profileStore,
      mockEmbed,
      vectorStore,
    );
  });

  afterEach(() => db.close());

  it('should process event with worldbook match and persona scan and embed', async () => {
    const event = makeEvent({ payload: { role: 'user', content: '测试 worldbook 匹配' } });
    eventStore.insert(event);

    await processor.process(event);

    // Check event was marked with profile, persona, and knowledge bits
    const processed = eventStore.getById(event.id);
    expect(processed).not.toBeNull();
    expect(processed!.processed & PROCESSED_PROFILE).toBe(PROCESSED_PROFILE);
    expect(processed!.processed & PROCESSED_PERSONA).toBe(PROCESSED_PERSONA);
    expect(processed!.processed & PROCESSED_KNOWLEDGE).toBe(PROCESSED_KNOWLEDGE);

    // Check worldbook entry was triggered (hit_count incremented)
    const wbEntry = worldbookStore.getById('wb-1');
    expect(wbEntry).not.toBeNull();
    expect(wbEntry!.hit_count).toBe(1);
  });

  it('should process event without worldbook match (no trigger keywords)', async () => {
    const event = makeEvent({ payload: { role: 'user', content: '你好' } });
    eventStore.insert(event);

    await processor.process(event);

    const processed = eventStore.getById(event.id);
    expect(processed).not.toBeNull();
    expect(processed!.processed & PROCESSED_PROFILE).toBe(PROCESSED_PROFILE);
    expect(processed!.processed & PROCESSED_PERSONA).toBe(PROCESSED_PERSONA);
    expect(processed!.processed & PROCESSED_KNOWLEDGE).toBe(PROCESSED_KNOWLEDGE);
  });

  it('should handle null vectorStore gracefully', async () => {
    const processorWithoutVector = new RealtimeProcessor(
      eventStore,
      worldbookMatcher,
      personaAdapter,
      profileStore,
      mockEmbed,
      null,
    );

    const event = makeEvent({ payload: { role: 'user', content: '测试内容' } });
    eventStore.insert(event);

    // Should not throw when vectorStore is null
    await expect(processorWithoutVector.process(event)).resolves.toBeUndefined();

    const processed = eventStore.getById(event.id);
    expect(processed).not.toBeNull();
    expect(processed!.processed & PROCESSED_KNOWLEDGE).toBe(PROCESSED_KNOWLEDGE);
  });

  it('should handle persona adapter returning null (no adjustment)', async () => {
    const quietLLM: ILLMService = {
      complete: async () => JSON.stringify({ adjustments: [] }),
    };
    const quietAdapter = new PersonaAdapter(personaStore, quietLLM);
    const p = new RealtimeProcessor(
      eventStore,
      worldbookMatcher,
      quietAdapter,
      profileStore,
      mockEmbed,
      null,
    );

    const event = makeEvent({ payload: { role: 'user', content: '普通消息' } });
    eventStore.insert(event);

    await expect(p.process(event)).resolves.toBeUndefined();
  });
});

describe('SessionEndProcessor', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let conversationStore: ConversationStore;
  let profileStore: ProfileStore;
  let personaStore: PersonaStore;
  let worldbookStore: WorldbookStore;
  let profileExtractor: ProfileExtractor;
  let personaAdapter: PersonaAdapter;
  let vectorStore: IVectorStore;
  let processor: SessionEndProcessor;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);

    const now = new Date().toISOString();

    // Seed rows
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);

    eventStore = new EventStore(db);
    conversationStore = new ConversationStore(db, null);
    profileStore = new ProfileStore(db);
    personaStore = new PersonaStore(db);
    worldbookStore = new WorldbookStore(db);
    profileExtractor = new ProfileExtractor(mockLLM);
    personaAdapter = new PersonaAdapter(personaStore, mockLLM);
    vectorStore = {
      insert: async () => {},
      search: async () => [],
      delete: async () => {},
      count: async () => 0,
    };

    processor = new SessionEndProcessor(
      eventStore,
      conversationStore,
      profileStore,
      personaStore,
      worldbookStore,
      profileExtractor,
      personaAdapter,
      mockLLM,
      mockEmbed,
      vectorStore,
    );
  });

  afterEach(() => db.close());

  it('should process session end: summary, profile, persona confirm', async () => {
    const sessionId = 'sess-end-1';

    // Insert a few events for this session
    const evt1 = makeEvent({ id: 'e1', session_id: sessionId, payload: { role: 'user', content: '我在全栈开发方面有经验' } });
    const evt2 = makeEvent({ id: 'e2', session_id: sessionId, payload: { role: 'assistant', content: '明白了' } });
    const evt3 = makeEvent({ id: 'e3', session_id: sessionId, payload: { role: 'user', content: '你说话别太正式了' } });
    eventStore.insert(evt1);
    eventStore.insert(evt2);
    eventStore.insert(evt3);

    await processor.process(sessionId);

    // All events should be marked with PROCESSED_SUMMARY
    for (const id of ['e1', 'e2', 'e3']) {
      const evt = eventStore.getById(id);
      expect(evt!.processed & PROCESSED_SUMMARY).toBe(PROCESSED_SUMMARY);
    }

    // Conversation should be created
    const conversations = conversationStore.getBySession(sessionId);
    expect(conversations.length).toBeGreaterThanOrEqual(1);
    expect(conversations[0].summary).toBeTruthy();
    expect(conversations[0].session_id).toBe(sessionId);

    // Profile facts should be stored
    const profile = profileStore.get();
    const facts = JSON.parse(profile.facts);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts.some((f: { fact: string }) => f.fact.includes('全栈工程师'))).toBe(true);
  });

  it('should handle empty session gracefully', async () => {
    const sessionId = 'sess-empty';
    // No events inserted

    await expect(processor.process(sessionId)).resolves.toBeUndefined();
  });

  it('should handle events with no extractable facts', async () => {
    const noFactsLLM: ILLMService = {
      complete: async (_system: string, _user: string) => {
        if (_system.includes('用户画像提取器')) {
          return JSON.stringify({ facts: [] });
        }
        return JSON.stringify({
          summary: '简短对话',
          participants: ['user', 'assistant'],
          topics: ['闲聊'],
          key_decisions: [],
        });
      },
    };

    const sessionId = 'sess-nofacts';
    const p = new SessionEndProcessor(
      eventStore,
      conversationStore,
      profileStore,
      personaStore,
      worldbookStore,
      new ProfileExtractor(noFactsLLM),
      personaAdapter,
      noFactsLLM,
      mockEmbed,
      vectorStore,
    );

    const evt = makeEvent({ id: 'e-nf', session_id: sessionId, payload: { role: 'user', content: '你好' } });
    eventStore.insert(evt);

    await expect(p.process(sessionId)).resolves.toBeUndefined();

    // Still should mark as summary-processed
    const processed = eventStore.getById('e-nf');
    expect(processed!.processed & PROCESSED_SUMMARY).toBe(PROCESSED_SUMMARY);
  });
});

describe('CronProcessor', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let conversationStore: ConversationStore;
  let knowledgeStore: KnowledgeStore;
  let profileStore: ProfileStore;
  let profileExtractor: ProfileExtractor;
  let vectorStore: IVectorStore;
  let processor: CronProcessor;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);

    const now = new Date().toISOString();

    // Seed rows
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);

    eventStore = new EventStore(db);
    conversationStore = new ConversationStore(db, null);
    knowledgeStore = new KnowledgeStore(db, null);
    profileStore = new ProfileStore(db);
    profileExtractor = new ProfileExtractor(mockLLM);
    vectorStore = {
      insert: async () => {},
      search: async () => [],
      delete: async () => {},
      count: async () => 0,
    };

    processor = new CronProcessor(
      eventStore,
      conversationStore,
      knowledgeStore,
      profileStore,
      profileExtractor,
      mockLLM,
      vectorStore,
    );
  });

  afterEach(() => db.close());

  it('should compact old events (>7 days)', async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const recentDate = new Date().toISOString();

    const oldEvent = makeEvent({ id: 'old-1', created_at: oldDate, processed: 0 });
    const recentEvent = makeEvent({ id: 'recent-1', created_at: recentDate, processed: 0 });
    eventStore.insert(oldEvent);
    eventStore.insert(recentEvent);

    await processor.process();

    // Old event should be marked with all processed flags
    const oldProcessed = eventStore.getById('old-1');
    const allFlags = PROCESSED_PROFILE | PROCESSED_SUMMARY | PROCESSED_PERSONA | PROCESSED_KNOWLEDGE;
    expect(oldProcessed!.processed & allFlags).toBe(allFlags);

    // Recent event should still be unprocessed
    const recentProcessed = eventStore.getById('recent-1');
    expect(recentProcessed!.processed).toBe(0);
  });

  it('should deep profile summarize all facts into basics', async () => {
    const now = new Date().toISOString();
    // Seed some profile facts
    const facts = [
      { fact: '用户是全栈工程师', confidence: 0.9, evidence: '有全栈开发经验', source_event: 'e1', updated_at: now },
      { fact: '用户喜欢TypeScript', confidence: 0.8, evidence: '经常写TypeScript', source_event: 'e2', updated_at: now },
    ];
    profileStore.replaceFacts(facts);

    await processor.process();

    // basics should have been updated with LLM summary
    const profile = profileStore.get();
    expect(profile.basics).not.toBe('{}');
    expect(profile.basics).toContain('全栈');
  });

  it('should archive old knowledge docs (>90 days)', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    // Insert old and recent knowledge docs
    db.prepare(`INSERT INTO knowledge_docs (id, title, source, content_hash, chunk_count, status, created_at, updated_at)
      VALUES ('kd-old', 'Old Doc', 'note', 'hash1', 1, 'active', ?, ?)`).run(oldDate, oldDate);
    db.prepare(`INSERT INTO knowledge_docs (id, title, source, content_hash, chunk_count, status, created_at, updated_at)
      VALUES ('kd-recent', 'Recent Doc', 'note', 'hash2', 1, 'active', ?, ?)`).run(recentDate, recentDate);

    await processor.process();

    // Old doc should be archived
    const oldDoc = knowledgeStore.getById('kd-old');
    expect(oldDoc!.status).toBe('archived');

    // Recent doc should still be active
    const recentDoc = knowledgeStore.getById('kd-recent');
    expect(recentDoc!.status).toBe('active');
  });

  it('should handle empty state without errors', async () => {
    // No events, no knowledge docs, no profile facts
    await expect(processor.process()).resolves.toBeUndefined();
  });
});
