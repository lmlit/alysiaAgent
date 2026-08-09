// tests/memory/unit/ConversationStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore';
import { initializeDatabase } from '../../../src/memory/database';
import type { Conversation } from '../../../src/memory/types';
import type { IVectorStore } from '../../../src/memory/interfaces/IVectorStore';

describe('ConversationStore', () => {
  let db: Database.Database;
  let store: ConversationStore;

  const makeConv = (overrides: Partial<Conversation> = {}): Conversation => ({
    id: 'conv-1',
    session_id: 'sess-1',
    summary: '讨论了 Rust 生命周期',
    participants: '["user","ai"]',
    topics: '["rust","lifetime"]',
    key_decisions: '[]',
    message_count: 5,
    started_at: '2026-06-28T10:00:00Z',
    ended_at: null,
    embedding_id: null,
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ConversationStore(db, null); // null vectorStore for unit test
  });

  afterEach(() => db.close());

  it('should insert and retrieve a conversation', async () => {
    await store.insert(makeConv());
    const conv = store.getById('conv-1');
    expect(conv).not.toBeNull();
    expect(conv!.summary).toBe('讨论了 Rust 生命周期');
  });

  it('should get conversations by session', async () => {
    await store.insert(makeConv({ id: 'c1', session_id: 'sess-A' }));
    await store.insert(makeConv({ id: 'c2', session_id: 'sess-A' }));
    await store.insert(makeConv({ id: 'c3', session_id: 'sess-B' }));

    expect(store.getBySession('sess-A')).toHaveLength(2);
  });

  it('should get recent conversations ordered by start time', async () => {
    await store.insert(makeConv({ id: 'c1', started_at: '2026-06-28T10:00:00Z' }));
    await store.insert(makeConv({ id: 'c2', started_at: '2026-06-28T11:00:00Z' }));
    await store.insert(makeConv({ id: 'c3', started_at: '2026-06-28T09:00:00Z' }));

    const recent = store.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].id).toBe('c2'); // most recent first
    expect(recent[2].id).toBe('c3');
  });

  it('should respect limit on getRecent', async () => {
    await store.insert(makeConv({ id: 'c1' }));
    await store.insert(makeConv({ id: 'c2' }));
    expect(store.getRecent(1)).toHaveLength(1);
  });
});

describe('ConversationStore — 8-09 会话隔离', () => {
  let db: Database.Database;
  let store: ConversationStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ConversationStore(db, null);
    const now = new Date().toISOString();
    const ins = (sessionId: string, id: string) =>
      db.prepare(`INSERT INTO conversations (id, session_id, summary, message_count, started_at) VALUES (?, ?, ?, 3, ?)`)
        .run(id, sessionId, `summary-${id}`, now);
    ins('qq-official-1:private:private_AAA', 'c1');
    ins('qq-official-1:group:group_XXX', 'c2');
    ins('qq-official-1:private:private_BBB', 'c3');
  });

  afterEach(() => { db.close(); });

  it('传私聊 sessionId → 只返回 private 摘要（群聊 summary 不混入）', () => {
    const convs = store.getRecent(10, 'qq-official-1:private:private_AAA');
    expect(convs.map(c => c.session_id).every(s => s.includes(':private:'))).toBe(true);
    expect(convs).toHaveLength(2);
  });

  it('传群聊 sessionId → 只返回同群摘要', () => {
    const convs = store.getRecent(10, 'qq-official-1:group:group_XXX');
    expect(convs.map(c => c.session_id)).toEqual(['qq-official-1:group:group_XXX']);
  });

  it('不传 sessionId → 旧行为（全库最近）', () => {
    expect(store.getRecent(10)).toHaveLength(3);
  });
});
