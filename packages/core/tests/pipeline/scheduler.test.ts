import { describe, it, expect, vi } from 'vitest';
import { PipelineScheduler } from '../../src/pipeline/scheduler.js';
import type { Stage } from '../../src/pipeline/types.js';
import { createPipelineContext } from '../../src/pipeline/context.js';
import { MessageEvent } from '../../src/platform/event.js';
import { MessageType } from '../../src/platform/types.js';
import type { Message, MessageSender, PlainComponent } from '../../src/platform/message.js';
import type { PlatformMetadata } from '../../src/platform/types.js';

const platformMeta: PlatformMetadata = { name: 'test', description: 't', id: 't-1' };

function makeEvent(): MessageEvent {
  const sender: MessageSender = { userId: 'u1', nickname: 'U' };
  const content: PlainComponent[] = [{ type: 'plain', text: 'hi' }];
  const msg: Message = { sessionId: 's1', groupId: '', sender, messageId: 'm1', type: MessageType.PRIVATE, content, raw: null };
  return new MessageEvent({ messageStr: 'hi', messageObj: msg, platformMeta, sessionId: 's1' });
}

class CountingStage implements Stage {
  public count = 0;
  async initialize() {}
  async process(_event: MessageEvent): Promise<void> {
    this.count++;
  }
}

class OnionStage implements Stage {
  public preCount = 0;
  public postCount = 0;
  async initialize() {}
  async *process(_event: MessageEvent): AsyncGenerator<void> {
    this.preCount++;
    yield;
    this.postCount++;
  }
}

describe('PipelineScheduler', () => {
  it('should execute stages in order', async () => {
    const stage1 = new CountingStage();
    const stage2 = new CountingStage();
    const stage3 = new CountingStage();
    const scheduler = new PipelineScheduler(createPipelineContext(), [stage1, stage2, stage3]);
    await scheduler.initialize();
    await scheduler.execute(makeEvent());
    expect(stage1.count).toBe(1);
    expect(stage2.count).toBe(1);
    expect(stage3.count).toBe(1);
  });

  it('should run onion model: pre -> inner -> post', async () => {
    const outer = new OnionStage();
    const inner = new CountingStage();
    const scheduler = new PipelineScheduler(createPipelineContext(), [outer, inner]);
    await scheduler.initialize();
    await scheduler.execute(makeEvent());
    expect(outer.preCount).toBe(1);
    expect(inner.count).toBe(1);       // inner ran between pre and post
    expect(outer.postCount).toBe(1);
  });

  it('should stop event propagation', async () => {
    const stopping = new (class implements Stage {
      async initialize() {}
      async process(event: MessageEvent): Promise<void> {
        event.stopEvent();
      }
    })();
    const after = new CountingStage();
    const scheduler = new PipelineScheduler(createPipelineContext(), [stopping, after]);
    await scheduler.initialize();
    await scheduler.execute(makeEvent());
    expect(after.count).toBe(0);
  });

  it('should stop in onion pre -> inner skipped', async () => {
    const outer = new (class implements Stage {
      async initialize() {}
      async *process(event: MessageEvent): AsyncGenerator<void> {
        event.stopEvent();
        yield;
      }
    })();
    const inner = new CountingStage();
    const scheduler = new PipelineScheduler(createPipelineContext(), [outer, inner]);
    await scheduler.initialize();
    await scheduler.execute(makeEvent());
    expect(inner.count).toBe(0);
  });
});
