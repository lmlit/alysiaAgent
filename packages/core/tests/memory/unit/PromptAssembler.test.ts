// tests/memory/unit/PromptAssembler.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PromptAssembler } from '../../../src/memory/PromptAssembler';
import { initializeDatabase } from '../../../src/memory/database';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore';
import { KnowledgeStore } from '../../../src/memory/stores/KnowledgeStore';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { CodeContextStore } from '../../../src/memory/stores/CodeContextStore';
import type { SearchResult, WorldbookEntry } from '../../../src/memory/types';

describe('PromptAssembler', () => {
  let db: Database.Database;
  let assembler: PromptAssembler;
  let profileStore: ProfileStore;
  let personaStore: PersonaStore;
  let worldbookStore: WorldbookStore;
  let codeContextStore: CodeContextStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    profileStore = new ProfileStore(db);
    personaStore = new PersonaStore(db);
    const convStore = new ConversationStore(db, null);
    const knowledgeStore = new KnowledgeStore(db, null);
    worldbookStore = new WorldbookStore(db);
    codeContextStore = new CodeContextStore(db);

    // Seed default rows
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at) VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}', '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}', '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);

    assembler = new PromptAssembler(profileStore, personaStore, convStore, knowledgeStore, worldbookStore, codeContextStore);
  });

  afterEach(() => db.close());

  it('should produce chat mode prompt with persona name', async () => {
    const prompt = await assembler.assemble('chat');
    expect(prompt).toContain('昔涟');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('should produce code mode prompt with technical profile only', async () => {
    profileStore.updateBasics('{"occupation":"后端工程师","experience":"5年"}');
    profileStore.updatePreferences('{"code_languages":["TypeScript","Rust"],"code_style":"explicit"}');

    const prompt = await assembler.assemble('code');
    expect(prompt).toContain('后端工程师');
    expect(prompt).toContain('TypeScript');
    expect(prompt).not.toContain('爱好');
  });

  it('should not include worldbook in prompt (worldbook is now an Agent tool)', async () => {
    const wbEntry: WorldbookEntry = {
      id: 'wb-1', trigger_keys: JSON.stringify(['hello']),
      trigger_mode: 'any', content: '用户常用英文打招呼',
      scope: 'chat', priority: 0, cooldown_sec: 300,
      last_triggered: null, hit_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    const prompt = await assembler.assemble('chat', [], [wbEntry]);
    // Worldbook is now a tool, not injected into prompt
    expect(prompt).not.toContain('用户常用英文打招呼');
  });

  it('should include project context in code mode', async () => {
    codeContextStore.upsert({
      id: 'ctx-1', project_name: 'alysiaAgent', project_path: '/work/alysiaAgent',
      tech_stack: '{"lang":"typescript"}', architecture_notes: 'Electron app',
      recent_changes: '[]', decisions: '[]', is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const prompt = await assembler.assemble('code');
    expect(prompt).toContain('alysiaAgent');
    expect(prompt).toContain('typescript');
  });

  it('should stay within token budget', async () => {
    const prompt = await assembler.assemble('chat');
    // Rough check: should be under 10000 chars (~2850 tokens for mixed CJK)
    expect(prompt.length).toBeLessThan(10000);
  });

  it('should include retrieved memories in chat mode', async () => {
    const retrieved: SearchResult[] = [
      { id: 'mem-1', score: 0.95, text: '用户喜欢函数式编程', metadata: {} },
      { id: 'mem-2', score: 0.80, text: '用户曾提到喜欢Rust语言', metadata: {} },
    ];

    const prompt = await assembler.assemble('chat', retrieved);
    expect(prompt).toContain('函数式编程');
    expect(prompt).toContain('Rust语言');
  });

  // ★ 10-15 fix-reflection-insight-misroute：【关于我】块限量注入。
  //   每日反思每天产一条，线上实测 31 条 = 1058 字 ≈ 705 tokens（占 3200 预算的 22%），
  //   且该块是最后一个 canFit 检查的块 → 超预算整块被丢，她一条都读不到。
  it('【关于我】只注入最近 8 条，较早的不进 prompt（但仍在库里）', async () => {
    const now = Date.now();
    const facts = Array.from({ length: 12 }, (_, i) => ({
      fact: `第${i + 1}条自我认知`,
      confidence: 0.5,
      evidence: `每日反思 2026-09-${String(i + 1).padStart(2, '0')}`,
      source_event: `reflection-2026-09-${String(i + 1).padStart(2, '0')}`,
      updated_at: new Date(now + i * 1000).toISOString(),
      source: 'inferred' as const,
      valid_from: new Date(now + i * 1000).toISOString(),
      valid_until: null,
      status: 'active' as const,
      category: 'general' as const,
    }));
    profileStore.addCharacterFacts(facts);

    // 库里完整保留 12 条
    expect(profileStore.getActiveCharacterFacts()).toHaveLength(12);

    const prompt = await assembler.assemble('chat');
    // 最近 8 条（5..12）在，最早 4 条（1..4）不在
    for (const n of [5, 8, 12]) expect(prompt).toContain(`第${n}条自我认知`);
    for (const n of [1, 2, 3, 4]) expect(prompt).not.toContain(`第${n}条自我认知`);
    expect(prompt).toContain('[关于我]');
  });

  // ★ 2026-10-28（fix-long-session-compaction）：facts 改为 required + 限量。
  //   40 条 ≈ 1,146 tokens（36%），会把 recent/life/memories 全挤掉；降到 20 条 ≈ 595 tokens。
  it('【关于你的事实】注入置信度前 20 条，且预算不足时整块不丢', async () => {
    const now = Date.now();
    const facts = Array.from({ length: 50 }, (_, i) => ({
      fact: `测试事实${String(i).padStart(2, '0')}`,
      confidence: 1 - i * 0.01,
      evidence: `证据${i}`,
      source_event: `evt-${i}`,
      updated_at: new Date(now).toISOString(),
      source: 'user' as const,
      valid_from: new Date(now).toISOString(),
      valid_until: null,
      status: 'active' as const,
      category: 'general' as const,
    }));
    profileStore.replaceFacts(facts);

    const prompt = await assembler.assemble('chat');
    const injected = prompt.match(/- 测试事实\d{2}/g) ?? [];
    expect(injected).toHaveLength(20);
    expect(prompt).toContain('测试事实00');   // 置信度最高
    expect(prompt).toContain('测试事实19');   // 第 20 条
    expect(prompt).not.toContain('测试事实20'); // 第 21 条之后不注入
    expect(prompt).toContain('[关于你的事实]');
  });
});
