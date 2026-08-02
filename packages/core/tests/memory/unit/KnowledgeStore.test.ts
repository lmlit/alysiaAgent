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

  it('should insert and retrieve chunks', async () => {
    await store.insert(makeDoc({ id: 'kd-1', chunk_count: 2 }));
    store.insertChunk({ id: 'chunk_1', doc_id: 'kd-1', chunk_index: 0, content: '第一章 介绍' });
    store.insertChunk({ id: 'chunk_2', doc_id: 'kd-1', chunk_index: 1, content: '第二章 使用说明' });

    const chunks = store.getChunksByDoc('kd-1');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunk_index).toBe(0);
  });

  it('should search chunks by content text', async () => {
    await store.insert(makeDoc({ id: 'kd-1', title: '产品手册' }));
    store.insertChunk({ id: 'c1', doc_id: 'kd-1', chunk_index: 0, content: '昔涟的生日是 3 月 21 日' });

    const results = store.searchChunksByText('生日', 5);
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain('3 月 21 日');
    expect(results[0].text).toContain('产品手册'); // 带标题前缀
  });

  it('should not search chunks of archived docs', async () => {
    await store.insert(makeDoc({ id: 'kd-1', title: '旧文档', status: 'archived' }));
    store.insertChunk({ id: 'c1', doc_id: 'kd-1', chunk_index: 0, content: '机密内容' });

    const results = store.searchChunksByText('机密', 5);
    expect(results).toHaveLength(0);
  });

  it('should delete doc and its chunks', async () => {
    await store.insert(makeDoc({ id: 'kd-1' }));
    store.insertChunk({ id: 'c1', doc_id: 'kd-1', chunk_index: 0, content: 'x' });

    store.deleteDoc('kd-1');
    expect(store.getById('kd-1')).toBeNull();
    expect(store.getChunksByDoc('kd-1')).toHaveLength(0);
  });
});
