// tests/memory/profile-correction.test.ts
// ★ 2026-10-16 · 产品增量「最小版记忆纠正」
//
// 计划给首版列的四条：
//   ① 查看当前用户事实与角色事实  ② 查看已有的来源和时间
//   ③ 纠正错误事实、使旧事实失效   ④ **验证后续对话使用新事实，而不是继续召回旧事实**
//
// 本文件守的是 ③ 与 ④ —— 尤其是 ④：它不是"接口返回对了"就算数，
// 要看**组装进 prompt 的那段事实文本**里旧事实是否真的消失了。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import type { ProfileFact } from '../../src/memory/types.js';

function makeMM() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const mm = new MemoryManager(
    db as any, null as any,
    { embed: async () => [0.1], dimension: () => 1024 } as any,
    { complete: async () => '{}' } as any,
  );
  return { db, mm };
}

/** 直接种一条用户事实（跳过 LLM 提取，测试要的是纠正链路） */
function seedFact(mm: MemoryManager, fact: string, source: 'user' | 'inferred' = 'user') {
  (mm as any).profileStore.addFacts([{
    fact,
    confidence: 0.9,
    evidence: 'test',
    source_event: 'test',
    updated_at: new Date().toISOString(),
    source,
    valid_from: new Date().toISOString(),
    valid_until: null,
    status: 'active',
    category: 'general',
  } as ProfileFact]);
}

const factTexts = (mm: MemoryManager, includeSuperseded = false) =>
  mm.getProfileSnapshot({ includeSuperseded }).facts.map(f => f.fact);

describe('★ 记忆纠正 — 纠正与失效', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => { ({ db, mm } = makeMM()); });
  afterEach(() => { db.close(); });

  it('★ 纠正：旧事实失效、新事实生效', () => {
    seedFact(mm, '用户在长沙');

    const r = mm.correctProfileFact('用户在长沙', '用户在上海');

    expect(r).toEqual({ superseded: true, added: true });
    expect(factTexts(mm)).toContain('用户在上海');
    expect(factTexts(mm), '旧事实仍被当作有效').not.toContain('用户在长沙');
  });

  it('★ 失效（不给替换）：confirmProfileFact(fact, false)', () => {
    seedFact(mm, '用户养了只叫团子的猫');

    expect(mm.confirmProfileFact('用户养了只叫团子的猫', false)).toBe(true);
    expect(factTexts(mm)).not.toContain('用户养了只叫团子的猫');
  });

  it('★★ 为什么必须显式两步：只 addFacts 的话两条不相似的措辞会**同时 active**', () => {
    seedFact(mm, '用户在长沙');

    // 「用户在长沙」→「用户在上海」归一化后**不相似** ⇒ 冲突检测认不出来 ⇒ 两条都 active
    // （这正是"纠正"不能只靠 addFacts 的原因；下面的用例证明 correctProfileFact 修掉了它）
    seedFact(mm, '用户在上海');
    expect(factTexts(mm), '前提变了：冲突检测现在能认出这两条是同一件事？').toEqual(
      expect.arrayContaining(['用户在长沙', '用户在上海']),
    );
  });

  it('★ 旧事实不存在：superseded=false，但新事实**仍然写入**（不白跑一趟）', () => {
    const r = mm.correctProfileFact('一条根本不存在的事实', '用户喜欢雨天');
    expect(r.superseded).toBe(false);
    expect(r.added).toBe(true);
    expect(factTexts(mm)).toContain('用户喜欢雨天');
  });

  it('★ 空新事实 → 抛错（不静默写一条空事实进去）', () => {
    seedFact(mm, '用户在长沙');
    expect(() => mm.correctProfileFact('用户在长沙', '   ')).toThrow(/不能为空/);
    // 旧事实不该被"纠正到一半"就失效了
    expect(factTexts(mm)).toContain('用户在长沙');
  });

  it('★ 手动纠正标记为 source=user —— 后续 inferred 提取不许把它顶掉', () => {
    seedFact(mm, '用户在长沙');
    mm.correctProfileFact('用户在长沙', '用户在上海');

    // 模拟后续 LLM 提取出一条冲突的 inferred 事实
    seedFact(mm, '用户在上海', 'inferred');

    expect(factTexts(mm)).toContain('用户在上海');
  });
});

