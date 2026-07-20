import { describe, it, expect, vi } from 'vitest';
import { PIIFilterStage } from '../../src/pipeline/stages/pii-filter.js';
import { MemoryIngestStage } from '../../src/pipeline/stages/memory-ingest.js';
import { WorldbookStage } from '../../src/pipeline/stages/worldbook.js';
import { MemoryRetrievalStage } from '../../src/pipeline/stages/memory-retrieval.js';
import { RespondStage } from '../../src/pipeline/stages/respond.js';
import { MessageEvent } from '../../src/platform/event.js';
import { MessageType } from '../../src/platform/types.js';
import type { Message, MessageSender, PlainComponent } from '../../src/platform/message.js';
import type { PlatformMetadata } from '../../src/platform/types.js';
import { MessageChain } from '../../src/platform/chain.js';

const platformMeta: PlatformMetadata = { name: 'test', description: 't', id: 't-1' };

function makeEvent(text: string, isGroup = false): MessageEvent {
  const sender: MessageSender = { userId: 'u1', nickname: 'Test' };
  const content: PlainComponent[] = [{ type: 'plain', text }];
  const msg: Message = {
    sessionId: 's1', groupId: isGroup ? 'g1' : '',
    sender, messageId: 'm1',
    type: isGroup ? MessageType.GROUP : MessageType.PRIVATE,
    content, raw: null,
  };
  return new MessageEvent({ messageStr: text, messageObj: msg, platformMeta, sessionId: 's1' });
}

describe('PIIFilterStage', () => {
  it('should filter phone numbers', async () => {
    const stage = new PIIFilterStage();
    await stage.initialize({} as any);
    const event = makeEvent('我的电话是13812345678');
    await stage.process(event);
    expect(event.messageStr).not.toContain('13812345678');
    expect(event.messageStr).toContain('[REDACTED]');
  });

  it('should filter ID card numbers', async () => {
    const stage = new PIIFilterStage();
    await stage.initialize({} as any);
    const event = makeEvent('身份证110101199001011234');
    await stage.process(event);
    expect(event.messageStr).not.toContain('110101199001011234');
  });
});

describe('MemoryIngestStage', () => {
  it('should call memoryManager.ingest', async () => {
    const mockMemory = { ingest: vi.fn().mockResolvedValue(undefined) };
    const stage = new MemoryIngestStage(mockMemory as any, 'owner1');
    await stage.initialize({} as any);
    await stage.process(makeEvent('hello'));
    expect(mockMemory.ingest).toHaveBeenCalledTimes(1);
  });

  it('should skip profile for NPC in group chat', async () => {
    const mockMemory = {
      ingest: vi.fn().mockResolvedValue(undefined),
      processProfile: vi.fn().mockResolvedValue(undefined),
    };
    // NPC sender (not owner) in group chat
    const stage = new MemoryIngestStage(mockMemory as any, 'owner1');
    await stage.initialize({} as any);
    const npcEvent = makeEvent('npc says hi', true);
    // npc userId is 'u1', owner is 'owner1' → should skip profile
    await stage.process(npcEvent);
    expect(mockMemory.ingest).toHaveBeenCalled();
  });
});

describe('WorldbookStage', () => {
  it('should set worldbook_triggered to false', async () => {
    const stage = new WorldbookStage();
    await stage.initialize({} as any);
    const event = makeEvent('hello');
    await stage.process(event);
    expect(event.getExtra('worldbook_triggered')).toBe(false);
  });
});

describe('MemoryRetrievalStage', () => {
  it('should call memoryManager.assemble', async () => {
    const mockMemory = { assemble: vi.fn().mockResolvedValue('SYSTEM PROMPT:昔涟') };
    const stage = new MemoryRetrievalStage(mockMemory as any);
    await stage.initialize({} as any);
    const event = makeEvent('hello');
    await stage.process(event);
    expect(mockMemory.assemble).toHaveBeenCalledWith('chat');
    expect(event.getExtra('memory_context')).toBe('SYSTEM PROMPT:昔涟');
  });
});

describe('RespondStage', () => {
  it('should send response chain if present', async () => {
    const stage = new RespondStage();
    await stage.initialize({} as any);
    const event = makeEvent('hello');
    const chain = new MessageChain().message('response text');
    event.setExtra('response_chain', chain);
    // Mock send to verify it's called
    const sendSpy = vi.spyOn(event, 'send').mockResolvedValue(undefined);
    await stage.process(event);
    expect(sendSpy).toHaveBeenCalledWith(chain);
  });

  it('should not fail if no response chain', async () => {
    const stage = new RespondStage();
    await stage.initialize({} as any);
    const event = makeEvent('hello');
    await expect(stage.process(event)).resolves.toBeUndefined();
  });

  it('should not fail if response chain is empty', async () => {
    const stage = new RespondStage();
    await stage.initialize({} as any);
    const event = makeEvent('hello');
    const emptyChain = new MessageChain();
    event.setExtra('response_chain', emptyChain);
    await expect(stage.process(event)).resolves.toBeUndefined();
  });

  it('should swallow send errors', async () => {
    const stage = new RespondStage();
    await stage.initialize({} as any);
    const event = makeEvent('hello');
    const chain = new MessageChain().message('response');
    event.setExtra('response_chain', chain);
    vi.spyOn(event, 'send').mockRejectedValue(new Error('send failed'));
    await expect(stage.process(event)).resolves.toBeUndefined();
  });
});
