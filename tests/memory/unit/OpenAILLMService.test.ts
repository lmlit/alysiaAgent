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
    expect(body.temperature).toBe(0.3);
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