describe('★★ 记忆纠正 — 后续对话必须用新事实（计划第 ④ 条）', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => { ({ db, mm } = makeMM()); });
  afterEach(() => { db.close(); });

  /** 组装一次真实的 chat prompt（她下一轮**真正看到**的那段文本） */
  const assembleChat = () => (mm as any).promptAssembler.assemble('chat', [], [], '', 'sess-1') as Promise<string>;

  it('★★ 纠正后：【关于你的事实】块里旧事实**消失**、新事实**出现**', async () => {
    seedFact(mm, '用户在长沙');
    const before = await assembleChat();
    expect(before, '前提：纠正前 prompt 里确实有它').toContain('用户在长沙');

    mm.correctProfileFact('用户在长沙', '用户在上海');

    const after = await assembleChat();
    expect(after, '后续对话仍在喂旧事实').not.toContain('用户在长沙');
    expect(after, '后续对话没拿到新事实').toContain('用户在上海');
  });

  it('★ 失效后：事实块里不再出现它（不是只在接口层过滤）', async () => {
    seedFact(mm, '用户养了只叫团子的猫');
    expect(await assembleChat()).toContain('团子');

    mm.confirmProfileFact('用户养了只叫团子的猫', false);

    expect(await assembleChat()).not.toContain('团子');
  });

  it('★ 「用户近况摘要」（喂生活事件生成器的那份）同样只剩新事实', () => {
    seedFact(mm, '用户在长沙');
    mm.correctProfileFact('用户在长沙', '用户在上海');

    const summary = mm.getUserActivitySummary();
    expect(summary).toContain('用户在上海');
    expect(summary).not.toContain('用户在长沙');
  });
});

describe('★ 记忆纠正 — 查看（含来源/时间/已作废）', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => { ({ db, mm } = makeMM()); });
  afterEach(() => { db.close(); });

  it('★ 快照带来源、时间与分类（纠正页要展示这些才能让人判断）', () => {
    seedFact(mm, '用户在长沙');
    const f = mm.getProfileSnapshot().facts.find(x => x.fact === '用户在长沙')!;

    expect(f).toBeDefined();
    expect(f.source).toBe('user');
    expect(f.validFrom).toBeTruthy();
    expect(f.category).toBe('general');
    expect(f.status).toBe('active');
  });

  it('★ 默认**不含**已作废的（画像展示只要"她现在相信的"）', () => {
    seedFact(mm, '用户在长沙');
    mm.correctProfileFact('用户在长沙', '用户在上海');
    expect(factTexts(mm)).not.toContain('用户在长沙');
  });

  it('★★ includeSuperseded 能看到被作废的那条 —— 否则用户无法确认"真的失效了"', () => {
    seedFact(mm, '用户在长沙');
    mm.correctProfileFact('用户在长沙', '用户在上海');

    const all = mm.getProfileSnapshot({ includeSuperseded: true }).facts;
    const old = all.find(f => f.fact === '用户在长沙');
    expect(old, '纠正页看不到被作废的旧事实').toBeDefined();
    expect(old!.status).toBe('superseded');
  });

  it('★ 角色事实也在快照里（首版**只读**：可查看，纠正仅支持用户事实）', () => {
    (mm as any).profileStore.addCharacterFacts([{
      fact: '昔涟喜欢雨天', confidence: 0.9, evidence: 't', source_event: 't',
      updated_at: new Date().toISOString(), source: 'inferred', valid_from: new Date().toISOString(),
      valid_until: null, status: 'active', category: 'general',
    } as ProfileFact]);

    expect(mm.getProfileSnapshot().characterFacts.map(f => f.fact)).toContain('昔涟喜欢雨天');
  });
});
