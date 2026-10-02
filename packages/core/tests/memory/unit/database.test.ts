import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase, addColumnIfMissing } from '../../../src/memory/database';

describe('Database Schema', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
  });

  afterAll(() => {
    db.close();
  });

  it('should create all tables after initialization', () => {
    initializeDatabase(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];

    const names = tables.map(t => t.name);
    expect(names).toContain('events');
    expect(names).toContain('user_profile');
    expect(names).toContain('persona');
    expect(names).toContain('conversations');
    expect(names).toContain('knowledge_docs');
    expect(names).toContain('worldbook_entries');
    expect(names).toContain('code_context');
  });

  it('should create all indexes on events table', () => {
    initializeDatabase(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events' ORDER BY name"
    ).all() as { name: string }[];

    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_events_session');
    expect(names).toContain('idx_events_created');
    expect(names).toContain('idx_events_unprocessed');
  });
});

// ★ 2026-10-02 change: fix-migration-and-logger-silent-failure
//
// 这些用例守的是「迁移失败必须可见」。原来的写法是
//   try { ALTER } catch { /* column already exists */ }
// —— 那句注释是**假设**，它把「列已存在」（正常幂等）与「锁库/磁盘满/权限」
// （迁移真失败）压成同一个静默分支，于是"库结构不对"能长期伪装成"还没有数据"。
describe('迁移：探测式幂等 + 失败必须大声', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
  });

  afterAll(() => {
    db.close();
  });

  it('重复初始化是幂等的（第二次不抛，列仍齐全）', () => {
    initializeDatabase(db);
    expect(() => initializeDatabase(db)).not.toThrow();

    const cols = db.prepare('PRAGMA table_info(persona)').all() as { name: string }[];
    const names = cols.map(c => c.name);
    // 探测式迁移加上的列必须都在
    expect(names).toContain('memory_config');
    expect(names).toContain('overlay_notes');
    expect(names).toContain('role');
    expect(names).toContain('system_prompt');
    expect(names).toContain('is_active');
  });

  it('addColumnIfMissing：列不存在时加上', () => {
    db.exec('CREATE TABLE IF NOT EXISTS _mig_test (id TEXT)');
    addColumnIfMissing(db, '_mig_test', 'added', 'ALTER TABLE _mig_test ADD COLUMN added TEXT');

    const cols = (db.prepare('PRAGMA table_info(_mig_test)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('added');
  });

  it('addColumnIfMissing：列已存在时是空操作，不抛', () => {
    expect(() =>
      addColumnIfMissing(db, '_mig_test', 'added', 'ALTER TABLE _mig_test ADD COLUMN added TEXT'),
    ).not.toThrow();
  });

  // ★ 核心：真失败不能被吞。旧写法这里会静默通过。
  it('迁移真失败 → 原样抛出（不再被裸 catch 吞掉）', () => {
    expect(() =>
      addColumnIfMissing(db, '_no_such_table', 'x', 'ALTER TABLE _no_such_table ADD COLUMN x TEXT'),
    ).toThrow();
  });

  it('表结构不对（列缺失）不会被误判为幂等跳过', () => {
    // 探测的是真实表结构，不是"猜"：不存在的列一定会被尝试加上，
    // 加不上就抛 —— 这就是"库结构不对"能立刻暴露的原因
    db.exec('CREATE TABLE IF NOT EXISTS _mig_test2 (id TEXT)');
    expect(() =>
      addColumnIfMissing(db, '_mig_test2', 'bad', 'THIS IS NOT VALID SQL'),
    ).toThrow();
  });
});
