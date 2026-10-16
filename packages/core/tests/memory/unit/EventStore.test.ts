// tests/memory/unit/EventStore.test.ts
import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../../../src/memory/stores/EventStore';
import { initializeDatabase } from '../../../src/memory/database';
import type { MemoryEvent } from '../../../src/memory/types';
import { PROCESSED_PROFILE } from '../../../src/memory/types';
import { logger } from '../../../src/utils/logger';

describe('EventStore', () => {
  let db: Database.Database;
  let store: EventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new EventStore(db);
  });

  afterEach(() => {
    db.close();
  });

  const makeEvent = (overrides: Partial<MemoryEvent> = {}): MemoryEvent => ({
    id: 'evt-001',
    session_id: 'sess-001',
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content: 'hello' },
    importance: 0.5,
    created_at: '2026-06-28T10:00:00Z',
    processed: 0,
    ...overrides,
  });

  it('should insert and retrieve an event', () => {
    const event = makeEvent();
    store.insert(event);

    const retrieved = store.getById('evt-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.session_id).toBe('sess-001');
    expect(retrieved!.source).toBe('chat');
  });

  it('should return null for non-existent event', () => {
    const retrieved = store.getById('nonexistent');
    expect(retrieved).toBeNull();
  });

  it('should return unprocessed events ordered by created_at', () => {
    store.insert(makeEvent({ id: 'e1', created_at: '2026-06-28T09:00:00Z' }));
    store.insert(makeEvent({ id: 'e2', created_at: '2026-06-28T10:00:00Z' }));
    store.insert(makeEvent({ id: 'e3', processed: PROCESSED_PROFILE, created_at: '2026-06-28T11:00:00Z' }));

    const unprocessed = store.getUnprocessed(10);
    expect(unprocessed).toHaveLength(2);
    expect(unprocessed[0].id).toBe('e1'); // older first
    expect(unprocessed[1].id).toBe('e2');
  });

  it('should respect limit on getUnprocessed', () => {
    store.insert(makeEvent({ id: 'e1' }));
    store.insert(makeEvent({ id: 'e2' }));
    expect(store.getUnprocessed(1)).toHaveLength(1);
  });

  it('should mark event as processed with bitmask', () => {
    store.insert(makeEvent({ id: 'e1' }));
    store.markProcessed('e1', PROCESSED_PROFILE);

    const event = store.getById('e1');
    expect(event!.processed & PROCESSED_PROFILE).toBeTruthy();
    expect(store.getUnprocessed(10)).toHaveLength(0);
  });

  it('should add flag without clearing existing flags', () => {
    store.insert(makeEvent({ id: 'e1', processed: PROCESSED_PROFILE }));
    store.markProcessed('e1', 2); // PROCESSED_SUMMARY

    const event = store.getById('e1');
    expect(event!.processed & PROCESSED_PROFILE).toBeTruthy();
    expect(event!.processed & 2).toBeTruthy();
  });

  it('should count events by session', () => {
    store.insert(makeEvent({ id: 'e1', session_id: 'sess-A' }));
    store.insert(makeEvent({ id: 'e2', session_id: 'sess-A' }));
    store.insert(makeEvent({ id: 'e3', session_id: 'sess-B' }));

    expect(store.countBySession('sess-A')).toBe(2);
    expect(store.countBySession('sess-B')).toBe(1);
  });

  const makeMsg = (id: string, content: string, createdAt: string): MemoryEvent =>
    makeEvent({ id, created_at: createdAt, payload: { role: 'user', content } });

  it('getRecentBySession: 按时间窗口过滤（since 之后的消息）', () => {
    store.insert(makeMsg('e-old', '旧消息', '2026-08-02T04:00:00.000Z'));
    store.insert(makeMsg('e-new1', '新消息1', '2026-08-02T07:30:00.000Z'));
    store.insert(makeMsg('e-new2', '新消息2', '2026-08-02T07:40:00.000Z'));

    const since = new Date('2026-08-02T07:00:00.000Z');
    const recent = store.getRecentBySession('sess-001', 20, since);
    expect(recent.map(r => r.content)).toEqual(['新消息1', '新消息2']);
  });

  it('getRecentBySession: 时间窗口 + limit 上限', () => {
    store.insert(makeMsg('e1', 'm1', '2026-08-02T07:00:00.000Z'));
    store.insert(makeMsg('e2', 'm2', '2026-08-02T07:10:00.000Z'));
    store.insert(makeMsg('e3', 'm3', '2026-08-02T07:20:00.000Z'));

    const since = new Date('2026-08-02T07:00:00.000Z');
    const recent = store.getRecentBySession('sess-001', 2, since);
    expect(recent).toHaveLength(2);
    expect(recent[recent.length - 1].content).toBe('m3'); // 时间升序
  });

  it('getRecentBySession: 无 since 时保持纯数量限制（向后兼容）', () => {
    store.insert(makeMsg('e1', 'm1', '2026-08-02T07:00:00.000Z'));
    store.insert(makeMsg('e2', 'm2', '2026-08-02T07:10:00.000Z'));
    store.insert(makeMsg('e3', 'm3', '2026-08-02T07:20:00.000Z'));

    const recent = store.getRecentBySession('sess-001', 2);
    expect(recent).toHaveLength(2);
    expect(recent.map(r => r.content)).toEqual(['m2', 'm3']); // 最新 2 条（时间升序）
  });
});

