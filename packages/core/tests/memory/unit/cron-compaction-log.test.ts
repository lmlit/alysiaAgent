/**
 * ★ 2026-10-20（change: `log-cron-compaction`）
 *
 * `compactOldEvents` 以前**一行日志都没有** —— "清了 300 条"与"一条都没有"
 * 在日志上完全同形。
 *
 * 补日志的同时查清了一件更重要的事：**`processed` 位在读取侧没有消费者**
 * （唯一读它的是 `getUnprocessed`，而唯一调用者是 compaction 自己；
 * 摘要/画像走 `getBySession`，**不按 processed 过滤**）。
 *
 * ⇒ 所以这一步**不是"放弃学习"**（我一度这么以为，是错的），
 *   它只是清空 `getUnprocessed` 的积压（语义卫生）。
 *   测试要把这个**真实语义**锁住，防止下一个人又照着名字想象它的作用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';
import { EventStore } from '../../../src/memory/stores/EventStore';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore';
import { KnowledgeStore } from '../../../src/memory/stores/KnowledgeStore';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import { CronProcessor } from '../../../src/memory/processors/CronProcessor';
import { logger } from '../../../src/utils/logger';
import type { MemoryEvent } from '../../../src/memory/types';

const DAY = 86_400_000;

describe('CronProcessor.compactOldEvents —— 留痕与真实语义', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let cron: CronProcessor;
  let infoSpy: any;
  let warnSpy: any;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    eventStore = new EventStore(db);
    cron = new CronProcessor(
      eventStore,
      new ConversationStore(db, null),
      new KnowledgeStore(db, null),
      new ProfileStore(db),
      { extract: async () => ({ facts: [] }) } as any,
      { complete: async () => '深度画像' } as any,
      null, // vectorStore：不测向量
    );
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  const ev = (id: string, ageDays: number, processed = 0): MemoryEvent => ({
    id,
    session_id: 's1',
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content: `内容 ${id}` },
    importance: 0.5,
    created_at: new Date(Date.now() - ageDays * DAY).toISOString(),
    processed,
  });

  it('★ 有积压 ⇒ 打一条 info，含条数与最老天数（以前完全静默）', async () => {
    eventStore.insert(ev('old-1', 30));
    eventStore.insert(ev('old-2', 10));
    eventStore.insert(ev('fresh', 1));

    const marked = await (cron as any).compactOldEvents();

    expect(marked).toBe(2);
    const line = infoSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(line).toContain('compaction');
    expect(line).toContain('2 条');
    expect(line).toMatch(/最老 \d+ 天前/);
    // ★ 必须写明真实语义：不影响摘要/画像
    expect(line).toContain('getBySession');
  });

  it('★ 真实语义：被 compaction 标记的事件**仍然进得了摘要窗口**（getBySession 不筛 processed）', async () => {
    eventStore.insert(ev('old-1', 30));
    await (cron as any).compactOldEvents();

    // 标记后 processed != 0
    expect(eventStore.getById('old-1')!.processed).not.toBe(0);
    // 但摘要窗口照样能读到它 —— 这就是"不是放弃学习"的证据
    const inWindow = eventStore.getBySession('s1');
    expect(inWindow.map(e => e.id)).toContain('old-1');
  });

  it('没有积压 ⇒ 不打 info（用 debug，别刷屏）', async () => {
    eventStore.insert(ev('fresh', 1));
    const marked = await (cron as any).compactOldEvents();
    expect(marked).toBe(0);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('积压 >500 ⇒ 额外 warn（提示可能停机过）', async () => {
    for (let i = 0; i < 501; i++) eventStore.insert(ev(`old-${i}`, 20));
    const marked = await (cron as any).compactOldEvents();
    expect(marked).toBe(501);
    const warned = warnSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(warned).toContain('501');
  });

  it('已经 processed 的事件不再重复计入', async () => {
    eventStore.insert(ev('done', 30, 2)); // 已有摘要位
    const marked = await (cron as any).compactOldEvents();
    expect(marked).toBe(0);
  });
});
