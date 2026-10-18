/**
 * 执行窗口 —— "做网站"这类**要烧 DeepSeek API 的活**只在**空闲时段**跑。
 *
 * ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）。用户给的规则（北京时间）：
 *
 *   **高峰**：周一至周五（**不含**中国法定节假日）9:00–12:00、14:00–18:00
 *   **空闲**：其余全部，包括周末与法定节假日**全天**
 *
 * ⇒ 高峰之外都能跑；每天实际可跑的空闲段是：
 *   00:00–09:00 / 12:00–14:00 / 18:00–24:00，以及周末与节假日全天。
 *
 * ★ 为什么做**认领侧**而不是"提交侧"：
 *   高峰时段直接拒收任务，她就得记住时间、用户也得等；而"先排队、到点自己跑"
 *   对双方都更自然 —— 而且**钱是按实际执行时间算的**，排队本身不花钱。
 *
 * ⚠️ 时区：一律按 **UTC+8** 自己算，**不看宿主机时区**。
 *   宿主可能是 UTC（容器默认），靠 `Date.getHours()` 会整体错 8 小时 —— 那会让
 *   "高峰时段"变成凌晨，白白多花钱。
 */

/** 北京时间相对 UTC 的偏移（分钟）。中国不实行夏令时，恒定 +480。 */
const BEIJING_OFFSET_MIN = 8 * 60;

/** 高峰窗口（北京时间，分钟数，左闭右开） */
export const DEFAULT_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60, 12 * 60], // 09:00–12:00
  [14 * 60, 18 * 60], // 14:00–18:00
];

export type TaskWindowReason =
  /** 周末（周六/周日）⇒ 全天空闲 */
  | 'weekend'
  /** 法定节假日 ⇒ 全天空闲 */
  | 'holiday'
  /** 工作日里的午休/夜间 ⇒ 空闲 */
  | 'off-peak-hour'
  /** 落在高峰窗口内 ⇒ **不许跑** */
  | 'peak';

export interface TaskWindow {
  /** `true` = 现在可以跑（空闲时段） */
  offPeak: boolean;
  reason: TaskWindowReason;
  /** 北京时间下的"现在"，便于日志/回执直接展示（如 `2026-10-18 10:23`） */
  nowBeijing: string;
  /** 若是高峰：本次高峰**结束**的时刻（ISO，UTC）；空闲时为 `undefined` */
  until?: string;
  /** 给人和模型看的一句话（中文，可直接放进工具回执） */
  message: string;
}

export interface TaskWindowInput {
  /** 判定时刻（默认现在） */
  now?: Date;
  /**
   * 中国法定节假日（`YYYY-MM-DD`，北京时间）。
   *
   * ⚠️ **不内置任何日期**：法定节假日每年由国务院办公厅公布，还要处理调休，
   * 猜一份错的表比没有更糟（会把本该省钱的假日当成工作日，或者反过来）。
   * 由配置提供；**未列出的日期按工作日处理** ⇒ 窗口照常生效 ⇒ 只会更省，不会多花。
   */
  holidays?: ReadonlyArray<string>;
  /** 覆盖默认高峰窗口（分钟数，左闭右开）；测试与将来的调价都用得上 */
  peakWindows?: ReadonlyArray<readonly [number, number]>;
}

/** 把时刻换算成"北京时间的年月日时分秒 + 星期"（不依赖宿主时区） */
function beijingParts(now: Date): {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  /** 0=周日 … 6=周六 */
  weekday: number;
  dateKey: string;
  minutes: number;
} {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MIN * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
    dateKey: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
      shifted.getUTCDate(),
    ).padStart(2, '0')}`,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** 北京时间 `YYYY-MM-DD HH:MM`；给定分钟数则是当天的该时刻，转成 ISO（UTC） */
function beijingTimeToIso(now: Date, minutesOfDay: number): string {
  const p = beijingParts(now);
  // 先取北京当天 00:00 对应的 UTC 时刻，再加分钟
  const baseUtcMs = Date.UTC(p.y, p.mo - 1, p.d) - BEIJING_OFFSET_MIN * 60_000;
  return new Date(baseUtcMs + minutesOfDay * 60_000).toISOString();
}

const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/**
 * 判定"现在能不能跑"。
 *
 * @returns 判定结果；**纯函数**，同一个 `now` 永远得到同一个答案（便于测试）
 */
export function computeTaskWindow(input: TaskWindowInput = {}): TaskWindow {
  const now = input.now ?? new Date();
  const holidays = new Set(input.holidays ?? []);
  const peakWindows = input.peakWindows ?? DEFAULT_PEAK_WINDOWS;
  const p = beijingParts(now);
  const nowBeijing = `${p.dateKey} ${pad(p.h)}:${pad(p.mi)}`;

  // ① 周末 ⇒ 全天空闲（★ 按用户规则：调休上班的周末也算空闲，不查补班表）
  if (p.weekday === 0 || p.weekday === 6) {
    return {
      offPeak: true,
      reason: 'weekend',
      nowBeijing,
      message: `现在（${nowBeijing}，周末）是空闲时段，可以跑。`,
    };
  }

  // ② 法定节假日 ⇒ 全天空闲（表由配置给；没列的按工作日算 ⇒ 只会更省）
  if (holidays.has(p.dateKey)) {
    return {
      offPeak: true,
      reason: 'holiday',
      nowBeijing,
      message: `现在（${nowBeijing}，法定节假日）是空闲时段，可以跑。`,
    };
  }

  // ③ 工作日：落在高峰窗口内 ⇒ 不许跑，给出"几点之后能跑"
  for (const [start, end] of peakWindows) {
    if (p.minutes >= start && p.minutes < end) {
      const until = beijingTimeToIso(now, end);
      return {
        offPeak: false,
        reason: 'peak',
        nowBeijing,
        until,
        message:
          `现在是高峰时段（${nowBeijing}，工作日 ${hhmm(start)}–${hhmm(end)}），` +
          `这件活要等到 ${hhmm(end)} 之后（北京时间）才会开始跑 —— 到点自己会跑，不用再交一次。`,
      };
    }
  }

  // ④ 工作日的高峰之外（早于 9:00 / 午休 12:00–14:00 / 18:00 之后）⇒ 空闲
  return {
    offPeak: true,
    reason: 'off-peak-hour',
    nowBeijing,
    message: `现在（${nowBeijing}，工作日的高峰之外）是空闲时段，可以跑。`,
  };
}
