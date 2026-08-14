// ★ 8-15 流式输出（llm-streaming-pipeline）——textChatStream 对等能力测试
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from '../../src/provider/openai.js';

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({ id: 'test', baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm' } as any);
}

function makeReq(extra: Record<string, unknown> = {}) {
  return { prompt: 'hi', sessionId: 's1', systemPrompt: '', contexts: [], ...extra } as any;
}

/** 构造 SSE 流式 Response（逐块 enqueue） */
function sseResponse(parts: string[], ok = true, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return { ok, status, body: stream } as any;
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('OpenAIProvider.textChatStream', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('SSE 逐块 yield 文本 chunk（isChunk: true）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const chunks = await collect(makeProvider().textChatStream(makeReq()));
    expect(chunks.map(c => c.completionText)).toEqual(['你', '好']);
    expect(chunks.every(c => c.isChunk === true)).toBe(true);
    expect(chunks.every(c => c.role === 'assistant')).toBe(true);
  });

  it('reasoning_content 透传（DeepSeek 思考过程独立字段）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"回复"}}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const chunks = await collect(makeProvider().textChatStream(makeReq()));
    expect(chunks[0].reasoningContent).toBe('思考中');
    expect(chunks[0].completionText).toBeFalsy();
    expect(chunks[1].completionText).toBe('回复');
  });

  it('sampling 槽位注入（temperature/max_tokens 进请求体,undefined 不传）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    await collect(makeProvider().textChatStream(makeReq({
      sampling: { temperature: 0.8, max_tokens: 128, top_p: undefined },
    })));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.8);
    expect(body.max_tokens).toBe(128);
    expect('top_p' in body).toBe(false);
  });

  it('fetch 挂起 → 60s 超时 yield err chunk（race 同 textChat 语义）', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const gen = makeProvider().textChatStream(makeReq());
    const it = gen[Symbol.asyncIterator]();
    const nextPromise = it.next();
    await vi.advanceTimersByTimeAsync(59_000);
    let settled = false;
    nextPromise.then(() => { settled = true; });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const { value } = await nextPromise;
    expect(value.role).toBe('err');
    expect(value.completionText).toBe('Request timed out (60s)');
  });

  it('外部 signal abort → yield err chunk "Request aborted"', async () => {
    const ctrl = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: any) => {
      ctrl.abort();
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return sseResponse(['data: [DONE]\n\n']);
    }));
    const chunks = await collect(makeProvider().textChatStream(makeReq({ signal: ctrl.signal })));
    expect(chunks[0].role).toBe('err');
    expect(chunks[0].completionText).toBe('Request aborted');
  });

  it('流式读取中途挂起（reader 不结束）→ 60s 超时', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"半"}}]}\n\n'));
        // 不发 [DONE]，流挂起
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream } as any));
    const gen = makeProvider().textChatStream(makeReq());
    const it = gen[Symbol.asyncIterator]();
    const first = await it.next(); // 第一块正常
    expect(first.value.completionText).toBe('半');
    const secondPromise = it.next();
    await vi.advanceTimersByTimeAsync(61_000);
    const { value } = await secondPromise;
    expect(value.role).toBe('err');
    expect(value.completionText).toBe('Request timed out (60s)');
  });

  it('API 非 200 → err chunk', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as any));
    const chunks = await collect(makeProvider().textChatStream(makeReq()));
    expect(chunks[0].role).toBe('err');
    expect(chunks[0].completionText).toContain('429');
  });

  it('工具调用累积 → [DONE] 后一次性 yield（非 chunk）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{\\"location\\":\\"北京\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const chunks = await collect(makeProvider().textChatStream(makeReq()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].isChunk).toBeFalsy();
    expect(chunks[0].toolsCallName).toEqual(['get_weather']);
    expect(chunks[0].toolsCallArgs).toEqual([{ location: '北京' }]);
  });
});
