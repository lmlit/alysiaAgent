/**
 * 自省人称归一的守卫（★ 2026-10-25，change: `first-person-self-facts`）
 *
 * 生产实测：48 条 `character_facts` 里 **5 条是第三人称**，它们被原样注入【关于我】⇒
 * 她读到时像在说别人（"昔涟会…"）。prompt 里写的是"第一人称"，但模型会漂移 ——
 * 所以**在写入端做确定性归一**，不指望 prompt 的自觉。
 */
import { describe, it, expect } from 'vitest';
import { normalizeSelfFact, needsSelfFactNormalize } from '../../../src/memory/self-facts';

describe('normalizeSelfFact —— 第三人称 → 第一人称', () => {
  it('★ 生产里真实出现过的 5 条，逐条归一', () => {
    const cases: Array<[string, string]> = [
      ['昔涟昨天给用户发了很多消息。', '我昨天给用户发了很多消息。'],
      ['昔涟会对用户表达亲昵/肉麻的话', '我会对用户表达亲昵/肉麻的话'],
      ['昔涟可能处于容易劳累或忙碌的状态', '我可能处于容易劳累或忙碌的状态'],
      ['昔涟有博客（或用户认为/提及她有博客）。', '我有博客（或用户认为/提及她有博客）。'],
      ['昔涟与“月光花园”链接有关/拥有月光花园', '我与“月光花园”链接有关/拥有月光花园'],
    ];
    for (const [input, want] of cases) {
      expect(normalizeSelfFact(input), input).toBe(want);
    }
  });

  it('「她」作主语开头 → 「我」', () => {
    expect(normalizeSelfFact('她会记得这些小事')).toBe('我会记得这些小事');
    expect(normalizeSelfFact('她对热闹没什么兴趣')).toBe('我对热闹没什么兴趣');
  });

  it('★ 已经是第一人称的原样返回（不许改坏）', () => {
    for (const s of [
      '我其实不怕清苦，怕的是没提前看一眼。',
      '我其实很享受被需要的时刻',
      '人家其实有点在意这个',
    ]) {
      expect(normalizeSelfFact(s)).toBe(s);
      expect(needsSelfFactNormalize(s), `不该被判为需要归一：${s}`).toBe(false);
    }
  });

  it('「小昔涟」也归一到「我」', () => {
    expect(normalizeSelfFact('小昔涟喜欢下雨天')).toBe('我喜欢下雨天');
  });

  it('★ 不动中间的第三人称（「我告诉她」是正常的）', () => {
    expect(normalizeSelfFact('我告诉昔涟这件事')).toBe('我告诉昔涟这件事');
    expect(normalizeSelfFact('我告诉她我在忙')).toBe('我告诉她我在忙');
  });

  it('★ 不动以「用户/轻月」开头的（那是被错放进来的"关于他"，不该伪装成自省）', () => {
    expect(normalizeSelfFact('用户晚上不喝茶')).toBe('用户晚上不喝茶');
    expect(normalizeSelfFact('轻月喜欢简洁的回答')).toBe('轻月喜欢简洁的回答');
  });

  it('空串/空白安全', () => {
    expect(normalizeSelfFact('')).toBe('');
    expect(normalizeSelfFact('   ')).toBe('');
  });
});
