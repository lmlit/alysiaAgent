/**
 * ★ 2026-10-20（change: `fix-memory-knob-regression`，B4）
 *
 * 记忆旋钮（`memory_config`）与人格参数**共用同一套护栏**——但"共用"之前是假的：
 * 24h 回归一律「回到 0」，而记忆旋钮的默认值**不是 0**。
 *
 * 后果不是"没回归"，是**单向漂移**（每次 stale 往极端挪 0.05，没有界线）：
 *   - `decay_rate → 0` = **永不遗忘**（语义 0 就是"不忘"）
 *   - `importance_threshold → 0` = **什么都记**
 *   - `retention_bias → 0` = 不再有"微微偏向正面"的性格
 *
 * 第二个洞：最终值走通用 `clamp(-1, 1)`，于是 `decay_rate` 能被调成**负数**，
 * 而它的语义域是 0..1。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { PersonaAdapter } from '../../../src/memory/engines/PersonaAdapter';
import { DEFAULT_MEMORY_CONFIG } from '../../../src/memory/types';

describe('PersonaAdapter —— 记忆旋钮的回归与钳制', () => {
  let db: Database.Database;
  let store: PersonaStore;
  let adapter: PersonaAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new PersonaStore(db);
    // 不调 LLM 的用例只测 apply / regress
    adapter = new PersonaAdapter(store, { complete: async () => '{}' } as any);
  });

  afterEach(() => db.close());

  /** 把某个参数的"上次调整时间"拨到 25 小时前，再触发一次 apply（会先跑 regressIfStale） */
  const applyStale = (param: string) => {
    (adapter as any).lastAdjustmentTime.set(param, Date.now() - 25 * 3600_000);
    // delta=0 + bypass：只为触发 regressIfStale，不额外改值
    (adapter as any).apply({ param, delta: 0, reason: 'test' }, { bypassLimits: true });
  };

  it('★ 回归目标是**默认值**，不是 0：decay_rate 停在 0.3 不会漂向"永不遗忘"', () => {
    const before = store.getMemoryConfig().decay_rate;
    expect(before).toBeCloseTo(DEFAULT_MEMORY_CONFIG.decay_rate, 5);

    // 手动改到 0.5，然后触发 stale 回归
    const cfg = store.getMemoryConfig();
    cfg.decay_rate = 0.5;
    store.updateMemoryConfig(cfg);
    applyStale('memory.decay_rate');

    const after = store.getMemoryConfig().decay_rate;
    expect(after, '应朝 0.3 回，而不是朝 0').toBeLessThan(0.5);
    expect(after, '回归不能越过默认值').toBeGreaterThanOrEqual(DEFAULT_MEMORY_CONFIG.decay_rate - 1e-9);
  });

  it('★ 低于默认值时回归是**向上**的（旧实现只会一路向下）', () => {
    const cfg = store.getMemoryConfig();
    cfg.importance_threshold = 0.1; // 默认 0.4
    store.updateMemoryConfig(cfg);
    applyStale('memory.importance_threshold');

    const after = store.getMemoryConfig().importance_threshold;
    expect(after, '应朝 0.4 回升').toBeGreaterThan(0.1);
    expect(after).toBeLessThanOrEqual(DEFAULT_MEMORY_CONFIG.importance_threshold + 1e-9);
  });

  it('★ 记忆旋钮按各自值域钳制：decay_rate 不会变负', () => {
    const cfg = store.getMemoryConfig();
    cfg.decay_rate = 0.05;
    store.updateMemoryConfig(cfg);

    (adapter as any).apply(
      { param: 'memory.decay_rate', delta: -0.1, reason: 'test', explicit: true },
      {},
    );
    expect(store.getMemoryConfig().decay_rate).toBeGreaterThanOrEqual(0);
  });

  it('retention_bias 是双向的：负向调整允许（-1..1）', () => {
    (adapter as any).apply(
      { param: 'memory.retention_bias', delta: -0.1, reason: 'test', explicit: true },
      {},
    );
    expect(store.getMemoryConfig().retention_bias).toBeLessThan(0.2);
    expect(store.getMemoryConfig().retention_bias).toBeGreaterThanOrEqual(-1);
  });

  it('人格参数仍回归到 0（原语义不变）', () => {
    (adapter as any).apply(
      { param: 'tone.warmth', delta: 0.1, reason: 'test', explicit: true },
      {},
    );
    (adapter as any).lastAdjustmentTime.set('tone.warmth', Date.now() - 25 * 3600_000);
    (adapter as any).apply({ param: 'tone.warmth', delta: 0, reason: 'test' }, { bypassLimits: true });

    expect(JSON.parse(store.get().tone).warmth).toBeLessThan(0.3);
  });
});
