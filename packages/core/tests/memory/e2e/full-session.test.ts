// E2E Full Session Test
// Tests the complete MemoryManager pipeline: ingest → session end → assemble
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager';
import { initializeDatabase } from '../../../src/memory/database';
import { EventStore } from '../../../src/memory/stores/EventStore';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { KnowledgeStore } from '../../../src/memory/stores/KnowledgeStore';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { CodeContextStore } from '../../../src/memory/stores/CodeContextStore';
import type { MemoryEvent } from '../../../src/memory/types';
import type { IEmbedService } from '../../../src/memory/interfaces/IEmbedService';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';

// ── Fixed embedding dimension ────────────────────────────────────────────────
const EMBED_DIM = 1536;

// ── Mock IEmbedService: returns a fixed 1536-dim array (unit vector) ────────
const fixedVector = new Array(EMBED_DIM).fill(0);
fixedVector[0] = 1; // unit vector along first axis

const mockEmbed: IEmbedService = {
  embed: async (_text: string) => [...fixedVector],
  dimension: () => EMBED_DIM,
};

// ── Mock ILLMService: returns structured JSON based on prompt content ───────
const mockLLM: ILLMService = {
  complete: async (_system: string, _user: string) => {
    if (_system.includes('会话总结')) {
      return JSON.stringify({
        summary: '用户讨论了TypeScript项目架构和代码规范',
        participants: ['user', 'assistant'],
        topics: ['TypeScript', '项目架构', '代码规范'],
        key_decisions: ['使用ESM模块', '采用Vitest进行测试'],
      });
    }
    if (_system.includes('用户画像提取器')) {
      return JSON.stringify({
        facts: [
          { fact: '用户是全栈TypeScript开发者', confidence: 0.9, evidence: '用户自称全栈开发者且使用TypeScript' },
          { fact: '用户关注代码质量', confidence: 0.8, evidence: '用户多次询问代码规范和测试' },
        ],
      });
    }
    if (_system.includes('人格参数调节器')) {
      return JSON.stringify({
        adjustments: [
          { param: 'tone.formality', delta: -0.1, reason: '用户倾向于非正式交流' },
        ],
      });
    }
    if (_system.includes('深度画像总结')) {
      return JSON.stringify({
        occupation: '全栈开发者',
        experience: '5年以上TypeScript经验',
        code_languages: ['TypeScript', 'Rust'],
        code_style: '函数式风格',
        comment_style: '中文JSDoc注释',
      });
    }
    return JSON.stringify({ summary: 'fallback summary', adjustments: [] });
  },
};

// ── Helper: create a MemoryEvent ─────────────────────────────────────────────
function makeEvent(overrides: Partial<MemoryEvent> & { payload?: Record<string, unknown> }): MemoryEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    session_id: 'e2e-session-1',
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content: '测试消息' },
    importance: 0.5,
    created_at: new Date().toISOString(),
    processed: 0,
    ...overrides,
  };
}

