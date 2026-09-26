// tests/memory/event-window.test.ts
// ★ 9-26 fix-session-event-window-truncation
//
// 这组测试直接编码线上故障：主会话积累 1436 条事件后，`getBySession` 的
// `ORDER BY created_at ASC LIMIT 1000` 只返回**最旧的 1000 条**，
// 导致「最近的事件」一条都取不到 → 会话摘要管道空转 18 小时、0 条新摘要。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../../src/memory/stores/EventStore.js';
import { initializeDatabase } from '../../src/memory/database.js';
import type { MemoryEvent } from '../../src/memory/types.js';

const SID = 'sess-long';

describe('EventStore.getBySession — 时间窗语义', () => {
  let db: Database.Database;
  let store: EventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new EventStore(db);
  });

  afterEach(() => db.close());

  /** 造 n 条消息事件，时间从 2026-01-01T00:00:00Z 起每条 +1 分钟 */
  function seed(n: number): Date[] {
    const times: Date[] = [];
    for (let i = 0; i < n; i++) {
      const t = new Date(Date.UTC(2026, 0, 1, 0, i));
      times.push(t);
      store.insert({
        id: `e-${i}`,
        session_id: SID,
        source: 'chat',
        type: 'message',
        payload: { role: 'user', content: `消息 ${i}` },
        importance: 0,
        created_at: t.toISOString(),
        processed: 0,
      } as MemoryEvent);
    }
    return times;
  }

  it('★★ 核心回归：事件数超 LIMIT 时，喂了 anchor 仍必须取到窗口内的事件', () => {
    // 线上原样：1436 条事件、anchor 落在最后 20 条之前
    const times = seed(1436);
    const anchor = times[1415];   // 之后还有 20 条（1416..1435）

    const got = store.getBySession(SID, { since: anchor });

    // 当前实现在这里是 0 条 —— 这就是管道空转的原因
    expect(got.length).toBeGreaterThan(0);
    // ⚠️ 边界语义是 `>=`（**包含** anchor 那一条本身）——沿用 process() 里原有的过滤语义，
    //    本 change 不顺手改成 `>`（那是另一个语义决策，会改变摘要窗口边界）。
    //    所以 anchor=times[1415] → 取到 1415..1435 共 21 条。
    expect(got.length).toBe(21);
    expect(got[0].id).toBe('e-1415');
    expect(got[got.length - 1].id).toBe('e-1435');
  });

  it('★ 无 since 时取【最近】N 条，而不是最旧的 N 条', () => {
    seed(1200);
    const got = store.getBySession(SID);            // 默认 limit 1000
    expect(got).toHaveLength(1000);
    // 必须覆盖到最后一条；旧实现最晚只到第 1000 条
    expect(got[got.length - 1].id).toBe('e-1199');
    expect(got[0].id).toBe('e-200');                // 最近 1000 条 = 200..1199
  });

  it('★ 窗口内超过 limit 时，保留最近的 limit 条（不是最旧的）', () => {
    const times = seed(1200);
    const got = store.getBySession(SID, { since: times[0], limit: 100 });
    expect(got).toHaveLength(100);
    expect(got[got.length - 1].id).toBe('e-1199');  // 最新的那条必须在
    expect(got[0].id).toBe('e-1100');
  });

  it('返回值按时间【升序】（对话拼接依赖顺序）', () => {
    const times = seed(50);
    const got = store.getBySession(SID, { since: times[10], limit: 5 });
    const ts = got.map(e => new Date(e.created_at).getTime());
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('since 早于所有事件 → 等价于全量（受 limit 约束）', () => {
    const times = seed(30);
    const got = store.getBySession(SID, { since: new Date(times[0].getTime() - 86400_000) });
    expect(got).toHaveLength(30);
  });

  it('since 晚于所有事件 → 空数组（不是抛错、也不是回退成全量）', () => {
    const times = seed(30);
    const got = store.getBySession(SID, { since: new Date(times[29].getTime() + 86400_000) });
    expect(got).toEqual([]);
  });

  it('只返回该 session 的事件', () => {
    seed(10);
    store.insert({
      id: 'other-1', session_id: 'sess-other', source: 'chat', type: 'message',
      payload: { role: 'user', content: 'x' }, importance: 0,
      created_at: '2026-01-01T00:00:30Z', processed: 0,
    } as MemoryEvent);
    const got = store.getBySession(SID, { limit: 100 });
    expect(got.every(e => e.session_id === SID)).toBe(true);
  });

  it('空会话 → 空数组', () => {
    expect(store.getBySession('nope')).toEqual([]);
  });
});
