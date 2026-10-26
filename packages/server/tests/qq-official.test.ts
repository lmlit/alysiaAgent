import { describe, it, expect, vi } from 'vitest';
import { logger } from '@alysia/core/utils/logger';
import { QQOfficialAgentAdapter, parseStickerMarks } from '../src/adapters/qq-official.js';

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

// ★ 2026-10-26（KI-5 / change: harden-silent-failures）：坏帧以前是裸 catch {}
//   —— "消息没来"与"消息被静默丢掉"完全同形。现在必须 warn（限频），且不能抛。
describe('handleFramePayload — 坏帧必须留痕（KI-5）', () => {
  const makeAdapter = (): QQOfficialAgentAdapter =>
    new QQOfficialAgentAdapter({ appId: 'test', appSecret: 'test' } as any);

  it('非法 JSON：不抛、warn 一次、带阶段与字节数', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const raw = '{not json';
    const adapter = makeAdapter();

    expect(() => (adapter as any).handleFramePayload(raw, '测试')).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('测试帧解析失败');
    expect(line).toContain(`${Buffer.byteLength(raw)} bytes`);
    warn.mockRestore();
  });

  it('连续坏帧：前 3 次逐条，第 4 次起限频（防坏流刷屏）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const adapter = makeAdapter();

    for (let i = 0; i < 4; i++) (adapter as any).handleFramePayload('bad', '网关');

    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});
