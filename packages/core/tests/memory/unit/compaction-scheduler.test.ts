/**
 * ★ 2026-10-28（change: `fix-long-session-compaction`）
 *
 * 压缩请求节流的边界。线上实际形态：`usage.input` 一旦过 8000，单 session
 * 后续每一轮都超；若不冷却，摘要 per-session mutex 会把后来者全判成 in-flight。
 */
import { describe, it, expect } from 'vitest';
import {
  COMPACTION_COOLDOWN_MS,
  shouldRequestCompaction,
  shouldHoldTruncation,
} from '../../../src/memory/compaction-scheduler';

const base = { triggerTokens: 8_000, cooldownMs: COMPACTION_COOLDOWN_MS };

describe('shouldRequestCompaction', () => {
  it('低于阈值 → 不请求（即使从没请求过）', () => {
    expect(shouldRequestCompaction({ ...base, inputTokens: 7_999, now: 1_000 })).toBe(false);
  });

  it('首次过阈值 → 请求', () => {
    expect(shouldRequestCompaction({ ...base, inputTokens: 8_001, now: 1_000 })).toBe(true);
  });

  it('冷却内再次过阈值 → 不请求', () => {
    const now = 1_000_000;
    expect(shouldRequestCompaction({
      ...base,
      inputTokens: 9_000,
      now,
      lastRequestAt: now - COMPACTION_COOLDOWN_MS + 1,
    })).toBe(false);
  });

  it('冷却到期 → 再次请求', () => {
    const now = 1_000_000;
    expect(shouldRequestCompaction({
      ...base,
      inputTokens: 9_000,
      now,
      lastRequestAt: now - COMPACTION_COOLDOWN_MS,
    })).toBe(true);
  });

  it('冷却恰好 10 分钟', () => {
    expect(COMPACTION_COOLDOWN_MS).toBe(10 * 60_000);
  });
});

describe('shouldHoldTruncation', () => {
  it('only failed holds（skipped 不是失败）', () => {
    expect(shouldHoldTruncation('failed')).toBe(true);
    expect(shouldHoldTruncation('ok')).toBe(false);
    expect(shouldHoldTruncation('skipped')).toBe(false);
  });
});
