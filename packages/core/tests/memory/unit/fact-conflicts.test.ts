/**
 * ★ 2026-10-28（change: `resolve-fact-conflicts`）
 *
 * ProfileStore 的写入分流与裁决：
 *   - user 明确陈述 → 立即覆盖；
 *   - 推断/行为冲突 → 入队，旧条保持 active；
 *   - 旧条来自 user、新条是推断 → 丢弃（不拿推断反问）；
 *   - keep old/new 都改对，且 basics 标 stale。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import type { ProfileFact } from '../../../src/memory/types';

const NOW = '2026-10-01T00:00:00.000Z';

function fact(text: string, source: ProfileFact['source'], extra: Partial<ProfileFact> = {}): ProfileFact {
  return {
    fact: text,
    confidence: 0.8,
    evidence: `证据：${text}`,
    source_event: 'evt-1',
    updated_at: NOW,
    source,
    valid_from: NOW,
    valid_until: null,
    status: 'active',
    category: 'identity',
    ...extra,
  };
}

describe('ProfileStore — 事实冲突候选', () => {
  let db: Database.Database;
  let store: ProfileStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ProfileStore(db);
  });

  afterEach(() => db.close());

  const seedOld = (source: ProfileFact['source']) => store.addFacts([fact('用户在长沙', source)]);

  it('inferred 冲突 → 旧条 active、新条不激活、候选入队', () => {
    seedOld('inferred');
    const added = store.addFacts([
      fact('用户在杭州', 'inferred', { conflicts_with: '用户在长沙' }),
    ]);
    expect(added).toHaveLength(0);
    expect(store.getCurrentFacts().map(f => f.fact)).toEqual(['用户在长沙']);
    const pending = store.listPendingConflicts(5);
    expect(pending).toHaveLength(1);
    expect(pending[0].old_fact).toBe('用户在长沙');
    expect(pending[0].new_fact).toBe('用户在杭州');
  });

  it('user 明确冲突 → 立即覆盖，不入队', () => {
    seedOld('user');
    const added = store.addFacts([
      fact('用户在杭州', 'user', { conflicts_with: '用户在长沙' }),
    ]);
    expect(added).toHaveLength(1);
    expect(store.getCurrentFacts().map(f => f.fact)).toEqual(['用户在杭州']);
    expect(store.listPendingConflicts(5)).toHaveLength(0);
    expect(store.getAllFacts().find(f => f.fact === '用户在长沙')?.status).toBe('superseded');
  });

  it('旧条 user、新条 inferred → 丢弃，不入队', () => {
    seedOld('user');
    const added = store.addFacts([
      fact('用户在杭州', 'inferred', { conflicts_with: '用户在长沙' }),
    ]);
    expect(added).toHaveLength(0);
    expect(store.listPendingConflicts(5)).toHaveLength(0);
    expect(store.getCurrentFacts()).toHaveLength(1);
  });

  it('keep=new → 旧 superseded、新 active + confirmed_at', () => {
    seedOld('inferred');
    store.addFacts([fact('用户在杭州', 'inferred', { conflicts_with: '用户在长沙' })]);
    const c = store.listPendingConflicts(1)[0];

    const r = store.resolveFactConflict(c.id, 'new');
    expect(r.ok).toBe(true);

    const all = store.getAllFacts();
    expect(all.find(f => f.fact === '用户在长沙')?.status).toBe('superseded');
    const active = all.find(f => f.fact === '用户在杭州');
    expect(active?.status).toBe('active');
    expect(active?.confirmed_at).toBeTruthy();
    expect(store.getConflictStats().kept_new).toBe(1);
  });

  it('keep=old → 旧条续期、候选丢弃', () => {
    seedOld('inferred');
    store.addFacts([fact('用户在杭州', 'inferred', { conflicts_with: '用户在长沙' })]);
    const c = store.listPendingConflicts(1)[0];

    const before = store.getCurrentFacts()[0].valid_until;
    const r = store.resolveFactConflict(c.id, 'old');
    expect(r.ok).toBe(true);
    expect(store.getCurrentFacts().map(f => f.fact)).toEqual(['用户在长沙']);
    expect(store.getCurrentFacts()[0].valid_until).not.toBe(before);
    expect(store.getConflictStats().kept_old).toBe(1);
  });

  it('用户用第三个值取代旧条 → 旧候选自动失效，不再问', () => {
    seedOld('inferred');
    store.addFacts([fact('用户在杭州', 'inferred', { conflicts_with: '用户在长沙' })]);
    expect(store.listPendingConflicts(5)).toHaveLength(1);

    store.addFacts([fact('用户在成都', 'user', { conflicts_with: '用户在长沙' })]);
    expect(store.getCurrentFacts().map(f => f.fact)).toEqual(['用户在成都']);
    expect(store.listPendingConflicts(5)).toHaveLength(0);
    expect(store.getConflictStats().expired).toBe(1);
  });

  it('重复同一对冲突只累加，不重复入队', () => {
    seedOld('inferred');
    store.addFacts([fact('用户在杭州', 'inferred', { conflicts_with: '用户在长沙' })]);
    store.addFacts([fact('用户在杭州', 'inferred', { conflicts_with: '用户在长沙' })]);
    const pending = store.listPendingConflicts(5);
    expect(pending).toHaveLength(1);
    expect(pending[0].occurrences).toBe(2);
  });
});
