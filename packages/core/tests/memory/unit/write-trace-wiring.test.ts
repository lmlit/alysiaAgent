// tests/memory/unit/write-trace-wiring.test.ts
// ★ 2026-10-02 change: observe-zero-row-writes
//
// 这组用例守的是「**只观测，不拦截**」这条约束本身：
// 目标行不存在时（0 行 / 空转），必须
//   ① 留下 `[WriteTrace]` 痕迹（否则分布收集不到 → 决策没有依据）
//   ② **函数照常返回、不抛**（一旦这里变成抛错，就是把"观测"偷偷升级成了"校验"）
//
// 换句话说：本文件的断言同时锁死了"夹带逻辑改动"这个最常见的走样方式。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { LifeStore } from '../../../src/memory/stores/LifeStore';
import { logger } from '../../../src/utils/logger';

/** 抓本轮所有 [WriteTrace] 日志 */
function captureTrace(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(logger, 'warn').mockImplementation((msg: string) => {
    if (String(msg).includes('[WriteTrace]')) lines.push(String(msg));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('零行观测接线：只观测不拦截', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('WorldbookStore.recordTrigger：目标行不存在 → 留痕，且不抛', () => {
    const { lines, restore } = captureTrace();
    const store = new WorldbookStore(db);

    expect(() => store.recordTrigger('no-such-entry')).not.toThrow();

    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WorldbookStore.recordTrigger');
  });

  it('WorldbookStore.updateEntry：目标行不存在 → 留痕，且不抛', () => {
    const { lines, restore } = captureTrace();
    const store = new WorldbookStore(db);

    expect(() => store.updateEntry('no-such-entry', { priority: 5 })).not.toThrow();

    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WorldbookStore.updateEntry');
  });

  it('WorldbookStore.deleteEntry：目标行不存在 → 留痕，且不抛', () => {
    const { lines, restore } = captureTrace();
    const store = new WorldbookStore(db);

    expect(() => store.deleteEntry('no-such-entry')).not.toThrow();

    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WorldbookStore.deleteEntry');
  });

  it('LifeStore.markDelivered：目标行不存在 → 留痕，且不抛（KI-11 最危险的那个）', () => {
    const { lines, restore } = captureTrace();
    const store = new LifeStore(db);

    expect(() => store.markDelivered('no-such-life-event')).not.toThrow();

    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('LifeStore.markDelivered');
  });

  // ★ 反向保护：0 行不是唯一路径 —— 真正改到行时**绝不能**留痕，
  //   否则每次启动都会刷噪声，比不观测更糟。
  it('真正改到时不留痕（观测不能变成噪声）', () => {
    const store = new WorldbookStore(db);
    store.insert({
      id: 'wb-real',
      trigger_keys: JSON.stringify(['测试']),
      trigger_mode: 'any',
      content: '内容',
      scope: 'chat',
      priority: 0,
      cooldown_sec: 0,
      last_triggered: null,
      hit_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      role: 'alysia',
      content_type: 'text',
      source: 'seed',
    } as any);

    const { lines, restore } = captureTrace();
    store.recordTrigger('wb-real');
    restore();

    expect(lines).toHaveLength(0);
  });
});
