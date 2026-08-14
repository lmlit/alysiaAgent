// ★ 8-14 lookup_worldbook 实时化（content-self-evolution）：写入后立即可查
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createWorldbookTool } from '../../src/tools/worldbook';
import { initializeDatabase } from '../../src/memory/database';

describe('lookup_worldbook 实时查询', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES ('wb-seed', '["白厄"]', 'any', '白厄是黄金裔之首', 'chat', 10, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'text')`).run();
  });

  afterEach(() => db.close());

  it('seed 条目可查', async () => {
    const tool = createWorldbookTool(db);
    const result = await tool.handler({ keyword: '白厄' });
    expect(result).toContain('白厄是黄金裔之首');
  });

  it('★ 实时性：工具创建后写入的新条目，立即可查（原启动冻结查不到）', async () => {
    const tool = createWorldbookTool(db);
    // 工具创建后才插入的新条目（模拟昔涟自写）
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type, source)
      VALUES ('wb_self_1', '["发光花"]', 'any', '以前在阳台上养过一盆会发光的小花', 'chat', 3, 0, NULL, 0, '2026-08-14T00:00:00', '2026-08-14T00:00:00', 'alysia', 'text', 'self')`).run();
    const result = await tool.handler({ keyword: '发光' });
    expect(result).toContain('会发光的小花');
  });

  it('无匹配 → 提示未找到 + 候选关键词', async () => {
    const tool = createWorldbookTool(db);
    const result = await tool.handler({ keyword: '不存在的词' });
    expect(result).toContain('未找到');
  });
});
