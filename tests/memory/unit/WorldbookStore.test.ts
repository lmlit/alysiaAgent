import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { initializeDatabase } from '../../../src/memory/database';
import type { WorldbookEntry } from '../../../src/memory/types';

describe('WorldbookStore', () => {
  let db: Database.Database;
  let store: WorldbookStore;

  const makeEntry = (overrides: Partial<WorldbookEntry> = {}): WorldbookEntry => ({
    id: 'wb-1',
    trigger_keys: JSON.stringify(['rust', 'lifetime']),
    trigger_mode: 'any',
    content: '用户正在学习 Rust 生命周期',
    scope: 'chat',
    priority: 0,
    cooldown_sec: 300,
    last_triggered: null,
    hit_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new WorldbookStore(db);
  });

  afterEach(() => db.close());

  it('should insert and retrieve an entry', () => {
    store.insert(makeEntry());
    const entry = store.getById('wb-1');
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('用户正在学习 Rust 生命周期');
  });

  it('should match entries by keywords (any mode)', () => {
    store.insert(makeEntry({ id: 'wb-1', trigger_keys: JSON.stringify(['rust', 'lifetime']) }));
    store.insert(makeEntry({ id: 'wb-2', trigger_keys: JSON.stringify(['python']) }));
    store.insert(makeEntry({ id: 'wb-3', trigger_keys: JSON.stringify(['rust', 'cargo']) }));

    const matched = store.matchByKeywords(['rust']);
    expect(matched).toHaveLength(2);
    expect(matched.map(e => e.id).sort()).toEqual(['wb-1', 'wb-3']);
  });

  it('should filter by scope', () => {
    store.insert(makeEntry({ id: 'wb-1', scope: 'code' }));
    store.insert(makeEntry({ id: 'wb-2', scope: 'chat' }));
    store.insert(makeEntry({ id: 'wb-3', scope: 'both' }));

    const codeMatches = store.matchByKeywords(['rust'], 'code');
    expect(codeMatches.map(e => e.id).sort()).toEqual(['wb-1', 'wb-3']);
  });

  it('should record trigger and respect cooldown', () => {
    store.insert(makeEntry({ id: 'wb-1', cooldown_sec: 60 }));
    store.recordTrigger('wb-1');

    const entry = store.getById('wb-1');
    expect(entry!.hit_count).toBe(1);
    expect(entry!.last_triggered).not.toBeNull();

    // matchByKeywords should filter out items still on cooldown
    // Create another entry not on cooldown
    store.insert(makeEntry({ id: 'wb-2', trigger_keys: JSON.stringify(['rust']) }));
    const matched = store.matchByKeywords(['rust']);
    expect(matched).toHaveLength(1); // only wb-2, wb-1 on cooldown
  });

  it('should update entry fields', () => {
    store.insert(makeEntry({ id: 'wb-1' }));
    store.updateEntry('wb-1', { content: 'updated content', priority: 5 });
    const entry = store.getById('wb-1');
    expect(entry!.content).toBe('updated content');
  });

  it('should delete an entry', () => {
    store.insert(makeEntry({ id: 'wb-1' }));
    store.deleteEntry('wb-1');
    expect(store.getById('wb-1')).toBeNull();
  });
});
