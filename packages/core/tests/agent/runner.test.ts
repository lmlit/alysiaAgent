import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunner } from '../../src/agent/runner.js';
import { AgentContext } from '../../src/agent/context.js';
import { NoopAgentHooks } from '../../src/agent/hooks.js';
import type { AgentHooks } from '../../src/agent/hooks.js';
import type { LLMResponse } from '../../src/provider/types.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeMockProviderManager(sequence: LLMResponse[]) {
  const calls: LLMResponse[] = [...sequence];
  return {
    getDefault: () => ({ config: { maxContextTokens: 16000 } }),
    textChatWithFallback: vi.fn().mockImplementation(() => {
      const resp = calls.shift();
      return resp ?? { role: 'err' as const, completionText: 'No more responses' };
    }),
  };
}

function makeMockToolRegistry() {
  return {
    toToolSet: () => ({ tools: [], toOpenAI: () => [] }),
    execute: vi.fn().mockResolvedValue('tool_result'),
  };
}

// ---------------------------------------------------------------------------
// AgentContext
// ---------------------------------------------------------------------------

describe('AgentContext', () => {
  it('should add and retrieve messages', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'You are helpful' });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe('You are helpful');
  });

  it('should accept maxTurns parameter', () => {
    const ctx = new AgentContext(42);
    expect(ctx.maxTurns).toBe(42);
  });

  it('should default maxTurns to 20', () => {
    const ctx = new AgentContext();
    expect(ctx.maxTurns).toBe(20);
  });

  it('should format messages to OpenAI format', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'system prompt' });
    ctx.addMessage({ role: 'user', content: 'hello' });
    ctx.addMessage({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'test', arguments: '{}' } },
      ],
    });
    ctx.addMessage({ role: 'tool', content: 'result', toolCallId: 'c1' });

    const formatted = ctx.toOpenAIFormat();
    expect(formatted).toHaveLength(4);
    expect(formatted[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(formatted[1]).toEqual({ role: 'user', content: 'hello' });
    expect(formatted[2].role).toBe('assistant');
    expect(formatted[2].tool_calls).toBeDefined();
    expect(formatted[3].role).toBe('tool');
    expect(formatted[3].tool_call_id).toBe('c1');
  });

  it('should truncate messages when over token limit, keeping system prompt', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'sys' });
    ctx.addMessage({ role: 'user', content: 'a'.repeat(3000) });
    ctx.addMessage({ role: 'assistant', content: 'b'.repeat(3000) });

    // Rough token estimate: ~6000 chars / 3 ≈ 2000 tokens → need to truncate
    ctx.truncate(500);

    expect(ctx.messages.length).toBeGreaterThanOrEqual(1);
    expect(ctx.messages[0].role).toBe('system');
    expect(ctx.messages[0].content).toBe('sys');
  });

  it('should not truncate if under limit', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'short' });
    ctx.addMessage({ role: 'user', content: 'hi' });

    ctx.truncate(10000);
    expect(ctx.messages).toHaveLength(2);
  });

  it('should not remove system prompt during truncation', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'important' });
    ctx.addMessage({ role: 'user', content: 'x'.repeat(5000) });

    ctx.truncate(100);
    expect(ctx.messages[0].role).toBe('system');
    expect(ctx.messages[0].content).toBe('important');
  });
});

// ---------------------------------------------------------------------------
// NoopAgentHooks
// ---------------------------------------------------------------------------

