import { describe, it, expect } from 'vitest';
import { segmentText } from '../src/adapters/qq-official.js';

describe('segmentText — 长文案分段（8-09）', () => {
  it('短文本不切', () => {
    expect(segmentText('早安，轻月')).toEqual(['早安，轻月']);
  });

  it('多句合并到 ≤40 字一段', () => {
    expect(segmentText('第一句。第二句！第三句？')).toEqual(['第一句。第二句！第三句？']);
  });

  it('超过 40 字按标点合段（除最后一段外每段 ≤40）', () => {
    const long = '这是一句很长的话。' + '这又是一句很长的话。'.repeat(8);
    const segs = segmentText(long);
    expect(segs.length).toBeGreaterThan(1);
    for (let i = 0; i < segs.length - 1; i++) {
      expect(segs[i].length).toBeLessThanOrEqual(40);
    }
    expect(segs.join('').replace(/\s/g, '')).toBe(long.replace(/\s/g, ''));
  });

  it('无标点长文本硬切兜底', () => {
    const segs = segmentText('字'.repeat(100));
    expect(segs).toHaveLength(3); // 40 + 40 + 20
    expect(segs[0]).toBe('字'.repeat(40));
  });

  it('尾部碎段并入上一段', () => {
    const segs = segmentText('一二三四五六七八九十。'.repeat(4) + '好。');
    const last = segs[segs.length - 1];
    expect(last).toContain('好。'); // 并入而非单独一段
  });

  it('超长句按弱停顿（逗号）切分', () => {
    const longSentence = '这是一句非常非常长的句子，其中包含很多内容，需要按逗号切分，才能避免硬切，保证自然。';
    const segs = segmentText(longSentence);
    expect(segs.every(s => s.length <= 40 || segs.length === 1)).toBe(true);
    expect(segs.join('').replace(/\s/g, '')).toBe(longSentence.replace(/\s/g, ''));
  });

  it('空串与纯标点安全（纯标点不成段）', () => {
    expect(segmentText('')).toEqual([]);
    expect(segmentText('。。。')).toEqual([]);
  });

  it('换行符分段（LLM 输出的自然段）', () => {
    expect(segmentText('第一段的话。\n第二段的话。')).toEqual(['第一段的话。', '第二段的话。']);
    expect(segmentText('没有句号的第一行\n没有句号的第二行')).toHaveLength(2);
  });
});
