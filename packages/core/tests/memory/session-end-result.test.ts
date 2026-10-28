// tests/memory/session-end-result.test.ts
// ★ 9-26 fix-session-event-window-truncation
// `process()` 必须能区分「真归档」与「空转」——否则日志里两者长得一样，
// 线上就是这么让一个空转了 18 小时的管道看起来一切正常的。
//
// ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C4）：结果从**一个布尔**改成**三段并列**
//   （`summary` / `facts` / `vector`）。理由见 proposal E5/E6：
//   一个布尔值必然让"摘要成功"替"事实提取失败"作证。
import { describe, it, expect } from 'vitest';
import { SessionEndProcessor } from '../../src/memory/processors/SessionEndProcessor.js';
import type { MemoryEvent } from '../../src/memory/types.js';

const ev = (id: string, content: string, createdAt = '2026-09-26T00:00:00Z'): MemoryEvent => ({
  id, session_id: 's1', source: 'chat', type: 'message',
  payload: { content, role: 'user' }, importance: 0, created_at: createdAt,
});

function makeProcessor(opts: {
  events?: MemoryEvent[];
  llm?: string;
  extract?: { facts?: unknown[]; characterFacts?: unknown[]; attempted?: boolean; error?: string };
} = {}) {
  const events = opts.events ?? [ev('e1', '你好')];
  const inserted: any[] = [];
  const factsStatuses: Array<{ id: string; status: string }> = [];
  const p = new SessionEndProcessor(
    { getBySession: () => events, updateImportance: () => {} } as any,
    {
      insert: async (c: any) => inserted.push(c),
      updateSummaryResult: async () => {},
      // ★ C4：事实状态是**独立的一笔记账**，harness 必须实现它（否则等于把被测行为删了）
      updateFactsStatus: (id: string, status: string) => { factsStatuses.push({ id, status }); return { rows: 1 }; },
      incrementFactsAttempts: () => {},
    } as any,
    { addFacts: () => {}, addCharacterFacts: () => {}, getCurrentFacts: () => [] } as any,
    {} as any, {} as any,
    {
      extract: async () => ({
        facts: [], characterFacts: [], attempted: true,
        ...(opts.extract ?? {}),
      }),
    } as any,
    { processSignal: async () => null, apply: () => {} } as any,
    { complete: async () => opts.llm ?? '{"summary":"正常摘要"}' } as any,
    { embed: async () => [0.1] } as any,
    null,   // 无向量库
  );
  return { p, inserted, factsStatuses };
}

describe('process() 返回结果 — 空转必须可区分', () => {
  it('无事件 → summary=skipped, reason=no-events', async () => {
    const { p } = makeProcessor({ events: [] });
    expect(await p.process('s1')).toMatchObject({ summary: 'skipped', facts: 'skipped', reason: 'no-events' });
  });

  it('有事件但都不是 message → reason=no-messages', async () => {
    const { p } = makeProcessor({ events: [{ ...ev('e1', 'x'), type: 'persona_change' }] });
    expect(await p.process('s1')).toMatchObject({ summary: 'skipped', reason: 'no-messages' });
  });

  it('message 但都没有 content → reason=no-dialogue（且不落 failed 行，避免噪声掩盖真失败）', async () => {
    const { p, inserted } = makeProcessor({ events: [{ ...ev('e1', ''), payload: {} }] });
    expect(await p.process('s1')).toMatchObject({ summary: 'skipped', reason: 'no-dialogue' });
    expect(inserted).toHaveLength(0);
  });

  it('摘要失败 → reason=summary-failed（与"无内容"区分开）', async () => {
    const { p } = makeProcessor({ llm: '这不是 JSON' });
    // ★ 2026-10-16 KI-15 / ★ 2026-10-21 C4：本用例只关心摘要段与原因，
    //   故用 toMatchObject；向量四态由 `unit/ConversationStore-vector.test.ts` 单独锁，
    //   事实段由本文件后半 + `facts-accounting.test.ts` 锁。
    expect(await p.process('s1')).toMatchObject({ summary: 'failed', reason: 'summary-failed' });
  });

  it('成功 → summary=ok', async () => {
    const { p } = makeProcessor();
    expect(await p.process('s1')).toMatchObject({ summary: 'ok' });
  });
});

// ══════════════════════════════════════════════════════════════════
// ★ C4 / E5：**摘要成功不许替事实提取作证**
// ══════════════════════════════════════════════════════════════════
describe('★★ 三段分账：摘要 / 事实 / 向量 各报各的', () => {
  it('★★ 摘要成功但事实提取失败 → facts=failed（旧实现这里只会返回"成功"）', async () => {
    const { p, factsStatuses } = makeProcessor({ extract: { attempted: true, error: 'LLM 空响应' } });

    const r = await p.process('s1');

    expect(r.summary).toBe('ok');
    expect(r.facts, '事实提取失败了，结果却报成功 —— 那批事实就永远没人知道丢了').toBe('failed');
    expect(factsStatuses, '失败必须落到库里（facts_status），不是只在日志里').toEqual([
      { id: expect.any(String), status: 'failed' },
    ]);
  });

  it('★ 提取成功但 0 条 → facts=ok（"看了，确实没有新事实"与"失败"不同）', async () => {
    const { p } = makeProcessor({ extract: { attempted: true } });
    expect(await p.process('s1')).toMatchObject({ summary: 'ok', facts: 'ok' });
  });

  it('★ 没有可提取的用户发言 → facts=skipped（一次 LLM 都不该调）', async () => {
    const { p } = makeProcessor({ extract: { attempted: false } });
    expect(await p.process('s1')).toMatchObject({ summary: 'ok', facts: 'skipped' });
  });
});
