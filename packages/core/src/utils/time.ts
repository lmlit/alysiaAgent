// src/utils/time.ts
// 本地时间格式化工具（日志/事件/prompt 注入统一使用）

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 2026年8月6日 星期四 21:35（本地时间） */
export function formatLocalTime(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本地日期 key: 2026-08-06 */
export function localDateKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO/UTC 时间字符串 → 本地日期 key（EventStore 存的是 ISO） */
export function localDateKeyFromISO(iso: string): string {
  return localDateKey(new Date(iso));
}
