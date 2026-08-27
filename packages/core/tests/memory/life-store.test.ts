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

  // ── ★ 8-27 叙事化重构：moodValue / origin / presence / 模板分类 ────────

  it('getState 默认 moodValue=0；updateState 持久化 moodValue', () => {
    expect(store.getState().moodValue).toBe(0);
    store.updateState({ moodValue: 22 });
    expect(store.getState().moodValue).toBe(22);
  });

  it('addEvent 默认 origin=regular；followup 标记透传', () => {
    store.addEvent({ id: 'e1', createdAt: '2026-08-06T09:00:00', type: 'internal', content: '余波' });
    expect(store.getEventById('e1')!.origin).toBe('regular');
    store.addEvent({ id: 'e2', createdAt: '2026-08-06T10:00:00', type: 'internal', content: '余波2', origin: 'followup' });
    expect(store.getEventById('e2')!.origin).toBe('followup');
  });

  it('scene presence: upsert 幂等 + list + 仅 present 进 listPresentNames', () => {
    expect(store.listPresentNames()).toEqual([]);
    store.upsertScenePresence('迷迷', 'present', '迷迷在我腿边团成一团');
    store.upsertScenePresence('风堇', 'off-scene');
    expect(store.listScenePresence().map(p => p.name).sort()).toEqual(['迷迷', '风堇']);
    expect(store.listPresentNames()).toEqual(['迷迷']);
    // 幂等更新
    store.upsertScenePresence('迷迷', 'present', '迷迷叼着发绳跑');
    const rows = store.listScenePresence().filter(p => p.name === '迷迷');
    expect(rows).toHaveLength(1);
    expect(rows[0].basis).toContain('发绳');
  });

  it('presenceStaleHours 返回距上次更新小时数；无记录返回 null', () => {
    expect(store.presenceStaleHours('迷迷')).toBeNull();
    store.upsertScenePresence('迷迷', 'present');
    const now = new Date().getTime();
    // 手动把 updated_at 改成 25h 前
    db.prepare('UPDATE ai_life_scene_presence SET updated_at = ? WHERE name = ?')
      .run(new Date(now - 25 * 3_600_000).toISOString(), '迷迷');
    expect(store.presenceStaleHours('迷迷', now)).toBeCloseTo(25, 0);
  });

  it('模板分类分组：种子带 category/group_name，旧 8 条 seed 也补分类', () => {
    const list = store.listTemplates();
    expect(list.length).toBeGreaterThanOrEqual(43); // 8-27 扩容 43 条
    const lv = list.find(t => t.id === 'lt-seed-01')!;
    expect(lv.category).toBe('独处');
    expect(lv.groupName).toBe('none');
    const share = list.find(t => t.id === 'lt-seed-04')!;
    expect(share.category).toBe('分享');
    const interact = list.find(t => t.id === 'lt-ref-30')!;
    expect(interact.groupName).toBe('迷迷');
    expect(interact.category).toBe('互动');
    // 三类数量
    const cat = (c: string) => list.filter(t => t.category === c).length;
    expect(cat('独处')).toBeGreaterThanOrEqual(20);
    expect(cat('互动')).toBeGreaterThanOrEqual(12);
    expect(cat('分享')).toBeGreaterThanOrEqual(11);
  });
});
