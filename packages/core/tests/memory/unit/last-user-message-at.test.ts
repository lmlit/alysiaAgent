/**
 * ★ 2026-10-20（change: `tie-intimacy-to-speech`）
 *
 * `getLastUserMessageAt` 是「他已经多久没说话」的**唯一判据**。
 *
 * 它最容易在实现时写成「取最后一条消息的时间」——那样会踩 whale 那个坑的等价物：
 * **任何 assistant 侧写入 / 机器注入都会刷新它** ⇒ 算出来永远是"刚联系过"，
 * 沉默衰减与亲密度档位一起失效，而且**没有任何报错**。
 *
 * 故本测试的重点不是"能取到值"，而是**三条排除**：
 *   ① 机器注入（`skip_profile` / `synthetic`）不算他说话
 *   ② 非 message 类型（生活事件等）不算
 *   ③ 归档会话里他说过的话**仍然算**（归档只是从列表消失）
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../../../src/memory/stores/EventStore';
import { initializeDatabase } from '../../../src/memory/database';
import type { MemoryEvent } from '../../../src/memory/types';

describe('EventStore.getLastUserMessageAt', () => {
  let db: Database.Database;
  let store: EventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new EventStore(db);
  });

  afterEach(() => db.close());

  const ev = (over: Partial<MemoryEvent>): MemoryEvent => ({
    id: 'e1', session_id: 's1', source: 'chat', type: 'message',
    payload: { role: 'user', content: 'hi' }, importance: 0.5,
    created_at: '2026-10-01T10:00:00.000Z', ...over,
  });

  it('空库 → null', () => {
    expect(store.getLastUserMessageAt()).toBeNull();
  });

  it('取最后一条**真人**消息时间（assistant 不算）', () => {
    store.insert(ev({ id: 'u1', created_at: '2026-10-01T10:00:00.000Z' }));
    store.insert(ev({ id: 'a1', created_at: '2026-10-05T10:00:00.000Z', payload: { role: 'assistant', content: '嗯' } }));
    expect(store.getLastUserMessageAt()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('★ 机器注入（skip_profile / synthetic）不是他说话 —— 不得刷新 idle', () => {
    store.insert(ev({ id: 'u1', created_at: '2026-10-01T10:00:00.000Z' }));
    // dsh runtime-context 快照：role=user，但它是机器投影出来的
    store.insert(ev({
      id: 'syn1', created_at: '2026-10-09T10:00:00.000Z',
      payload: { role: 'user', content: '<runtime-context>', skip_profile: true, synthetic: 'runtime-context' },
    }));
    // 群里 NPC 的消息同样是 role=user + skip_profile
    store.insert(ev({
      id: 'npc1', created_at: '2026-10-10T10:00:00.000Z',
      payload: { role: 'user', content: '路人甲', skip_profile: true },
    }));
    expect(store.getLastUserMessageAt(), '被注入刷新的话他会永远"刚说过话"').toBe('2026-10-01T10:00:00.000Z');
  });

  it('非 message 事件（生活事件等）不算', () => {
    store.insert(ev({ id: 'u1', created_at: '2026-10-01T10:00:00.000Z' }));
    store.insert(ev({
      id: 'life1', type: 'life-event', session_id: 'life', created_at: '2026-10-09T10:00:00.000Z',
      payload: { role: 'user', content: '她自己的一天' },
    }));
    expect(store.getLastUserMessageAt()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('缺 role 时按 sender_id 推导（与 getMessagesBySession 同判据）', () => {
    store.insert(ev({ id: 'u1', payload: { sender_id: 'u-1', content: '无 role 字段' }, created_at: '2026-10-02T10:00:00.000Z' }));
    store.insert(ev({ id: 'a1', payload: { content: 'assistant 无 sender_id' }, created_at: '2026-10-03T10:00:00.000Z' }));
    expect(store.getLastUserMessageAt()).toBe('2026-10-02T10:00:00.000Z');
  });

  it('归档会话里他说过的话仍然算（归档只影响列表）', () => {
    const e = ev({ id: 'u1', created_at: '2026-10-04T10:00:00.000Z' });
    store.insert(e);
    store.archiveBySession('s1');
    expect(store.getLastUserMessageAt()).toBe('2026-10-04T10:00:00.000Z');
  });
});
