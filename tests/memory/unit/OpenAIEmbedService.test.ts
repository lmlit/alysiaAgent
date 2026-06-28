// tests/memory/unit/OpenAIEmbedService.test.ts
import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIEmbedService } from '../../../src/memory/services/OpenAIEmbedService';
import type { ServiceConfig } from '../../../src/memory/services/config';

describe('OpenAIEmbedService', () => {
  const config: ServiceConfig = {
    baseUrl: 'https://test-api.example.com/v1',
    apiKey: 'test-key',
    embedModel: 'test-embed-model',
    embedDimension: 1536,
    chatModel: 'test-chat-model',
  };

  let service: OpenAIEmbedService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    service = new OpenAIEmbedService(config);
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

  it('should call embed endpoint with correct payload', async () => {
    const embedResponse = {
      data: [{ embedding: new Array(1536).fill(0.1) }],
    };
    mockFetch(embedResponse);

    const vector = await service.embed('hello world');

    expect(vector).toHaveLength(1536);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://test-api.example.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.model).toBe('test-embed-model');
    expect(body.input).toEqual(['hello world']);
  });

  it('should auto-detect dimension from first response', async () => {
    const embedResponse = {
      data: [{ embedding: new Array(2048).fill(0.1) }],
    };
    mockFetch(embedResponse);

    await service.embed('hello');
    expect(service.dimension()).toBe(2048);
  });

  it('should report configured dimension', () => {
    expect(service.dimension()).toBe(1536);
  });

  it('should throw on API error', async () => {
    mockFetch({ error: 'invalid api key' }, 401);

    await expect(service.embed('hello')).rejects.toThrow('Embed API error 401');
  });

  it('should throw on empty response', async () => {
    mockFetch({ data: [] });

    await expect(service.embed('hello')).rejects.toThrow('unexpected response');
  });
});