// ── Test suite ───────────────────────────────────────────────────────────────
describe('E2E Full Session', () => {
  let db: Database.Database;
  let manager: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);

    // Seed mandatory rows (persona + user_profile)
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);

    // Seed a code context entry
    db.prepare(`INSERT INTO code_context (id, project_name, project_path, tech_stack, architecture_notes, recent_changes, decisions, is_active, created_at, updated_at)
      VALUES ('cc-1', 'alysia-agent', '/home/user/alysia-agent', '{"frontend":"React","backend":"Node.js","language":"TypeScript"}',
      '微服务架构', '["添加MemoryManager","重构EventStore"]', '["使用Vitest"]', 1, ?, ?)`).run(now, now);

    // Create MemoryManager with null vectorStore (to keep test focused on pipeline)
    manager = new MemoryManager(db, null, mockEmbed, mockLLM);
  });

  afterEach(() => db.close());

  it('should complete full session lifecycle: ingest → end → assemble', async () => {
    // ── 1. Ingest 5+ events ──────────────────────────────────────────────────
    const events: MemoryEvent[] = [
      makeEvent({
        id: 'e2e-evt-1',
        source: 'chat',
        type: 'message',
        payload: { role: 'user', content: '你好，我是全栈TypeScript开发者' },
        importance: 0.6,
      }),
      makeEvent({
        id: 'e2e-evt-2',
        source: 'chat',
        type: 'message',
        payload: { role: 'assistant', content: '你好！欢迎使用Alysia Agent' },
        importance: 0.3,
      }),
      makeEvent({
        id: 'e2e-evt-3',
        source: 'chat',
        type: 'message',
        payload: { role: 'user', content: '帮我看看项目架构，我想用ESM模块' },
        importance: 0.7,
      }),
      makeEvent({
        id: 'e2e-evt-4',
        source: 'code',
        type: 'message',
        payload: { role: 'user', content: '这个函数应该怎么写？需要类型安全' },
        importance: 0.5,
      }),
      makeEvent({
        id: 'e2e-evt-5',
        source: 'tool',
        type: 'tool_call',
        payload: { tool: 'search', args: { query: 'TypeScript ESM' } },
        importance: 0.4,
      }),
      makeEvent({
        id: 'e2e-evt-6',
        source: 'chat',
        type: 'message',
        payload: { role: 'user', content: '记得写完整的JSDoc注释' },
        importance: 0.5,
      }),
    ];

    for (const event of events) {
      await manager.ingest(event);
    }

    // ── 2. End session ───────────────────────────────────────────────────────
    await manager.onSessionEnd('e2e-session-1');

    // ── 3. Verify events stored ─────────────────────────────────────────────
    const eventStore = new EventStore(db);
    for (const evt of events) {
      const stored = eventStore.getById(evt.id);
      expect(stored).not.toBeNull();
      expect(stored!.session_id).toBe('e2e-session-1');
      expect(stored!.source).toBe(evt.source);
      expect(stored!.type).toBe(evt.type);
    }

    // ── 4. Verify conversation was created ───────────────────────────────────
    const conversationStore = new ConversationStore(db, null);
    const convs = conversationStore.getBySession('e2e-session-1');
    expect(convs.length).toBeGreaterThanOrEqual(1);
    expect(convs[0].summary).toBe('用户讨论了TypeScript项目架构和代码规范');
    expect(convs[0].session_id).toBe('e2e-session-1');

    // Verify topics stored correctly
    const topics = JSON.parse(convs[0].topics);
    expect(topics).toContain('TypeScript');
    expect(topics).toContain('项目架构');

    // Verify key decisions stored
    const decisions = JSON.parse(convs[0].key_decisions);
    expect(decisions).toContain('使用ESM模块');
    expect(decisions).toContain('采用Vitest进行测试');

    // ── 5. Verify profile facts extracted ────────────────────────────────────
    const profileStore = new ProfileStore(db);
    const profile = profileStore.get();
    const facts = JSON.parse(profile.facts);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts.some((f: { fact: string }) => f.fact.includes('全栈TypeScript开发者'))).toBe(true);
    expect(facts.some((f: { fact: string }) => f.fact.includes('代码质量'))).toBe(true);

    // ── 6. Verify chat prompt ────────────────────────────────────────────────
    const chatPrompt = await manager.assemble('chat');
    expect(chatPrompt).toContain('昔涟');
    expect(chatPrompt).toContain('角色设定');
    expect(chatPrompt).toContain('[最近对话]');
    expect(chatPrompt).toContain('用户讨论了TypeScript项目架构和代码规范');
    expect(chatPrompt.length).toBeGreaterThan(50);

    // ── 7. Verify code prompt ────────────────────────────────────────────────
    const codePrompt = await manager.assemble('code');
    expect(codePrompt).toContain('昔涟');
    expect(codePrompt).toContain('编程助手模式');
    expect(codePrompt).toContain('[当前项目]');
    expect(codePrompt).toContain('alysia-agent');
    expect(codePrompt).toContain('TypeScript');
    expect(codePrompt.length).toBeGreaterThan(50);
  });

  it('should populate all stores correctly after session end', async () => {
    // Ingest minimal events
    const evt = makeEvent({
      id: 'e2e-stores-1',
      source: 'chat',
      type: 'message',
      payload: { role: 'user', content: '我是后端工程师，喜欢Rust语言' },
      importance: 0.6,
    });
    await manager.ingest(evt);

    await manager.onSessionEnd('e2e-session-1');

    // Verify all stores have expected data
    const eventStore = new EventStore(db);
    const conversationStore = new ConversationStore(db, null);
    const profileStore = new ProfileStore(db);
    const personaStore = new PersonaStore(db);
    const worldbookStore = new WorldbookStore(db);
    const knowledgeStore = new KnowledgeStore(db, null);
    const codeContextStore = new CodeContextStore(db);

    // EventStore
    const stored = eventStore.getById('e2e-stores-1');
    expect(stored).not.toBeNull();

    // ConversationStore (session end creates conversation)
    const convs = conversationStore.getBySession('e2e-session-1');
    expect(convs.length).toBe(1);

    // ProfileStore (facts extracted during session end)
    const profile = profileStore.get();
    expect(JSON.parse(profile.facts).length).toBeGreaterThanOrEqual(1);

    // PersonaStore (seeded, should exist)
    const persona = personaStore.get();
    expect(persona.name).toBe('昔涟');

    // WorldbookStore (seeded none, but table exists)
    expect(worldbookStore).toBeDefined();

    // KnowledgeStore (no docs seeded)
    expect(knowledgeStore.listActive()).toEqual([]);

    // CodeContextStore (seeded, should be active)
    const codeCtx = codeContextStore.getActive();
    expect(codeCtx).not.toBeNull();
    expect(codeCtx!.project_name).toBe('alysia-agent');
  });
});
