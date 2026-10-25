/**
 * 表态时钟（第二根轴）的守卫 —— ★ 2026-10-25，change: `worth-telling-and-silence-clock`
 *
 * ## 它是什么
 *
 * 亲密度那条轴也在"沉默 → 少说话"，但它**慢**（decay 1.8/天：82→70 要 7 天、→40 要 23 天、
 * →25 要 32 天）。whale 的形状是 **3 天开始降 / 7 天归零** —— 它管的是"发言额度"而不是
 * "关系温度"，所以敢快。
 *
 * 我们**不动亲密度衰减速率**（那会让关系温度也掉得飞快），而是加一根**只压额度**的独立轴，
 * 与亲密度档位**取 min**（沿用「只降不升」）。
 *
 * ## 这个文件守什么
 *
 * 1. `null`（从没说过话）**不压** —— 旧代码正是拿哨兵值冒充它，导致衰减永不触发；
 *    额度这边犯同样的错会把推送直接掐死（第一版真这么写了，被测试抓出来）
 * 2. 边界值 3 / 7 天各归哪一档
 * 3. **不抄 whale 的数值**：默认值可被 opts 覆盖，这里也钉住"可覆盖"这件事
 */
import { describe, it, expect } from 'vitest';
import { silenceCap, SILENCE_QUIET_DAYS, SILENCE_MUTE_DAYS } from '../src/context-facts.js';

describe('silenceCap —— 沉默天数 → 每日额度', () => {
  it('★ null（从没说过话）⇒ 不压（不拿哨兵冒充天数）', () => {
    expect(silenceCap(null)).toBeNull();
  });

  it('0–2 天：满额（不额外限制）', () => {
    expect(silenceCap(0)).toBeNull();
    expect(silenceCap(2)).toBeNull();
  });

  it('★ 第 3 天开始降 → cap 3', () => {
    expect(silenceCap(3)?.cap).toBe(3);
    expect(silenceCap(6)?.cap).toBe(3);
    expect(silenceCap(6)?.label).toContain('有点久');
  });

  it('★ 第 7 天归零 → cap 0（她不主动说了）', () => {
    expect(silenceCap(7)?.cap).toBe(0);
    expect(silenceCap(30)?.cap).toBe(0);
    expect(silenceCap(7)?.label).toContain('安静下来');
  });

  it('默认值 3 / 7，且**可被覆盖**（数值是保守起点，不抄 whale）', () => {
    expect(SILENCE_QUIET_DAYS).toBe(3);
    expect(SILENCE_MUTE_DAYS).toBe(7);
    // 覆盖成 5/10：第 4 天不压，第 5 天降到 3，第 10 天归零
    expect(silenceCap(4, 5, 10)).toBeNull();
    expect(silenceCap(5, 5, 10)?.cap).toBe(3);
    expect(silenceCap(10, 5, 10)?.cap).toBe(0);
  });

  it('非法值（NaN）⇒ 不压（不因为脏数据把她静音）', () => {
    expect(silenceCap(Number.NaN)).toBeNull();
  });
});
