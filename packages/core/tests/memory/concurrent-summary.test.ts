// tests/memory/concurrent-summary.test.ts
// ★ 2026-10-16 · change: `fix-concurrent-summary-duplication`（KI-19 残余）
//
// 现象（两种，同一根因）：
//   ① `conversations.id = conv-${sessionId}-${Date.now()}` —— **同一毫秒**的两次落库
//      会做出**同一个 id** ⇒ 第二条 `INSERT` 撞 PRIMARY KEY ⇒
//      `UNIQUE constraint failed: conversations.id` ⇒ `onSessionEnd` 把异常抛出去
//      ⇒ **后一次整段丢失**。
//   ② 两次调用**重叠**时（各自在对方落库前就算好窗口锚点），两次会摘**同一批事件**
//      ⇒ **同一会话出现两条摘要**（KI-19 原本的症状）。
//
// ⚠️ **必须先想清楚再修**：撞 PK 其实**歪打正着地挡住**了 ②。
//   所以"只把 id 改成唯一"会把「崩溃丢一条」换成「**静默重复两条**」——
//   拿一个更响的错换一个更坏的静默错。
//   ⇒ 正确修法是**两件一起**：
//     (a) **per-session 并发互斥**（语义修复）
//     (b) id 唯一（防御：即便互斥失效，也不该撞 PK 把整段丢掉）
//
// ⚠️⚠️ **测试必须走 `MemoryManager`**：直接调 `SessionEndProcessor.process(sid)`
//   **不传 `since`** 会落回"缺省全历史"语义——那正是 `fix-session-end-window`
//   修过的坑。我第一版就这么踩了：测出来的"重复摘要"其实是测试自己绕过了锚点。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import { ConversationStore } from '../../src/memory/stores/ConversationStore.js';
import type { MemoryEvent } from '../../src/memory/types.js';
import type { ILLMService } from '../../src/memory/interfaces/ILLMService.js';
import type { IEmbedService } from '../../src/memory/interfaces/IEmbedService.js';

const SUMMARY_JSON = JSON.stringify({
  summary: '她聊了工作与代码风格',
  participants: ['user', 'assistant'],
  topics: ['工作'],
  key_decisions: [],
  character_perspective: '',
  important_moments: [],
  adjustments: [],
  facts: [],
  character_facts: [],
});

/** LLM 故意**让出一次事件循环**：让两次并发调用都能在对方落库前算完锚点 */
const slowLLM: ILLMService = {
  complete: async () => {
    await new Promise(r => setTimeout(r, 0));
    return SUMMARY_JSON;
  },
};
const mockEmbed: IEmbedService = { embed: async () => [0.1], dimension: () => 2 };

const msgEvent = (id: string, sid: string, content: string, at: string): MemoryEvent => ({
  id, session_id: sid, source: 'chat', type: 'message',
  payload: { role: 'user', content },
  importance: 0.6, created_at: at,
});

describe('★ KI-19 残余：同一会话并发结算', () => {
  let db: Database.Database;
  let mm: MemoryManager;
  let convs: ConversationStore;

  const SID = 'sess-concurrent';
  const T0 = '2026-10-16T10:00:00.000Z';

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
    mm = new MemoryManager(db, null, mockEmbed, slowLLM);
    convs = new ConversationStore(db, null);
  });
  afterEach(() => db.close());

  it('★★ 两次并发结算 → **只留一条** conversation，且**不抛**', async () => {
    // 只冻结**时钟读数**（`Date.now`），不用 fake timers —— 后者会把 LLM mock 里的
    // `setTimeout(0)` 一起冻住，测试得靠推进时间才走得完（实测那样要 5 秒）。
    // 冻结读数就够：让两次落库落在**同一毫秒**（旧实现必撞 PK）。
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T12:00:00.000Z'));
    try {
      await mm.ingest(msgEvent('m1', SID, '今天在忙什么', T0));
      await mm.ingest(msgEvent('m2', SID, '记得早点休息', '2026-10-16T10:00:05.000Z'));

      const results = await Promise.allSettled([
        mm.onSessionEnd(SID),
        mm.onSessionEnd(SID),
      ]);

      const rejected = results.filter(r => r.status === 'rejected');
      const rows = convs.getBySession(SID);
      const dump = JSON.stringify(rows.map(r => ({ id: r.id, ended: r.ended_at })));

      expect(
        rejected.map(r => String((r as PromiseRejectedResult).reason?.message ?? '')),
        '并发结算抛错了 —— 旧实现会撞 `UNIQUE constraint failed: conversations.id`，把后一次整段丢掉',
      ).toEqual([]);

      expect(
        rows.length,
        `同一会话产出 ${rows.length} 条摘要（同一批事件被摘了两遍）—— 这正是 KI-19 的原症状：${dump}`,
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('★ 回归守卫：顺序两次 `onSessionEnd` → 第二次走 no-events（锚点会前进）', async () => {
    await mm.ingest(msgEvent('n1', SID, '只有一条消息', T0));

    await mm.onSessionEnd(SID);
    await mm.onSessionEnd(SID);

    const rows = convs.getBySession(SID);
    expect(
      rows.length,
      `顺序两次结算产出 ${rows.length} 条 —— 第二次的窗口锚点没有前进：` +
        JSON.stringify(rows.map(r => ({ id: r.id, ended: r.ended_at }))),
    ).toBe(1);
  });

  it('★ 两条**不同**会话并发 → 各自成行（同一毫秒下 id 也不许撞）', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T12:00:00.000Z'));
    try {
      await mm.ingest(msgEvent('p1', 'sess-A', '甲的话', T0));
      await mm.ingest(msgEvent('p2', 'sess-B', '乙的话', T0));

      const results = await Promise.allSettled([
        mm.onSessionEnd('sess-A'),
        mm.onSessionEnd('sess-B'),
      ]);

      expect(results.filter(r => r.status === 'rejected')).toEqual([]);
      const ids = [
        ...convs.getBySession('sess-A').map(c => c.id),
        ...convs.getBySession('sess-B').map(c => c.id),
      ];
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size, '两条会话的 id 撞了（同一毫秒 + 同一时间戳后缀）').toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
