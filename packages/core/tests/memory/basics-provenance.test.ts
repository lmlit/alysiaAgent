// tests/memory/basics-provenance.test.ts
// ★ 2026-10-21 · change: unify-memory-eligibility（契约 C3 / E7）
//
// 钉住一件事：`basics`（`[关于你]` 段的来源）是**派生结果**，不是真相。
//
// 立它之前的实况（E2/E7）：
//   - 事实被纠正后，`basics` 里那句话仍然原样进 prompt —— 旧说法换了个出口继续生效；
//   - 也**没有任何记号**说明它是什么时候、由哪些事实生成的 ⇒ 无从判断是否过时。
//
// 三条约定：
//   ① 事实状态变化 ⇒ `basics` 标 **stale**（不同步重建：重建要调 LLM，不能挂写入路径）
//   ② stale 时 prompt **降级标注**「较早的印象，可能已过时」——不丢掉，但不当成当前认知
//   ③ 写 `basics` 时记谱系（用了哪些事实键），并且**可重建**（`rebuildBasics()`）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import type { ProfileFact } from '../../src/memory/types.js';

const NOW = () => new Date().toISOString();

function fact(factText: string, over: Partial<ProfileFact> = {}): ProfileFact {
  return {
    fact: factText,
    confidence: 0.9,
    evidence: `证据：${factText}`,
    source_event: 'evt-1',
    updated_at: NOW(),
    source: 'user',
    valid_from: NOW(),
    valid_until: null,
    status: 'active',
    category: 'general',
    ...over,
  } as ProfileFact;
}

function makeMM() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const llm = { complete: async () => '他在深圳做后端，喜欢海。' };
  const mm = new MemoryManager(db as any, null as any, { embed: async () => [0.1] } as any, llm as any);
  return { db, mm };
}

describe('★ C3 / E7 basics 的谱系、失效与重建', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    const h = makeMM();
    db = h.db;
    mm = h.mm;
  });
  afterEach(() => db.close());

  it('★★ 事实被纠正 ⇒ `basics` 立刻标 stale（"源头改对了"不等于"出口不用旧信息"）', () => {
    const store = mm['profileStore'];
    store.addFacts([fact('用户在长沙工作')]);
    store.updateBasicsWithSource('他在长沙工作。', [store.factKeyOf('用户在长沙工作')]);
    expect(store.getBasicsMeta(), '刚写完就 stale，谱系写错了').toMatchObject({ stale: false, factCount: 1 });

    store.supersede('长沙', fact('用户在深圳工作', { confidence: 1.0 }));

    expect(store.getBasicsMeta().stale, '纠正之后 basics 仍标着"新鲜" —— 旧说法会继续当当前认知用').toBe(true);
  });

  it('★★ 重建：`basics` 的谱系只记**当次实际用到的**事实键，重建后 stale 清除', async () => {
    const store = mm['profileStore'];
    store.addFacts([fact('用户在长沙工作')]);
    store.supersede('长沙', fact('用户在深圳工作'));
    // 上面两次写入已把 stale 置 1
    expect(store.getBasicsMeta().stale).toBe(true);

    const r = await mm.rebuildBasics();

    expect(r.ok).toBe(true);
    expect(r.usedFacts, '当前态只有"深圳"一条，重写时不该把"长沙"也喂进去').toBe(1);
    const meta = store.getBasicsMeta();
    expect(meta.stale).toBe(false);
    expect(meta.factCount).toBe(1);
    expect(meta.generatedAt, '谱系里没有生成时间 ⇒ 事后无法判断这份印象有多旧').toBeTruthy();
    expect(store.get().basics).toContain('深圳');
  });

  it('★★ stale 且仍有当前事实 ⇒ **整块不注入**（不让旧总结和新事实在 prompt 里打架）', async () => {
    const store = mm['profileStore'];
    store.addFacts([fact('用户在长沙工作')]);
    store.updateBasicsWithSource('他在长沙工作。', [store.factKeyOf('用户在长沙工作')]);

    const fresh = await mm.assemble('chat');
    expect(fresh).toContain('[关于你]');
    expect(fresh).toContain('他在长沙工作。');

    // 用户纠正：现在在深圳
    store.supersede('长沙', fact('用户在深圳工作'));
    const stalePrompt = await mm.assemble('chat');

    expect(
      stalePrompt,
      '过时的 basics 还在注入 —— 你纠正之后她仍会把"长沙"当当前认知说出口（S1 的产品判据）',
    ).not.toContain('他在长沙工作。');
    // 但当前认知必须在场：事实块接手
    expect(stalePrompt, '旧说法压掉了，新说法却没补上 —— 她从"记得错"变成"什么都不知道"').toContain('深圳');
  });

  it('★ stale 且当前一条事实都没有 ⇒ 降级标注后仍注入（没有事实块兜底时不能让她一片空白）', async () => {
    const store = mm['profileStore'];
    store.addFacts([fact('用户在长沙工作')]);
    store.updateBasicsWithSource('他在长沙工作。', [store.factKeyOf('用户在长沙工作')]);
    // 事实全部过期 ⇒ 当前态为空
    store.replaceFacts(store.getAllFacts().map(f => ({ ...f, status: 'expired' as const, valid_until: NOW() })));

    const prompt = await mm.assemble('chat');
    expect(prompt).toContain('较早的印象，可能已过时');
    expect(prompt).toContain('他在长沙工作。');
  });

  it('★ 当前事实全失效 ⇒ 重建**拒绝改写**，basics 原样保留且标 stale', async () => {
    const store = mm['profileStore'];
    store.addFacts([fact('用户在长沙工作')]);
    store.updateBasicsWithSource('他在长沙工作。', [store.factKeyOf('用户在长沙工作')]);
    // 全部置为过期
    store.replaceFacts(store.getAllFacts().map(f => ({ ...f, status: 'expired' as const, valid_until: NOW() })));

    const r = await mm.rebuildBasics();

    expect(r.ok, '当前态为空还报成功').toBe(false);
    expect(r.stale).toBe(true);
    expect(store.get().basics, '把已知印象洗成空白了 —— 她突然对你一无所知').toContain('长沙');
  });
});
