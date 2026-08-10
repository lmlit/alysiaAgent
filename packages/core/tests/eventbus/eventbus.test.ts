import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/eventbus/EventBus.js';
import { MessageEvent } from '../../src/platform/event.js';
import { MessageType } from '../../src/platform/types.js';
import type { Message, MessageSender, PlainComponent } from '../../src/platform/message.js';
import type { PlatformMetadata } from '../../src/platform/types.js';

const platformMeta: PlatformMetadata = { name: 'test', description: 't', id: 't-1' };

function makeEvent(text: string, type: MessageType = MessageType.PRIVATE): MessageEvent {
  const sender: MessageSender = { userId: 'u1', nickname: 'U' };
  const content: PlainComponent[] = [{ type: 'plain', text }];
  const msg: Message = {
    sessionId: type === MessageType.PRIVATE ? 's1' : 'g1',
    groupId: type === MessageType.PRIVATE ? '' : 'g1',
    sender,
    messageId: 'm1',
    type,
    content,
    raw: null,
  };
  return new MessageEvent({ messageStr: text, messageObj: msg, platformMeta, sessionId: msg.sessionId });
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

  // ★ 8-10 私聊并发（eventbus-concurrent-private-dispatch）：execute 不 await——
  //   第一条私聊还在处理（pending）时，第二条的 execute 立即被调用（Coalescer
  //   打断在飞的前提）；串行下第二条会排队等第一条完成
  it('私聊事件并发：前一条处理中（pending）第二条立即 dispatch', async () => {
    const processed: string[] = [];
    let resolveFirst: (() => void) | null = null;
    const mockScheduler = {
      initialize: vi.fn(),
      execute: vi.fn().mockImplementation(async (e: MessageEvent) => {
        processed.push(e.messageStr);
        if (e.messageStr === 'first') {
          await new Promise<void>(r => { resolveFirst = r; }); // 模拟长处理（LLM 生成）
        }
      }),
    };

    const bus = new EventBus();
    bus.registerScheduler('test::private:s1', mockScheduler as any);
    bus.dispatch();

    const e1 = makeEvent('first');
    (e1 as any).session = { toString: () => 'test::private:s1' };
    await bus.put(e1);
    await new Promise(r => setTimeout(r, 10));

    // 第一条仍在处理（pending）→ 第二条私聊消息也立即 dispatch（并发）
    const e2 = makeEvent('second');
    (e2 as any).session = { toString: () => 'test::private:s1' };
    await bus.put(e2);
    await new Promise(r => setTimeout(r, 10));
    expect(processed).toContain('first');
    expect(processed).toContain('second'); // 不被前一条阻塞

    resolveFirst?.();
    await new Promise(r => setTimeout(r, 10));
    bus.stop();
  });

  // ★ 8-10 群聊串行：前一条群聊处理中，第二条排队等待（await 阻塞）
  it('群聊事件串行：前一条处理中（pending）第二条不 dispatch', async () => {
    const processed: string[] = [];
    let resolveFirst: (() => void) | null = null;
    const mockScheduler = {
      initialize: vi.fn(),
      execute: vi.fn().mockImplementation(async (e: MessageEvent) => {
        processed.push(e.messageStr);
        if (e.messageStr === 'first') {
          await new Promise<void>(r => { resolveFirst = r; });
        }
      }),
    };

    const bus = new EventBus();
    bus.registerScheduler('test::group:g1', mockScheduler as any);
    bus.dispatch();

    const e1 = makeEvent('first', MessageType.GROUP);
    (e1 as any).session = { toString: () => 'test::group:g1' };
    await bus.put(e1);
    await new Promise(r => setTimeout(r, 10));

    const e2 = makeEvent('second', MessageType.GROUP);
    (e2 as any).session = { toString: () => 'test::group:g1' };
    await bus.put(e2);
    await new Promise(r => setTimeout(r, 10));
    expect(processed).toEqual(['first']); // 第二条排队，未处理

    resolveFirst?.();
    await new Promise(r => setTimeout(r, 20));
    expect(processed).toEqual(['first', 'second']); // 第一条完成后第二条处理
    bus.stop();
  });

  // ★ 8-10 priority 插队：priority 事件排到普通事件前面先处理
  it('priority 插队：priority 事件先于已排队的普通事件处理', async () => {
    const processed: string[] = [];
    let resolveFirst: (() => void) | null = null;
    const mockScheduler = {
      initialize: vi.fn(),
      execute: vi.fn().mockImplementation(async (e: MessageEvent) => {
        processed.push(e.messageStr);
        if (e.messageStr === 'blocking') {
          await new Promise<void>(r => { resolveFirst = r; }); // 群聊阻塞中（串行）
        }
      }),
    };

    const bus = new EventBus();
    bus.registerScheduler('test::group:g1', mockScheduler as any);
    bus.dispatch();

    const blocking = makeEvent('blocking', MessageType.GROUP);
    (blocking as any).session = { toString: () => 'test::group:g1' };
    await bus.put(blocking);
    await new Promise(r => setTimeout(r, 10));

    const normal = makeEvent('normal', MessageType.GROUP);
    (normal as any).session = { toString: () => 'test::group:g1' };
    await bus.put(normal); // 排队（在 blocking 之后）

    const pri = makeEvent('pri', MessageType.GROUP);
    (pri as any).session = { toString: () => 'test::group:g1' };
    await bus.put(pri, { priority: true }); // 插队到队首

    resolveFirst?.();
    await new Promise(r => setTimeout(r, 20));
    expect(processed).toEqual(['blocking', 'pri', 'normal']); // priority 先处理
    bus.stop();
  });
});
