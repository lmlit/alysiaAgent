// tests/memory/channel-field-facts-hints.test.ts
// ★ 2026-10-16 · change: `add-memory-channel-field`（facts / hints 层）
//
// 上一层（events/conversations）见 `channel-field.test.ts`。
// 本文件锁住**结构化记忆条目**的渠道：
//   - facts / character_facts：写入点在 `ProfileExtractor`（起源事件拿得到 ⇒ 如实派生）
//   - adaptation_hints：写入点在 `PersonaAdapter.apply()`（渠道由调用方**穿参**下来）
//
// ⚠️ 一再强调的两个概念，本文件用测试钉死：
//   `source`（提取方式：user/behavior/inferred）**不等于** `channel`（从哪个入口来）。
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { PersonaStore } from '../../src/memory/stores/PersonaStore.js';
import { PersonaAdapter } from '../../src/memory/engines/PersonaAdapter.js';
import { ProfileExtractor } from '../../src/memory/engines/ProfileExtractor.js';
import type { MemoryEvent } from '../../src/memory/types.js';
import type { ILLMService } from '../../src/memory/interfaces/ILLMService.js';

const FACTS_JSON = JSON.stringify({
  facts: [{ fact: '用户在写一个记忆系统', confidence: 0.9, evidence: '我们在写记忆系统', directly_stated: true }],
  character_facts: [{ fact: '昔涟在编程时会先读代码', confidence: 0.7, evidence: '我先去看一眼代码', category: 'general' }],
});

const llmReturning = (payload: string): ILLMService => ({ complete: async () => payload });

const evt = (sid: string): MemoryEvent => ({
  id: 'evt-1', session_id: sid, source: 'chat', type: 'message',
  payload: { role: 'user', content: '我们在写记忆系统' },
  importance: 0.6, created_at: '2026-10-16T10:00:00.000Z',
});

describe('★ facts / character_facts 的渠道', () => {
  it('dsh 会话 → facts 与 character_facts 都标 dsh', async () => {
    const { facts, characterFacts } = await new ProfileExtractor(llmReturning(FACTS_JSON))
      .extract([evt('dsh:session-29b9865c-9096-4eb1-9232-a2eda044b023')]);
    expect(facts[0].channel).toBe('dsh');
    expect(characterFacts[0].channel).toBe('dsh');
  });

  it('QQ 会话 → qq', async () => {
    const { facts } = await new ProfileExtractor(llmReturning(FACTS_JSON)).extract([evt('qq-official-1:u1')]);
    expect(facts[0].channel).toBe('qq');
  });

  it('★ 判不出来的会话 → unknown（**不许猜**成 qq/dsh）', async () => {
    const { facts } = await new ProfileExtractor(llmReturning(FACTS_JSON)).extract([evt('telegram:1')]);
    expect(facts[0].channel).toBe('unknown');
  });

  it('★ `source`（提取方式）**不受渠道影响**，两者是不同的轴', async () => {
    const { facts } = await new ProfileExtractor(llmReturning(FACTS_JSON)).extract([evt('dsh:session-x')]);
    // 用户直接陈述 ⇒ source='user'；渠道是 dsh。两者并存，不许互相顶替。
    expect(facts[0].source).toBe('user');
    expect(facts[0].channel).toBe('dsh');
  });
});

describe('★ adaptation_hints 的渠道', () => {
  const open = () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    return { db, store: new PersonaStore(db), adapter: new PersonaAdapter(new PersonaStore(db), llmReturning('{}')) };
  };
  const hint = (store: PersonaStore) => store.getAdaptationHints().slice(-1)[0] as Record<string, unknown>;

  it('调用方穿参 → hint 如实记渠道', () => {
    const { db, store, adapter } = open();
    try {
      const ok = adapter.apply({ param: 'tone.formality', delta: -0.05, reason: '太正式了' }, { channel: 'dsh' });
      expect(ok).toBe(true);
      expect(hint(store).channel).toBe('dsh');
    } finally { db.close(); }
  });

  it('★ 没穿参 → unknown（**不许**默认成某个真实渠道）', () => {
    const { db, store, adapter } = open();
    try {
      adapter.apply({ param: 'tone.formality', delta: -0.05, reason: 'x' });
      expect(hint(store).channel).toBe('unknown');
    } finally { db.close(); }
  });

  it('★ 情绪漂移（生活事件驱动，没有用户会话）→ life，**不是** unknown', () => {
    const { db, store, adapter } = open();
    try {
      // moodValue ≥ +15 触发 playfulness 微升
      adapter.adjustFromMood(20);
      expect(hint(store).channel, '生活管线驱动的调整被记成 unknown 了 —— 那会把"设计行为"和"数据债"混成一谈').toBe('life');
    } finally { db.close(); }
  });
});
