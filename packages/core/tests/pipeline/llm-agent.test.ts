import { describe, it, expect, vi } from 'vitest';
import { LLMAgentStage } from '../../src/pipeline/stages/llm-agent.js';
import { MessageEvent } from '../../src/platform/event.js';
import { MessageType } from '../../src/platform/types.js';
import type {
  Message,
  MessageSender,
  MessageComponent,
} from '../../src/platform/message.js';
import type { PlatformMetadata } from '../../src/platform/types.js';
import type { PipelineContext } from '../../src/pipeline/types.js';
import { MessageChain } from '../../src/platform/chain.js';

// ---------------------------------------------------------------------------
// Hoisted mock for AgentRunner.run() — shared across all tests
// ---------------------------------------------------------------------------
const mockRun = vi.hoisted(() => vi.fn());

vi.mock('../../src/agent/runner.js', () => {
  return {
    AgentRunner: class {
      run = mockRun;
    },
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
const platformMeta: PlatformMetadata = {
  name: 'test',
  description: 't',
  id: 't-1',
};

function makeEvent(
  text: string,
  sessionId = 's1',
  components?: MessageComponent[],
): MessageEvent {
  const sender: MessageSender = { userId: 'u1', nickname: 'Test' };
  const content = components ?? [{ type: 'plain' as const, text }];
  const msg: Message = {
    sessionId,
    groupId: '',
    sender,
    messageId: 'm1',
    type: MessageType.PRIVATE,
    content,
    raw: null,
  };
  return new MessageEvent({
    messageStr: text,
    messageObj: msg,
    platformMeta,
    sessionId,
  });
}

function makeMockContext(): PipelineContext {
  const cmdRegistry = { execute: vi.fn(), register: vi.fn() };
  // Real in-memory token stats so tests can verify accumulation
  const tokenStatsMap = new Map<string, { recordCount: number; totalInput: number; totalOutput: number; totalTokens: number }>();
  return {
    providerManager: {} as any,
    toolRegistry: {} as any,
    commandRegistry: cmdRegistry,
    memoryManager: {
      getActiveSystemPrompt: vi.fn().mockReturnValue('测试人格提示词'),
      onSessionEnd: vi.fn().mockResolvedValue(undefined),
      // ★ 8-09 输出回写 mock
      ingest: vi.fn().mockResolvedValue(undefined),
      listStickers: vi.fn().mockReturnValue([{ name: '睡觉', path: '/data/stickers/睡觉.png' }]),
      findSticker: vi.fn().mockReturnValue({ content: '/data/stickers/睡觉.png' }),
      recordTokenUsage: vi.fn().mockImplementation(
        (sid: string, usage: { input: number; output: number; total: number }) => {
          const e = tokenStatsMap.get(sid) ?? { recordCount: 0, totalInput: 0, totalOutput: 0, totalTokens: 0 };
          e.recordCount += 1;
          e.totalInput += usage.input;
          e.totalOutput += usage.output;
          e.totalTokens += usage.total;
          tokenStatsMap.set(sid, e);
        },
      ),
      getTokenStats: vi.fn().mockImplementation((sid?: string) => {
        if (sid) return tokenStatsMap.get(sid) ?? { recordCount: 0, totalInput: 0, totalOutput: 0, totalTokens: 0 };
        return { global: { input: 0, output: 0, tokens: 0 }, perSession: {} };
      }),
    } as any,
    config: {
      bot: { name: 'Alysia', ownerId: '' },
      llm: {
        primary: { baseUrl: '', apiKey: '', model: '' },
        embedding: { baseUrl: '', apiKey: '', model: '' },
      },
      server: { port: 6185 },
    },
  } as PipelineContext;
}

// ---------------------------------------------------------------------------
// Consume an AsyncGenerator fully (two steps: pre-yield and post-yield)
// ---------------------------------------------------------------------------
async function consumeGenerator(
  gen: AsyncGenerator<void, void, void>,
): Promise<void> {
  // Step 1: run PRE code up to the yield
  const r1 = await gen.next();
  expect(r1.done).toBe(false);
  // Step 2: resume after yield — runs POST code, generator finishes
  const r2 = await gen.next();
  expect(r2.done).toBe(true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('LLMAgentStage', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue({
      chain: new MessageChain().message('LLM response'),
      tokenUsage: { input: 100, output: 50, total: 150 },
    });
  });

  describe('command interception', () => {
    it('should execute command and set response_chain when message starts with /', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi
        .fn()
        .mockResolvedValue('command executed');

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('/stats');
      const gen = stage.process(event);

      // PRE: execute command → yield
      const r1 = await gen.next();
      expect(r1.done).toBe(false);

      expect(ctx.commandRegistry.execute).toHaveBeenCalledWith(
        event,
        '/stats',
      );
      const chain = event.getExtra('response_chain');
      expect(chain).toBeInstanceOf(MessageChain);
      // AgentRunner should NOT be called for commands
      expect(mockRun).not.toHaveBeenCalled();

      // POST: generator finishes (return after yield)
      const r2 = await gen.next();
      expect(r2.done).toBe(true);
    });

    it('should not call AgentRunner when command is intercepted', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi
        .fn()
        .mockResolvedValue('some result');

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('/help');
      const gen = stage.process(event);
      await gen.next();
      await gen.next();

      expect(mockRun).not.toHaveBeenCalled();
    });

    it('should proceed to AgentRunner if command returns null', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('hello');
      await consumeGenerator(stage.process(event));

      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(event.getExtra('response_chain')).toBeInstanceOf(MessageChain);
    });
  });

  describe('LLM call', () => {
    it('should call AgentRunner with the user message', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('hello world');
      await consumeGenerator(stage.process(event));

      expect(mockRun).toHaveBeenCalledWith(
        'hello world',
        expect.stringContaining('测试人格提示词'),
        [],
        't-1:private:s1',
        undefined, // sampling 槽（makeMockContext 无 sampling 配置）
        undefined, // signal（makeMockContext 无 coalescer）
      );
    });

    it('should include memory_context in the system prompt', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('hi');
      event.setExtra('memory_context', '你是知识渊博的助手。');

      await consumeGenerator(stage.process(event));

      expect(mockRun).toHaveBeenCalledWith(
        'hi',
        expect.stringContaining('你是知识渊博的助手。'),
        expect.any(Array),
        expect.any(String),
        undefined,
        undefined, // signal（makeMockContext 无 coalescer）
      );
    });

    it('should use default system prompt when no memory_context is set', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('hi');
      await consumeGenerator(stage.process(event));

      expect(mockRun).toHaveBeenCalledWith(
        'hi',
        expect.stringContaining('测试人格提示词'),
        expect.any(Array),
        expect.any(String),
        undefined,
        undefined, // signal
      );
    });

    it('should extract image URLs from message components', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const components: MessageComponent[] = [
        { type: 'plain' as const, text: '看图' },
        { type: 'image' as const, url: 'https://example.com/img.png' },
      ];
      const event = makeEvent('看图', 's1', components);

      await consumeGenerator(stage.process(event));

      expect(mockRun).toHaveBeenCalledWith(
        '看图',
        expect.any(String),
        ['https://example.com/img.png'],
        expect.any(String),
        undefined,
        undefined, // signal
      );
    });

    it('should filter out empty image URLs', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const components: MessageComponent[] = [
        { type: 'plain' as const, text: 'pic' },
        { type: 'image' as const, url: '' },
      ];
      const event = makeEvent('pic', 's1', components);

      await consumeGenerator(stage.process(event));

      expect(mockRun).toHaveBeenCalledWith(
        'pic',
        expect.any(String),
        [], // empty string filtered out
        expect.any(String),
        undefined,
        undefined, // signal
      );
    });

    it('should set response_chain from AgentRunner result', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('hello');
      await consumeGenerator(stage.process(event));

      const chain = event.getExtra('response_chain');
      expect(chain).toBeInstanceOf(MessageChain);
      expect(chain?.getComponents()).toHaveLength(1);
    });

    it('should store _token_usage in extras before yield', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('hello');
      const gen = stage.process(event);

      // Only run PRE code (before yield)
      const r1 = await gen.next();
      expect(r1.done).toBe(false);

      const usage = event.getExtra('_token_usage');
      expect(usage).toEqual({ input: 100, output: 50, total: 150 });

      // Finish the generator
      await gen.next();
    });
  });

  describe('token stats recording (POST)', () => {
    it('should record token usage after yield', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('test', 'stats-session-1');
      await consumeGenerator(stage.process(event));

      const stats = ctx.memoryManager.getTokenStats('t-1:private:stats-session-1') as any;
      expect(stats.recordCount).toBe(1);
      expect(stats.totalInput).toBe(100);
      expect(stats.totalOutput).toBe(50);
      expect(stats.totalTokens).toBe(150);
    });

    it('should accumulate token stats across multiple calls', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const sessionId = 'accum-session';

      // First call (uses the default 100/50/150 from beforeEach)
      const ev1 = makeEvent('msg1', sessionId);
      await consumeGenerator(stage.process(ev1));

      // Second call with different usage
      mockRun.mockResolvedValueOnce({
        chain: new MessageChain().message('msg2'),
        tokenUsage: { input: 200, output: 100, total: 300 },
      });
      const ev2 = makeEvent('msg2', sessionId);
      await consumeGenerator(stage.process(ev2));

      const stats = ctx.memoryManager.getTokenStats(`t-1:private:${sessionId}`) as any;
      expect(stats.recordCount).toBe(2);
      expect(stats.totalInput).toBe(300); // 100 + 200
      expect(stats.totalOutput).toBe(150); // 50 + 100
      expect(stats.totalTokens).toBe(450); // 150 + 300
    });

    it('should keep separate stats per session', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const ev1 = makeEvent('msg1', 'session-a');
      await consumeGenerator(stage.process(ev1));

      const ev2 = makeEvent('msg2', 'session-b');
      await consumeGenerator(stage.process(ev2));

      const statsA = ctx.memoryManager.getTokenStats('t-1:private:session-a') as any;
      const statsB = ctx.memoryManager.getTokenStats('t-1:private:session-b') as any;

      expect(statsA.recordCount).toBe(1);
      expect(statsB.recordCount).toBe(1);
    });

    it('should not record stats when command is intercepted', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi
        .fn()
        .mockResolvedValue('command result');

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('/stats', 'cmd-session');
      const gen = stage.process(event);
      await gen.next();
      await gen.next();

      // No LLM call, no token usage recorded
      const stats = ctx.memoryManager.getTokenStats('t-1:private:cmd-session') as any;
      expect(stats.recordCount).toBe(0);
    });
  });

  describe('getTokenStats (via MemoryManager)', () => {
    it('should return zero stats for unknown sessions', () => {
      const ctx = makeMockContext();
      const stats = ctx.memoryManager.getTokenStats('nonexistent') as any;
      expect(stats).toEqual({
        recordCount: 0,
        totalInput: 0,
        totalOutput: 0,
        totalTokens: 0,
      });
    });

    it('should return existing stats for known sessions', async () => {
      const ctx = makeMockContext();
      ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);

      const stage = new LLMAgentStage();
      await stage.initialize(ctx);

      const event = makeEvent('hi', 'known-session');
      await consumeGenerator(stage.process(event));

      const stats = ctx.memoryManager.getTokenStats('t-1:private:known-session') as any;
      expect(stats.recordCount >= 1).toBe(true);
    });
  });
});

describe('LLMAgentStage — 8-09 输出回写', () => {
  it('回复完成后 ingest assistant 消息进记忆', async () => {
    const ctx = makeMockContext();
    ctx.commandRegistry.execute = vi.fn().mockResolvedValue(null);
    mockRun.mockResolvedValue({
      chain: new MessageChain().message('这是回复内容'),
      tokenUsage: { input: 100, output: 20, total: 120 },
    });
    const stage = new LLMAgentStage();
    await stage.initialize(ctx);
    const event = makeEvent('你好');
    await consumeGenerator(stage.process(event));
    expect(ctx.memoryManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'chat',
        type: 'message',
        payload: { content: '这是回复内容', role: 'assistant' },
      })
    );
  });
});
