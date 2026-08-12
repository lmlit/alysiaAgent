// tests/provider/openai.test.ts — ★ 8-12 60s 超时 Promise.race 修复（llm-request-timeout-race）
// 根因：AbortController 无法中断 undici fetch 的 DNS/连接建立阶段，网络故障时
// 请求挂到 DNS 系统超时（线上实测 566s）；race 保证准时返回 timed out
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from '../../src/provider/openai.js';

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({ id: 'test', baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm' } as any);
}

function makeReq(extra: Record<string, unknown> = {}) {
  return { prompt: 'hi', sessionId: 's1', systemPrompt: '', contexts: [], ...extra } as any;
}

function mockOkResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '你好' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  } as any;
}

describe('OpenAIProvider.textChat 超时与打断', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('正常请求 → assistant 回复', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockOkResponse()));
    const p = makeProvider();
    const resp = await p.textChat(makeReq());
    expect(resp.role).toBe('assistant');
    expect(resp.completionText).toBe('你好');
    expect(resp.usage).toEqual({ input: 10, output: 5, total: 15 });
  });

  // ★ 8-12 核心场景：fetch 挂起（DNS/连接层不可 abort）→ 60s 准时返回 timed out
  it('fetch 挂起（不 reject、不响应 abort）→ 60s 超时返回 timed out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {}))); // 永久挂起
    const p = makeProvider();
    const respPromise = p.textChat(makeReq());

    // 推进 59s：尚未超时（不 resolve）
    await vi.advanceTimersByTimeAsync(59_000);
    let settled = false;
    respPromise.then(() => { settled = true; });
    expect(settled).toBe(false);

    // 推进过 60s → race 超时 reject → 返回 timed out
    const resp = await Promise.race([respPromise, vi.advanceTimersByTimeAsync(2_000).then(() => respPromise)]);
    expect(resp.role).toBe('err');
    expect(resp.completionText).toBe('Request timed out (60s)');
  });

  it('外部 signal abort → 返回 aborted（token 未计入）', async () => {
    const ctrl = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: any) => {
      ctrl.abort(); // 模拟：请求发出后新消息打断
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return mockOkResponse();
    }));
    const p = makeProvider();
    const resp = await p.textChat(makeReq({ signal: ctrl.signal }));
    expect(resp.role).toBe('err');
    expect(resp.completionText).toBe('Request aborted');
  });

  it('API 非 200 → err（含状态码）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as any));
    const p = makeProvider();
    const resp = await p.textChat(makeReq());
    expect(resp.role).toBe('err');
    expect(resp.completionText).toContain('429');
  });
});
