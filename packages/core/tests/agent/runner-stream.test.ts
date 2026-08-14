// ★ 8-15 流式出口（llm-streaming-pipeline）——runStream chunk 回调契约
import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../../src/agent/runner.js';
import type { LLMResponse } from '../../src/provider/types.js';

function makeStreamProviderManager(sequences: LLMResponse[][]) {
  const calls: LLMResponse[][] = [...sequences];
  return {
    getDefault: () => ({ config: { maxContextTokens: 16000 } }),
    streamWithFallback: vi.fn().mockImplementation(async function* (req: any) {
      const seq = calls.shift() ?? [];
      for (const item of seq) yield item;
    }),
  };
}

function makeToolRegistry() {
  return {
    toToolSet: () => ({ tools: [], toOpenAI: () => [] }),
    execute: vi.fn().mockResolvedValue('tool_result'),
  };
}

describe('AgentRunner.runStream', () => {
  it('文本 chunk 逐块回调（kind: text）', async () => {
    const pm = makeStreamProviderManager([[
      { role: 'assistant', completionText: '你', isChunk: true },
      { role: 'assistant', completionText: '好', isChunk: true },
    ]]);
    const onChunk = vi.fn();
    const runner = new AgentRunner(pm as any, makeToolRegistry() as any);
    const result = await runner.runStream('hi', 'sys', [], 's1', undefined, undefined, onChunk);
    expect(onChunk.mock.calls.map(c => c[0])).toEqual([
      { kind: 'text', text: '你' },
      { kind: 'text', text: '好' },
    ]);
    expect(result.chain.getComponents()[0]).toEqual({ type: 'plain', text: '你好' });
    expect(result.aborted).toBeFalsy();
  });

  it('reasoning chunk 透传（kind: reasoning），文本与思考顺序保持', async () => {
    const pm = makeStreamProviderManager([[
      { role: 'assistant', completionText: '', reasoningContent: '想了一下', isChunk: true },
      { role: 'assistant', completionText: '答案', isChunk: true },
    ]]);
    const onChunk = vi.fn();
    const runner = new AgentRunner(pm as any, makeToolRegistry() as any);
    await runner.runStream('q', 'sys', [], 's1', undefined, undefined, onChunk);
    expect(onChunk.mock.calls.map(c => c[0])).toEqual([
      { kind: 'reasoning', text: '想了一下' },
      { kind: 'text', text: '答案' },
    ]);
  });

  it('工具调用流式响应 → 执行工具 → 下轮继续流式（工具阶段无文本 chunk）', async () => {
    const pm = makeStreamProviderManager([
      [
        // 第一轮:工具调用(非 chunk,累积后一次性)
        { role: 'assistant', completionText: '', toolsCallName: ['get_weather'], toolsCallArgs: [{ loc: 'BJ' }], toolsCallIds: ['c1'] },
      ],
      [
        { role: 'assistant', completionText: '晴', isChunk: true },
        { role: 'assistant', completionText: '朗', isChunk: true },
      ],
    ]);
    const tools = makeToolRegistry();
    const onChunk = vi.fn();
    const runner = new AgentRunner(pm as any, tools as any);
    const result = await runner.runStream('weather', 'sys', [], 's1', undefined, undefined, onChunk);
    expect(tools.execute).toHaveBeenCalledWith('get_weather', { loc: 'BJ' }, 's1');
    expect(pm.streamWithFallback).toHaveBeenCalledTimes(2);
    expect(onChunk.mock.calls.map(c => c[0])).toEqual([
      { kind: 'text', text: '晴' },
      { kind: 'text', text: '朗' },
    ]);
    expect(result.chain.getComponents()[0].text).toBe('晴朗');
  });

  it('流式 usage 跨轮累积', async () => {
    const pm = makeStreamProviderManager([[
      { role: 'assistant', completionText: 'A', isChunk: true, usage: { input: 10, output: 5, total: 15 } },
    ]]);
    const runner = new AgentRunner(pm as any, makeToolRegistry() as any);
    const result = await runner.runStream('q', 'sys', [], 's1');
    expect(result.tokenUsage).toEqual({ input: 10, output: 5, total: 15 });
  });

  it('signal abort（循环中）→ 返回 aborted，不再回调', async () => {
    const pm = makeStreamProviderManager([[
      { role: 'assistant', completionText: '半句', isChunk: true },
      { role: 'assistant', completionText: '后半', isChunk: true },
    ]]);
    const ctrl = new AbortController();
    const onChunk = vi.fn(() => { ctrl.abort(); }); // 第一块后打断
    const runner = new AgentRunner(pm as any, makeToolRegistry() as any);
    const result = await runner.runStream('q', 'sys', [], 's1', undefined, ctrl.signal, onChunk);
    expect(result.aborted).toBe(true);
    expect(onChunk).toHaveBeenCalledTimes(1); // 中断后不再回调
    expect(result.chain.getComponents()).toHaveLength(0); // 结果丢弃
  });

  it('provider 全失败（首 chunk 前 err）→ err 文本作为最终回复', async () => {
    const pm = makeStreamProviderManager([
      [{ role: 'err', completionText: 'All providers failed' }],
    ]);
    const runner = new AgentRunner(pm as any, makeToolRegistry() as any);
    const result = await runner.runStream('q', 'sys', [], 's1');
    expect(result.chain.getComponents()[0].text).toBe('All providers failed');
  });
});
