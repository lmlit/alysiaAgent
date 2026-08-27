import { describe, it, expect } from 'vitest';
import { parseStickerMarks } from '../src/adapters/qq-official.js';

describe('parseStickerMarks — 表情包标记协议解析', () => {
  it('单标记：提取名字并从正文移除', () => {
    const { text, marks } = parseStickerMarks('晚安好梦哦 [表情包:睡觉]');
    expect(marks).toEqual(['睡觉']);
    expect(text).toBe('晚安好梦哦');
  });

  it('多标记：全部提取，正文全部移除', () => {
    const { text, marks } = parseStickerMarks('开心 [表情包:开心] 再来一个 [表情包:撒娇]');
    expect(marks).toEqual(['开心', '撒娇']);
    expect(text).toBe('开心 再来一个');
  });

  it('无标记：原样返回，marks 为空', () => {
    const { text, marks } = parseStickerMarks('普通消息，没有任何表情');
    expect(marks).toEqual([]);
    expect(text).toBe('普通消息，没有任何表情');
  });

  it('标记名字带空格：trim 后提取', () => {
    const { marks } = parseStickerMarks('[表情包: 睡觉 ]');
    expect(marks).toEqual(['睡觉']);
  });

  it('纯标记：正文为空', () => {
    const { text, marks } = parseStickerMarks('[表情包:睡觉]');
    expect(marks).toEqual(['睡觉']);
    expect(text).toBe('');
  });

  it('三连换行压缩为双换行', () => {
    const { text } = parseStickerMarks('第一段\n\n\n\n第二段');
    expect(text).toBe('第一段\n\n第二段');
  });

  // ★ 8-27 全角兼容：LLM 偶发输出 ［表情包:名字］/［表情包：名字］（实测全角未被解析
  //   原样发给用户 → 8-27 修复，解析端双保险）
  it('全角方括号 ［表情包:名字］→ 同样解析移除', () => {
    const { text, marks } = parseStickerMarks('晚安好梦哦 ［表情包:睡觉］');
    expect(marks).toEqual(['睡觉']);
    expect(text).toBe('晚安好梦哦');
  });

  it('全角冒号 ［表情包：名字］→ 同样解析移除', () => {
    const { text, marks } = parseStickerMarks('［表情包：嘻嘻］今天心情不错');
    expect(marks).toEqual(['嘻嘻']);
    expect(text).toBe('今天心情不错');
  });

  it('半角全角混用：全部提取', () => {
    const { text, marks } = parseStickerMarks('开心 [表情包:开心] 又 ［表情包:害羞］');
    expect(marks).toEqual(['开心', '害羞']);
    expect(text).toBe('开心 又');
  });
});
