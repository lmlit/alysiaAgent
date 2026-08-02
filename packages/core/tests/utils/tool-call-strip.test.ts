import { describe, it, expect } from 'vitest';
import { stripToolCallText } from '../../src/utils/tool-call-strip.js';

describe('stripToolCallText — 剥离 LLM 回复中的工具调用残留文本', () => {
  it('正常文本原样返回', () => {
    expect(stripToolCallText('你好呀，今天天气不错～')).toBe('你好呀，今天天气不错～');
    expect(stripToolCallText('')).toBe('');
  });

  it('剥离 tool_calls 完整块，保留前置文案', () => {
    const text = '好的，我来帮你查一下附近适合散步的地方～\n\n<tool_calls>\n<invoke name="web_search">\n<parameter name="query">长沙 公园 散步</parameter>\n</invoke>\n</tool_calls>';
    expect(stripToolCallText(text)).toBe('好的，我来帮你查一下附近适合散步的地方～');
  });

  it('剥离孤立 invoke 对（无 tool_calls 容器）', () => {
    const text = '马上查一下～<invoke name="web_search"><parameter name="query">天气</parameter></invoke>好了查完了';
    expect(stripToolCallText(text)).toBe('马上查一下～好了查完了');
  });

  it('剥离 Anthropic 风格 antml: 变体', () => {
    const text = '我来搜索<antml:invoke name="web_search"><antml:parameter name="query">测试</antml:parameter></antml:invoke>';
    expect(stripToolCallText(text)).toBe('我来搜索');
  });

  it('剥离自闭合 invoke 标签', () => {
    expect(stripToolCallText('查一下<invoke name="web_search" arg="1"/>完')).toBe('查一下完');
  });

  it('剥离未闭合 tool_calls 容器（模型截断场景）：删到文本末尾', () => {
    const text = '好的，稍等～\n\n<tool_calls>\n<invoke name="web_search">\n<parameter name="query">长沙';
    expect(stripToolCallText(text)).toBe('好的，稍等～');
  });

  it('剥离孤立残留闭包标签', () => {
    expect(stripToolCallText('结果如下</tool_calls>完成')).toBe('结果如下完成');
  });

  it('剥离后清理多余空行和多余空格', () => {
    const text = '第一段\n\n\n\n第二段  <invoke name="web_search" x="1"/>  末尾';
    expect(stripToolCallText(text)).toBe('第一段\n\n第二段 末尾');
  });

  it('无 < 字符时零开销原样返回', () => {
    const text = '纯文本没有任何标签';
    expect(stripToolCallText(text)).toBe(text);
  });
});
