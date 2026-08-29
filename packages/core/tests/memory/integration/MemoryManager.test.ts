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

  it('should import knowledge and retrieve via text search', async () => {
    const longContent = '昔涟的设定文档。'.repeat(200); // 超过 500 字符触发分块
    const result = await manager.importKnowledge({ title: '昔涟设定', content: longContent });
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.deduplicated).toBe(false);

    // 重复导入 → 去重
    const dup = await manager.importKnowledge({ title: '昔涟设定', content: longContent });
    expect(dup.deduplicated).toBe(true);

    // 检索命中 chunk 内容
    const read = await manager.read({ query: '设定文档', mode: 'chat', limit: 5 });
    const hit = read.retrieved.find(r => r.text.includes('昔涟的设定文档'));
    expect(hit).toBeDefined();
  });

  // ===== 8-12 记忆旋钮接线（memory-knobs-into-recall-pipeline）=====

  it('旋钮衰减：recency_weight 高时旧结果被罚，新结果靠前', async () => {
    const now = Date.now();
    const vectorStore: IVectorStore = {
      insert: async () => {},
      // ★ 按 source 区分返回：event 两条（旧/新），knowledge 一条（无时间不衰减）
      search: async (_v: number[], _k: number, opts?: { source?: string }) => {
        if (opts?.source === 'chat') return [
          { id: 'old', score: 0.9, text: '旧事件', metadata: { source: 'event', created_at: new Date(now - 3 * 86_400_000).toISOString() } },
          { id: 'new', score: 0.8, text: '新事件', metadata: { source: 'event', created_at: new Date(now - 3_600_000).toISOString() } },
        ];
        if (opts?.source === 'knowledge') return [
          { id: 'kb', score: 0.7, text: '知识条目', metadata: { source: 'knowledge' } },
        ];
        return [];
      },
      delete: async () => {},
      count: async () => 3,
    };
    const mm = new MemoryManager(db, vectorStore, mockEmbed, mockLLM);
    // 强旋钮：recency_weight=1（只认最近）→ 3 天前的 0.9 被罚 50%×ageFactor 后低于新事件
    mm.adjustMemoryConfig({ recency_weight: 1 });
    const result = await mm.read({ query: 'x', mode: 'chat', limit: 5 });
    const order = result.retrieved.map(r => r.id);
    expect(order[0]).toBe('new'); // 新事件超越旧事件
    expect(order).toContain('kb'); // 知识不衰减仍在
  });

  it('旋钮：decay_rate=0（不忘）→ 旧结果不衰减，保持相关度排序', async () => {
    const now = Date.now();
    const vectorStore: IVectorStore = {
      insert: async () => {},
      search: async (_v: number[], _k: number, opts?: { source?: string }) => {
        if (opts?.source === 'chat') return [
          { id: 'old', score: 0.9, text: '旧事件', metadata: { source: 'event', created_at: new Date(now - 10 * 86_400_000).toISOString() } },
          { id: 'new', score: 0.8, text: '新事件', metadata: { source: 'event', created_at: new Date(now - 3_600_000).toISOString() } },
        ];
        return [];
      },
      delete: async () => {},
      count: async () => 2,
    };
    const mm = new MemoryManager(db, vectorStore, mockEmbed, mockLLM);
    // 写 decay_rate=0：半衰无穷 → 不罚
    mm.adjustMemoryConfig({ decay_rate: 0 });
    const result = await mm.read({ query: 'x', mode: 'chat', limit: 5 });
    expect(result.retrieved.map(r => r.id)).toEqual(['old', 'new']); // 相关度排序保持
  });

  it('旋钮：importance > threshold 的结果加分提前', async () => {
    const vectorStore: IVectorStore = {
      insert: async () => {},
      search: async (_v: number[], _k: number, opts?: { source?: string }) => {
        if (opts?.source === 'chat') return [
          { id: 'imp', score: 0.5, text: '重要事件', metadata: { source: 'event', importance: 0.9 } },
          { id: 'norm', score: 0.6, text: '普通事件', metadata: { source: 'event' } },
        ];
        return [];
      },
      delete: async () => {},
      count: async () => 2,
    };
    const mm = new MemoryManager(db, vectorStore, mockEmbed, mockLLM);
    const result = await mm.read({ query: 'x', mode: 'chat', limit: 5 });
    // importance 0.9 > threshold 0.4 → +0.15 → 0.65 > 0.6 提前
    expect(result.retrieved.map(r => r.id)).toEqual(['imp', 'norm']);
  });

  // ===== 8-12 事件向量检索（life-event-vector-search）=====

  it('recordLifeEvent → 事件嵌入向量（source=life_event，fire-and-forget）', async () => {
    const inserts: Array<{ source?: string }> = [];
    const vectorStore: IVectorStore = {
      insert: async (_id: string, _v: number[], _t: string, meta: Record<string, unknown>) => { inserts.push(meta); },
      search: async () => [],
      delete: async () => {},
      count: async () => 0,
    };
    const mm = new MemoryManager(db, vectorStore, mockEmbed, mockLLM);
    const id = mm.recordLifeEvent({ type: 'chat', content: '在阳台看书' });
    await new Promise(r => setTimeout(r, 20)); // 等 fire-and-forget 嵌入完成
    expect(inserts).toHaveLength(1);
    expect(inserts[0].source).toBe('life_event');
    expect(inserts[0].created_at).toBeTruthy();
    expect(id).toContain('life-');
  });

  it('read() 检索含 life 事件（source=life_event）', async () => {
    const vectorStore: IVectorStore = {
      insert: async () => {},
      search: async (_v: number[], _k: number, opts?: { source?: string }) => {
        if (opts?.source === 'life_event') return [
          { id: 'life-1', score: 0.85, text: '午后在画册上描了一颗星', metadata: { source: 'life_event', created_at: new Date().toISOString() } },
        ];
        return [];
      },
      delete: async () => {},
      count: async () => 1,
    };
    const mm = new MemoryManager(db, vectorStore, mockEmbed, mockLLM);
    const result = await mm.read({ query: '画册', mode: 'chat', limit: 5 });
    expect(result.retrieved.some(r => r.id === 'life-1')).toBe(true);
  });

  it('should list and delete knowledge docs', async () => {
    await manager.importKnowledge({ title: '文档A', content: '内容A' });
    await manager.importKnowledge({ title: '文档B', content: '内容B' });

    const docs = manager.listKnowledgeDocs();
    expect(docs).toHaveLength(2);

    await manager.deleteKnowledgeDoc(docs[0].id);
    expect(manager.listKnowledgeDocs()).toHaveLength(1);
  });

  // ★ 8-29 cr-p0-delete-cleanup：删除同步清向量——已删内容不再被召回
  it('deleteKnowledgeDoc → 同步删除 chunks 向量', async () => {
    const deleted: string[] = [];
    const vectorStore: IVectorStore = {
      insert: async () => {},
      search: async () => [],
      delete: async (id: string) => { deleted.push(id); },
      count: async () => 0,
    };
    const mm = new MemoryManager(db, vectorStore, mockEmbed, mockLLM);
    await mm.importKnowledge({ title: '文档A', content: '第一段内容。第二段内容。' });

    const docs = mm.listKnowledgeDocs();
    expect(docs).toHaveLength(1);
    await mm.deleteKnowledgeDoc(docs[0].id);
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.every(id => id.startsWith(`chunk_${docs[0].id}`))).toBe(true);
  });

  // ★ 8-29 cr-p0-delete-cleanup：会话删除同步清事件+摘要向量
  it('deleteSession → 同步删除 events/conversations 向量', async () => {
    const deleted: string[] = [];
    const vectorStore: IVectorStore = {
      insert: async () => {},
      search: async () => [],
      delete: async (id: string) => { deleted.push(id); },
      count: async () => 0,
    };
    const mm = new MemoryManager(db, vectorStore, mockEmbed, mockLLM);
    await mm.ingest({
      id: 'evt-1', session_id: 'webui:private:u1', source: 'chat', type: 'message',
      payload: { content: '你好', role: 'user' }, importance: 0.5,
      created_at: new Date().toISOString(),
    } as any);

    await mm.deleteSession('u1');
    expect(deleted).toContain('evt-1');
  });

  // ── v3 角色系统 ─────────────────────────────────────

  it('should import role with worldbook and switch', async () => {
    const result = manager.importRole({
      role: 'tester',
      name: '测试员',
      system_prompt: '你是测试员人格',
      persona: { tone: { formality: 0.8 }, speech_style: {}, emotional_range: {} },
      worldbook: [
        { trigger_keys: ['测试'], content: '这是测试角色的世界书条目', priority: 10 },
        { trigger_keys: ['图片'], content: 'http://img/1.png', content_type: 'image' },
      ],
      activate: true,
    });
    expect(result.worldbookCount).toBe(2);

    // 激活后 system_prompt 生效
    expect(manager.getActiveSystemPrompt()).toContain('测试员人格');
    expect(manager.getActiveRoleId()).toBe('tester');

    // 角色列表
    const roles = manager.listRoles();
    expect(roles.find(r => r.role === 'tester')?.isActive).toBe(true);

    // 导出回读
    const exported = manager.exportRole('tester');
    expect(exported?.name).toBe('测试员');
    expect(exported?.worldbook).toHaveLength(2);
    expect(exported?.worldbook?.[1].content_type).toBe('image');
  });

  it('should filter worldbook by active role', async () => {
    manager.importRole({
      role: 'a',
      name: '角色A',
      worldbook: [{ trigger_keys: ['关键词A'], content: 'A的世界书' }],
    });
    manager.importRole({
      role: 'b',
      name: '角色B',
      worldbook: [{ trigger_keys: ['关键词A'], content: 'B的世界书' }],
      activate: true,
    });

    // 当前激活 B → 只匹配 B 的条目
    const read = await manager.read({ query: '关键词A', mode: 'chat', limit: 3 });
    expect(read.worldbook_triggers).toHaveLength(1);
    expect(read.worldbook_triggers[0].content).toContain('B的世界书');
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

describe('MemoryManager — 8-09 getRecentDialogueBlock', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    mm = new MemoryManager(db as any, null as any, null as any, null as any);
    const now = new Date().toISOString();
    mm.ingest({ id: 'u1', session_id: 'sess-d', source: 'chat', type: 'message', payload: { role: 'user', content: '你好呀' }, importance: 0.5, created_at: now, processed: 0 });
    mm.ingest({ id: 'a1', session_id: 'sess-d', source: 'chat', type: 'message', payload: { role: 'assistant', content: '你好呀，昔涟在呢' }, importance: 0.3, created_at: now, processed: 0 });
  });

  afterEach(() => db.close());

  it('返回 你/昔涟 标签的对话块', () => {
    const block = mm.getRecentDialogueBlock('sess-d');
    expect(block).toContain('【最近对话】');
    expect(block).toContain('你: 你好呀');
    expect(block).toContain('昔涟: 你好呀，昔涟在呢');
  });

  it('无消息返回空串', () => {
    expect(mm.getRecentDialogueBlock('sess-empty')).toBe('');
  });
});

