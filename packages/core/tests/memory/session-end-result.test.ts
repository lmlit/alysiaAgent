// tests/memory/session-end-result.test.ts
// ★ 9-26 fix-session-event-window-truncation
// `process()` 必须能区分「真归档」与「空转」——否则日志里两者长得一样，
// 线上就是这么让一个空转了 18 小时的管道看起来一切正常的。
import { describe, it, expect } from 'vitest';
import { SessionEndProcessor } from '../../src/memory/processors/SessionEndProcessor.js';
import type { MemoryEvent } from '../../src/memory/types.js';

const ev = (id: string, content: string, createdAt = '2026-09-26T00:00:00Z'): MemoryEvent => ({
  id, session_id: 's1', source: 'chat', type: 'message',
  payload: { content, role: 'user' }, importance: 0, created_at: createdAt, processed: 0,
});

function makeProcessor(opts: { events?: MemoryEvent[]; llm?: string } = {}) {
  const events = opts.events ?? [ev('e1', '你好')];
  const inserted: any[] = [];
  const processed: string[] = [];
  const p = new SessionEndProcessor(
    { getBySession: () => events, markProcessed: (id: string) => processed.push(id), updateImportance: () => {} } as any,
    { insert: async (c: any) => inserted.push(c), updateSummaryResult: async () => {} } as any,
    { addFacts: () => {}, addCharacterFacts: () => {} } as any,
    {} as any, {} as any,
    { extract: async () => ({ facts: [], characterFacts: [] }) } as any,
    { processSignal: async () => null, apply: () => {} } as any,
    { complete: async () => opts.llm ?? '{"summary":"正常摘要"}' } as any,
    { embed: async () => [0.1] } as any,
    null,   // 无向量库
  );
  return { p, inserted, processed };
}

describe('process() 返回结果 — 空转必须可区分', () => {
  it('无事件 → summarized:false, reason=no-events', async () => {
    const { p } = makeProcessor({ events: [] });
    expect(await p.process('s1')).toEqual({ summarized: false, reason: 'no-events' });
  });

  it('有事件但都不是 message → reason=no-messages', async () => {
    const { p } = makeProcessor({ events: [{ ...ev('e1', 'x'), type: 'persona_change' }] });
    expect(await p.process('s1')).toEqual({ summarized: false, reason: 'no-messages' });
  });

  it('message 但都没有 content → reason=no-dialogue（且不落 failed 行，避免噪声掩盖真失败）', async () => {
    const { p, inserted } = makeProcessor({ events: [{ ...ev('e1', ''), payload: {} }] });
    expect(await p.process('s1')).toEqual({ summarized: false, reason: 'no-dialogue' });
    expect(inserted).toHaveLength(0);
  });

  it('摘要失败 → reason=summary-failed（与"无内容"区分开）', async () => {
    const { p } = makeProcessor({ llm: '这不是 JSON' });
    expect(await p.process('s1')).toEqual({ summarized: false, reason: 'summary-failed' });
  });

  it('成功 → summarized:true', async () => {
    const { p } = makeProcessor();
    expect(await p.process('s1')).toEqual({ summarized: true });
  });
});
