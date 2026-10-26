// tests/memory/summary-anchor-floor.test.ts
// ★ 2026-10-16 · change: fix-summary-anchor-floor（KI-26）
//
// 现象：**「没有历史摘要 + 消息全部早于 24h」⇒ 那批消息永远进不了摘要。**
//
// `MemoryManager.summaryAnchor()` 在「这个会话还没有上一份摘要」时用
// `Date.now() − 24h` 当窗口下界 ⇒ 更早的消息一条都看不见 ⇒ `no-events` 直接返回。
// 而且**永远够不着**：下次的锚点是「上一份摘要的 ended_at」，可上一份根本不存在，
// 于是每回都退回 now−24h，而 now 还在往前跑。
//
// 真实场景：会话开着超过 24 小时才结束（dsh 长会话 / QQ 群持续几天的会话），
// 或进程停过一段时间后由 `archiveStaleSessions` 归档 —— 最老那一段**永久不进摘要**。
//
// 本文件守四件事：
//   ① 从未摘要过的会话 → **必须**从头摘要（主症；旧实现一条都不产）
//   ② 已有历史摘要 → 仍从 `ended_at` 之后继续（**不许**回头重摘）
//   ③ 有会话记录但 `ended_at` 为空 → **保守**（宁可漏，也不要重摘整段历史）
//   ④ 新鲜会话行为不变
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database';
import { MemoryManager } from '../../src/memory/MemoryManager';
import { ConversationStore } from '../../src/memory/stores/ConversationStore';
import { ProfileStore } from '../../src/memory/stores/ProfileStore';
import type { MemoryEvent } from '../../src/memory/types';
import type { ILLMService } from '../../src/memory/interfaces/ILLMService';
import type { IEmbedService } from '../../src/memory/interfaces/IEmbedService';
import { logger } from '../../src/utils/logger';
import { __resetThrottledWarnings } from '../../src/utils/write-trace';
const DAY = 86_400_000;

const mockEmbed: IEmbedService = { embed: async () => [0.1, 0.2], dimension: () => 2 };

/** 按 system prompt 分流的假 LLM（与既有 e2e/集成用例同一套判据） */
const llm: ILLMService = {
  complete: vi.fn(async (system: string, _user: string) => {
    if (system.includes('会话总结')) {
      return JSON.stringify({
        summary: '她聊了工作与代码风格',
        participants: ['user', 'assistant'],
        topics: ['工作'],
        key_decisions: [],
        character_perspective: '',
        important_moments: [],
      });
    }
    if (system.includes('用户画像提取器')) {
      return JSON.stringify({
        facts: [{ fact: '用户是后端工程师', confidence: 0.9, evidence: '用户自称后端工程师' }],
      });
    }
    return '{}';
  }),
};

/** `ageMs` = 这条消息发生在多久以前 */
function makeEvent(id: string, sessionId: string, content: string, ageMs: number): MemoryEvent {
  return {
    id,
    session_id: sessionId,
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content },
    importance: 0.6,
    created_at: new Date(Date.now() - ageMs).toISOString(),
  };
}

