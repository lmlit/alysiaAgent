/**
 * 结果事件 outbox 单测（★ change: `wake-her-on-task-result`）。
 *
 * 这一层是「结果落库」与「她真的知道」之间的唯一桥梁，四条性质缺一不可：
 *   幂等入队 / 原子领取 / 超时回收 / 失败退避与用尽即停。
 * 每条都带**反向守卫**（合法路径不许被误伤）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import {
  ProjectTaskEventStore,
  insertEventRow,
} from '../../src/memory/stores/ProjectTaskEventStore.js';

const T0 = new Date('2026-10-19T00:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function makeStore(opts: Parameters<typeof ProjectTaskEventStore.prototype.constructor>[1] = {}) {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return { db, store: new ProjectTaskEventStore(db, opts) };
}

const ev = (over: Partial<Parameters<ProjectTaskEventStore['enqueue']>[0]> = {}) => ({
  eventId: 'pt-1:r0:result',
  taskId: 'pt-1',
  projectId: 'alysia-toys',
  revision: 0,
  kind: 'result',
  payload: { outcome: 'succeeded' },
  ...over,
});

describe('入队幂等', () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => { s = makeStore(); });

  it('第一次入队 → created；同 eventId 再来 → 不新建、不覆盖', () => {
    const a = s.store.enqueue(ev(), T0);
    expect(a.created).toBe(true);
    const b = s.store.enqueue(ev({ payload: { outcome: 'failed' } }), at(5));
    expect(b.created, '同一条结果被重复入队 —— 会把她叫醒两次').toBe(false);
    expect(s.store.get('pt-1:r0:result')!.payload.outcome, '重复入队改写了既有状态').toBe('succeeded');
  });

  it('不同 revision 是不同事件（返工后的新一轮必须能入队）', () => {
    s.store.enqueue(ev(), T0);
    const r1 = s.store.enqueue(ev({ eventId: 'pt-1:r1:result', revision: 1 }), at(1));
    expect(r1.created).toBe(true);
    expect(s.store.countByStatus()).toEqual({ pending: 2 });
  });

  it('insertEventRow 在外部事务里也能用（终态与入队同事务的入口）', () => {
    const db = s.db;
    const ins = db.transaction(() => insertEventRow(db, ev(), T0));
    expect(ins()).toBe(true);
    expect(insertEventRow(db, ev(), T0), '第二次必须返回 false（幂等空转）').toBe(false);
  });
});

describe('原子领取', () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => { s = makeStore(); });

  it('空队列 → null（空闲是常态，不是错误）', () => {
    expect(s.store.claimNext(T0)).toBeNull();
  });

  it('领取后状态是 claimed、attempts=1；再领同一条拿不到', () => {
    s.store.enqueue(ev(), T0);
    const got = s.store.claimNext(at(1));
    expect(got!.status).toBe('claimed');
    expect(got!.attempts).toBe(1);
    expect(s.store.claimNext(at(2)), '同一条被领了两次 —— 她会说两遍').toBeNull();
  });

  it('按 created_at 先进先出（排队不饿死）', () => {
    s.store.enqueue(ev({ eventId: 'a', taskId: 'a' }), at(0));
    s.store.enqueue(ev({ eventId: 'b', taskId: 'b' }), at(1));
    expect(s.store.claimNext(at(2))!.eventId).toBe('a');
    expect(s.store.claimNext(at(3))!.eventId).toBe('b');
  });

  it('next_at 没到 → 领不到（退避真的生效）', () => {
    s.store.enqueue(ev(), T0);
    s.store.claimNext(at(0));
    s.store.fail('pt-1:r0:result', '发送失败', at(1));
    expect(s.store.claimNext(at(2)), '退避期内又被领走了').toBeNull();
    expect(s.store.claimNext(at(3600))!.eventId).toBe('pt-1:r0:result');
  });
});

describe('超时回收（进程崩了的恢复入口）', () => {
  it('claimed 超时 → 退回 pending 可重领；次数用尽 → dead', () => {
    const s = makeStore({ claimTimeoutMs: 60_000, maxAttempts: 2 });
    s.store.enqueue(ev(), T0);
    expect(s.store.claimNext(at(0))!.attempts).toBe(1);
    // 5 分钟后再来：别人可以接手
    const again = s.store.claimNext(at(300));
    expect(again!.eventId).toBe('pt-1:r0:result');
    expect(again!.attempts).toBe(2);
    // 再来一次：次数用尽 ⇒ 不再回收，状态转 dead
    expect(s.store.claimNext(at(900))).toBeNull();
    expect(s.store.get('pt-1:r0:result')!.status).toBe('dead');
  });
});

describe('失败退避与收口', () => {
  it('fail 递增 attempts 并可重领；ack 之后不许再被领', () => {
    const s = makeStore({ maxAttempts: 5 });
    s.store.enqueue(ev(), T0);
    const got = s.store.claimNext(at(1))!;
    expect(s.store.finish(got.eventId, at(2))).toBe(true);
    expect(s.store.get(got.eventId)!.status).toBe('done');
    expect(s.store.claimNext(at(9999)), 'done 的事件又被领走了 —— 会重复通知').toBeNull();
  });

  it('重复 ack 是空转（不把 done 改成别的时间）', () => {
    const s = makeStore();
    s.store.enqueue(ev(), T0);
    s.store.claimNext(at(1));
    expect(s.store.finish('pt-1:r0:result', at(2))).toBe(true);
    expect(s.store.finish('pt-1:r0:result', at(3))).toBe(false);
    expect(s.store.get('pt-1:r0:result')!.processedAt).toBe(at(2).toISOString());
  });

  it('attempts 用尽 → dead，且原因留在 last_error（响亮地停）', () => {
    const s = makeStore({ maxAttempts: 1 });
    s.store.enqueue(ev(), T0);
    s.store.claimNext(at(1));
    const after = s.store.fail('pt-1:r0:result', 'QQ 通道返回 false', at(2))!;
    expect(after.status).toBe('dead');
    expect(after.lastError).toContain('QQ 通道');
  });

  it('listByTask 能看见一条任务的全部投递尝试（排障用）', () => {
    const s = makeStore();
    s.store.enqueue(ev(), T0);
    s.store.enqueue(ev({ eventId: 'pt-1:r1:result', revision: 1 }), at(1));
    expect(s.store.listByTask('pt-1')).toHaveLength(2);
  });
});
