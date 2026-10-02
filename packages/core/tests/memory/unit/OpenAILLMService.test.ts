// tests/memory/unit/OpenAILLMService.test.ts
import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import { OpenAILLMService } from '../../../src/memory/services/OpenAILLMService';
import type { ServiceConfig } from '../../../src/memory/services/config';

describe('OpenAILLMService', () => {
  const config: ServiceConfig = {
    chatBaseUrl: 'https://test-api.example.com/v1',
    chatApiKey: 'test-key',
    chatModel: 'test-chat-model',
    embedBaseUrl: 'https://test-embed.example.com/v1',
    embedApiKey: 'test-embed-key',
    embedModel: 'test-embed-model',
    embedDimension: 1536,
  };

  let service: OpenAILLMService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    service = new OpenAILLMService(config);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: object, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
      json: async () => response,
    });
  }

  it('should call chat completions endpoint with correct payload', async () => {
    mockFetch({
      choices: [{ message: { content: 'the response' } }],
    });

    const result = await service.complete('system prompt here', 'user prompt here');

    expect(result).toBe('the response');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-key',
        }),
      }),
    );

    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.model).toBe('test-chat-model');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'system prompt here' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'user prompt here' });
    // ★ 8-10 采样统一：不传第三参 → 默认取构造函数那份（profile.extract 槽）
    // ★ 2026-10-01 fix-profile-extract-empty-response：该槽从 1024 提到 4096 并开 JSON 模式
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(4096);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  // ★ 2026-10-01 fix-profile-extract-empty-response：**接口契约回归测试**。
  //   本方法此前只声明两个形参，把 ILLMService 约定的第三参 `sampling` 静默丢弃
  //   （TS 允许「少形参」赋给「多形参」签名，所以编译期不报错）——
  //   后果是 MemoryManager 的 slotify 按场景传槽**全部失效**，
  //   CronProcessor（要纯文本）被套上 profile.extract 的 json_object → API 400。
  it('★ 第三参 sampling 必须生效（替换默认槽，而非被丢弃）', async () => {
    mockFetch({ choices: [{ message: { content: 'ok' } }] });

    await service.complete('sys', 'user', { temperature: 0.9, max_tokens: 2048 });

    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.temperature).toBe(0.9);
    expect(body.max_tokens).toBe(2048);
    // 替换语义：调用方传的槽没有 response_format，就**不能**残留默认槽的 json_object
    // （否则 deepProfile 这类纯文本调用会被 API 400 拒掉）
    expect(body.response_format).toBeUndefined();
  });

  it('should throw on API error', async () => {
    mockFetch({ error: 'rate limit exceeded' }, 429);

    await expect(service.complete('sys', 'user')).rejects.toThrow('LLM API error 429');
  });

  it('should throw on empty response', async () => {
    mockFetch({ choices: [] });

    await expect(service.complete('sys', 'user')).rejects.toThrow('empty response');
  });
});
