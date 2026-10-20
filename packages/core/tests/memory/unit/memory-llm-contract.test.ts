/**
 * ★ 2026-10-20（change: unify-memory-llm-client；KI-3）
 *
 * **为什么有这个文件**：记忆链路曾有两套 LLM 客户端（生产内联字面量 + `OpenAILLMService`），
 * 而且它们**已经分叉**：生产有 120s 超时与 `[LLM:memory]` 观测，`OpenAILLMService` 两者都没有，
 * 而 E2E 测的正是后者 ⇒ **E2E 不代表生产**。
 *
 * KI-3 的原始要求就是这一条：「对同一槽，两个实现产出的 request body 必须相同」。
 * 现在两者共用 `MemoryLlmClient`，本测试锁住的是**装配层**不出岔子
 * （构造默认槽、sampling 透传、signal 存在）—— 光有共享类还不够，
 * 适配器传错参数一样会分叉。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryLlmClient, MEMORY_LLM_TIMEOUT_MS } from '../../../src/memory/services/MemoryLlmClient';
import { OpenAILLMService } from '../../../src/memory/services/OpenAILLMService';
import type { ServiceConfig } from '../../../src/memory/services/config';

const endpoint = { baseUrl: 'https://llm.example.com/v1', apiKey: 'k-1', model: 'm-1' };

const serviceConfig: ServiceConfig = {
  chatBaseUrl: endpoint.baseUrl,
  chatApiKey: endpoint.apiKey,
  chatModel: endpoint.model,
  embedBaseUrl: 'https://embed.example.com/v1',
  embedApiKey: 'k-2',
  embedModel: 'm-2',
  embedDimension: 1024,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 用 mock fetch 抓 request body，返回响应内容。 */
function capture(): { body: () => any; init: () => RequestInit } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    } as any;
  }) as any;
  return {
    body: () => JSON.parse(String(calls[0].init.body)),
    init: () => calls[0].init,
  };
}

describe('记忆链路 LLM 客户端契约', () => {
  it('★ 同一显式 slot：两个入口发出的 request body 逐字相同', async () => {
    const slot = { temperature: 0.42, top_p: 0.9, max_tokens: 777 };

    const capA = capture();
    await new MemoryLlmClient(endpoint).complete('sys', 'usr', slot);
    const bodyA = capA.body();

    const capB = capture();
    await new OpenAILLMService(serviceConfig).complete('sys', 'usr', slot);
    const bodyB = capB.body();

    expect(bodyB).toEqual(bodyA);
    // 顺带锁住历史 bug：第三参 sampling 不得被静默丢弃
    expect(bodyA.temperature).toBe(0.42);
    expect(bodyA.max_tokens).toBe(777);
  });

  it('★ 两个入口都必须带 signal（超时能力不是生产独有）', async () => {
    const capA = capture();
    await new MemoryLlmClient(endpoint).complete('sys', 'usr');
    expect(capA.init().signal).toBeInstanceOf(AbortSignal);

    const capB = capture();
    await new OpenAILLMService(serviceConfig).complete('sys', 'usr');
    expect(capB.init().signal).toBeInstanceOf(AbortSignal);
  });

  it('生产语义：不传 slot ⇒ 不带任何采样字段（走服务端默认）', async () => {
    const cap = capture();
    await new MemoryLlmClient(endpoint).complete('sys', 'usr');
    const body = cap.body();
    expect(body.model).toBe('m-1');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it('★ 超时：abort 底层请求并抛出可读错误（KI-21 的修复不能被重构弄丢）', async () => {
    let aborted = false;
    globalThis.fetch = vi.fn((_url: any, init: any) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        rej(new Error('aborted by client'));
      });
    })) as any;

    const client = new MemoryLlmClient(endpoint, { timeoutMs: 30 });
    await expect(client.complete('sys', 'usr')).rejects.toThrow(/超时/);
    expect(aborted, '超时必须 abort 底层连接，不能只 reject').toBe(true);
  });

  it('空响应：生产语义 = warn + 返回空串；测试语义 = 抛错（差异显式化）', async () => {
    const warns: string[] = [];
    const logger = { info() {}, warn: (m: string) => { warns.push(m); } };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    })) as any;

    const prod = new MemoryLlmClient(endpoint, { logger });
    await expect(prod.complete('sys', 'usr')).resolves.toBe('');
    expect(warns.join('\n')).toContain('EMPTY content');
    expect(warns.join('\n')).toContain('finish=length');

    const testOnly = new MemoryLlmClient(endpoint, { throwOnEmpty: true });
    await expect(testOnly.complete('sys', 'usr')).rejects.toThrow(/empty response/);
  });

  // ── ★ 2026-10-20（change: tidy-a-class-seams，A 类）：观测与信封字段也必须一致 ──
  //   理由：两个入口若只保证 body 相同，仍可能在**请求头 / URL / 错误文案**上分叉 ——
  //   而这三样正是排查时最先看的（"是不是 key 没带""路径拼错了""报错格式不一样"）。

  it('★ 请求信封一致：URL 拼接 + 两个请求头', async () => {
    const capA = capture();
    await new MemoryLlmClient(endpoint).complete('sys', 'usr');
    const a = { url: calls0Url(), headers: capA.init().headers };

    const capB = capture();
    await new OpenAILLMService(serviceConfig).complete('sys', 'usr');
    const b = { url: calls0Url(), headers: capB.init().headers };

    expect(b.url).toBe(a.url);
    expect(a.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(b.headers).toEqual(a.headers);
    expect(a.headers).toEqual({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer k-1',
    });

    function calls0Url(): string {
      return (globalThis.fetch as any).mock.calls[0][0];
    }
  });

  it('★ 错误文案一致：`LLM API error <status>: <body>`（两条链路同形）', async () => {
    const mockError = () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'boom',
        json: async () => ({}),
      })) as any;
    };

    mockError();
    await expect(new MemoryLlmClient(endpoint).complete('sys', 'usr')).rejects.toThrow('LLM API error 500: boom');

    mockError();
    await expect(new OpenAILLMService(serviceConfig).complete('sys', 'usr')).rejects.toThrow('LLM API error 500: boom');
  });

  it('★ 默认超时锁在 120s（契约 6.1：批处理链路，不是交互式的 60s）', () => {
    expect(MEMORY_LLM_TIMEOUT_MS).toBe(120_000);
  });
});
