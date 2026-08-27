// tests/memory/unit/ProfileStore.test.ts
import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import { initializeDatabase } from '../../../src/memory/database';
import type { ProfileFact } from '../../../src/memory/types';

describe('ProfileStore', () => {
  let db: Database.Database;
  let store: ProfileStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ProfileStore(db);
    // Seed with default row
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(now);
  });

  afterEach(() => {
    db.close();
  });

  it('should return the single profile row', () => {
    const profile = store.get();
    expect(profile.id).toBe(1);
    expect(profile.basics).toBe('{}');
    expect(profile.preferences).toBe('{}');
  });

  it('should update basics', () => {
    store.updateBasics('{"occupation":"engineer"}');
    const profile = store.get();
    expect(JSON.parse(profile.basics).occupation).toBe('engineer');
  });

  it('should update preferences', () => {
    store.updatePreferences('{"code_style":"explicit"}');
    const profile = store.get();
    expect(JSON.parse(profile.preferences).code_style).toBe('explicit');
  });

  it('should add and retrieve facts', () => {
    const fact: ProfileFact = {
      fact: '用户是后端工程师',
      confidence: 0.9,
      evidence: '我说我是后端',
      source_event: 'evt-1',
      updated_at: new Date().toISOString(),
    };
    store.addFacts([fact]);
    const facts = store.getFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('用户是后端工程师');
  });

  it('should replace all facts', () => {
    store.addFacts([{ fact: 'old', confidence: 0.5, evidence: 'x', source_event: 'e1', updated_at: new Date().toISOString() }]);
    store.replaceFacts([{ fact: 'new', confidence: 0.9, evidence: 'y', source_event: 'e2', updated_at: new Date().toISOString() }]);
    expect(store.getFacts()).toHaveLength(1);
  });

  it('should update timestamp on setUpdated', () => {
    vi.useFakeTimers();
    store.setUpdated();
    const before = store.get().updated_at;
    vi.advanceTimersByTime(1);
    store.setUpdated();
    const after = store.get().updated_at;
    expect(after).not.toBe(before);
    vi.useRealTimers();
  });
});

describe('ProfileStore — 8-09 包含去重', () => {
  let db: Database.Database;
  let store: ProfileStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ProfileStore(db);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(new Date().toISOString());
  });

  afterEach(() => { db.close(); });

  it('短事实（用户在长沙）是长事实（用户目前所在城市是长沙）子串 → 视为冲突并 supersede', () => {
    store.addFacts([{ fact: '用户目前所在城市是长沙', confidence: 0.8, evidence: 'e', source_event: 'e1', updated_at: new Date().toISOString() }]);
    const added = store.addFacts([{ fact: '用户在长沙', confidence: 0.6, evidence: 'e', source_event: 'e2', updated_at: new Date().toISOString() }]);
    expect(added).toHaveLength(1);
    const all = store.getAllFacts();
    expect(all.filter(f => f.status === 'active')).toHaveLength(1); // 只有一条 active
    expect(all.find(f => f.status === 'superseded')?.fact).toBe('用户目前所在城市是长沙');
  });

  it('短词（<3 字归一化）不误合并', () => {
    store.addFacts([{ fact: '长沙', confidence: 0.5, evidence: 'e', source_event: 'e1', updated_at: new Date().toISOString() }]);
    store.addFacts([{ fact: '用户玩星穹铁道', confidence: 0.7, evidence: 'e', source_event: 'e2', updated_at: new Date().toISOString() }]);
    expect(store.getFacts()).toHaveLength(2); // 互不包含，都保留
  });
});

