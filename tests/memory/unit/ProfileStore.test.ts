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
