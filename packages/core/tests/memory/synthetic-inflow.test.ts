// tests/memory/synthetic-inflow.test.ts
// ★ 2026-10-16 · change: filter-synthetic-context-inflow（KI-20）
//
// 现象：dsh 每一步之前会把「动态运行时上下文」投影成**一条 user 消息**塞进会话，
// 适配器的「用户消息」监听器照单全收 ⇒ 这段文本以 `role:'user'` 入库 ⇒
// 画像从画像里「重新学」（**画像回吸**）、人格从中再触发 hints（**记忆触发记忆**）。
//
// 修复的判据不是文本，而是服务端打的两个标记（`skip_profile` + `synthetic`）。
// 本文件守四件事：
//   ① 合成事件**不进学习管道**（画像 / 人格 / 嵌入）
//   ② 但它**仍在事件表里**（事件日志不可变，且复盘要靠它）
//   ③ 跳过**必须留痕**；而群聊 NPC 的 skip_profile **不许**因此变吵
//   ④ **合成事件不进摘要** —— 摘要会被召回并回灌，是第三条泄漏路径
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database';
import { EventStore } from '../../src/memory/stores/EventStore';
import { ConversationStore } from '../../src/memory/stores/ConversationStore';
import { ProfileStore } from '../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../src/memory/stores/PersonaStore';
import { WorldbookStore } from '../../src/memory/stores/WorldbookStore';
import { WorldbookMatcher } from '../../src/memory/engines/WorldbookMatcher';
import { PersonaAdapter } from '../../src/memory/engines/PersonaAdapter';
import { ProfileExtractor } from '../../src/memory/engines/ProfileExtractor';
import { RealtimeProcessor } from '../../src/memory/processors/RealtimeProcessor';
import { SessionEndProcessor } from '../../src/memory/processors/SessionEndProcessor';
import { logger } from '../../src/utils/logger';
import { __resetThrottledWarnings } from '../../src/utils/write-trace';
import type { MemoryEvent } from '../../src/memory/types';
import type { ILLMService } from '../../src/memory/interfaces/ILLMService';
import type { IEmbedService } from '../../src/memory/interfaces/IEmbedService';
import type { IVectorStore } from '../../src/memory/interfaces/IVectorStore';

/** 服务端会给 dsh 合成注入打的两个标记（见 `packages/server/src/ingest.ts`） */
const SYNTHETIC = { skip_profile: true, synthetic: 'runtime-context', dsh_source: 'runtime-context' };

/**
 * ★ 2026-10-17（change: `isolate-delegated-task-memory`）：**委托任务会话**的标记。
 *
 * 服务端见到 `payload.dsh_origin` 就打**同样这两个字段**（不新增机制），
 * 所以 core 这边**必须一视同仁** —— 本常量存在的意义就是把这条契约钉死在测试里：
 * 将来若有人把闸改成「只认 `runtime-context`」，这条会立刻红。
 */
const DELEGATED = { skip_profile: true, synthetic: 'delegated-task', dsh_origin: 'delegated-task' };

/** dsh 真正注入的那段文本（本用例只借它的形态，不依赖它的内容做判据） */
const RUNTIME_CONTEXT_TEXT =
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n' +
  '[角色设定]\n[关于你]\n[关于我]';

const mockLLM: ILLMService = {
  complete: vi.fn(async (_system: string, _user: string) =>
    JSON.stringify({
      summary: '摘要',
      participants: ['user', 'assistant'],
      topics: [],
      key_decisions: [],
      character_perspective: '',
      important_moments: [],
    }),
  ),
};

const mockEmbed: IEmbedService = { embed: async () => [0.1, 0.2], dimension: () => 2 };

