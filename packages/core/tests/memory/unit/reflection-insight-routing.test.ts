// ★ 10-15 fix-reflection-insight-misroute
//
// 每日反思的 insight 语义是「我悟到的一个关于**自己**的事实」
// （LIFE_REFLECTION_PROMPT 给的示例就是「我其实很享受被需要的时刻」），
// 所以它必须进【角色画像】character_facts（PromptAssembler 的【关于我】块），
// 而不是用户画像 facts。
//
// 此前 recordReflection 把它写进了 user_profile.facts，并硬编码
// confidence=0.5 / category='preference'，线上因此累积 31 条错位自省
// （特征完全吻合：31 条全部 conf=0.5、全部落 preference、evidence 全为「每日反思 <日期>」），
// 同时 character_facts 长期为 0 条 —— 她读不到自己积累的自我认知。
import { describe, it, beforeEach, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager';
import { initializeDatabase } from '../../../src/memory/database';
import type { IEmbedService } from '../../../src/memory/interfaces/IEmbedService';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';

const mockEmbed: IEmbedService = {
  embed: async () => new Array(1536).fill(0).map(() => Math.random()),
  dimension: () => 1536,
};

// recordReflection 本身不调 LLM（adjustments 才走人格护栏）；给个最小实现即可
const mockLLM: ILLMService = { complete: async () => '{}' };

const INSIGHT = '我其实很享受独处的安静';

describe('recordReflection — insight 路由（fix-reflection-insight-misroute）', () => {
  let db: Database.Database;
  let manager: MemoryManager;

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

    manager = new MemoryManager(db, null, mockEmbed, mockLLM);
  });

  it('insight 进 character_facts，不进用户 facts', () => {
    const r = manager.recordReflection({ reflection: '今天过得安静', insight: INSIGHT });
    expect(r.insightAdded).toBe(true);

    const snap = manager.getProfileSnapshot();
    expect(snap.facts.map(f => f.fact)).not.toContain(INSIGHT);
    expect(snap.characterFacts.map(f => f.fact)).toContain(INSIGHT);
  });

  it('category 不再硬编码 preference（自省取 general）', () => {
    manager.recordReflection({ reflection: 'x', insight: INSIGHT });
    const cf = manager.getProfileSnapshot().characterFacts.find(f => f.fact === INSIGHT);
    expect(cf?.category).toBe('general');
  });

  it('无 insight 时两侧画像都不动', () => {
    const r = manager.recordReflection({ reflection: '只有反思文本，没有 insight' });
    expect(r.insightAdded).toBe(false);
    const snap = manager.getProfileSnapshot();
    expect(snap.facts).toHaveLength(0);
    expect(snap.characterFacts).toHaveLength(0);
  });

  it('重复 insight 被去重（不无限堆积——线上那 31 条里约 5 条是同义的）', () => {
    manager.recordReflection({ reflection: 'a', insight: INSIGHT });
    manager.recordReflection({ reflection: 'b', insight: INSIGHT });
    const active = manager.getProfileSnapshot().characterFacts.filter(f => f.fact === INSIGHT);
    expect(active).toHaveLength(1);
  });

  it('reflection 文本仍进 ai_life_state（这条路径不受影响）', () => {
    const r = manager.recordReflection({ reflection: '今天过得安静', insight: INSIGHT });
    expect(r.reflectionSaved).toBe(true);
  });
});
