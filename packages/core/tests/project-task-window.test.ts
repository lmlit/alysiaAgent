/**
 * 执行窗口单测（★ change: `gate-project-tasks-to-offpeak`）。
 *
 * 规则（北京时间）：
 *   高峰 = 周一至周五（不含法定节假日）9:00–12:00、14:00–18:00
 *   空闲 = 其余全部（含周末与节假日全天）
 *
 * ★ 这里最容易错的是**时区**：宿主可能是 UTC，用 `getHours()` 会整体错 8 小时 ——
 *   那会让"高峰"跑到凌晨去，白花钱。所以下面专门用 UTC 时刻钉边界。
 */
import { describe, it, expect } from 'vitest';
import { computeTaskWindow, DEFAULT_PEAK_WINDOWS } from '../src/memory/project-task-window.js';

/** 北京时间的某个时刻（写测试时比 UTC 直观） */
function bj(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi));
}

// 2026-10-19 是周一，2026-10-24 是周六，2026-10-25 是周日（已核对）
const MON = [2026, 10, 19] as const;
const SAT = [2026, 10, 24] as const;
const SUN = [2026, 10, 25] as const;

describe('工作日的高峰窗口（左闭右开）', () => {
  it.each([
    [9, 0, false, '09:00 起就是高峰（左闭）'],
    [9, 30, false, '高峰中段'],
    [11, 59, false, '高峰末尾前一分钟'],
    [12, 0, true, '12:00 起是午休（右开）'],
    [13, 59, true, '午休末尾'],
    [14, 0, false, '14:00 起又是高峰（左闭）'],
    [17, 59, false, '下午高峰末尾前一分钟'],
    [18, 0, true, '18:00 起空闲（右开）'],
    [8, 59, true, '早上高峰之前'],
    [23, 30, true, '深夜'],
    [0, 0, true, '零点'],
  ])('%i:%i → offPeak=%s（%s）', (h, mi, expected) => {
    const w = computeTaskWindow({ now: bj(MON[0], MON[1], MON[2], h, mi) });
    expect(w.offPeak).toBe(expected);
  });

  it('高峰时给出"几点之后能跑"：午休那场 → 12:00', () => {
    const w = computeTaskWindow({ now: bj(MON[0], MON[1], MON[2], 10, 15) });
    expect(w.reason).toBe('peak');
    // 12:00 北京时间 = 04:00 UTC
    expect(w.until).toBe('2026-10-19T04:00:00.000Z');
    expect(w.message).toContain('12:00');
  });

  it('高峰时给出"几点之后能跑"：下午那场 → 18:00', () => {
    const w = computeTaskWindow({ now: bj(MON[0], MON[1], MON[2], 16, 40) });
    expect(w.until).toBe('2026-10-19T10:00:00.000Z');
    expect(w.message).toContain('18:00');
  });

  it('★ 回执里要写明"到点自己会跑，不用再交一次"（否则她会重复提交）', () => {
    const w = computeTaskWindow({ now: bj(MON[0], MON[1], MON[2], 10, 0) });
    expect(w.message).toContain('不用再交一次');
  });
});

describe('周末全天空闲', () => {
  it.each([
    [SAT[0], SAT[1], SAT[2], 10, 0],
    [SAT[0], SAT[1], SAT[2], 15, 30],
    [SUN[0], SUN[1], SUN[2], 10, 0],
    [SUN[0], SUN[1], SUN[2], 23, 59],
  ])('%i-%i-%i %i:%i → 空闲（周末）', (y, mo, d, h, mi) => {
    const w = computeTaskWindow({ now: bj(y, mo, d, h, mi) });
    expect(w.offPeak).toBe(true);
    expect(w.reason).toBe('weekend');
  });

  it('★ 周末即使是高峰时段也照跑（按用户规则：周末全天算空闲）', () => {
    expect(computeTaskWindow({ now: bj(SAT[0], SAT[1], SAT[2], 10, 0) }).offPeak).toBe(true);
  });
});

describe('法定节假日全天空闲', () => {
  const holiday = '2026-10-20'; // 假设的假日在周一

  it('假日的高峰时段也照跑', () => {
    const w = computeTaskWindow({ now: bj(2026, 10, 20, 10, 0), holidays: [holiday] });
    expect(w.offPeak).toBe(true);
    expect(w.reason).toBe('holiday');
  });

  it('★ 没在表里的日子按工作日算（宁可等一会儿，也不在高峰烧钱）', () => {
    const w = computeTaskWindow({ now: bj(2026, 10, 20, 10, 0), holidays: [] });
    expect(w.offPeak).toBe(false);
    expect(w.reason).toBe('peak');
  });

  it('节假日表只影响那一天，不影响别的日子', () => {
    const w = computeTaskWindow({ now: bj(2026, 10, 21, 10, 0), holidays: [holiday] });
    expect(w.offPeak).toBe(false);
  });
});

describe('★ 时区：不看宿主时区，一律 UTC+8', () => {
  it('同一时刻，无论用何种方式构造 Date，判定一致', () => {
    const utc = new Date('2026-10-19T02:00:00.000Z'); // = 北京 10:00（周一高峰）
    expect(computeTaskWindow({ now: utc }).offPeak).toBe(false);
    expect(computeTaskWindow({ now: new Date(utc.getTime()) }).offPeak).toBe(false);
  });

  it('★ UTC 01:00 = 北京 09:00 → 刚好进高峰（差 8 小时会把这里判反）', () => {
    expect(computeTaskWindow({ now: new Date('2026-10-19T01:00:00.000Z') }).offPeak).toBe(false);
  });

  it('UTC 00:59 = 北京 08:59 → 还在空闲', () => {
    expect(computeTaskWindow({ now: new Date('2026-10-19T00:59:00.000Z') }).offPeak).toBe(true);
  });

  it('跨日边界：UTC 16:00 = 北京次日 00:00（周二凌晨）→ 空闲', () => {
    const w = computeTaskWindow({ now: new Date('2026-10-19T16:00:00.000Z') });
    expect(w.offPeak).toBe(true);
    expect(w.nowBeijing).toBe('2026-10-20 00:00');
  });

  it('nowBeijing 是给人看的北京时间（不是 UTC）', () => {
    expect(computeTaskWindow({ now: new Date('2026-10-19T02:34:00.000Z') }).nowBeijing).toBe(
      '2026-10-19 10:34',
    );
  });
});

describe('窗口可覆盖（将来调价/临时豁免）', () => {
  it('把高峰改成空数组 → 工作日也全天空闲', () => {
    const w = computeTaskWindow({
      now: bj(MON[0], MON[1], MON[2], 10, 0),
      peakWindows: [],
    });
    expect(w.offPeak).toBe(true);
    expect(w.reason).toBe('off-peak-hour');
  });

  it('默认窗口就是 9-12 与 14-18', () => {
    expect(DEFAULT_PEAK_WINDOWS).toEqual([
      [540, 720],
      [840, 1080],
    ]);
  });
});
