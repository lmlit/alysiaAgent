// ★ 9-25 wire-importance-signal：生活事件的重要性 = 基线 + 情绪强度
import { describe, it, expect } from 'vitest';
import {
  FOLLOWUP_FACTOR,
  LIFE_BASE,
  LIFE_EMOTION_MAX,
  lifeEventImportance,
  moodDeltaToIntensity,
} from '../../src/memory/importance.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/memory/types.js';

const THRESHOLD = DEFAULT_MEMORY_CONFIG.importance_threshold; // 0.4

describe('moodDeltaToIntensity — 数字', () => {
  it('带正号/不带/负号都取绝对值', () => {
    expect(moodDeltaToIntensity('+1')).toBe(1);
    expect(moodDeltaToIntensity('1')).toBe(1);
    expect(moodDeltaToIntensity('-1')).toBe(1);
  });

  it('超出 1 截到 1（实测有 +2）', () => {
    expect(moodDeltaToIntensity('+2')).toBe(1);
  });

  it('小数按字面量（不做尺度校准 —— 数据本身不可靠）', () => {
    expect(moodDeltaToIntensity('+0.1')).toBeCloseTo(0.1, 5);
    expect(moodDeltaToIntensity('+0.001')).toBeCloseTo(0.001, 5);
  });

  it('0 → 0', () => {
    expect(moodDeltaToIntensity('+0')).toBe(0);
    expect(moodDeltaToIntensity('0')).toBe(0);
  });
});

describe('moodDeltaToIntensity — 情绪词', () => {
  it('低唤醒词给低值（平静 / 安静）', () => {
    expect(moodDeltaToIntensity('平静')).toBeLessThan(0.3);
    expect(moodDeltaToIntensity('安静')).toBeLessThan(0.3);
  });

  it('★ 取的是唤醒度不是正负：难过/生气同样给高值', () => {
    expect(moodDeltaToIntensity('难过')).toBeGreaterThan(0.7);
    expect(moodDeltaToIntensity('生气')).toBeGreaterThan(0.7);
  });

  it('高唤醒词给高值', () => {
    expect(moodDeltaToIntensity('雀跃')).toBeGreaterThan(0.8);
    expect(moodDeltaToIntensity('开心')).toBeGreaterThan(0.7);
  });

  it('英文词也认（实测有 warm）', () => {
    expect(moodDeltaToIntensity('warm')).toBeCloseTo(0.5, 5);
  });

  it('子串匹配："有点开心" 命中 "开心"', () => {
    expect(moodDeltaToIntensity('有点开心')).toBeGreaterThan(0.7);
  });

  it('子串匹配按强度降序：同时含高低词时取高的', () => {
    // "平静地开心" 同时含"平静"(0.15) 与"开心"(0.75) → 应取 0.75
    expect(moodDeltaToIntensity('平静地开心')).toBeGreaterThan(0.7);
  });

  it('未收录的词给 fallback，不判 0（有标记本身就有信息）', () => {
    const v = moodDeltaToIntensity('恍恍惚惚');
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.7);
  });
});

describe('moodDeltaToIntensity — 空值', () => {
  it('空/null/undefined → 0', () => {
    expect(moodDeltaToIntensity('')).toBe(0);
    expect(moodDeltaToIntensity('   ')).toBe(0);
    expect(moodDeltaToIntensity(null)).toBe(0);
    expect(moodDeltaToIntensity(undefined)).toBe(0);
  });
});

describe('lifeEventImportance', () => {
  it('无情绪 → 基线', () => {
    expect(lifeEventImportance({})).toBe(LIFE_BASE);
    expect(lifeEventImportance({ moodDelta: '' })).toBe(LIFE_BASE);
  });

  it('强情绪 → 基线 + 满额加成', () => {
    expect(lifeEventImportance({ moodDelta: '+1' })).toBeCloseTo(
      LIFE_BASE + LIFE_EMOTION_MAX,
      3,
    );
  });

  it('对话余波折减', () => {
    const regular = lifeEventImportance({ moodDelta: '+1', origin: 'regular' });
    const followup = lifeEventImportance({ moodDelta: '+1', origin: 'followup' });
    expect(followup).toBeLessThan(regular);
    expect(followup).toBeCloseTo(regular * FOLLOWUP_FACTOR, 3);
  });

  it('结果恒在 0~1', () => {
    for (const md of ['+999', '-999', '平静', '雀跃', '', null as any]) {
      const v = lifeEventImportance({ moodDelta: md });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('★ 相对于默认阈值 0.4 有区分度（接线前全恒 0，分支永不触发）', () => {
    const calm = lifeEventImportance({ moodDelta: '平静' });          // 低唤醒
    const excited = lifeEventImportance({ moodDelta: '雀跃' });        // 高唤醒
    const none = lifeEventImportance({});                             // 无标记

    expect(calm).toBeLessThan(THRESHOLD);      // 平静的不过线
    expect(excited).toBeGreaterThan(THRESHOLD); // 有情绪波动的过线
    expect(none).toBeLessThan(THRESHOLD);
    // 关键：不是"全过线"也不是"全不过线" —— 那等于没接
    expect(new Set([calm > THRESHOLD, excited > THRESHOLD]).size).toBe(2);
  });
});
