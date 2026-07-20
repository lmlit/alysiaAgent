import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandRegistry } from '../../src/commands/registry.js';
import { createSessionCommands } from '../../src/commands/session.js';
import { createStatsCommand } from '../../src/commands/stats.js';
import { MessageEvent } from '../../src/platform/event.js';
import type { PlatformMetadata } from '../../src/platform/types.js';
import { MessageType } from '../../src/platform/types.js';
import { MessageChain } from '../../src/platform/chain.js';

function makeTestEvent(text: string): MessageEvent {
  const metadata: PlatformMetadata = { name: 'test', description: 'test', id: 'test_platform' };
  return new MessageEvent({
    messageStr: text,
    messageObj: {
      sessionId: 'sess_1',
      groupId: '',
      sender: { userId: 'user1', nickname: 'Tester' },
      messageId: 'msg_1',
      type: MessageType.PRIVATE,
      content: [{ type: 'plain', text }],
      raw: null,
    },
    platformMeta: metadata,
    sessionId: 'default',
  });
}

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it('should return null for non-command messages', async () => {
    const event = makeTestEvent('hello world');
    const result = await registry.execute(event, 'hello world');
    expect(result).toBeNull();
  });

  it('should return null for unknown commands', async () => {
    const event = makeTestEvent('/unknown');
    const result = await registry.execute(event, '/unknown');
    expect(result).toBeNull();
  });

  it('should execute a registered command', async () => {
    registry.register({
      name: 'ping',
      description: 'Ping pong',
      handler: async () => 'pong',
    });
    const event = makeTestEvent('/ping');
    const result = await registry.execute(event, '/ping');
    expect(result).toBe('pong');
  });

  it('should handle command aliases', async () => {
    registry.register({
      name: 'help',
      description: 'Show help',
      aliases: ['h', '?'],
      handler: async () => 'help text',
    });
    const event = makeTestEvent('/h');
    const result = await registry.execute(event, '/h');
    expect(result).toBe('help text');
  });

  it('should pass arguments to handler', async () => {
    registry.register({
      name: 'echo',
      description: 'Echo args',
      handler: async (_event, args) => args.join(' '),
    });
    const event = makeTestEvent('/echo hello world');
    const result = await registry.execute(event, '/echo hello world');
    expect(result).toBe('hello world');
  });

  it('should handle command returning MessageChain', async () => {
    registry.register({
      name: 'chain',
      description: 'Return chain',
      handler: async () => new MessageChain().message('chain result'),
    });
    const event = makeTestEvent('/chain');
    const result = await registry.execute(event, '/chain');
    expect(result).toBe('chain result');
  });
});

describe('Session commands', () => {
  it('/new should call onNew with unifiedMsgOrigin', async () => {
    const onNew = vi.fn().mockResolvedValue('new_session_id');
    const onReset = vi.fn();
    const cmds = createSessionCommands(onNew, onReset);
    const newCmd = cmds.find(c => c.name === 'new')!;
    expect(newCmd).toBeDefined();

    const event = makeTestEvent('/new');
    const result = await newCmd.handler(event, []);
    expect(onNew).toHaveBeenCalledWith(event.unifiedMsgOrigin);
    expect(result).toContain('new_');
  });

  it('/reset should call onReset with unifiedMsgOrigin', async () => {
    const onNew = vi.fn();
    const onReset = vi.fn().mockResolvedValue(undefined);
    const cmds = createSessionCommands(onNew, onReset);
    const resetCmd = cmds.find(c => c.name === 'reset')!;
    expect(resetCmd).toBeDefined();

    const event = makeTestEvent('/reset');
    const result = await resetCmd.handler(event, []);
    expect(onReset).toHaveBeenCalledWith(event.unifiedMsgOrigin);
    expect(result).toContain('Session reset');
  });
});

describe('Stats command', () => {
  it('/stats should return formatted stats string', async () => {
    const getStats = vi.fn().mockReturnValue({
      recordCount: 5,
      totalInput: 1000,
      totalOutput: 500,
      totalTokens: 1500,
    });
    const cmd = createStatsCommand(getStats);

    const event = makeTestEvent('/stats');
    const result = await cmd.handler(event, []);

    expect(result).toContain('1,500');
    expect(result).toContain('1,000');
    expect(result).toContain('500');
    expect(result).toContain('5');
  });

  it('/stats should handle empty session', async () => {
    const getStats = vi.fn().mockReturnValue({
      recordCount: 0,
      totalInput: 0,
      totalOutput: 0,
      totalTokens: 0,
    });
    const cmd = createStatsCommand(getStats);

    const event = makeTestEvent('/stats');
    const result = await cmd.handler(event, []);

    expect(result).toContain('No stats available');
  });

  it('/stats should pass sessionId to getStats', async () => {
    const getStats = vi.fn().mockReturnValue({
      recordCount: 1,
      totalInput: 10,
      totalOutput: 5,
      totalTokens: 15,
    });
    const cmd = createStatsCommand(getStats);

    const event = makeTestEvent('/stats');
    await cmd.handler(event, []);

    expect(getStats).toHaveBeenCalledWith(event.unifiedMsgOrigin);
  });
});
