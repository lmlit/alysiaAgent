import { describe, it, expect } from 'vitest';
import { parseIntentMarks } from '../../src/pipeline/stages/llm-agent';

describe('parseIntentMarks — 8-28 意图标记解析（ai-life-intent-system）', () => {
  it('delayed-reply：解析 + 剥离标记，用户不可见', () => {
    const { text, intents } = parseIntentMarks('让我想想你说的猫的事，晚点告诉你哈 [intent:delayed-reply|关于猫的事|2]');
    expect(text).toBe('让我想想你说的猫的事，晚点告诉你哈');
    expect(intents).toEqual([{ type: 'delayed-reply', content: '关于猫的事', hours: 2 }]);
  });

  it('promise：解析 + 剥离', () => {
    const { text, intents } = parseIntentMarks('明天给你看迷迷画的花 [intent:promise|给轻月看迷迷画的画|24]');
    expect(text).toBe('明天给你看迷迷画的花');
    expect(intents).toEqual([{ type: 'promise', content: '给轻月看迷迷画的画', hours: 24 }]);
  });

  it('多标记：全部解析 + 全部剥离', () => {
    const { text, intents } = parseIntentMarks('先答应你 [intent:promise|陪你看星星|12] 回头再说 [intent:delayed-reply|你问的那件事|1]');
    expect(intents).toHaveLength(2);
    expect(text).toBe('先答应你 回头再说');
  });

  it('延迟小时数钳制：0 → 1，99 → 72', () => {
    expect(parseIntentMarks('[intent:promise|x|0]').intents[0].hours).toBe(1);
    expect(parseIntentMarks('[intent:promise|x|99]').intents[0].hours).toBe(72);
  });

  it('无标记 → 原样返回', () => {
    const { text, intents } = parseIntentMarks('普通回复，没有意图');
    expect(text).toBe('普通回复，没有意图');
    expect(intents).toHaveLength(0);
  });

  it('非法类型 → 不匹配', () => {
    const { intents } = parseIntentMarks('[intent:unknown|内容|2]');
    expect(intents).toHaveLength(0);
  });
});
