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

  // ★ 8-12 主提示词瘦身（life-prompt-slim）：今天事件只注入最近 3 条
  it('今天超过 3 条事件 → 只注入最近 3 条（倒序）', () => {
    for (let i = 1; i <= 5; i++) {
      mm.lifeStore.addEvent({
        id: `e${i}`, createdAt: new Date(Date.now() + i * 1000).toISOString(), // 递增时间
        type: 'chat', content: `事件${i}`,
      });
    }
    const inj = mm.getLifeEventInjection();
    expect(inj).toContain('事件5');
    expect(inj).toContain('事件4');
    expect(inj).toContain('事件3');
    expect(inj).not.toContain('事件2'); // 最旧的被截断
    expect(inj).not.toContain('事件1');
    // 倒序：事件5 在 事件4 前
    expect(inj.indexOf('事件5')).toBeLessThan(inj.indexOf('事件4'));
  });

  it('注入预算：总长超 500 字 → 丢最旧摘要保事件', () => {
    mm.recordLifeEvent({ type: 'chat', content: '今天的事件细节'.repeat(30) }); // 长事件
    for (let d = 1; d <= 7; d++) {
      mm.upsertDailySummary(`2026-08-${String(d).padStart(2, '0')}`, '摘要'.repeat(40));
    }
    const inj = mm.getLifeEventInjection();
    expect(inj).toContain('今天的事件细节'); // 事件保留
    expect(inj.length).toBeLessThanOrEqual(550); // 预算附近
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

  it('getWorldbookSample 返回含 id 的结构（终审修复：生成器引用 + 命中统计）', () => {
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES ('wb-test', '["测试"]', 'any', '测试设定内容', 'chat', 10, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'text')`).run();
    const sample = mm.getWorldbookSample(5);
    expect(sample).toEqual([{ id: 'wb-test', content: '测试设定内容' }]);
  });

  it('bumpWorldbookHit 递增 hit_count + 记录 last_triggered（spec §7 ②）', () => {
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES ('wb-test', '["测试"]', 'any', '测试设定内容', 'chat', 10, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'text')`).run();
    mm.bumpWorldbookHit('wb-test');
    mm.bumpWorldbookHit('wb-test');
    const row = db.prepare('SELECT hit_count, last_triggered FROM worldbook_entries WHERE id = ?').get('wb-test') as any;
    expect(row.hit_count).toBe(2);
    expect(row.last_triggered).toBeTruthy();
  });

  it('recordLifeEvent 返回事件 id，wbEntryId/referenceEventId 透传入库（终审修复）', () => {
    const id = mm.recordLifeEvent({ type: 'chat', content: '在阳台看书', wbEntryId: 'wb-test', referenceEventId: 'life-0' });
    expect(id.startsWith('life-')).toBe(true);
    const events = mm.listLifeEvents(2);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(id);
    expect(events[0].wbEntryId).toBe('wb-test');
    expect(events[0].referenceEventId).toBe('life-0');
  });

  it('markLifeEventDelivered 置 delivered=1（终审修复：markDelivered 接线）', () => {
    const id = mm.recordLifeEvent({ type: 'chat', content: '在阳台看书' });
    expect(mm.listLifeEvents(2)[0].delivered).toBe(0);
    mm.markLifeEventDelivered(id);
    expect(mm.listLifeEvents(2)[0].delivered).toBe(1);
  });

  it('listLifeSummaries 返回近 7 天摘要（旧 → 新）', () => {
    mm.upsertDailySummary('2026-08-06', '下雨听雨');
    mm.upsertDailySummary('2026-08-05', '在旧书店待了一下午');
    expect(mm.listLifeSummaries(7)).toEqual([
      { date: '2026-08-05', summary: '在旧书店待了一下午' },
      { date: '2026-08-06', summary: '下雨听雨' },
    ]);
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
