import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import { localDateKey, localDateKeyFromISO } from '../../src/utils/time.js';

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

  it('getLifeEventInjection 时区边界：本地 0 点前的 UTC 事件归"今天" + 本地时间显示', () => {
    vi.useFakeTimers();
    try {
      // 用本地构造器设置"现在"，任何时区下 localDateKey 都是 2026-08-07
      vi.setSystemTime(new Date(2026, 7, 7, 2, 0, 0));
      expect(localDateKey()).toBe('2026-08-07');
      // 北京时区：UTC 2026-08-06T16:30:00Z = 本地 8-07 00:30（UTC 日期仍是前一天）
      expect(localDateKeyFromISO('2026-08-06T16:30:00Z')).toBe('2026-08-07');
      mm.lifeStore.addEvent({
        id: 'tz-boundary', createdAt: '2026-08-06T16:30:00Z',
        type: 'chat', content: '午夜事件',
      });
      const inj = mm.getLifeEventInjection();
      // 旧实现会因 '2026-08-06T16:30:00Z' < '2026-08-07T00:00:00' 字符串比较漏掉该事件，
      // 且时间显示为 16:30（UTC 切片）
      expect(inj).toContain('- 今天 00:30 午夜事件');
      expect(inj).not.toContain('16:30');
    } finally {
      vi.useRealTimers();
    }
  });

  it('privacy readonly: assembleWithWorldbook 不含 [我的近期日常]，reset 后恢复', async () => {
    mm.recordLifeEvent({ type: 'chat', content: '在阳台看书' });
    expect(mm.getLifeEventInjection()).toContain('[我的近期日常]');

    // readonly：只注入角色设定，生活事件流不注入
    mm.setPrivacyMode('readonly');
    const minimal = await mm.assembleWithWorldbook('chat', [], []);
    expect(minimal).not.toContain('[我的近期日常]');

    // 会话结束 reset 后恢复完整注入
    mm.resetPrivacyMode();
    const normal = await mm.assembleWithWorldbook('chat', [], []);
    expect(normal).toContain('[我的近期日常]');
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
