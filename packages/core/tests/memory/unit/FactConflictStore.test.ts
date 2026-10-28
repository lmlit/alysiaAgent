/**
 * ★ 2026-10-28（change: `resolve-fact-conflicts`）
 *
 * 冲突候选队列的边界：去重、冷却、过期、裁决、上限。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';
import {
  FactConflictStore,
  FACT_CONFLICT_ASK_COOLDOWN_MS,
  FACT_CONFLICT_MAX_ASKS,
  FACT_CONFLICT_MAX_PENDING,
  FACT_CONFLICT_TTL_MS,
} from '../../../src/memory/stores/FactConflictStore';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');

function input(n: number) {
  return {
    old_fact_key: '用户在长沙',
    old_fact: '用户在长沙',
    old_source: 'user',
    old_confidence: 0.9,
    new_fact_key: `用户在杭州${n}`,
    new_fact: `用户在杭州${n}`,
    new_source: 'inferred',
    new_confidence: 0.6,
    new_category: 'identity',
    evidence: '最近提到杭州',
  };
}

describe('FactConflictStore', () => {
  let db: Database.Database;
  let store: FactConflictStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new FactConflictStore(db);
  });

  afterEach(() => db.close());

  it('create → pending，重复同一对只累加 occurrences', () => {
    const a = store.create(input(1), T0);
    const b = store.create(input(1), T0 + 1000);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.id).toBe(b.id);
    const rows = store.listPending({ limit: 5, now: T0 + 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(2);
  });

  it('markAsked → 冷却内不再返回；过冷却后重新可问', () => {
    const { id } = store.create(input(1), T0);
    store.markAsked([id], T0);
    expect(store.listPending({ limit: 5, now: T0 + 1000 })).toHaveLength(0);
    expect(store.listPending({ limit: 5, now: T0 + FACT_CONFLICT_ASK_COOLDOWN_MS })).toHaveLength(1);
    expect(store.get(id)?.ask_count).toBe(1);
  });

  it('问满 maxAsks 后不再返回', () => {
    const { id } = store.create(input(1), T0);
    store.markAsked([id], T0);
    store.markAsked([id], T0 + FACT_CONFLICT_ASK_COOLDOWN_MS);
    expect(store.get(id)?.ask_count).toBe(FACT_CONFLICT_MAX_ASKS);
    expect(store.listPending({ limit: 5, now: T0 + 10 * FACT_CONFLICT_ASK_COOLDOWN_MS })).toHaveLength(0);
  });

  it('14 天未裁决 → expired', () => {
    const { id } = store.create(input(1), T0);
    store.expire(T0 + FACT_CONFLICT_TTL_MS + 1);
    expect(store.get(id)?.status).toBe('expired');
    expect(store.stats().expired).toBe(1);
  });

  it('resolve 只改冲突行，keep=new → kept_new', () => {
    const { id } = store.create(input(1), T0);
    expect(store.resolve(id, 'new', T0 + 1000)).toBe(true);
    expect(store.get(id)?.status).toBe('kept_new');
    expect(store.resolve(id, 'old', T0 + 2000)).toBe(false); // 已裁决
  });

  it('pending 上限：超过 MAX 时最旧的 expired', () => {
    for (let i = 0; i < FACT_CONFLICT_MAX_PENDING + 2; i++) {
      const row = input(i);
      row.old_fact_key = `旧${i}`;
      row.old_fact = `旧${i}`;
      store.create(row, T0 + i);
    }
    expect(store.stats().pending).toBe(FACT_CONFLICT_MAX_PENDING);
    expect(store.stats().expired).toBeGreaterThanOrEqual(2);
  });
});