describe('NoopAgentHooks', () => {
  it('should exist and be instantiable', () => {
    const hooks = new NoopAgentHooks();
    expect(hooks).toBeInstanceOf(NoopAgentHooks);
  });

  it('should have all methods as no-ops', async () => {
    const hooks = new NoopAgentHooks();
    await expect(hooks.onAgentBegin?.({} as any, [])).resolves.toBeUndefined();
    await expect(hooks.onAgentDone?.({} as any, {} as any)).resolves.toBeUndefined();
    await expect(hooks.onToolStart?.({} as any, 't', {})).resolves.toBeUndefined();
    await expect(hooks.onToolEnd?.({} as any, 't', {}, 'r')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

describe('AgentRunner', () => {
  it('should return text response for a simple LLM call with no tools', async () => {
    const providerManager = makeMockProviderManager([
      { role: 'assistant', completionText: 'Hello world!' },
    ]);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const result = await runner.run('test prompt', 'system prompt');

    expect(result.chain.getComponents()).toHaveLength(1);
    expect(result.chain.getComponents()[0]).toEqual({ type: 'plain', text: 'Hello world!' });
    expect(providerManager.textChatWithFallback).toHaveBeenCalledTimes(1);
  });

  it('should execute tools and continue the loop', async () => {
    const providerManager = makeMockProviderManager([
      {
        role: 'assistant',
        completionText: '',
        toolsCallName: ['get_weather'],
        toolsCallArgs: [{ location: 'Beijing' }],
        toolsCallIds: ['call_0'],
      },
      { role: 'assistant', completionText: 'Weather: 25°C' },
    ]);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const result = await runner.run('weather?', 'system');

    expect(toolRegistry.execute).toHaveBeenCalledWith('get_weather', {
      location: 'Beijing',
    });
    expect(result.chain.getComponents()[0]).toEqual({
      type: 'plain',
      text: 'Weather: 25°C',
    });
    expect(providerManager.textChatWithFallback).toHaveBeenCalledTimes(2);
  });

  it('should handle tool execution errors gracefully', async () => {
    const providerManager = makeMockProviderManager([
      {
        role: 'assistant',
        completionText: '',
        toolsCallName: ['broken_tool'],
        toolsCallArgs: [{}],
        toolsCallIds: ['call_0'],
      },
      { role: 'assistant', completionText: 'Error was reported' },
    ]);
    const toolRegistry = makeMockToolRegistry();
    toolRegistry.execute = vi
      .fn()
      .mockRejectedValue(new Error('Something went wrong'));
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const result = await runner.run('do something', 'system');

    expect(toolRegistry.execute).toHaveBeenCalledWith('broken_tool', {});
    expect(result.chain.getComponents()[0].text).toBe('Error was reported');
    expect(providerManager.textChatWithFallback).toHaveBeenCalledTimes(2);
  });

  it('should stop after MAX_STEPS and return max-steps message', async () => {
    const toolCallResponse: LLMResponse = {
      role: 'assistant',
      completionText: '',
      toolsCallName: ['always_call'],
      toolsCallArgs: [{}],
      toolsCallIds: ['call_0'],
    };
    // 10 tool-calling responses fill all steps
    const sequence: LLMResponse[] = Array(10).fill(toolCallResponse);
    // The 11th would be a normal response but should never be reached
    sequence.push({ role: 'assistant', completionText: 'Done' });

    const providerManager = makeMockProviderManager(sequence);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const result = await runner.run('loop', 'system');

    // Should have called LLM exactly MAX_STEPS times
    expect(providerManager.textChatWithFallback).toHaveBeenCalledTimes(10);
    // Should contain the max-steps message
    const text = result.chain.getComponents()[0].text;
    expect(text).toContain('最大步数');
  });

  it('should handle provider error response', async () => {
    const providerManager = makeMockProviderManager([
      { role: 'err', completionText: 'API Error occurred' },
    ]);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const result = await runner.run('test', 'system');

    expect(result.chain.getComponents()[0].text).toBe('API Error occurred');
    expect(providerManager.textChatWithFallback).toHaveBeenCalledTimes(1);
  });

  it('should track token usage from LLM responses', async () => {
    const providerManager = makeMockProviderManager([
      {
        role: 'assistant',
        completionText: 'Hi',
        usage: { input: 10, output: 5, total: 15 },
      },
    ]);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const result = await runner.run('test', 'system');

    expect(result.tokenUsage).toEqual({ input: 10, output: 5, total: 15 });
  });

  it('should aggregate token usage across multiple LLM calls', async () => {
    const providerManager = makeMockProviderManager([
      {
        role: 'assistant',
        completionText: '',
        toolsCallName: ['t'],
        toolsCallArgs: [{}],
        toolsCallIds: ['c1'],
        usage: { input: 10, output: 1, total: 11 },
      },
      {
        role: 'assistant',
        completionText: 'Done',
        usage: { input: 20, output: 2, total: 22 },
      },
    ]);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const result = await runner.run('test', 'system');

    expect(result.tokenUsage).toEqual({ input: 30, output: 3, total: 33 });
  });

  it('should invoke custom hooks during tool execution', async () => {
    const hooks = new NoopAgentHooks();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    hooks.onToolStart = onToolStart;
    hooks.onToolEnd = onToolEnd;

    const providerManager = makeMockProviderManager([
      {
        role: 'assistant',
        completionText: '',
        toolsCallName: ['test_tool'],
        toolsCallArgs: [{ arg: 1 }],
        toolsCallIds: ['c1'],
      },
      { role: 'assistant', completionText: 'done' },
    ]);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(
      providerManager as any,
      toolRegistry as any,
      hooks,
    );

    await runner.run('test', 'system');

    expect(onToolStart).toHaveBeenCalledWith(null, 'test_tool', { arg: 1 });
    expect(onToolEnd).toHaveBeenCalledWith(null, 'test_tool', { arg: 1 }, 'tool_result');
  });

  it('should pass image URLs only on the first step', async () => {
    const providerManager = makeMockProviderManager([
      {
        role: 'assistant',
        completionText: '',
        toolsCallName: ['t'],
        toolsCallArgs: [{}],
        toolsCallIds: ['c1'],
      },
      { role: 'assistant', completionText: 'done' },
    ]);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    await runner.run('test', 'system', ['http://example.com/img.png']);

    // First call should have imageUrls, second should not
    const firstCallArg = providerManager.textChatWithFallback.mock.calls[0][0];
    const secondCallArg = providerManager.textChatWithFallback.mock.calls[1][0];
    expect(firstCallArg.imageUrls).toEqual(['http://example.com/img.png']);
    expect(secondCallArg.imageUrls).toEqual([]);
  });

  it('should use NoopAgentHooks by default when no hooks provided', () => {
    const providerManager = makeMockProviderManager([
      { role: 'assistant', completionText: 'Hello' },
    ]);
    const toolRegistry = makeMockToolRegistry();
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    // Should not throw
    expect(async () => {
      await runner.run('test', 'system');
    }).not.toThrow();
  });
});
