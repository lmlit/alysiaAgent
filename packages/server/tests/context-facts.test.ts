/**
 * `context-facts.ts` —— 事实层的单测（★ 2026-10-24，change: `converge-context-facts`）
 *
 * 守三件事：
 *   1. **唯一出处**：档位/idle 的算法只在这里，且边界与旧版 `life.ts` 逐点一致
 *   2. **`null` 语义**：没有真人消息就是 `null`（不是 7、不是 999），调用方必须显式处理
 *   3. **不静默**：读源抛异常 → 进 `problems[]`，不吞
 */
import { describe, it, expect, vi } from 'vitest';
import {
  collectContextFacts,
  idleDaysSince,
  intimacyTier,
  INTIMACY_TIERS,
  type FactsSource,
} from '../src/context-facts.js';

const NOW = new Date('2026-08-06T12:00:00');

describe('intimacyTier —— 档位边界（与 life.ts 旧实现逐点一致）', () => {
  it('70/40/25 三个边界', () => {
    expect(intimacyTier(90).tier).toBe('close');
    expect(intimacyTier(70).tier).toBe('close');
    expect(intimacyTier(69).tier).toBe('normal');
    expect(intimacyTier(40).tier).toBe('normal');
    expect(intimacyTier(39).tier).toBe('distant');
    expect(intimacyTier(25).tier).toBe('distant');
    expect(intimacyTier(24).tier).toBe('silent');
    expect(intimacyTier(10).tier).toBe('silent');
  });

  it('非有限值一律回落 30（`Number.isFinite` 对 Infinity 也是 false）', () => {
    // 30 落在 [25,40) ⇒ distant。注意 Infinity **不会**被判成 close —— 这是个容易想当然的点
    expect(intimacyTier(NaN).tier).toBe('distant');
    expect(intimacyTier(Infinity).tier).toBe('distant');
    expect(intimacyTier(-Infinity).tier).toBe('distant');
  });

  it('四档的 cap 顺序是 5/3/1/0（只降不升的判据基础）', () => {
    expect(INTIMACY_TIERS.map(t => t.cap)).toEqual([5, 3, 1, 0]);
  });
});

describe('idleDaysSince —— null 语义', () => {
  it('没有真人消息 → null（**不是** 7、也不是 999）', () => {
    expect(idleDaysSince(null, NOW)).toBeNull();
    expect(idleDaysSince(undefined, NOW)).toBeNull();
  });

  it('按整天向下取整', () => {
    expect(idleDaysSince('2026-08-06T10:00:00', NOW)).toBe(0);
    expect(idleDaysSince('2026-07-30T11:00:00', NOW)).toBe(7);
    expect(idleDaysSince('2026-07-29T11:00:00', NOW)).toBe(8);
    expect(idleDaysSince('2026-07-07T11:00:00', NOW)).toBe(30);
  });

  it('未来时间/坏时间戳不产出负数或 NaN', () => {
    expect(idleDaysSince('2026-09-01T00:00:00', NOW)).toBe(0);
    expect(idleDaysSince('不是日期', NOW)).toBe(0);
  });
});

describe('collectContextFacts —— 采集', () => {
  const src = (over: Partial<FactsSource> = {}): FactsSource => ({
    getLifeSnapshot: () => ({ intimacy: 62, mood: '平静', moodValue: 0.2, moodNote: '安静' }),
    getLastUserMessageAt: () => '2026-08-01T11:00:00',
    listLifeEvents: () => [
      { content: '在阳台看书', createdAt: '2026-08-06T09:00:00' },
      { content: '昨天听的雨', createdAt: '2026-08-05T21:00:00' },
    ],
    getUserActivitySummary: () => '在玩老头环',
    ...over,
  });

  it('字段齐全，档位/idle/日常/近况各就各位', () => {
    const f = collectContextFacts(src(), NOW);
    expect(f.intimacy).toBe(62);
    expect(f.snapshotPresent).toBe(true);
    expect(f.tier.label).toBe('平常');
    expect(f.idleDays).toBe(5);
    expect(f.mood.mood).toBe('平静');
    expect(f.todayEvents).toEqual(['在阳台看书']); // 昨天那条被本地日期过滤
    expect(f.userActivity).toBe('在玩老头环');
    expect(f.problems).toEqual([]);
  });

  it('没有快照 → intimacy 回落 30，但 snapshotPresent=false（供调用方判"算不算素材"）', () => {
    const f = collectContextFacts(src({ getLifeSnapshot: () => null }), NOW);
    expect(f.intimacy).toBe(30);
    expect(f.snapshotPresent, '回落值和真值必须可区分').toBe(false);
  });

  it('没有真人消息 → idleDays=null（**不用哨兵冒充**）', () => {
    const f = collectContextFacts(src({ getLastUserMessageAt: () => null }), NOW);
    expect(f.idleDays).toBeNull();
    expect(f.lastUserAt).toBeNull();
  });

  it('★ 读源抛异常 → 进 problems，不吞、也不炸', () => {
    const f = collectContextFacts({
      getLifeSnapshot: () => { throw new Error('snapshot boom'); },
      getLastUserMessageAt: () => { throw new Error('last msg boom'); },
      listLifeEvents: () => { throw new Error('events boom'); },
      getUserActivitySummary: () => { throw new Error('activity boom'); },
    }, NOW);
    expect(f.problems).toHaveLength(4);
    expect(f.problems.join('|')).toContain('snapshot boom');
    expect(f.intimacy, '异常时仍回落可用值').toBe(30);
    expect(f.todayEvents).toEqual([]);
  });

  it('todayEventLimit=0 ⇒ 不查生活事件（relationshipBlock 不需要它）', () => {
    const spy = vi.fn(() => [{ content: 'x', createdAt: '2026-08-06T09:00:00' }]);
    const f = collectContextFacts(src({ listLifeEvents: spy }), NOW, { todayEventLimit: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(f.todayEvents).toEqual([]);
  });

  it('日常最多 N 条，取最近的', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      content: `事件${i + 1}`, createdAt: '2026-08-06T0' + (i + 1) + ':00:00',
    }));
    const f = collectContextFacts(src({ listLifeEvents: () => many }), NOW, { todayEventLimit: 3 });
    expect(f.todayEvents).toEqual(['事件4', '事件5', '事件6']);
  });
});
