import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/eventbus/EventBus.js';
import { MessageEvent } from '../../src/platform/event.js';
import { MessageType } from '../../src/platform/types.js';
import type { Message, MessageSender, PlainComponent } from '../../src/platform/message.js';
import type { PlatformMetadata } from '../../src/platform/types.js';

const platformMeta: PlatformMetadata = { name: 'test', description: 't', id: 't-1' };

function makeEvent(text: string): MessageEvent {
  const sender: MessageSender = { userId: 'u1', nickname: 'U' };
  const content: PlainComponent[] = [{ type: 'plain', text }];
  const msg: Message = { sessionId: 's1', groupId: '', sender, messageId: 'm1', type: MessageType.PRIVATE, content, raw: null };
  return new MessageEvent({ messageStr: text, messageObj: msg, platformMeta, sessionId: 's1' });
}

describe('EventBus', () => {
  it('should dispatch events to scheduler', async () => {
    const processed: string[] = [];
    const mockScheduler = {
      initialize: vi.fn(),
      execute: vi.fn().mockImplementation(async (e: MessageEvent) => {
        processed.push(e.messageStr);
      }),
    };

    const bus = new EventBus();
    bus.registerScheduler('test::private:s1', mockScheduler as any);
    const event1 = makeEvent('msg1');
    // Temporarily override unifiedMsgOrigin for the test
    (event1 as any).session = { toString: () => 'test::private:s1' };

    bus.dispatch(); // start processing loop

    await bus.put(event1);
    // Small delay for processing
    await new Promise(r => setTimeout(r, 10));
    expect(mockScheduler.execute).toHaveBeenCalledTimes(1);
    expect(processed).toContain('msg1');

    bus.stop();
  });
});
