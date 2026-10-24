// tests/memory/facts-retry.test.ts
// ★ 2026-10-21 · change: unify-memory-eligibility（契约 C4 / E5 / E6）
//
// 这组用例直接编码 **E5** 那条体验：
//   "她当时聊得很正常，但真正该记住的东西并没有留下来。"
//
// 机制（改之前）：摘要成功 ⇒ 摘要行 `status='ok'` ⇒ 锚点前进 ⇒ `getBySession`
// 再也捞不到那个窗口；而事实提取失败只留一行 error 日志 ⇒ 那批事实**永久丢失**。
//
// 修法（本文件守的东西）：
//   ① 失败落成**库里的一行状态**（`conversations.facts_status='failed'`）
//   ② 有**补偿**：`retryFailedFactExtraction()` 只重跑事实，不重摘摘要、不重写向量
//   ③ 补偿有**上限**（D3 拍板：每窗口 1 次），用尽后留 `failed` 且可见
//   ④ `onSessionEnd()` **返回**三段结果（不再返回 void）——调用方才可能如实回执（E6）
//
// ⚠️ 用真的 `MemoryManager` + 内存库：这条链路的错法是"失败没有被记账"，
//   mock 掉 store 就等于把被测行为删掉。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import type { MemoryEvent } from '../../src/memory/types.js';

const SID = 'sess-facts-retry';

const SUMMARY_JSON = JSON.stringify({
  summary: '聊了换城市的事',
  participants: ['user'],
  topics: [],
  key_decisions: [],
  character_perspective: '',
  important_moments: [],
});

const FACTS_JSON = JSON.stringify({
  facts: [{ fact: '用户在深圳工作', confidence: 0.9, evidence: '他说在深圳', directly_stated: true, category: 'identity' }],
  character_facts: [],
});

/** 提取器与摘要共用同一个 LLM 客户端，用 **system 提示词**区分是哪个槽 */
const isExtractSlot = (system: string) => system.includes('用户画像提取器');

function makeMM(behaviour: { extract: () => string }) {
  const db = new Database(':memory:');
  initializeDatabase(db);
  let extractCalls = 0;
  const llm = {
    complete: async (system: string) => {
      if (isExtractSlot(system)) {
        extractCalls++;
        return behaviour.extract();
      }
      return SUMMARY_JSON;
    },
  };
  const mm = new MemoryManager(db as any, null as any, { embed: async () => [0.1], dimension: () => 1024 } as any, llm as any);
  return { db, mm, extractCalls: () => extractCalls };
}

const msg = (id: string, content: string, at: Date): MemoryEvent => ({
  id, session_id: SID, source: 'chat', type: 'message',
  payload: { role: 'user', content },
  importance: 0, created_at: at.toISOString(), processed: 0,
});

function latestConv(db: Database.Database): any {
  return db.prepare('SELECT * FROM conversations WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1').get(SID);
}

describe('★ E5 事实提取失败必须**可见且可补**', () => {
  let db: Database.Database;
  let mm: MemoryManager;
  let extractCalls: () => number;
  let failFirst = true;

  beforeEach(() => {
    failFirst = true;
    const h = makeMM({
      extract: () => {
        // 第一次：空响应（线上最常见的失败形态）
        if (failFirst) {
          failFirst = false;
          return '';
        }
        return FACTS_JSON;
      },
    });
    db = h.db;
    mm = h.mm;
    extractCalls = h.extractCalls;
  });
  afterEach(() => db.close());

  it('★★ 摘要成功 + 提取失败 → 库里 `facts_status=failed`（不是只有一行日志）', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await mm.ingest(msg('e1', '我换到深圳了', new Date(Date.now() - 60_000)));

    const r = await mm.onSessionEnd(SID);

    // ④ 三段结果：摘要成功、事实失败 —— 两者不许互相冒充
    expect(r.summary, '摘要本身是成功的').toBe('ok');
    expect(r.facts, '事实提取失败了，结果却报成功').toBe('failed');

    const conv = latestConv(db);
    expect(conv.summary_status).toBe('ok');
    expect(conv.facts_status, '失败没有落到库里 ⇒ 那个窗口随锚点前进后永久消失').toBe('failed');
    expect(conv.facts_attempts).toBe(0);
  });

  it('★★ 补偿：`retryFailedFactExtraction()` 只补事实，补上后状态转 ok', async () => {
    await mm.ingest(msg('e1', '我换到深圳了', new Date(Date.now() - 60_000)));
    await mm.onSessionEnd(SID);
    expect(latestConv(db).facts_status).toBe('failed');

    const before = latestConv(db).summary;   // 摘要不该被重摘
    const ok = await mm.retryFailedFactExtraction();

    expect(ok, '补偿应当成功一个窗口').toBe(1);
    const after = latestConv(db);
    expect(after.facts_status).toBe('ok');
    expect(after.summary, '补事实把摘要也重写了一遍（不该动它）').toBe(before);

    // 事实真的进画像了
    const facts = mm.getProfileSnapshot().facts;
    expect(facts.map(f => f.fact)).toContain('用户在深圳工作');
  });

  it('★ D3：自动重试**每窗口最多 1 次**，用尽后留 failed 且不再调用提取器', async () => {
    await mm.ingest(msg('e1', '我换到深圳了', new Date(Date.now() - 60_000)));
    await mm.onSessionEnd(SID);

    // 模拟"已经补过一次且又失败了"（生产里由 retryFailedFacts 自己递增）
    db.prepare("UPDATE conversations SET facts_attempts = 1 WHERE session_id = ?").run(SID);

    const callsBefore = extractCalls();
    const ok = await mm.retryFailedFactExtraction();

    expect(ok).toBe(0);
    expect(extractCalls(), '次数用尽后还在白烧 LLM').toBe(callsBefore);
    expect(latestConv(db).facts_status, '用尽后必须**保持可见**，不能悄悄变成 ok').toBe('failed');
  });

  it('★ 提取成功但 0 条 → facts=ok（与"失败"不同：看了，确实没有新事实）', async () => {
    db.close();
    const h = makeMM({ extract: () => JSON.stringify({ facts: [], character_facts: [] }) });
    db = h.db; mm = h.mm;
    await mm.ingest(msg('e1', '今天天气不错', new Date(Date.now() - 60_000)));

    const r = await mm.onSessionEnd(SID);
    expect(r).toMatchObject({ summary: 'ok', facts: 'ok' });
    expect(latestConv(db).facts_status).toBe('ok');
  });
});
