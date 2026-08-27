// ★ 8-14 内容自进化（content-self-evolution）——MemoryManager 自写条目行为契约
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../src/memory/MemoryManager';
import { initializeDatabase } from '../../src/memory/database';
import { logger } from '../../src/utils/logger';

const embedService = { embed: async () => [0], dimension: () => 1024 };

describe('MemoryManager 内容自进化', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    // 校验器 mock：内容含"不该写" → reject，否则 write
    const llm = {
      complete: async (_sys: string, user: string) =>
        user.includes('不该写')
          ? JSON.stringify({ decision: 'reject', reason: '不是关于她自己的事' })
          : JSON.stringify({ decision: 'write', reason: '通过' }),
    };
    mm = new MemoryManager(db, null, embedService as any, llm as any);
  });

  afterEach(() => db.close());

  // ── write_worldbook ─────────────────────────────────────────

  it('校验通过 → 写入 source=self / role=alysia / scope=chat', async () => {
    const r = await mm.addWorldbookEntry({ triggerKeys: ['阳台', '发光花'], content: '以前在阳台上养过一盆会发光的小花' });
    expect(r.ok).toBe(true);
    expect(r.id).toBeTruthy();
    const row = db.prepare('SELECT * FROM worldbook_entries WHERE id = ?').get(r.id) as any;
    expect(row.source).toBe('self');
    expect(row.role).toBe('alysia');
    expect(row.scope).toBe('chat');
  });

  it('触发词为空 → 拒写', async () => {
    const r = await mm.addWorldbookEntry({ triggerKeys: [], content: '一条设定' });
    expect(r.ok).toBe(false);
  });

  it('内容超 250 字 → 拒写', async () => {
    const r = await mm.addWorldbookEntry({ triggerKeys: ['a'], content: 'x'.repeat(251) });
    expect(r.ok).toBe(false);
  });

  it('查重：content 完全重复 → 拒写', async () => {
    await mm.addWorldbookEntry({ triggerKeys: ['阳台'], content: '在阳台看书' });
    const r = await mm.addWorldbookEntry({ triggerKeys: ['阳台'], content: '在阳台看书' });
    expect(r.ok).toBe(false);
  });

  it('查重：trigger_keys 有交集 → 拒写', async () => {
    await mm.addWorldbookEntry({ triggerKeys: ['阳台', '花'], content: '在阳台养花' });
    const r = await mm.addWorldbookEntry({ triggerKeys: ['花'], content: '种了一盆花' });
    expect(r.ok).toBe(false);
  });

  it('LLM 校验 reject → 拒写且不落库', async () => {
    const r = await mm.addWorldbookEntry({ triggerKeys: ['x'], content: '轻月喜欢打游戏 不该写' });
    expect(r.ok).toBe(false);
    expect((db.prepare('SELECT COUNT(*) c FROM worldbook_entries').get() as any).c).toBe(0);
  });

  it('LLM 校验异常 → 降级拒写（宁可漏记不误记）', async () => {
    const badLlm = { complete: async () => { throw new Error('provider down'); } };
    const m2 = new MemoryManager(db, null, embedService as any, badLlm as any);
    const r = await m2.addWorldbookEntry({ triggerKeys: ['x'], content: '正常内容' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('校验失败');
  });

  it('审计日志：成功写入记 [SelfEvolve]', async () => {
    const spy = vi.spyOn(logger, 'info');
    await mm.addWorldbookEntry({ triggerKeys: ['猫'], content: '以前养过一只会说话的猫' });
    expect(spy.mock.calls.some(c => String(c[0]).includes('SelfEvolve'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('listWorldbookEntries 含 source；delete 生效', async () => {
    const { id } = await mm.addWorldbookEntry({ triggerKeys: ['猫'], content: '养过一只猫' });
    const list = mm.listWorldbookEntries();
    expect(list.length).toBe(1);
    expect(list[0].source).toBe('self');
    expect(list[0].triggerKeys).toEqual(['猫']);
    expect(mm.deleteWorldbookEntry(id)).toBe(true);
    expect(mm.deleteWorldbookEntry(id)).toBe(false);
  });

  // ── add_life_template ───────────────────────────────────────

  it('addLifeTemplate 成功 → weight=2 / source=self', async () => {
    const r = await mm.addLifeTemplate({ activity: '对着窗台上的多肉发呆', type: 'internal' });
    expect(r.ok).toBe(true);
    const row = db.prepare('SELECT * FROM life_templates WHERE id = ?').get(r.id) as any;
    expect(row.weight).toBe(2);
    expect(row.source).toBe('self');
  });

  it('addLifeTemplate 查重：activity 相同 → 拒写', async () => {
    await mm.addLifeTemplate({ activity: '对着窗台上的多肉发呆', type: 'internal' });
    const dup = await mm.addLifeTemplate({ activity: '对着窗台上的多肉发呆', type: 'internal' });
    expect(dup.ok).toBe(false);
  });

  it('addLifeTemplate LLM reject → 拒写', async () => {
    const r = await mm.addLifeTemplate({ activity: '帮轻月写周报 不该写', type: 'internal' });
    expect(r.ok).toBe(false);
  });

  it('listLifeTemplates = seed 43 条（8-27 扩容）+ 自加；delete 生效', async () => {
    expect(mm.listLifeTemplates().length).toBe(43); // seed 保底（8-14 原 8 条 → 8-27 扩容 43 条）
    const { id } = await mm.addLifeTemplate({ activity: '在窗台种薄荷', type: 'chat' });
    expect(mm.listLifeTemplates().length).toBe(44);
    expect(mm.listLifeTemplates().some(t => t.activity === '在窗台种薄荷' && t.type === 'chat')).toBe(true);
    expect(mm.deleteLifeTemplate(id)).toBe(true);
    expect(mm.listLifeTemplates().length).toBe(43);
  });
});
