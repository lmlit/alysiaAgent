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
  it('今天超过 2 条事件 → 只注入最近 2 条（★ 8-28 微叙事适配，原 3 条）', () => {
    for (let i = 1; i <= 5; i++) {
      mm.lifeStore.addEvent({
        id: `e${i}`, createdAt: new Date(Date.now() + i * 1000).toISOString(), // 递增时间
        type: 'chat', content: `事件${i}`,
      });
    }
    const inj = mm.getLifeEventInjection();
    expect(inj).toContain('事件5');
    expect(inj).toContain('事件4');
    expect(inj).not.toContain('事件3'); // 最旧的被截断
    expect(inj).not.toContain('事件2');
    expect(inj).not.toContain('事件1');
    // 倒序：事件5 在 事件4 前
    expect(inj.indexOf('事件5')).toBeLessThan(inj.indexOf('事件4'));
  });

  // ★ 8-12 窗口外补叙（life-offline-recap）：昨天 internal 事件注入最近 2 条
  it('昨天 3 条 internal → 只注入最近 2 条（跨天补叙）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 7, 12, 12, 0, 0)); // 本地 8-12 中午
      const yesterday = (h: number, m: number) =>
        new Date(2026, 7, 11, h, m).toISOString();
      for (let i = 1; i <= 3; i++) {
        mm.lifeStore.addEvent({
          id: `y${i}`, createdAt: yesterday(8 + i, 30), type: 'internal', content: `深夜事件${i}`,
        });
      }
      const inj = mm.getLifeEventInjection();
      expect(inj).toContain('深夜事件3');
      expect(inj).toContain('深夜事件2');
      expect(inj).not.toContain('深夜事件1'); // 最旧的昨天事件不补叙
      expect(inj).toContain('昨天 '); // 带昨天时间戳格式
    } finally {
      vi.useRealTimers();
    }
  });

  it('昨天 chat 类型事件不补叙（只补 internal 独处事件）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 7, 12, 12, 0, 0));
      mm.lifeStore.addEvent({
        id: 'y-chat', createdAt: new Date(2026, 7, 11, 20, 0).toISOString(),
        type: 'chat', content: '昨天的推送事件',
      });
      const inj = mm.getLifeEventInjection();
      expect(inj).not.toContain('昨天的推送事件'); // chat 已推送过，不补
    } finally {
      vi.useRealTimers();
    }
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

  // ★ 8-12 二期④：life_event 种子纳入采样
  // ★ 8-27 分层随机（life-worldbook-layered-sample）：life_event 取 3 + text 取 2，随机抽取
  it('getWorldbookSample 纳入 content_type=life_event 的事件种子（8-27 起随机抽取不再按 priority 排序）', () => {
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES ('wb-life', '[""]', 'any', '昔涟会在集市买桃子', 'chat', 20, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'life_event')`).run();
    const sample = mm.getWorldbookSample(5);
    expect(sample.some(x => x.content === '昔涟会在集市买桃子')).toBe(true);
  });

  // ★ 8-27 分层随机：life_event 3 + text 2，总量=5
  it('getWorldbookSample 分层：life_event 3 条 + text 2 条', () => {
    const ins = db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES (?, '[""]', 'any', ?, 'chat', 5, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', ?)`);
    for (let i = 1; i <= 4; i++) ins.run(`wb-life-${i}`, `生活条目${i}`, 'life_event');
    for (let i = 1; i <= 3; i++) ins.run(`wb-text-${i}`, `设定条目${i}`, 'text');
    const sample = mm.getWorldbookSample(5);
    expect(sample).toHaveLength(5);
    const life = sample.filter(x => x.id.startsWith('wb-life'));
    const text = sample.filter(x => x.id.startsWith('wb-text'));
    expect(life).toHaveLength(3);
    expect(text).toHaveLength(2);
  });

  // ★ 8-27 截断 200 字（原 100 字）
  it('getWorldbookSample 每条截断 200 字', () => {
    const long = '生'.repeat(300);
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES ('wb-long', '[""]', 'any', ?, 'chat', 5, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'life_event')`).run(long);
    const sample = mm.getWorldbookSample(5);
    const item = sample.find(x => x.id === 'wb-long');
    expect(item!.content.length).toBe(200);
  });

  // ★ 8-27 digest 简介优先（worldbook-digest-summary）：有 digest 返回 digest，无则回落截断
  it('getWorldbookSample digest 优先：text 条目有 digest → 返回 digest', () => {
    const longContent = '很长很长的设定正文'.repeat(30);
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type, digest)
      VALUES ('wb-digest', '[""]', 'any', ?, 'chat', 5, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'text', ?)`).run(longContent, '白厄是昔涟从小一起长大的发小，两人相识于哀丽秘榭');
    const sample = mm.getWorldbookSample(5);
    const item = sample.find(x => x.id === 'wb-digest');
    expect(item!.content).toBe('白厄是昔涟从小一起长大的发小，两人相识于哀丽秘榭');
  });

  it('getWorldbookSample 无 digest → 回落截断正文 200 字', () => {
    const long = '设'.repeat(300);
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES ('wb-raw', '[""]', 'any', ?, 'chat', 5, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'text')`).run(long);
    const sample = mm.getWorldbookSample(5);
    const item = sample.find(x => x.id === 'wb-raw');
    expect(item!.content.length).toBe(200);
  });

  it('getWorldbookSample digest 为空串 → 回落截断正文', () => {
    db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type, digest)
      VALUES ('wb-empty-digest', '[""]', 'any', '设定正文内容', 'chat', 5, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'text', '')`).run();
    const sample = mm.getWorldbookSample(5);
    const item = sample.find(x => x.id === 'wb-empty-digest');
    expect(item!.content).toBe('设定正文内容');
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
