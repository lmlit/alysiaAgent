// tests/memory/channel-field.test.ts
// ★ 2026-10-16 · change: `add-memory-channel-field`
//
// 背景：后续要让昔涟**从 QQ 侧调用 dsh 编程工具** ⇒ QQ 日常对话与 dsh 编程会话在同一套库里
// 并存，且将来要**特殊处理**（差异化召回/注入）。此前渠道只能靠 `session_id` 前缀猜。
//
// 两条必须锁住的判据：
//   ① **`events.source` 不能当渠道用** —— 它是 chat/code（事件性质），而 dsh 会话里两者都有
//      （实测 730 条 dsh 事件里 **28 条**是 `source='chat'`）。用 `source='code'` 判 dsh 会漏。
//   ② 派生不出来的记 **'unknown'**，不许猜；'' 只表示"还没回填"，两者语义不同。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { EventStore } from '../../src/memory/stores/EventStore.js';
import { ConversationStore } from '../../src/memory/stores/ConversationStore.js';
import { channelOfSession, isDshSubagentSession } from '../../src/utils/channel.js';
import type { MemoryEvent, Conversation } from '../../src/memory/types.js';

const evt = (id: string, sid: string): MemoryEvent => ({
  id, session_id: sid, source: 'chat', type: 'message',
  payload: { role: 'user', content: 'hi' },
  importance: 0.5, created_at: '2026-10-16T10:00:00.000Z',
});

const conv = (id: string, sid: string): Conversation => ({
  id, session_id: sid, summary: 's', participants: '[]', topics: '[]', key_decisions: '[]',
  message_count: 1, started_at: '2026-10-16T10:00:00.000Z', ended_at: '2026-10-16T10:00:01.000Z',
  embedding_id: null,
});

describe('★ 渠道派生 channelOfSession', () => {
  it('实测的前缀家族各归各位', () => {
    expect(channelOfSession('dsh:session-29b9865c-9096-4eb1-9232-a2eda044b023')).toBe('dsh');
    expect(channelOfSession('dsh:9a33c81f-98a8-4d91-842d-8019ff4c637f')).toBe('dsh'); // 子会话
    expect(channelOfSession('dsh:unknown')).toBe('dsh'); // 退化 id，但确实来自 dsh 通道
    expect(channelOfSession('qq-official-1:user-123')).toBe('qq');
    expect(channelOfSession('webui:default')).toBe('webui');
  });

  it('判不出来 → unknown（**不许猜**）', () => {
    expect(channelOfSession('telegram:1')).toBe('unknown');
    expect(channelOfSession('')).toBe('unknown');
    expect(channelOfSession(null)).toBe('unknown');
    expect(channelOfSession(undefined)).toBe('unknown');
  });

  it('dsh 子会话判据：主会话是 dsh:session-<uuid>，其余 dsh: 视为子会话', () => {
    expect(isDshSubagentSession('dsh:session-29b9865c-...')).toBe(false);
    expect(isDshSubagentSession('dsh:9a33c81f-...')).toBe(true);
    expect(isDshSubagentSession('qq-official-1:x')).toBe(false);
  });
});

describe('★ 渠道写入与回填', () => {
  const open = () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    return db;
  };

  it('events：写入时按 session_id 落库（不靠事后反推）', () => {
    const db = open();
    try {
      const store = new EventStore(db);
      store.insert(evt('e1', 'dsh:session-aaa'));
      store.insert(evt('e2', 'qq-official-1:u1'));
      store.insert(evt('e3', 'weird:thing'));
      const rows = db.prepare('SELECT id, channel FROM events ORDER BY id').all() as Array<{ id: string; channel: string }>;
      expect(rows).toEqual([
        { id: 'e1', channel: 'dsh' },
        { id: 'e2', channel: 'qq' },
        { id: 'e3', channel: 'unknown' },
      ]);
    } finally { db.close(); }
  });

  it('★ 显式传入的 channel 优先（未来按渠道分派时要用）', () => {
    const db = open();
    try {
      const store = new EventStore(db);
      store.insert({ ...evt('e1', 'qq-official-1:u1'), channel: 'dsh' });
      expect(db.prepare('SELECT channel FROM events WHERE id = ?').get('e1')).toEqual({ channel: 'dsh' });
    } finally { db.close(); }
  });

  it('conversations：同样写入时落库', async () => {
    const db = open();
    try {
      const store = new ConversationStore(db, null);
      await store.insert(conv('c1', 'dsh:session-aaa'));
      await store.insert(conv('c2', 'qq-official-1:u1'));
      const rows = db.prepare('SELECT id, channel FROM conversations ORDER BY id').all() as Array<{ id: string; channel: string }>;
      expect(rows).toEqual([{ id: 'c1', channel: 'dsh' }, { id: 'c2', channel: 'qq' }]);
    } finally { db.close(); }
  });

  it('★ 回填：老库（channel 为空）在初始化时按前缀补齐，判不出的记 unknown', () => {
    const db = open();
    try {
      // 模拟"加列之前就已存在的行"：直接写空 channel
      // ★ 2026-10-26（KI-27）：events 表不再有 processed 列。
      db.prepare(`INSERT INTO events (id, session_id, source, type, payload, importance, created_at, channel)
        VALUES (?,?,?,?,?,?,?,?)`).run('old1', 'dsh:session-old', 'chat', 'message', '{}', 0.5, '2026-10-01T00:00:00.000Z', '');
      db.prepare(`INSERT INTO events (id, session_id, source, type, payload, importance, created_at, channel)
        VALUES (?,?,?,?,?,?,?,?)`).run('old2', 'qq-official-1:old', 'chat', 'message', '{}', 0.5, '2026-10-01T00:00:00.000Z', '');

      initializeDatabase(db); // 再跑一次迁移 = 回填

      const rows = db.prepare('SELECT id, channel FROM events WHERE id LIKE ? ORDER BY id').all('old%');
      expect(rows).toEqual([{ id: 'old1', channel: 'dsh' }, { id: 'old2', channel: 'qq' }]);
    } finally { db.close(); }
  });

  it('★ 回填**不覆盖**已有渠道（幂等：已判定的行再跑一次不变）', () => {
    const db = open();
    try {
      const store = new EventStore(db);
      store.insert({ ...evt('e1', 'qq-official-1:u1'), channel: 'dsh' });
      initializeDatabase(db);
      expect(db.prepare('SELECT channel FROM events WHERE id = ?').get('e1')).toEqual({ channel: 'dsh' });
    } finally { db.close(); }
  });
});
