import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';

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