describe('★ KI-26 摘要窗口下界：从未摘要过的会话必须从头摘', () => {
  let db: Database.Database;
  let mm: MemoryManager;
  let convs: ConversationStore;

  const seedConversation = (sid: string, id: string, endedAt: string | null) =>
    db.prepare(
      `INSERT INTO conversations (id, session_id, summary, started_at, ended_at)
       VALUES (?, ?, '历史摘要', ?, ?)`,
    ).run(id, sid, new Date(Date.now() - 3 * DAY).toISOString(), endedAt);

  const dialogueOf = (from = 0) =>
    (llm.complete as unknown as ReturnType<typeof vi.fn>).mock.calls
      .slice(from)
      .map(c => String(c[1]))
      .join('\n');

  beforeEach(() => {
    __resetThrottledWarnings();   // 限频是模块级计数，用例之间必须清掉
    db = new Database(':memory:');
    initializeDatabase(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);
    (llm.complete as unknown as ReturnType<typeof vi.fn>).mockClear();
    mm = new MemoryManager(db, null, mockEmbed, llm);
    convs = new ConversationStore(db, null);
  });
  afterEach(() => db.close());

  it('★★ 主症：消息都是 3 天前、且从未摘要过 → **必须**产出摘要与画像', async () => {
    const sid = 'sess-old-1';
    await mm.ingest(makeEvent('a1', sid, '我是后端工程师，主要用 TypeScript', 3 * DAY));
    await mm.ingest(makeEvent('a2', sid, '代码风格我喜欢显式命名', 3 * DAY - 5000));

    await mm.onSessionEnd(sid);

    expect(
      convs.getBySession(sid).length,
      '会话结束得太晚（消息全部早于 now−24h）⇒ 一条摘要都没生成，这批消息永久进不了记忆',
    ).toBeGreaterThan(0);
    expect(
      JSON.parse(new ProfileStore(db).get().facts).length,
      'facts 一条没提出来',
    ).toBeGreaterThan(0);
  });

  it('★ 同一个会话里，跨过 24h 线的那段**也要**摘进去（不能只摘最近一天）', async () => {
    const sid = 'sess-old-2';
    await mm.ingest(makeEvent('b1', sid, '很久以前说过：我在学 Rust', 3 * DAY));
    await mm.ingest(makeEvent('b2', sid, '刚刚说：今天在看生命周期', 0));

    await mm.onSessionEnd(sid);
    const dialogue = dialogueOf();

    expect(dialogue, '只摘了最近的，早于 24h 的那段被丢了').toContain('我在学 Rust');
    expect(dialogue).toContain('今天在看生命周期');
  });

  it('★ 回归：**已有历史摘要** → 仍从 `ended_at` 之后继续，不回头重摘', async () => {
    const sid = 'sess-hist-1';
    await mm.ingest(makeEvent('c1', sid, '两天前说过的旧内容', 2 * DAY));
    // 历史摘要的 ended_at 落在「旧内容」之后 → 旧内容**不该**再进新摘要
    seedConversation(sid, 'conv-hist', new Date(Date.now() - DAY).toISOString());
    await mm.ingest(makeEvent('c2', sid, '这是刚说的新内容', 0));

    const before = (llm.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await mm.onSessionEnd(sid);
    const dialogue = dialogueOf(before);

    expect(dialogue, '新窗口没带上新消息').toContain('这是刚说的新内容');
    expect(dialogue, '回头重摘了已摘过的旧内容（重复学习副作用）').not.toContain('两天前说过的旧内容');
  });

  it('★ 回归：有会话记录但 `ended_at` 为空 → **保守**，不重摘整段历史', async () => {
    const sid = 'sess-hist-2';
    await mm.ingest(makeEvent('d1', sid, '三天前的旧内容', 3 * DAY));
    seedConversation(sid, 'conv-hist-2', null);   // ended_at 空

    await mm.onSessionEnd(sid);

    expect(
      convs.getBySession(sid).length,
      'ended_at 为空时退回"从头摘" —— 会把已摘过的历史重摘一遍',
    ).toBe(1);   // 只有种下的那一份，没有新增
  });

  it('★ 回归：新鲜会话照常摘要（修窗口下界不能把常见路径弄坏）', async () => {
    const sid = 'sess-fresh';
    await mm.ingest(makeEvent('e1', sid, '刚刚说的内容', 1000));

    await mm.onSessionEnd(sid);

    expect(convs.getBySession(sid).length).toBe(1);
    expect(dialogueOf()).toContain('刚刚说的内容');
  });

  // ─────────────────────────────────────────────────────────────
  // ★ 2026-10-11 的事故守卫**没有被丢掉**，而是换了一条更强的判据：
  //   那次事故的机制是「**同一段历史被反复摘要**」（45 秒内连摘三次，
  //   坏窗口 46~61 天 / 1000 条是它的症状）。当初的对策是"别往回想太远"（now−24h），
  //   代价是静默永久丢失（KI-26）。
  //   真正的守卫应当是「**摘过就前进、绝不回头**」—— 下面这条直接锁它。
  // ─────────────────────────────────────────────────────────────

  it('★ 不设时间上限：10 天前、从未摘要过的会话**也要**摘进来', async () => {
    const sid = 'sess-nocap';
    await mm.ingest(makeEvent('f1', sid, '十天前说过的话', 10 * DAY));
    await mm.ingest(makeEvent('f2', sid, '昨天说过的话', 1 * DAY));

    await mm.onSessionEnd(sid);
    const dialogue = dialogueOf();

    expect(dialogue, '超过某个时间上限的旧消息被丢了 —— 而它们从未被摘过').toContain('十天前说过的话');
    expect(dialogue).toContain('昨天说过的话');
  });

  it('★★ 事故形态不会复发：摘过一次之后，第二次**绝不**重摘同一段历史', async () => {
    const sid = 'sess-once';
    await mm.ingest(makeEvent('h1', sid, '十天前的历史内容', 10 * DAY));
    await mm.ingest(makeEvent('h2', sid, '昨天的内容', 1 * DAY));

    await mm.onSessionEnd(sid);                      // 第一次：从头摘
    const afterFirst = (llm.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // 之后又来了一条新消息，再次结算
    await mm.ingest(makeEvent('h3', sid, '刚说的新内容', 0));
    await mm.onSessionEnd(sid);
    const second = dialogueOf(afterFirst);

    expect(second, '第二次没带上新消息').toContain('刚说的新内容');
    expect(second, '重摘了已摘过的历史 —— 这正是 2026-10-11 事故的机制').not.toContain('十天前的历史内容');
    expect(second).not.toContain('昨天的内容');
  });
});
