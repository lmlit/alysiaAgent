import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { WorldbookMatcher } from '../../../src/memory/engines/WorldbookMatcher';
import { initializeDatabase } from '../../../src/memory/database';
import type { WorldbookEntry } from '../../../src/memory/types';

describe('WorldbookMatcher', () => {
  let db: Database.Database;
  let store: WorldbookStore;
  let matcher: WorldbookMatcher;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new WorldbookStore(db);
    matcher = new WorldbookMatcher(store);

    store.insert({
      id: 'wb-1', trigger_keys: JSON.stringify(['rust', 'lifetime']),
      trigger_mode: 'any', content: '用户在学习 Rust 生命周期',
      scope: 'chat', priority: 5, cooldown_sec: 300,
      last_triggered: null, hit_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } satisfies WorldbookEntry);
    store.insert({
      id: 'wb-2', trigger_keys: JSON.stringify(['coding', 'code']),
      trigger_mode: 'any', content: '用户正在写代码',
      scope: 'code', priority: 3, cooldown_sec: 60,
      last_triggered: null, hit_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } satisfies WorldbookEntry);
  });

  afterEach(() => db.close());

  it('should extract keywords and match entries', async () => {
    const entries = await matcher.match('Rust 的生命周期真的好难理解', 'chat');
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('wb-1');
  });

  it('should filter entries by mode scope', async () => {
    const entries = await matcher.match('我在 coding', 'code');
    const ids = entries.map(e => e.id);
    expect(ids).toContain('wb-2');
    expect(ids).not.toContain('wb-1');
  });

  it('should record trigger and not return cooldown entries on subsequent match', async () => {
    const first = await matcher.match('Rust lifetime 问题', 'chat');
    expect(first).toHaveLength(1);
    // second call should not return wb-1 because cooldown
    const second = await matcher.match('Rust lifetime 问题', 'chat');
    expect(second).toHaveLength(0);
  });
});