describe('EventStore — 8-09 归档/检索支持', () => {
  let db: Database.Database;
  let store: EventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new EventStore(db);
  });

  afterEach(() => db.close());

  it('getActiveSessions：since 之后有消息的 session 去重返回', () => {
    const mk = (id: string, sid: string, at: string) => ({
      id, session_id: sid, source: 'chat', type: 'message', payload: { role: 'user', content: 'x' },
      importance: 0.5, created_at: at, processed: 0,
    });
    store.insert(mk('e1', 'sess-a', '2026-08-09T08:00:00.000Z'));
    store.insert(mk('e2', 'sess-a', '2026-08-09T09:00:00.000Z'));
    store.insert(mk('e3', 'sess-b', '2026-08-08T00:00:00.000Z'));
    const active = store.getActiveSessions(new Date('2026-08-09T00:00:00.000Z'));
    expect(active).toEqual(['sess-a']); // sess-b 在 since 前，sess-a 去重
  });

  it('searchByVector：委托 vectorStore 且按 source=chat 过滤', async () => {
    const vectorStore = { search: vi.fn().mockResolvedValue([{ id: 'x', text: 't', score: 0.9 }]) };
    const s = new EventStore(db, vectorStore as any);
    const r = await s.searchByVector([0.1], 3);
    expect(vectorStore.search).toHaveBeenCalledWith([0.1], 3, { source: 'chat' });
    expect(r).toHaveLength(1);
  });

  it('无 vectorStore → 空结果（不炸）', async () => {
    expect(await store.searchByVector([0.1], 3)).toEqual([]);
  });
});

