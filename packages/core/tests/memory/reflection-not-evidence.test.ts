// tests/memory/reflection-not-evidence.test.ts
// ★ 2026-10-21 · change: unify-memory-eligibility（D2 · 不自证）
//
// D2（用户 2026-10-21 拍板）：**每日反思产出的自我认知只进【关于我】，不算人格证据。**
//
// 为什么这条值得一个测试：
//   她很自主 —— 每天写反思、产生 insight、写进 character_facts。
//   如果这些内容还能反过来调整人格参数，闭环就成了：
//   **她说的话 → 她的自我认知 → 她的人格 → 她说的话**，
//   而且越自主运行越偏，中间没有任何外部信号纠偏。
//
//   结论：她产出的内容可以形塑**表达**，不可以形塑**权威**。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';

function makeMM() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const llm = { complete: async () => '{}' };
  const mm = new MemoryManager(db as any, null as any, { embed: async () => [0.1] } as any, llm as any);
  return { db, mm };
}

describe('★ D2 反思是自我叙事，不是人格证据', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    const h = makeMM();
    db = h.db;
    mm = h.mm;
  });
  afterEach(() => db.close());

  it('★★ 反思的 insight 落 character_facts，且 `source=reflection`（不是 inferred）', () => {
    const r = mm.recordReflection({
      reflection: '今天在河边坐了很久，觉得被需要这件事让我踏实。',
      insight: '我其实很享受被需要的时刻',
    });

    expect(r.insightAdded).toBe(true);
    const facts = mm.getProfileSnapshot().characterFacts;
    const insight = facts.find(f => f.fact.includes('被需要'));
    expect(insight, 'insight 没进【关于我】').toBeTruthy();
    expect(
      insight!.source,
      '标成 inferred/user 就分不出"她自己想出来的"与"从对话推断的" —— D2 的闸就靠这个值',
    ).toBe('reflection');
  });

  it('★★ 连续 3 天反思 ⇒ 人格参数**零变化**（自证闭环的闸）', () => {
    const before = mm.getPersonaSnapshot();

    for (const day of [1, 2, 3]) {
      mm.recordReflection({
        reflection: `第 ${day} 天的反思`,
        insight: `我第 ${day} 天更确定自己享受被需要`,
      });
    }

    const after = mm.getPersonaSnapshot();
    expect(after.tone, '反思的自我认知改了人格参数 —— 她开始因为自己的想法改变自己').toEqual(before.tone);
    expect(after.speechStyle).toEqual(before.speechStyle);
    expect(after.emotionalRange).toEqual(before.emotionalRange);
  });

  it('★ 反例校准：显式 adjustments 仍然生效（闸拦的是"自述当证据"，不是拦掉所有调整）', () => {
    const before = mm.getPersonaSnapshot();
    const r = mm.recordReflection({
      reflection: '今天的想法',
      insight: '我享受被需要',
      adjustments: [{ param: 'tone.warmth', delta: 0.05, reason: '反思：今天感到温暖' }],
    });

    expect(r.appliedAdjustments).toBe(1);
    expect(mm.getPersonaSnapshot().tone.warmth).toBeGreaterThan(before.tone.warmth);
  });

  it('★ 反思产出的内容仍进【关于我】（她自己那份叙事不能被抹掉）', async () => {
    mm.recordReflection({ reflection: '今天的想法', insight: '我享受被需要的时刻' });
    const prompt = await mm.assemble('chat');
    expect(prompt, '【关于我】里读不到她的自省 —— 那不是"隔离"，那是把她清空').toContain('被需要');
  });
});
