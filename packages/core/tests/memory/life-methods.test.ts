import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';

function makeManager(db: Database.Database): MemoryManager {
  const embedService = { embed: async () => [0], dimension: () => 1024 };
  const llmService = { complete: async () => '{}' };
  return new MemoryManager(db as any, null, embedService as any, llmService as any);
}

describe('MemoryManager life methods', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('getLifeSnapshot returns defaults', () => {
    const s = mm.getLifeSnapshot();
    expect(s.intimacy).toBe(30);
    expect(s.currentActivity).toBe('');
  });

  it('recordLifeEvent stores event and updates activity', () => {
    mm.recordLifeEvent({ type: 'chat', content: '在阳台看书，看到一朵像兔子的云' });
    const s = mm.getLifeSnapshot();
    expect(s.currentActivity).toBe('在阳台看书，看到一朵像兔子的云');
  });

  it('getLifeEventInjection returns today events + summaries, empty block when nothing', () => {
    expect(mm.getLifeEventInjection()).toBe('');
    mm.recordLifeEvent({ type: 'chat', content: '在阳台看书' });
    const inj = mm.getLifeEventInjection();
    expect(inj).toContain('[我的近期日常]');
    expect(inj).toContain('在阳台看书');
  });

  it('getWorldbookSample returns active role entries', () => {
    // seed 一条世界书
    const wb = db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES ('wb-test', '["测试"]', 'any', '测试设定内容', 'chat', 10, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'text')`);
    wb.run();
    const sample = mm.getWorldbookSample(5);
    expect(sample.some(x => x.content === '测试设定内容')).toBe(true);
  });

  it('getUserActivitySummary returns facts or empty', () => {
    expect(mm.getUserActivitySummary()).toBe('');
    const p = db.prepare("SELECT * FROM user_profile WHERE id = 1");
    const row = p.get() as any;
    const facts = JSON.parse(row.facts);
    facts.push({ fact: '用户喜欢看小说', confidence: 0.9, source: 'user', status: 'active' });
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify(facts));
    expect(mm.getUserActivitySummary()).toContain('看小说');
  });
});
