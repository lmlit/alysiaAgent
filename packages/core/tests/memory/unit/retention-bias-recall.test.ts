/**
 * ★ 2026-10-20（change: `wire-retention-bias-into-recall`）
 *
 * `retention_bias` 此前**完全空转**：旋钮存在、注入 prompt、但召回排序里没有任何一处读它。
 *
 * 接线卡在一个**数据缺口**上（不是难）：
 * 重要度取的是**强度（arousal）**——`moodDeltaToIntensity` 用 `Math.abs`，
 * 「难过」和「雀跃」都是高分；而 `retention_bias`（-1 只记坏的 / +1 只记好的）
 * 要的是**正负（valence）**。两轴不能合并：
 * 合并 = 把「难过」当低强度 ⇒ 负面时刻进不了长期记忆 —— 那不是偏向正面，是**失忆**。
 *
 * 所以本 change 的顺序是：**先造 valence 数据源**（`metadata.polarity`），**再接旋钮**。
 *
 * 测试守四件事：
 *   ① 正负判定不把负面当正面；判不出来返回 0（**不猜**）
 *   ② 没有 polarity 的存量记忆**完全不受影响**（不追溯改排序）
 *   ③ `retention_bias = 0` ⇒ 不计调整（可整体关闭）
 *   ④ 有 polarity + 非零 bias ⇒ 正向记忆排到负向前面
 */
import { describe, it, expect } from 'vitest';
import { moodDeltaToPolarity } from '../../../src/memory/importance';
import { MemoryManager } from '../../../src/memory/MemoryManager';
import type { SearchResult } from '../../../src/memory/types';

/** `applyKnobsToRetrieved` 不读 `this` 的任何成员，所以可以直接借原型调，不必建整台 MemoryManager */
function score(items: SearchResult[], knobs: Record<string, number>) {
  const fn = (MemoryManager as any).prototype.applyKnobsToRetrieved;
  return fn.call({}, items, {
    retention_bias: 0.2, decay_rate: 0.3, importance_threshold: 0.4, recency_weight: 0.3, confirmation_bias: 0.3,
    ...knobs,
  }) as { results: SearchResult[]; boosted: number; polarityAdjusted: number };
}

const item = (id: string, sc: number, meta: Record<string, unknown> = {}): SearchResult => ({
  id, text: `内容 ${id}`, score: sc, metadata: { source: 'life_event', ...meta },
});

describe('moodDeltaToPolarity —— 情绪正负（valence）', () => {
  it('数值：符号即正负，0 不猜', () => {
    expect(moodDeltaToPolarity('+1')).toBe(1);
    expect(moodDeltaToPolarity('0.001')).toBe(1);
    expect(moodDeltaToPolarity('-2')).toBe(-1);
    expect(moodDeltaToPolarity('-0.1')).toBe(-1);
    expect(moodDeltaToPolarity('0')).toBe(0);
  });

  it('★ 负面词必须判负（强度表里它们同样是高分，这里是另一条轴）', () => {
    expect(moodDeltaToPolarity('难过')).toBe(-1);
    expect(moodDeltaToPolarity('低落')).toBe(-1);
    expect(moodDeltaToPolarity('生气')).toBe(-1);
    expect(moodDeltaToPolarity('有点委屈')).toBe(-1);
  });

  it('正面词判正；中性词判 0', () => {
    expect(moodDeltaToPolarity('开心')).toBe(1);
    expect(moodDeltaToPolarity('warm')).toBe(1);
    expect(moodDeltaToPolarity('平静')).toBe(1); // 平静偏安心侧，但强度低
    expect(moodDeltaToPolarity('淡淡的')).toBe(0); // 中性：既不偏正也不偏负
  });

  it('★ 判不出来返回 0（不猜）', () => {
    expect(moodDeltaToPolarity('')).toBe(0);
    expect(moodDeltaToPolarity(null)).toBe(0);
    expect(moodDeltaToPolarity('说不清的某种感觉')).toBe(0);
  });
});

describe('retention_bias 接入召回（路内调整）', () => {
  it('★ 存量记忆没有 polarity ⇒ 完全不受影响（不追溯改排序）', () => {
    const rs = score([item('a', 0.9), item('b', 0.8)], { retention_bias: 0.9 });
    expect(rs.results.map(r => r.id)).toEqual(['a', 'b']);
    expect(rs.polarityAdjusted, '没有 valence 就不该动分').toBe(0);
  });

  it('★ retention_bias = 0 ⇒ 不计调整（可整体关闭）', () => {
    const rs = score(
      [item('pos', 0.8, { polarity: 1 }), item('neg', 0.8, { polarity: -1 })],
      { retention_bias: 0 },
    );
    expect(rs.polarityAdjusted).toBe(0);
    expect(rs.results.map(r => r.id)).toEqual(['pos', 'neg']);
  });

  it('★ 正 bias ⇒ 好的记忆排前（同分时），并如实计数', () => {
    const rs = score(
      [item('neg', 0.8, { polarity: -1 }), item('pos', 0.8, { polarity: 1 })],
      { retention_bias: 0.2 },
    );
    expect(rs.results.map(r => r.id)).toEqual(['pos', 'neg']);
    expect(rs.polarityAdjusted).toBe(2);
  });

  it('负 bias ⇒ 坏的记忆排前（"记仇"方向也要成立）', () => {
    const rs = score(
      [item('pos', 0.8, { polarity: 1 }), item('neg', 0.8, { polarity: -1 })],
      { retention_bias: -0.5 },
    );
    expect(rs.results.map(r => r.id)).toEqual(['neg', 'pos']);
  });

  it('★ 幅度保守：不足以翻掉明显分差（默认 0.2 时约 ±6%）', () => {
    // 0.9 vs 0.8 的差距远超 ±6%，bias 不该把弱的翻上来
    const rs = score(
      [item('strong', 0.9, { polarity: -1 }), item('weak', 0.8, { polarity: 1 })],
      { retention_bias: 0.2 },
    );
    expect(rs.results[0].id).toBe('strong');
  });
});