describe('ProfileStore — 8-28 分类过期 + 确认闭环', () => {
  let db: Database.Database;
  let store: ProfileStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ProfileStore(db);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(new Date().toISOString());
  });

  afterEach(() => { db.close(); });

  it('分类过期时长：status→14天 / identity→365天 / general→60天', () => {
    const now = Date.now();
    const base = { confidence: 0.8, evidence: 'e', source_event: 'e1', updated_at: new Date().toISOString(), status: 'active' as const };
    store.addFacts([{ ...base, fact: '用户最近在玩绝区零', category: 'status' }]);
    store.addFacts([{ ...base, fact: '用户在长沙定居', category: 'identity' }]);
    store.addFacts([{ ...base, fact: '用户一般十一点睡', category: 'general' }]);
    const all = store.getAllFacts();
    const by = (f: string) => all.find(x => x.fact === f)!;
    expect(new Date(by('用户最近在玩绝区零').valid_until!).getTime() - now).toBeCloseTo(14 * 86_400_000, -5);
    expect(new Date(by('用户在长沙定居').valid_until!).getTime() - now).toBeCloseTo(365 * 86_400_000, -5);
    expect(new Date(by('用户一般十一点睡').valid_until!).getTime() - now).toBeCloseTo(60 * 86_400_000, -5);
  });

  it('旧调用无 category → valid_until null（永不过期，向后兼容）', () => {
    store.addFacts([{ fact: '老数据', confidence: 0.5, evidence: 'e', source_event: 'e1', updated_at: new Date().toISOString(), status: 'active' }]);
    expect(store.getAllFacts()[0].valid_until).toBeNull();
    expect(store.getAllFacts()[0].category).toBe('general'); // migrateFact 兜底
  });

  it('待确认窗口：过期 1 天 → pending；过期 5 天 → 自动 expired 清理', () => {
    const now = Date.now();
    const mk = (fact: string, daysAgo: number, cat: 'status' | 'general') => ({
      fact, confidence: 0.8, evidence: 'e', source_event: 'e1',
      updated_at: new Date(now - (daysAgo + 14) * 86_400_000).toISOString(),
      source: 'inferred' as const,
      valid_from: new Date(now - (daysAgo + 14) * 86_400_000).toISOString(),
      valid_until: new Date(now - daysAgo * 86_400_000).toISOString(), // 过期 daysAgo 天
      status: 'active' as const, category: cat,
    });
    store.addFacts([mk('用户之前玩绝区零', 1, 'status'), mk('用户以前的旧习惯', 5, 'general')]);
    // 1 天前过期的在待确认列表
    const pending = store.listPendingConfirmFacts();
    expect(pending.map(p => p.fact)).toEqual(['用户之前玩绝区零']);
    // 5 天前过期的已被清理为 expired
    const all = store.getAllFacts();
    expect(all.find(f => f.fact === '用户以前的旧习惯')?.status).toBe('expired');
  });

  it('confirmFact 确认 → 按分类续期一个周期', () => {
    const now = Date.now();
    store.addFacts([{
      fact: '用户之前玩绝区零', confidence: 0.8, evidence: 'e', source_event: 'e1',
      updated_at: new Date().toISOString(), source: 'inferred',
      valid_from: new Date(now - 15 * 86_400_000).toISOString(),
      valid_until: new Date(now - 86_400_000).toISOString(), status: 'active', category: 'status',
    }]);
    const key = store.factKeyOf('用户之前玩绝区零');
    expect(store.confirmFact(key, true)).toBe(true);
    const f = store.getAllFacts().find(x => x.fact === '用户之前玩绝区零')!;
    expect(f.status).toBe('active');
    expect(new Date(f.valid_until!).getTime() - now).toBeCloseTo(14 * 86_400_000, -5); // 续期 14 天
  });

  it('confirmFact 否认 → superseded（不删除）', () => {
    store.addFacts([{
      fact: '用户以前在长沙', confidence: 0.8, evidence: 'e', source_event: 'e1',
      updated_at: new Date().toISOString(), source: 'inferred',
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() - 86_400_000).toISOString(),
      status: 'active', category: 'identity',
    }]);
    const key = store.factKeyOf('用户以前在长沙');
    expect(store.confirmFact(key, false)).toBe(true);
    const f = store.getAllFacts().find(x => x.fact === '用户以前在长沙')!;
    expect(f.status).toBe('superseded');
  });

  it('confirmFact 未匹配 key → false', () => {
    expect(store.confirmFact('不存在的归一化文本', true)).toBe(false);
  });
});

describe('ProfileStore — 8-28 角色事实（memory-character-perspective）', () => {
  let db: Database.Database;
  let store: ProfileStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ProfileStore(db);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(new Date().toISOString());
  });

  afterEach(() => { db.close(); });

  it('addCharacterFacts + getAllCharacterFacts roundtrip（与用户事实分离）', () => {
    store.addCharacterFacts([{ fact: '昔涟最近在学做点心', confidence: 0.7, evidence: 'e', source_event: 'e1', category: 'status' }]);
    const cf = store.getAllCharacterFacts();
    expect(cf).toHaveLength(1);
    expect(cf[0].fact).toContain('做点心');
    expect(cf[0].category).toBe('status');
    expect(cf[0].status).toBe('active');
    // 分类 TTL 生效（status → 14 天）
    const ttl = new Date(cf[0].valid_until!).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(13 * 86_400_000);
    // 用户事实不受影响
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('getActiveCharacterFacts 过滤过期/superseded', () => {
    store.addCharacterFacts([
      { fact: '昔涟喜欢雨天', confidence: 0.8, evidence: 'e', source_event: 'e1', category: 'preference' },
    ]);
    const all = store.getAllCharacterFacts();
    all[0].status = 'superseded';
    db.prepare('UPDATE user_profile SET character_facts = ? WHERE id = 1').run(JSON.stringify(all));
    expect(store.getActiveCharacterFacts()).toHaveLength(0);
  });
});
