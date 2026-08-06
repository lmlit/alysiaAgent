import { describe, it, expect, vi, afterEach } from 'vitest';
import { fmtMsgTime } from '../../src/pipeline/stages/memory-retrieval.js';

describe('fmtMsgTime — 短期记忆时间标记（AI 区分天数）', () => {
  afterEach(() => vi.useRealTimers());

  it('今天的时间只显示 HH:MM', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 7, 10, 0)); // 本地 2026-08-07 10:00
    expect(fmtMsgTime(new Date(2026, 7, 7, 0, 47).toISOString())).toBe('[00:47]');
  });

  it('昨天的时间标记 [昨天 HH:MM]', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 7, 10, 0));
    expect(fmtMsgTime(new Date(2026, 7, 6, 21, 30).toISOString())).toBe('[昨天 21:30]');
  });

  it('更早的标记 [M月D日 HH:MM]', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 7, 10, 0));
    expect(fmtMsgTime(new Date(2026, 7, 3, 9, 5).toISOString())).toBe('[8月3日 09:05]');
  });

  it('无时间戳或非法时间返回空', () => {
    expect(fmtMsgTime(undefined)).toBe('');
    expect(fmtMsgTime('not-a-date')).toBe('');
  });
});
