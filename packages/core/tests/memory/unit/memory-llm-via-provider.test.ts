/**
 * ★ 2026-10-20（change: `let-memory-use-provider`，B3）
 *
 * 收编的能力：让记忆链路可以经 `ProviderManager.textChatWithFallback`（拿到 fallback
 * 与统一 provider 观测）。**默认不开**，本文件测的就是"开了要对、没开不变"。
 *
 * 三件事必须钉住：
 *   ① **超时要带过去**（120s）—— 否则记忆链路被 provider 的 60s 判死，
 *      而 `profile.extract` 是 4096 tokens 的结构化 JSON，合法耗时已观测 29.7s
 *   ② **错误语义要翻译回契约**：provider 用 `{role:'err'}` 表达失败（**不抛**），
 *      而契约 6.2 要「超时」字样、契约 7.4 要 `LLM API error <status>: <body>`
 *   ③ **契约 5 的 `[LLM:memory]` 标签不能丢**（槽位归属），即使走 provider
 */
import { describe, it, expect, vi } from 'vitest';
import { MemoryLlmClient, MEMORY_LLM_TIMEOUT_MS } from '../../../src/memory/services/MemoryLlmClient';

const endpoint = { baseUrl: 'https://llm.example.com/v1', apiKey: 'k-1', model: 'm-1' };

function fakeProvider(resp: any) {
  return { textChatWithFallback: vi.fn(async () => resp) };
}

describe('memory LLM 经 ProviderManager（默认关，开启后等价可用）', () => {
  it('★ 不传 provider ⇒ 走直连 fetch（默认行为完全不变）', async () => {
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as any;
    }) as any;

    const c = new MemoryLlmClient(endpoint);
    await expect(c.complete('sys', 'usr')).resolves.toBe('ok');
    expect(calls).toHaveLength(1);
    expect(String(calls[0].url)).toBe('https://llm.example.com/v1/chat/completions');
  });

  it('★ 传了 provider ⇒ 走它，且把 120s 超时带过去', async () => {
    const p = fakeProvider({ role: 'assistant', completionText: 'via-provider' });
    const c = new MemoryLlmClient(endpoint, { provider: p as any });

    await expect(c.complete('sys', 'usr', { temperature: 0.2 })).resolves.toBe('via-provider');

    const [req, fallbackIds] = p.textChatWithFallback.mock.calls[0] as unknown as [any, any];
    expect(req.systemPrompt).toBe('sys');
    expect(req.prompt).toBe('usr');
    expect(req.sampling).toEqual({ temperature: 0.2 });
    expect(req.timeoutMs, '记忆链路是批处理，必须 120s').toBe(MEMORY_LLM_TIMEOUT_MS);
    expect(fallbackIds).toEqual([]);
  });

  it('★ provider 报超时 ⇒ 翻译回契约 6.2 的中文文案', async () => {
    const p = fakeProvider({ role: 'err', completionText: 'LLM request timed out (120s)' });
    const c = new MemoryLlmClient(endpoint, { provider: p as any });
    await expect(c.complete('sys', 'usr')).rejects.toThrow(/LLM 请求超时（120s）/);
  });

  it('★ provider 的 API error ⇒ 补成契约 7.4 的 `LLM API error <status>: <body>`', async () => {
    const p = fakeProvider({ role: 'err', completionText: 'API error 429: rate limit' });
    const c = new MemoryLlmClient(endpoint, { provider: p as any });
    await expect(c.complete('sys', 'usr')).rejects.toThrow('LLM API error 429: rate limit');
  });

  it('★ 走 provider 也要保留 `[LLM:memory]`（契约 5 的槽位归属）', async () => {
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
    const p = fakeProvider({
      role: 'assistant', completionText: '内容',
      usage: { input: 10, output: 5, total: 15 }, finishReason: 'stop',
    });
    const c = new MemoryLlmClient(endpoint, { provider: p as any, logger });
    await c.complete('sys', 'usr');
    expect(lines.join('\n')).toContain('[LLM:memory]');
    expect(lines.join('\n')).toContain('tokens=10+5=15');
    expect(lines.join('\n')).toContain('finish=stop');
  });

  it('provider 返回空内容 ⇒ 仍按「生产语义」warn 后返回空串', async () => {
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
    const p = fakeProvider({ role: 'assistant', completionText: '', finishReason: 'length' });
    const c = new MemoryLlmClient(endpoint, { provider: p as any, logger });
    await expect(c.complete('sys', 'usr')).resolves.toBe('');
    expect(lines.join('\n')).toContain('EMPTY content');
  });

  it('providerRef 懒取：未启用时不调用、启用后才取', async () => {
    const p = fakeProvider({ role: 'assistant', completionText: 'lazy' });
    const ref = vi.fn(() => p as any);
    const c = new MemoryLlmClient(endpoint, { providerRef: ref });
    await expect(c.complete('sys', 'usr')).resolves.toBe('lazy');
    expect(ref).toHaveBeenCalledTimes(1);
  });
});
