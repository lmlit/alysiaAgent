// tests/provider/openai.test.ts — ★ 8-12 60s 超时 Promise.race 修复（llm-request-timeout-race）
// 根因：AbortController 无法中断 undici fetch 的 DNS/连接建立阶段，网络故障时
// 请求挂到 DNS 系统超时（线上实测 566s）；race 保证准时返回 timed out
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from '../../src/provider/openai.js';
import { logger } from '../../src/utils/logger.js';

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

  // ───────────────────────────────────────────────────────────
  // ★ 第三批（2026-10-16）· 请求取消：超时后必须**回收**底层请求
  //
  // 旧实现：60s race 到点只 `reject(...)`，**从不调用 `controller.abort()`**
  // ⇒ race 保证了「准时返回」，但**已建立的连接继续挂着**（后端继续生成、socket 不释放）。
  // 这两件事**分工不同**：`abort` 到不了 DNS/连接建立阶段，所以「准时」只能靠 race；
  // 而「回收」只能靠 abort。修的时候别把 race 删掉换 abort。
  // ───────────────────────────────────────────────────────────
  it('★★ 主症：超时后**必须 abort 底层请求**（否则连接不释放、后端继续跑）', async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: any) => {
      captured = opts.signal;
      return new Promise(() => {});   // 永久挂起（DNS/连接层，abort 传不到）
    }));
    const p = makeProvider();
    const respPromise = p.textChat(makeReq());

    await vi.advanceTimersByTimeAsync(61_000);
    const resp = await respPromise;

    expect(resp.completionText).toBe('Request timed out (60s)');
    expect(captured, 'fetch 没拿到 signal').toBeDefined();
    expect(captured!.aborted, '超时后没有 abort 底层请求 —— 连接与后端生成都还在跑').toBe(true);
  });

  // ───────────────────────────────────────────────────────────
  // ★ 第三批 · 监听泄漏：`{ once: true }` 只在**触发时**自动摘除
  //
  // 外部 signal（Coalescer 的打断注册表）是**长寿命**对象，而**大多数请求正常跑完**
  // （永远不会触发 abort）⇒ 每次请求都在它身上残留一个闭包，只增不减。
  // ───────────────────────────────────────────────────────────
  it('★★ 外部 signal 上的监听必须在请求结束后摘掉（长会话下不然会只增不减）', async () => {
    const { getEventListeners } = await import('node:events');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockOkResponse()));
    const outer = new AbortController();
    // 长寿命信号：模拟 Coalescer 的打断注册表（跨很多次请求复用同一个 signal）
    const before = getEventListeners(outer.signal, 'abort').length;

    const p = makeProvider();
    for (let i = 0; i < 5; i++) await p.textChat(makeReq({ signal: outer.signal }));

    expect(
      getEventListeners(outer.signal, 'abort').length,
      '每次请求都在长寿命 signal 上残留了一个监听',
    ).toBe(before);
  });

  it('回归：外部打断仍然生效（摘监听不能把打断功能也摘掉）', async () => {
    let captured: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: any) => {
      captured = opts.signal;
      return mockOkResponse();
    }));
    const outer = new AbortController();
    const p = makeProvider();

    await p.textChat(makeReq({ signal: outer.signal }));
    // 请求已结束，此时外部 signal 上不该再挂着监听
    outer.abort();
    expect(captured!.aborted, '请求结束后外部 abort 不该再影响那次已完成的请求').toBe(false);
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

// ★ 2026-10-02 add-llm-budget-observability：
//   CHAT_MODEL 是推理模型，reasoning 与可见内容共用同一个 max_tokens 预算。
//   finish=length + content 为空 是「预算被吃光」的唯一可靠判据——
//   在此之前这两个字段根本没被解析，所以 KI-1 无法判定。
describe('OpenAIProvider.textChat 预算观测（finish_reason / reasoning_tokens）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockResponseWith(choice: unknown, usage: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [choice], usage }),
    } as any;
  }

  it('解析 finish_reason 与 reasoning_tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponseWith(
      { message: { role: 'assistant', content: '{"content":"x"}' }, finish_reason: 'stop' },
      { prompt_tokens: 1200, completion_tokens: 310, total_tokens: 1510, completion_tokens_details: { reasoning_tokens: 242 } },
    )));
    const resp = await new OpenAIProvider({ id: 't', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } as any).textChat(makeReq());
    expect(resp.finishReason).toBe('stop');
    expect(resp.usage).toEqual({ input: 1200, output: 310, total: 1510, reasoningTokens: 242 });
  });

  // ★ KI-1 的现场：预算被推理吃光 → completion_tokens 全花在 reasoning 上、content 为空
  it('finish_reason=length + content 为空 → 仍返回 assistant 但内容空（预算耗尽现场）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponseWith(
      { message: { role: 'assistant', content: '' }, finish_reason: 'length' },
      { prompt_tokens: 900, completion_tokens: 1024, total_tokens: 1924, completion_tokens_details: { reasoning_tokens: 1024 } },
    )));
    const resp = await new OpenAIProvider({ id: 't', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } as any).textChat(makeReq());
    expect(resp.role).toBe('assistant');
    expect(resp.completionText).toBe('');
    expect(resp.finishReason).toBe('length');
    expect(resp.usage?.reasoningTokens).toBe(1024);
    // 空响应必须可见，且日志要指出这是预算问题而不是别的
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EMPTY content');
    expect(String(warn.mock.calls[0][0])).toContain('finish=length');
  });

  it('finish!=length 的空响应 → 日志明确说"不是预算问题"（避免误导排查方向）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponseWith(
      { message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
      { prompt_tokens: 900, completion_tokens: 5, total_tokens: 905 },
    )));
    await new OpenAIProvider({ id: 't', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } as any).textChat(makeReq());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('不是预算问题');
  });

  it('字段缺失（非推理模型 / 老响应）→ 不崩，降级为 undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponseWith(
      { message: { role: 'assistant', content: '普通回复' } }, // 无 finish_reason
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, // 无 completion_tokens_details
    )));
    const resp = await new OpenAIProvider({ id: 't', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } as any).textChat(makeReq());
    expect(resp.role).toBe('assistant');
    expect(resp.completionText).toBe('普通回复');
    expect(resp.finishReason).toBeUndefined();
    expect(resp.usage?.reasoningTokens).toBeUndefined();
    expect(resp.usage).toEqual({ input: 10, output: 5, total: 15 });
  });

  it('工具调用且无文本 → 不算空响应（不误报 warn）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponseWith(
      {
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'recall_memory', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      },
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    )));
    const resp = await new OpenAIProvider({ id: 't', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } as any).textChat(makeReq());
    expect(resp.toolsCallName).toEqual(['recall_memory']);
    expect(warn).not.toHaveBeenCalled();
  });
});
