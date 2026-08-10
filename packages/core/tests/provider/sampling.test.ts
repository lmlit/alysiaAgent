// tests/provider/sampling.test.ts — ★ 8-10 采样参数统一配置（sampling-config-unify）
import { describe, it, expect } from 'vitest';
import { DEFAULT_SAMPLING, mergeSampling, slotToBody } from '../../src/provider/sampling';
import { OpenAIProvider } from '../../src/provider/openai';
import type { ProviderConfig, ProviderRequest } from '../../src/provider/types';

describe('mergeSampling', () => {
  it('returns DEFAULT when no config', () => {
    const s = mergeSampling(undefined);
    expect(s.chat).toEqual({});
    expect(s.vision.describe).toEqual({ temperature: 0.1, max_tokens: 200 });
    expect(s.life.generateEvent).toEqual({ temperature: 0.9 });
    expect(s.profile.extract).toEqual({ temperature: 0.1, max_tokens: 1024 });
    expect(s.session.summary).toEqual({ temperature: 0.3, max_tokens: 512 });
  });

  it('deep-merges only provided fields (undefined/null skipped)', () => {
    const s = mergeSampling({
      life: { generateEvent: { temperature: 1.2 } },
      chat: { temperature: 0.7 },
    });
    expect(s.life.generateEvent).toEqual({ temperature: 1.2 }); // 覆盖
    expect(s.life.generateSummary).toEqual(DEFAULT_SAMPLING.life.generateSummary); // 未覆盖保持默认
    expect(s.chat).toEqual({ temperature: 0.7 });
    expect(s.vision.describe).toEqual(DEFAULT_SAMPLING.vision.describe);
  });

  it('partial slot with some undefined fields keeps base values', () => {
    const s = mergeSampling({ vision: { describe: { max_tokens: 512 } } });
    expect(s.vision.describe).toEqual({ temperature: 0.1, max_tokens: 512 });
  });
});

describe('slotToBody', () => {
  it('drops undefined fields', () => {
    expect(slotToBody({ temperature: 0.5, max_tokens: undefined })).toEqual({ temperature: 0.5 });
    expect(slotToBody(undefined)).toEqual({});
  });
});

describe('OpenAIProvider body assembly', () => {
  const provider = new OpenAIProvider({ id: 'test', type: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'm' } as ProviderConfig);

  it('merges sampling fields into request body', async () => {
    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }), text: async () => '' };
    }) as any;

    try {
      const req: ProviderRequest = {
        prompt: 'hi',
        sessionId: 's',
        sampling: { temperature: 0.7, presence_penalty: 0.2 },
      };
      await provider.textChat(req);
      expect(capturedBody.temperature).toBe(0.7);
      expect(capturedBody.presence_penalty).toBe(0.2);
      expect(capturedBody.max_tokens).toBeUndefined(); // 未传字段不进 body
      expect(capturedBody.stream).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not send sampling fields when req.sampling is absent', async () => {
    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }), text: async () => '' };
    }) as any;

    try {
      await provider.textChat({ prompt: 'hi', sessionId: 's' } as ProviderRequest);
      expect(capturedBody.temperature).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
