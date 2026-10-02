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
    // ★ 2026-10-01 fix-profile-extract-empty-response：曾是 max_tokens 1024 且无 JSON 模式。
    //   1024 被 reasoning 吃光 → 空响应 → ProfileExtractor 裸 catch 吞掉 → 画像长期不生长。
    expect(s.profile.extract).toEqual({ temperature: 0.1, max_tokens: 4096, response_format: 'json_object' });
    // CronProcessor.deepProfile 专用：纯文本输出，**不能**带 response_format
    expect(s.profile.deepRewrite).toEqual({ temperature: 0.3, max_tokens: 2048 });
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
  it('★ 需要 LLM 生成内容的槽位，max_tokens 必须给 reasoning 留余量（≥2048）', () => {
    // ★ 2026-10-01 fix-profile-extract-empty-response：
    //   这个守卫**原先漏了 profile 两个槽**，于是 `profile.extract` 的 1024
    //   与 `profile.deepRewrite` 的「无限制」都逃过了它——而它们正是同一类故障：
    //   实测 1024 被 reasoning 吃光仍没结束（finish_reason=length）→ content 为空。
    //   把它们补进守卫，这类 bug 才不会再从缝里漏过去。
    expect(DEFAULT_SAMPLING.session.summary.max_tokens!).toBeGreaterThanOrEqual(2048);
    expect(DEFAULT_SAMPLING.life.generateSummary.max_tokens!).toBeGreaterThanOrEqual(2048);
    expect(DEFAULT_SAMPLING.profile.extract.max_tokens!).toBeGreaterThanOrEqual(2048);
    expect(DEFAULT_SAMPLING.profile.deepRewrite.max_tokens!).toBeGreaterThanOrEqual(2048);
  });

  // ★ 2026-10-01：JSON 模式的两条守卫**按输出契约分类**，而不是按槽名列举。
  //   原因：`response_format: 'json_object'` 要求 prompt 里含 "json" 字样，
  //   否则 API 直接 400。所以判据是「该槽的**全部**消费者是否都产 JSON」，
  //   不是「这个槽看起来像不像结构化任务」。
  //   （反面教材：profile.extract 曾被误判为"非结构化槽"而不该带它；
  //     CronProcessor.deepProfile 又因为与它共用槽而被套上它 → 400。）
  it('结构化输出槽位（消费者 prompt 均含 "json"）必须开 JSON 模式', () => {
    // ProfileExtractor「返回JSON」/ PersonaAdapter「返回JSON」/ SessionEndProcessor 六字段 JSON
    expect(DEFAULT_SAMPLING.profile.extract.response_format).toBe('json_object');
    expect(DEFAULT_SAMPLING.session.summary.response_format).toBe('json_object');
  });

  it('纯文本输出槽位不得带 JSON 模式（否则 API 400）', () => {
    // deepRewrite 的 prompt 是「返回纯文本总结」，里面没有 "json"
    expect(DEFAULT_SAMPLING.profile.deepRewrite.response_format).toBeUndefined();
    expect(DEFAULT_SAMPLING.life.generateEvent.response_format).toBeUndefined();
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
