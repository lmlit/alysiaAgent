import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { LifeStore } from '../../src/memory/stores/LifeStore.js';

describe('LifeStore', () => {
  let db: Database.Database;
  let store: LifeStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new LifeStore(db);
  });

  it('getState returns defaults on empty db', () => {
    const s = store.getState();
    expect(s.currentActivity).toBe('');
    expect(s.intimacy).toBe(30);
  });

  it('updateState persists partial updates', () => {
    store.updateState({ currentActivity: '在阳台看书', mood: '平静', intimacy: 42 });
    const s = store.getState();
    expect(s.currentActivity).toBe('在阳台看书');
    expect(s.mood).toBe('平静');
    expect(s.intimacy).toBe(42);
  });

  it('addEvent + getTodayEvents roundtrip', () => {
    store.addEvent({
      id: 'evt-1', createdAt: '2026-08-06T09:30:00', type: 'chat',
      content: '在阳台看书，看到一朵像兔子的云',
    });
    const today = store.getTodayEvents('2026-08-06');
    expect(today).toHaveLength(1);
    expect(today[0].content).toContain('兔子');
    expect(store.getTodayEvents('2026-08-07')).toHaveLength(0);
  });

  it('getEventsSince filters by time', () => {
    store.addEvent({ id: 'e1', createdAt: '2026-08-06T09:00:00', type: 'internal', content: '倒水' });
    store.addEvent({ id: 'e2', createdAt: '2026-08-06T15:00:00', type: 'internal', content: '听歌' });
    const since = store.getEventsSince('2026-08-06T12:00:00');
    expect(since.map(e => e.id)).toEqual(['e2']);
  });

  it('markDelivered flips flag', () => {
    store.addEvent({ id: 'e1', createdAt: '2026-08-06T09:00:00', type: 'chat', content: 'x' });
    store.markDelivered('e1');
    expect(store.getEventById('e1')!.delivered).toBe(1);
  });

  it('daily summaries upsert + recent query', () => {
    store.upsertDailySummary('2026-08-05', '在旧书店待了一下午');
    store.upsertDailySummary('2026-08-06', '下雨听雨');
    store.upsertDailySummary('2026-08-05', '在旧书店待了一下午，淘到星星的书');
    const recent = store.getRecentSummaries(3);
    expect(recent).toHaveLength(2);
    expect(recent.find(r => r.date === '2026-08-05')!.summary).toContain('星星的书');
  });
});
