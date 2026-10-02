// tests/utils/write-trace.test.ts
// ★ 2026-10-02 change: observe-zero-row-writes
//
// 写入影响行数观测：**只观测，不拦截**。
// `changes === 0` 有两种含义（幂等跳过 vs 目标行不存在），静态分不出来 ——
// 所以先收集分布、跑一段时间再决策（KI-11）。这组用例守两件事：
//   1. 非 0 行**绝对不能**打日志（否则每次启动刷噪声，比不观测更糟）
//   2. 0 行时必须留痕，且带上 tag / 上下文（否则事后统计不出来）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { traceZeroRows } from '../../src/utils/write-trace.js';
import { logger } from '../../src/utils/logger.js';

describe('traceZeroRows', () => {
  afterEach(() => vi.restoreAllMocks());

  it('changes > 0 → 不打日志（不能变成噪声）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    traceZeroRows('SomeStore.someMethod', 1);
    traceZeroRows('SomeStore.someMethod', 42);
    expect(warn).not.toHaveBeenCalled();
  });

  it('changes === 0 → 打一行 warn，含 tag 与 context', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    traceZeroRows('LifeStore.markDelivered', 0, 'id=life-abc');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('[WriteTrace]');
    expect(line).toContain('LifeStore.markDelivered');
    expect(line).toContain('id=life-abc');
  });

  it('无 context 也能打（tag 单独可统计）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    traceZeroRows('WorldbookStore.recordTrigger', 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('WorldbookStore.recordTrigger');
  });

  it('只观测不拦截：调用方拿不到任何"失败"信号（不抛、不返回）', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(() => traceZeroRows('X.y', 0)).not.toThrow();
    expect(traceZeroRows('X.y', 0)).toBeUndefined();
  });
});
