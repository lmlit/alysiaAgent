import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamAbortedError, streamChat } from '../lib/api/stream';
import type { ChatFrame } from '../lib/api/stream';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 用若干「网络分片」造一个 SSE 响应体 */
function sseResponse(chunks: string[], init: { status?: number } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

function collect() {
  const frames: ChatFrame[] = [];
  return { frames, onFrame: (f: ChatFrame) => frames.push(f) };
}

describe('streamChat — 正常帧序列', () => {
  it('connected → chunk* → done 全收到', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame({ type: 'connected', sessionId: 'sess-1' }),
          frame({ type: 'chunk', kind: 'reasoning', text: '让我想想' }),
          frame({ type: 'chunk', kind: 'text', text: '你好' }),
          frame({ type: 'chunk', kind: 'text', text: '呀' }),
          frame({ type: 'done', reply: '你好呀' }),
        ]),
      ),
    );
    const { frames, onFrame } = collect();
    await streamChat('hi', 'sess-1', { onFrame });
    expect(frames.map((f) => f.type)).toEqual(['connected', 'chunk', 'chunk', 'chunk', 'done']);
  });

  it('reasoning 与 text 的 kind 原样透传（调用方靠它分流思考条/正文）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame({ type: 'chunk', kind: 'reasoning', text: 'R' }),
          frame({ type: 'chunk', kind: 'text', text: 'T' }),
        ]),
      ),
    );
    const { frames, onFrame } = collect();
    await streamChat('hi', 'sess-1', { onFrame });
    expect(frames[0]).toMatchObject({ kind: 'reasoning', text: 'R' });
    expect(frames[1]).toMatchObject({ kind: 'text', text: 'T' });
  });

  it('aborted / error 帧正常收到', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([frame({ type: 'aborted', message: '被打断' })])),
    );
    const { frames, onFrame } = collect();
    await streamChat('hi', 'sess-1', { onFrame });
    expect(frames[0]).toMatchObject({ type: 'aborted', message: '被打断' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([frame({ type: 'error', message: '超时' })])),
    );
    const second = collect();
    await streamChat('hi', 'sess-1', { onFrame: second.onFrame });
    expect(second.frames[0]).toMatchObject({ type: 'error', message: '超时' });
  });
});

describe('streamChat — 分片边界', () => {
  it('★ 一个 data: 事件被拆到两个网络分片，仍能解析', async () => {
    const whole = frame({ type: 'chunk', kind: 'text', text: '被拆开的帧' });
    const cut = Math.floor(whole.length / 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([whole.slice(0, cut), whole.slice(cut)])),
    );
    const { frames, onFrame } = collect();
    await streamChat('hi', 'sess-1', { onFrame });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ text: '被拆开的帧' });
  });

  it('★ 一个分片里含多个事件，全部解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame({ type: 'chunk', kind: 'text', text: '1' }) +
            frame({ type: 'chunk', kind: 'text', text: '2' }) +
            frame({ type: 'done', reply: '12' }),
        ]),
      ),
    );
    const { frames, onFrame } = collect();
    await streamChat('hi', 'sess-1', { onFrame });
    expect(frames.map((f) => f.type)).toEqual(['chunk', 'chunk', 'done']);
  });

  it('分片落在 \\n\\n 中间（尾部残留）不丢事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(['data: {"type":"done"}\n', '\n'])),
    );
    const { frames, onFrame } = collect();
    await streamChat('hi', 'sess-1', { onFrame });
    expect(frames).toEqual([{ type: 'done' }]);
  });
});

describe('streamChat — 异常帧与错误', () => {
  it('畸形 JSON 跳过并告警，不炸整条流', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: {不是JSON\n\n', frame({ type: 'done' })]),
      ),
    );
    const { frames, onFrame } = collect();
    await streamChat('hi', 'sess-1', { onFrame });
    expect(frames).toEqual([{ type: 'done' }]);
    expect(warn).toHaveBeenCalled();
  });

  it('非 data: 行（如注释/心跳）被忽略', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([': keep-alive\n\n', frame({ type: 'done' })])),
    );
    const { frames, onFrame } = collect();
    await streamChat('hi', 'sess-1', { onFrame });
    expect(frames).toEqual([{ type: 'done' }]);
  });

  it('HTTP 非 2xx → 抛错并 console.error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );
    await expect(streamChat('hi', 'sess-1', { onFrame: () => {} })).rejects.toThrow('HTTP 401');
    expect(err).toHaveBeenCalled();
  });

  it('网络失败 → 抛可读错误', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(streamChat('hi', 'sess-1', { onFrame: () => {} })).rejects.toThrow(
      '无法连接到服务端',
    );
  });
});

describe('streamChat — 中断（★ webui 的停止按钮是坏的，这里必须真的断）', () => {
  it('fetch 收到 signal（不能像 webui 那样漏传）', async () => {
    const spy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return sseResponse([frame({ type: 'done' })]);
    });
    vi.stubGlobal('fetch', spy);
    const ctrl = new AbortController();
    await streamChat('hi', 'sess-1', { signal: ctrl.signal, onFrame: () => {} });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('传输中途 abort → 抛 StreamAbortedError，且不再回调后续帧', async () => {
    const ctrl = new AbortController();
    const encoder = new TextEncoder();
    const seen: ChatFrame[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame({ type: 'chunk', kind: 'text', text: '前半' })));
        // 第二块到达前中止
        setTimeout(() => {
          ctrl.abort();
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, 0);
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    await expect(
      streamChat('hi', 'sess-1', { signal: ctrl.signal, onFrame: (f) => seen.push(f) }),
    ).rejects.toBeInstanceOf(StreamAbortedError);

    // 中止前已收到的帧保留（界面据此显示"已停止"+ 部分内容）
    expect(seen).toHaveLength(1);
  });

  it('abort 导致的 fetch reject 也归为 StreamAbortedError（不报成网络故障）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }),
    );
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      streamChat('hi', 'sess-1', { signal: ctrl.signal, onFrame: () => {} }),
    ).rejects.toBeInstanceOf(StreamAbortedError);
  });
});
