import { describe, it, expect } from 'vitest';
import { formatLocalTime, localDateKey, localDateKeyFromISO } from '../../src/utils/time.js';

describe('time utils', () => {
  it('formatLocalTime produces Chinese format with weekday', () => {
    // 2026-08-06 是星期四
    const d = new Date(2026, 7, 6, 21, 35); // 本地时间构造
    expect(formatLocalTime(d)).toBe('2026年8月6日 星期四 21:35');
  });

  it('formatLocalTime pads minutes', () => {
    const d = new Date(2026, 0, 5, 9, 5);
    expect(formatLocalTime(d)).toBe('2026年1月5日 星期一 09:05');
  });

  it('localDateKey produces YYYY-MM-DD', () => {
    const d = new Date(2026, 7, 6, 21, 35);
    expect(localDateKey(d)).toBe('2026-08-06');
  });

  it('localDateKeyFromISO converts UTC ISO to local date key', () => {
    // 2026-08-06T16:00:00Z = 北京 2026-08-07 00:00
    expect(localDateKeyFromISO('2026-08-06T16:00:00Z')).toBe('2026-08-07');
  });
});
