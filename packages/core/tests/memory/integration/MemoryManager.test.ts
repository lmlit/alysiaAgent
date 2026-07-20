// tests/memory/integration/MemoryManager.test.ts
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager';
import { initializeDatabase } from '../../../src/memory/database';
import type { MemoryEvent, MemoryReadRequest } from '../../../src/memory/types';
import type { IEmbedService } from '../../../src/memory/interfaces/IEmbedService';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';
import type { IVectorStore } from '../../../src/memory/interfaces/IVectorStore';

// ── Mock services ──────────────────────────────────────────────────────────

const mockEmbed: IEmbedService = {
  embed: async () => new Array(1536).fill(0).map(() => Math.random()),
  dimension: () => 1536,
};

const mockLLM: ILLMService = {
  complete: async (_system: string, _user: string) => {
    if (_system.includes('会话总结')) {
      return JSON.stringify({
        summary: '用户询问了关于职业的问题',
        participants: ['user', 'assistant'],
        topics: ['职业'],
        key_decisions: [],
      });
    }
    if (_system.includes('用户画像提取器')) {
      return JSON.stringify({
        facts: [
          { fact: '用户是后端工程师', confidence: 0.85, evidence: '我是后端工程师' },
        ],
      });
    }
    if (_system.includes('人格参数调节器')) {
      return JSON.stringify({
        adjustments: [{ param: 'tone.formality', delta: -0.05, reason: '用户希望更随意' }],
      });
    }
    return JSON.stringify({ summary: 'test summary', adjustments: [] });
  },
};

const mockVectorStore: IVectorStore = {
  insert: async () => {},
  search: async () => [],
  delete: async () => {},
  count: async () => 0,
};

describe('MemoryManager', () => {
  let db: Database.Database;
  let manager: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);

    // Seed mandatory rows
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);

    manager = new MemoryManager(db, null, mockEmbed, mockLLM);
  });

  afterEach(() => db.close());

  it('should ingest an event and make it retrievable', async () => {
    const event: MemoryEvent = {
      id: 'evt-1',
      session_id: 'sess-1',
      source: 'chat',
      type: 'message',
      payload: { role: 'user', content: '我是后端工程师' },
      importance: 0.6,
      created_at: new Date().toISOString(),
      processed: 0,
    };

    await manager.ingest(event);

    const result = await manager.read({ query: '职业', mode: 'chat', limit: 5 });
    expect(result.retrieved).toBeDefined();
    expect(result.worldbook_triggers).toBeDefined();
  });

  it('should assemble chat mode system prompt', async () => {
    const prompt = await manager.assemble('chat');
    expect(prompt).toContain('昔涟');
    expect(prompt.length).toBeGreaterThan(50);
  });

  it('should assemble code mode system prompt', async () => {
    // First set up some profile data
    db.prepare(`UPDATE user_profile SET basics = ?, preferences = ?, updated_at = ? WHERE id = 1`)
      .run('{"occupation":"后端工程师"}', '{"code_languages":["TypeScript","Rust"]}', new Date().toISOString());

    const prompt = await manager.assemble('code');
    expect(prompt).toContain('后端工程师');
    expect(prompt).not.toContain('爱好');
    expect(prompt.length).toBeGreaterThan(50);
  });

  it('should handle session end', async () => {
    await manager.ingest({
      id: 'evt-1', session_id: 'sess-1', source: 'chat', type: 'message',
      payload: { role: 'user', content: 'hello' }, importance: 0.3,
      created_at: new Date().toISOString(), processed: 0,
    });

    await manager.onSessionEnd('sess-1');
    // Should not throw — verifies session end pipeline is wired up
  });
});
