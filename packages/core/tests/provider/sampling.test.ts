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
    // ★ 9-25 fix-session-summary-silent-failure：曾是 max_tokens 512 —— 太小，
    //   摘要要返回 6 字段 JSON（含逐字摘句），中文下必然触顶截断 → 线上 22 天 100% 失败。
    expect(s.session.summary).toEqual({ temperature: 0.3, max_tokens: 2048, response_format: 'json_object' });
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

  // ★ 9-25 fix-session-summary-silent-failure
  it('response_format 映射成 API 要的 {type:"json_object"}，不是裸字符串', () => {
    expect(slotToBody({ response_format: 'json_object' })).toEqual({
      response_format: { type: 'json_object' },
    });
  });

  it('未设 response_format 时不出现在 body 里（不干扰普通调用）', () => {
    expect(slotToBody({ temperature: 0.5 }).response_format).toBeUndefined();
  });
});

describe('mergeSampling — response_format（★ 9-25）', () => {
  it('默认 session.summary 带 json_object', () => {
    expect(DEFAULT_SAMPLING.session.summary.response_format).toBe('json_object');
  });

  // ★ 9-25 教训固化：CHAT_MODEL 是**推理模型**，每次调用先花 ~250 tokens 在 reasoning 上，
  //   可见内容与 reasoning 共用同一个 max_tokens 预算。512 会让对话稍长时内容额度归零
  //   → 空响应。这同一个 512 造成了线上「会话摘要 22 天 100% 失败」与「每日反思 11 次
  //   empty response」两处故障。此测试防止有人把预算又调回小值。
  it('★ 结构化输出槽位的 max_tokens 必须给 reasoning 留余量（≥1024）', () => {
    expect(DEFAULT_SAMPLING.session.summary.max_tokens!).toBeGreaterThanOrEqual(1024);
    expect(DEFAULT_SAMPLING.life.generateSummary.max_tokens!).toBeGreaterThanOrEqual(1024);
  });

  it('其它槽位默认不带（避免误开 JSON 模式）', () => {
    expect(DEFAULT_SAMPLING.life.generateEvent.response_format).toBeUndefined();
    expect(DEFAULT_SAMPLING.profile.extract.response_format).toBeUndefined();
  });

  it('合并时 response_format 不被 hasValue 丢掉（它是字符串不是数字）', () => {
    const s = mergeSampling({ session: { summary: { max_tokens: 4096 } } });
    // 覆盖了 max_tokens，但 response_format 仍保留自默认
    expect(s.session.summary).toEqual({
      temperature: 0.3,
      max_tokens: 4096,
      response_format: 'json_object',
    });
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