// ★ KI-12（change: fix-store-write-trace）：Event Log 是不可变的 —— 同 id 重投
//   （QQ 重连 / dsh 重传）必须是幂等空转或响亮冲突，禁止静默覆盖状态列。
describe('EventStore — KI-12 同 id 重投不可变语义', () => {
  let db: Database.Database;
  let store: EventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new EventStore(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  const makeEvent = (overrides: Partial<MemoryEvent> = {}): MemoryEvent => ({
    id: 'evt-dup',
    session_id: 'sess-dup',
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content: 'hello' },
    importance: 0.5,
    created_at: '2026-06-28T10:00:00Z',
    processed: 0,
    ...overrides,
  });

  const rowOf = (id: string) =>
    db.prepare('SELECT archived, processed, importance, created_at, payload FROM events WHERE id = ?')
      .get(id) as { archived: number; processed: number; importance: number; created_at: string; payload: string } | undefined;

  /** 主症：QQ 重连重投软删除会话的事件 → archived 被 INSERT OR REPLACE 回落 0（会话复活） */
  it('同 id 同内容重投：不复活软删除会话（archived 仍为 1）', () => {
    const event = makeEvent();
    store.insert(event);
    store.archiveBySession('sess-dup');
    expect(rowOf('evt-dup')!.archived).toBe(1); // 前置：归档确实生效

    store.insert(event); // 同 id 同内容重投

    expect(rowOf('evt-dup')!.archived).toBe(1);
  });

  /** 主症：processed / importance / created_at 一概不许被重投改写 */
  it('同 id 同内容重投：processed / importance / created_at 均不变', () => {
    store.insert(makeEvent({ importance: 0.5, created_at: '2026-06-28T10:00:00Z' }));
    store.markProcessed('evt-dup', PROCESSED_PROFILE);
    store.updateImportance('evt-dup', 0.9);

    // 重投带不同元数据 —— 但 payload 相同（= 同内容），状态列一律不许改
    store.insert(makeEvent({ importance: 0.1, created_at: '2026-07-01T00:00:00Z', processed: 0 }));

    const row = rowOf('evt-dup')!;
    expect(row.processed & PROCESSED_PROFILE).toBeTruthy(); // 不许归 0（否则再摘要 + 再画像提取）
    expect(row.importance).toBeCloseTo(0.9);                // 不许清掉 LLM 打的分数
    expect(row.created_at).toBe('2026-06-28T10:00:00Z');    // 不许挪出摘要窗口
  });

  it('同 id 不同内容重投：保留原事件 + logger.warn 报冲突（含 id 与 session）', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    store.insert(makeEvent({ payload: { role: 'user', content: '原始内容' } }));
    store.insert(makeEvent({ payload: { role: 'user', content: '重投内容' } }));

    expect(JSON.parse(rowOf('evt-dup')!.payload).content).toBe('原始内容'); // 禁止静默覆盖
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('evt-dup');
    expect(logged).toContain('sess-dup');
  });

  it('同 id 不同内容重投：冲突时不改任何状态列', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    store.insert(makeEvent({ importance: 0.5, created_at: '2026-06-28T10:00:00Z' }));
    store.markProcessed('evt-dup', PROCESSED_PROFILE);

    store.insert(makeEvent({
      payload: { role: 'user', content: '重投内容' },
      importance: 0.99,
      created_at: '2026-09-01T00:00:00Z',
      processed: 0,
    }));

    const row = rowOf('evt-dup')!;
    expect(row.processed & PROCESSED_PROFILE).toBeTruthy();
    expect(row.importance).toBeCloseTo(0.5);
    expect(row.created_at).toBe('2026-06-28T10:00:00Z');
  });

  it('payload 键序不同不算内容不同（归一化比较，不误报冲突）', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    store.insert(makeEvent({ payload: { role: 'user', content: 'x' } }));

    store.insert(makeEvent({ payload: { content: 'x', role: 'user' } }));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(JSON.parse(rowOf('evt-dup')!.payload)).toEqual({ role: 'user', content: 'x' });
  });

  it('新 id：正常插入（回归，archived 走表默认 0）', () => {
    store.insert(makeEvent({ id: 'evt-brand-new', session_id: 'sess-new' }));

    const row = rowOf('evt-brand-new')!;
    expect(row.archived).toBe(0);
    expect(row.processed).toBe(0);
    expect(store.getById('evt-brand-new')).not.toBeNull();
    expect(store.countBySession('sess-new')).toBe(1);
  });

  it('新 id 且与既有行不同：两条都在（互不影响）', () => {
    store.insert(makeEvent({ id: 'e1', payload: { role: 'user', content: 'a' } }));
    store.insert(makeEvent({ id: 'e2', payload: { role: 'user', content: 'b' } }));
    expect(store.countBySession('sess-dup')).toBe(2);
  });
});
