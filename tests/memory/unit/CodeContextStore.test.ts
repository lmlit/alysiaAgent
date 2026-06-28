// tests/memory/unit/CodeContextStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CodeContextStore } from '../../../src/memory/stores/CodeContextStore';
import { initializeDatabase } from '../../../src/memory/database';
import type { CodeContext } from '../../../src/memory/types';

describe('CodeContextStore', () => {
  let db: Database.Database;
  let store: CodeContextStore;

  const makeCtx = (overrides: Partial<CodeContext> = {}): CodeContext => ({
    id: 'ctx-1',
    project_name: 'alysiaAgent',
    project_path: '/work/alysiaAgent',
    tech_stack: '{"lang":"typescript","runtime":"node"}',
    architecture_notes: 'Electron + agent core',
    recent_changes: '[]',
    decisions: '[]',
    is_active: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new CodeContextStore(db);
  });

  afterEach(() => db.close());

  it('should upsert and retrieve active context', () => {
    store.upsert(makeCtx());
    const ctx = store.getActive();
    expect(ctx).not.toBeNull();
    expect(ctx!.project_name).toBe('alysiaAgent');
  });

  it('should return null if no active context', () => {
    expect(store.getActive()).toBeNull();
  });

  it('should deactivate old context when upserting with same id', () => {
    store.upsert(makeCtx({ id: 'ctx-1' }));
    store.deactivate('ctx-1');
    expect(store.getActive()).toBeNull();
  });

  it('should add decisions', () => {
    store.upsert(makeCtx({ id: 'ctx-1' }));
    store.addDecision('ctx-1', { decision: 'use better-sqlite3', reason: 'sync API', date: '2026-06-28' });
    const ctx = store.getById('ctx-1');
    const decisions = JSON.parse(ctx!.decisions);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('use better-sqlite3');
  });

  it('should update recent changes', () => {
    store.upsert(makeCtx({ id: 'ctx-1' }));
    store.updateRecentChanges('ctx-1', JSON.stringify(['added EventStore', 'added ProfileStore']));
    const ctx = store.getById('ctx-1');
    expect(JSON.parse(ctx!.recent_changes)).toHaveLength(2);
  });
});
