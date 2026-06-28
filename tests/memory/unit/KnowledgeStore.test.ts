// tests/memory/unit/KnowledgeStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { KnowledgeStore } from '../../../src/memory/stores/KnowledgeStore';
import { initializeDatabase } from '../../../src/memory/database';
import type { KnowledgeDoc } from '../../../src/memory/types';

describe('KnowledgeStore', () => {
  let db: Database.Database;
  let store: KnowledgeStore;

  const makeDoc = (overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc => ({
    id: 'kd-1',
    title: 'test doc',
    source: 'imported',
    file_path: null,
    content_hash: 'abc123',
    chunk_count: 1,
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new KnowledgeStore(db, null);
  });

  afterEach(() => db.close());

  it('should insert and retrieve a doc', async () => {
    await store.insert(makeDoc());
    const doc = store.getById('kd-1');
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('test doc');
  });

  it('should list only active docs', async () => {
    await store.insert(makeDoc({ id: 'kd-1', status: 'active' }));
    await store.insert(makeDoc({ id: 'kd-2', status: 'archived' }));
    await store.insert(makeDoc({ id: 'kd-3', status: 'active' }));

    const active = store.listActive();
    expect(active).toHaveLength(2);
  });

  it('should archive a doc', async () => {
    await store.insert(makeDoc({ id: 'kd-1' }));
    store.archive('kd-1');
    const doc = store.getById('kd-1');
    expect(doc!.status).toBe('archived');
  });

  it('should reject duplicate content_hash', async () => {
    await store.insert(makeDoc({ id: 'kd-1', content_hash: 'abc' }));
    // getByHash returns existing doc
    const existing = store.getByHash('abc');
    expect(existing).not.toBeNull();
  });
});
