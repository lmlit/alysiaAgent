// tests/memory/unit/EventStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../../../src/memory/stores/EventStore';
import { initializeDatabase } from '../../../src/memory/database';
import type { MemoryEvent } from '../../../src/memory/types';
import { PROCESSED_PROFILE } from '../../../src/memory/types';

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
});
