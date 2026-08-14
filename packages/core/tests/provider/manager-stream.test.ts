// ★ 8-15 流式 fallback（llm-streaming-pipeline）——streamWithFallback 语义
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderManager } from '../../src/provider/manager.js';
import type { LLMResponse } from '../../src/provider/types.js';

async function* genOf(items: LLMResponse[]): AsyncGenerator<LLMResponse> {
  for (const i of items) yield i;
}

function makeStreamProvider(id: string, items: LLMResponse[]): any {
  return {
    config: { id },
    textChatStream: vi.fn().mockImplementation(async function* () {
      for (const i of items) yield i;
    }),
  };
}

function makeManager(providers: any[]): ProviderManager {
  const m = new ProviderManager();
  // registerProvider 会包装真实 OpenAIProvider（测试会真 fetch）→ 直接注入 mock 实例
  (m as any).providers = new Map(providers.map(p => [p.config.id, p]));
  (m as any).defaultProviderId = providers[0].config.id;
  return m;
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('ProviderManager.streamWithFallback', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('主 provider 首 chunk 前 err → 切换 fallback（fallback 成功输出）', async () => {
    const primary = makeStreamProvider('p1', [{ role: 'err', completionText: 'API error 500' }]);
    const fb = makeStreamProvider('p2', [{ role: 'assistant', completionText: 'fallback 你好', isChunk: true }]);
    const m = makeManager([primary, fb]);
    const chunks = await collect(m.streamWithFallback({ prompt: 'hi', sessionId: 's' }, ['p2']));
    expect(chunks.map(c => c.completionText)).toEqual(['fallback 你好']);
    expect(primary.textChatStream).toHaveBeenCalledTimes(1);
    expect(fb.textChatStream).toHaveBeenCalledTimes(1);
  });

  it('已出 chunk 后失败 → 不切换 fallback，err chunk 透出后终止', async () => {
    const primary = makeStreamProvider('p1', [
      { role: 'assistant', completionText: '前半句', isChunk: true },
      { role: 'err', completionText: 'mid-stream failed' },
    ]);
    const fb = makeStreamProvider('p2', [{ role: 'assistant', completionText: '不应被调用', isChunk: true }]);
    const m = makeManager([primary, fb]);
    const chunks = await collect(m.streamWithFallback({ prompt: 'hi', sessionId: 's' }, ['p2']));
    expect(chunks.map(c => c.completionText)).toEqual(['前半句', 'mid-stream failed']);
    expect(fb.textChatStream).not.toHaveBeenCalled();
  });

  it('全部 provider 首 chunk 前失败 → err "All providers failed"', async () => {
    const primary = makeStreamProvider('p1', [{ role: 'err', completionText: 'down' }]);
    const fb = makeStreamProvider('p2', [{ role: 'err', completionText: 'down2' }]);
    const m = makeManager([primary, fb]);
    const chunks = await collect(m.streamWithFallback({ prompt: 'hi', sessionId: 's' }, ['p2']));
    expect(chunks.map(c => c.completionText)).toEqual(['All providers failed']);
  });

  it('signal 已 abort → 立即 err "Request aborted"，不调任何 provider', async () => {
    const primary = makeStreamProvider('p1', [{ role: 'assistant', completionText: 'x', isChunk: true }]);
    const m = makeManager([primary]);
    const ctrl = new AbortController();
    ctrl.abort();
    const chunks = await collect(m.streamWithFallback({ prompt: 'hi', sessionId: 's', signal: ctrl.signal }, []));
    expect(chunks[0].role).toBe('err');
    expect(chunks[0].completionText).toBe('Request aborted');
    expect(primary.textChatStream).not.toHaveBeenCalled();
  });
});