describe('MemoryManager — 8-28 视角与角色事实（memory-character-perspective）', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    const embedService = { embed: async () => [0], dimension: () => 1024 };
    const llmService = { complete: async () => '{}' };
    mm = new MemoryManager(db as any, null, embedService as any, llmService as any);
  });

  afterEach(() => db.close());

  it('ingest 默认 perspective=interaction；显式 self 透传入库', async () => {
    await mm.ingest({ id: 'e1', session_id: 's1', source: 'chat', type: 'message', payload: { content: 'hi', role: 'user' }, importance: 0, created_at: new Date().toISOString(), processed: 0 } as any);
    await mm.ingest({ id: 'e2', session_id: 's1', source: 'chat', type: 'message', payload: { content: '在阳台看书', role: 'assistant' }, importance: 0, created_at: new Date().toISOString(), processed: 0, perspective: 'self' } as any);
    const rows = db.prepare('SELECT id, perspective FROM events ORDER BY id').all() as Array<{ id: string; perspective: string }>;
    expect(rows).toEqual([
      { id: 'e1', perspective: 'interaction' },
      { id: 'e2', perspective: 'self' },
    ]);
  });

  it('getProfileSnapshot 返回 characterFacts（默认空）', () => {
    const snap = mm.getProfileSnapshot();
    expect(snap.characterFacts).toEqual([]);
  });
});
