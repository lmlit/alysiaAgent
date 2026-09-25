// tests/utils/llm-json.test.ts
// ★ 9-25 fix-session-summary-silent-failure
// 这些用例**直接编码线上真实故障**（2026-09-18 ~ 09-25 的三种报错），
// 不是假想的边界——每一条都对应服务器日志里出现过的一行：
//   Unexpected token '`', "```json      → 围栏
//   Unterminated string in JSON at pos  → 截断
//   Unexpected end of JSON input        → 空白
import { describe, it, expect } from 'vitest';
import { stripMarkdownFence, looksTruncated, parseLLMJson } from '../../src/utils/llm-json.js';

describe('stripMarkdownFence', () => {
  it('剥离 ```json 围栏', () => {
    expect(stripMarkdownFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('剥离无语言标记的 ``` 围栏', () => {
    expect(stripMarkdownFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('剥离后顺带去掉首尾空白', () => {
    expect(stripMarkdownFence('  \n```json\n{"a":1}\n```\n  ')).toBe('{"a":1}');
  });

  it('无围栏时原样返回（仅 trim）', () => {
    expect(stripMarkdownFence('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('null/undefined 安全', () => {
    expect(stripMarkdownFence(null as any)).toBe('');
    expect(stripMarkdownFence(undefined as any)).toBe('');
  });
});

describe('looksTruncated', () => {
  it('未闭合的对象 → 截断', () => {
    // 线上原句：Unterminated string in JSON at position 388
    expect(looksTruncated('{"summary":"今天过得不坏，只是那片干叶子碎在手里')).toBe(true);
  });

  it('未闭合的数组 → 截断', () => {
    expect(looksTruncated('[{"quote":"abc"')).toBe(true);
  });

  it('完整对象 → 非截断', () => {
    expect(looksTruncated('{"a":1}')).toBe(false);
  });

  it('字符串里含花括号不算错配', () => {
    expect(looksTruncated('{"a":"}{"}')).toBe(false);
  });

  it('转义引号不算未闭合', () => {
    expect(looksTruncated('{"a":"say \\"hi\\""}')).toBe(false);
  });

  it('不以 { 或 [ 开头 → 不算截断（交由裸文本分支处理）', () => {
    expect(looksTruncated('今天天气不错')).toBe(false);
  });
});

describe('parseLLMJson — 线上故障回归', () => {
  it('【9-21 线上原样】markdown 围栏 → 必须解析成 JSON，不能失败', () => {
    const raw = '```json\n{"summary":"今天聊了天气","topics":["天气"]}\n```';
    const r = parseLLMJson(raw);
    expect(r.kind).toBe('json');
    if (r.kind === 'json') {
      expect(r.value.summary).toBe('今天聊了天气');
      expect(r.value.topics).toEqual(['天气']);
    }
  });

  it('【9-18/9-25 线上原样】被截断的 JSON → 判为 bare + truncated=true', () => {
    const raw = '{"summary":"今天过得不坏，只是那片干叶子碎在手里时，我有';
    const r = parseLLMJson(raw);
    expect(r.kind).toBe('bare');
    if (r.kind === 'bare') expect(r.truncated).toBe(true);
  });

  it('【9-21 线上原样】空白响应 → empty（不是 bare）', () => {
    expect(parseLLMJson('').kind).toBe('empty');
    expect(parseLLMJson('   \n  ').kind).toBe('empty');
    expect(parseLLMJson('```json\n\n```').kind).toBe('empty');
  });

  it('正常 JSON → json', () => {
    const r = parseLLMJson('{"a":1}');
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(r.value).toEqual({ a: 1 });
  });

  it('裸文本（无 JSON 外壳）→ bare + truncated=false', () => {
    const r = parseLLMJson('今天没什么特别的，只是喝了杯茶。');
    expect(r.kind).toBe('bare');
    if (r.kind === 'bare') {
      expect(r.text).toBe('今天没什么特别的，只是喝了杯茶。');
      expect(r.truncated).toBe(false);
    }
  });

  it('围栏里是裸文本 → 剥围栏后按裸文本处理', () => {
    const r = parseLLMJson('```\n今天没什么特别的。\n```');
    expect(r.kind).toBe('bare');
    if (r.kind === 'bare') expect(r.text).toBe('今天没什么特别的。');
  });
});
