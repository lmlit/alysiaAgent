// tests/memory/conversation-summary-status.test.ts
// ★ 9-25 fix-session-summary-silent-failure：摘要失败状态（可见性 + 检索过滤 + 迁移）
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ConversationStore } from '../../src/memory/stores/ConversationStore.js';
import { initializeDatabase } from '../../src/memory/database.js';
import type { Conversation } from '../../src/memory/types.js';

function makeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    session_id: 'sess-1',
    summary: '讨论了 Rust 生命周期',
    participants: '["user","ai"]',
    topics: '["rust"]',
    key_decisions: '[]',
    message_count: 5,
    started_at: '2026-09-01T10:00:00Z',
    ended_at: '2026-09-01T11:00:00Z',
    embedding_id: null,
    ...overrides,
  };
}

describe('summary_status 写入与查询', () => {
  let db: Database.Database;
  let store: ConversationStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ConversationStore(db, null);
  });

  it('默认写入 ok', async () => {
    await store.insert(makeConv());
    expect(store.getById('conv-1')!.summary_status).toBe('ok');
  });

  it('失败行可被 getFailed 捞出（这就是"缺失可见"）', async () => {
    await store.insert(makeConv({ id: 'c-ok', summary: '真摘要' }));
    await store.insert(makeConv({ id: 'c-bad', summary: '', summary_status: 'failed' }));

    const failed = store.getFailed();
    expect(failed.map(c => c.id)).toEqual(['c-bad']);
    expect(failed[0].summary).toBe('');
    expect(failed[0].session_id).toBe('sess-1');   // 窗口还原所需的关联还在
    expect(failed[0].ended_at).toBe('2026-09-01T11:00:00Z');
  });

  it('★ getRecent 排除失败行（空摘要不进 prompt）', async () => {
    await store.insert(makeConv({ id: 'c-ok', summary: '真摘要' }));
    await store.insert(makeConv({ id: 'c-bad', summary: '', summary_status: 'failed' }));

    expect(store.getRecent(10).map(c => c.id)).toEqual(['c-ok']);
    expect(store.getRecent(10, 'sess-1').map(c => c.id)).toEqual(['c-ok']);
  });

  it('★ searchByText 排除失败行', async () => {
    await store.insert(makeConv({ id: 'c-ok', summary: '讨论了 Rust 生命周期' }));
    await store.insert(makeConv({ id: 'c-bad', summary: '', summary_status: 'failed' }));

    expect(store.searchByText('Rust', 10).map(r => r.id)).toEqual(['c-ok']);
  });

  it('getPreviousEndedAt 取更早一条的 ended_at（窗口起点还原）', async () => {
    await store.insert(makeConv({ id: 'c1', ended_at: '2026-09-01T11:00:00Z' }));
    await store.insert(makeConv({ id: 'c2', ended_at: '2026-09-01T17:00:00Z' }));
    expect(store.getPreviousEndedAt('sess-1', '2026-09-01T17:00:00Z')).toBe('2026-09-01T11:00:00Z');
    // 没有更早的 → null
    expect(store.getPreviousEndedAt('sess-1', '2026-09-01T11:00:00Z')).toBeNull();
  });

  it('updateSummaryResult 就地补好并翻回 ok', async () => {
    await store.insert(makeConv({ id: 'c-bad', summary: '', summary_status: 'failed' }));

    await store.updateSummaryResult('c-bad', {
      summary: '补出来的真摘要',
      participants: '["user","ai"]',
      topics: '["补的"]',
      key_decisions: '[]',
      character_perspective: '',
    });

    const c = store.getById('c-bad')!;
    expect(c.summary).toBe('补出来的真摘要');
    expect(c.summary_status).toBe('ok');
    expect(c.message_count).toBe(5);            // 关联信息不动
    expect(store.getFailed()).toHaveLength(0);
  });
});

describe('★ 迁移：老库（无 summary_status 列）能升级', () => {
  it('ALTER 补列，且存量行视为 ok（不被误判为失败）', () => {
    const db = new Database(':memory:');
    // 手工建"老版本"的 conversations 表（没有 summary_status）
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, summary TEXT NOT NULL,
        participants TEXT NOT NULL DEFAULT '[]', topics TEXT NOT NULL DEFAULT '[]',
        key_decisions TEXT NOT NULL DEFAULT '[]', message_count INTEGER DEFAULT 0,
        started_at TEXT NOT NULL, ended_at TEXT, embedding_id TEXT
      );
      INSERT INTO conversations (id, session_id, summary, started_at)
        VALUES ('old-1', 'sess-old', '一条老摘要', '2026-08-01T00:00:00Z');
    `);

    initializeDatabase(db);   // 跑迁移

    const cols = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('summary_status');

    const store = new ConversationStore(db, null);
    // 存量行不能因为列是后加的就被当成失败
    expect(store.getFailed()).toHaveLength(0);
    expect(store.getById('old-1')!.summary_status).toBe('ok');
    expect(store.getRecent(10).map(c => c.id)).toContain('old-1');
  });
});