function makeEvent(overrides: Partial<MemoryEvent> & { payload?: Record<string, unknown> }): MemoryEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    session_id: 'dsh:session-x',
    source: 'code',
    type: 'message',
    payload: { role: 'user', content: '普通消息' },
    importance: 0.5,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('★ 合成注入不进学习管道（KI-20）', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let personaAdapter: PersonaAdapter;
  let vectorStore: IVectorStore & { insert: ReturnType<typeof vi.fn> };
  let processor: RealtimeProcessor;

  beforeEach(() => {
    __resetThrottledWarnings();
    db = new Database(':memory:');
    initializeDatabase(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);

    eventStore = new EventStore(db);
    const personaStore = new PersonaStore(db);
    personaAdapter = new PersonaAdapter(personaStore, mockLLM);
    const profileStore = new ProfileStore(db);
    const worldbookStore = new WorldbookStore(db);
    vectorStore = {
      insert: vi.fn(async () => {}),
      search: async () => [],
      delete: async () => {},
      count: async () => 0,
    } as never;
    processor = new RealtimeProcessor(
      eventStore,
      new WorldbookMatcher(worldbookStore),
      personaAdapter,
      profileStore,
      new ProfileExtractor(mockLLM),
      mockEmbed,
      vectorStore,
    );
  });
  afterEach(() => db.close());

  it('★★ 主症：合成注入不触发人格扫描、不做嵌入（只留流水账）', async () => {
    const spy = vi.spyOn(personaAdapter, 'processSignal');
    const event = makeEvent({ payload: { role: 'user', content: RUNTIME_CONTEXT_TEXT, ...SYNTHETIC } });
    eventStore.insert(event);

    await processor.process(event);

    expect(spy, '合成注入被当成"用户说了什么"去做人格扫描了').not.toHaveBeenCalled();
    expect(vectorStore.insert, '合成注入被嵌入进向量库了（日后会被召回）').not.toHaveBeenCalled();
  });

  it('★ 回归：普通用户消息照常走画像与嵌入（别把闸焊死）', async () => {
    const spy = vi.spyOn(personaAdapter, 'processSignal');
    const event = makeEvent({ payload: { role: 'user', content: '我家猫最近怎么样' } });
    eventStore.insert(event);

    await processor.process(event);

    expect(spy).toHaveBeenCalled();
    expect(vectorStore.insert).toHaveBeenCalled();
  });

  it('★★ R4：合成事件**仍然在事件表里**（拦的是学习，不是入库）', async () => {
    const event = makeEvent({ payload: { role: 'user', content: RUNTIME_CONTEXT_TEXT, ...SYNTHETIC } });
    eventStore.insert(event);
    await processor.process(event);

    const stored = eventStore.getById(event.id);
    expect(stored, '事件被删掉了 —— 事件日志是不可变的，且复盘要靠它').not.toBeNull();
    expect(stored!.payload.content).toBe(RUNTIME_CONTEXT_TEXT);
    // 证据也留着：将来要能回答"它为什么被跳过"
    expect(stored!.payload.dsh_source).toBe('runtime-context');
  });

  it('★★ R5：跳过**必须留痕**（否则"滤掉了"与"本来没采到"同形）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const event = makeEvent({ payload: { role: 'user', content: RUNTIME_CONTEXT_TEXT, ...SYNTHETIC } });
    eventStore.insert(event);

    await processor.process(event);

    // ★ 2026-10-17（change: `isolate-delegated-task-memory`）：文案改为**原因中立**
    //   —— `synthetic` 现在也承载「委托任务会话」这一来源（机器发起，不是用户发言），
    //   对那种事件说「合成注入」会把排查带偏。断言因此跟着改口径，
    //   但要求更强了：**必须能看到「为什么被跳过」**。
    const logged = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged, '跳过没留痕 —— "滤掉了"与"本来没采到"会同形').toContain('非用户发言');
    expect(logged, '留痕里没有跳过原因，事后无法复盘').toContain('runtime-context');
    warn.mockRestore();
  });

  // ★ 2026-10-17（change: `isolate-delegated-task-memory`）：**委托会话走同一个闸**
  it('★★ 委托任务会话（dsh_origin）与合成注入**一视同仁**：同样不进画像/人格/嵌入', async () => {
    const spy = vi.spyOn(personaAdapter, 'processSignal');
    const event = makeEvent({ payload: { role: 'user', content: '把关于我页面做出来', ...DELEGATED } });
    eventStore.insert(event);

    await processor.process(event);

    expect(spy, '委托会话被当成"用户说了什么"去做人格扫描了').not.toHaveBeenCalled();
    expect(vectorStore.insert, '委托会话被嵌入进向量库了（日后会被召回）').not.toHaveBeenCalled();
    // 与合成注入一样，只留流水账（事件仍在，只是不进学习管道）
    expect(eventStore.getById(event.id)).not.toBeNull();
  });

  it('★ 回归：群聊 NPC 的 skip_profile **不许**因此变吵（那量很大，会淹掉日志）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const event = makeEvent({ payload: { role: 'user', content: '群里的路人甲说话', skip_profile: true } });
    eventStore.insert(event);

    await processor.process(event);

    expect(
      warn.mock.calls.map(c => String(c[0])).join('\n'),
      'NPC 消息也开始打日志了 —— 本项目已因 96.6% 噪声吃过一次亏',
    ).not.toContain('非用户发言');
    warn.mockRestore();
  });
});

describe('★★ 合成注入不进摘要（第三条泄漏路径）', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let processor: SessionEndProcessor;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);

    eventStore = new EventStore(db);
    const conversationStore = new ConversationStore(db);
    const profileStore = new ProfileStore(db);
    const personaStore = new PersonaStore(db);
    const worldbookStore = new WorldbookStore(db);
    const vectorStore: IVectorStore = {
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
      new ProfileExtractor(mockLLM),
      new PersonaAdapter(personaStore, mockLLM),
      mockLLM,
      mockEmbed,
      vectorStore,
    );
  });
  afterEach(() => db.close());

  it('★★ 摘要的输入里**不含**合成注入，但含真实对话', async () => {
    const complete = mockLLM.complete as unknown as ReturnType<typeof vi.fn>;
    complete.mockClear();

    const synthetic = makeEvent({
      session_id: 'sess-sum-1',
      payload: { role: 'user', content: RUNTIME_CONTEXT_TEXT, ...SYNTHETIC },
    });
    const real = makeEvent({
      session_id: 'sess-sum-1',
      payload: { role: 'user', content: '我今天去看了海' },
    });
    eventStore.insert(synthetic);
    eventStore.insert(real);

    await processor.process('sess-sum-1');

    const prompt = complete.mock.calls.map(c => String(c[1])).join('\n');
    expect(prompt, '合成注入进了摘要 —— 摘要会被召回并回灌，等于它换个形式留在记忆里')
      .not.toContain('runtime-context snapshots');
    expect(prompt, '真实对话不该被一起滤掉').toContain('我今天去看了海');
  });

  it('★ 全是合成注入的会话 → 走「无可用对话」而不是产出摘要', async () => {
    const complete = mockLLM.complete as unknown as ReturnType<typeof vi.fn>;
    complete.mockClear();
    eventStore.insert(makeEvent({
      session_id: 'sess-sum-2',
      payload: { role: 'user', content: RUNTIME_CONTEXT_TEXT, ...SYNTHETIC },
    }));

    const r = await processor.process('sess-sum-2');

    expect(r.summary).toBe('skipped');
    expect(r.reason).toBe('no-dialogue');
    expect(complete, '只有合成注入时不该白调一次 LLM').not.toHaveBeenCalled();
  });
});
