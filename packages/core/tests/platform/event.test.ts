import { describe, it, expect } from 'vitest';
import { MessageEvent } from '../../src/platform/event.js';
import { MessageType, MessageSession } from '../../src/platform/types.js';
import type { Message, MessageSender, PlainComponent } from '../../src/platform/message.js';
import type { PlatformMetadata } from '../../src/platform/types.js';

function makeMessage(overrides: Partial<Message> = {}): Message {
  const sender: MessageSender = { userId: '123', nickname: 'TestUser' };
  const content: PlainComponent[] = [{ type: 'plain', text: 'hello' }];
  return {
    sessionId: 'chat-1',
    groupId: '',
    sender,
    messageId: 'msg-1',
    type: MessageType.PRIVATE,
    content,
    raw: null,
    ...overrides,
  };
}

const platformMeta: PlatformMetadata = {
  name: 'test',
  description: 'Test platform',
  id: 'test-1',
};

describe('MessageEvent', () => {
  it('should create event with correct session', () => {
    const msg = makeMessage();
    const event = new MessageEvent({
      messageStr: 'hello',
      messageObj: msg,
      platformMeta,
      sessionId: msg.sessionId,
    });

    expect(event.messageStr).toBe('hello');
    expect(event.getSenderId()).toBe('123');
    expect(event.getSenderName()).toBe('TestUser');
    expect(event.getMessageType()).toBe(MessageType.PRIVATE);
    expect(event.isPrivateChat()).toBe(true);
  });

  it('should detect group chat', () => {
    const msg = makeMessage({ type: MessageType.GROUP, groupId: 'group-1' });
    const event = new MessageEvent({
      messageStr: 'hi',
      messageObj: msg,
      platformMeta,
      sessionId: msg.sessionId,
    });

    expect(event.getMessageType()).toBe(MessageType.GROUP);
    expect(event.getGroupId()).toBe('group-1');
    expect(event.isPrivateChat()).toBe(false);
  });

  it('should stop event propagation', () => {
    const event = new MessageEvent({
      messageStr: 'hello',
      messageObj: makeMessage(),
      platformMeta,
      sessionId: 'chat-1',
    });

    expect(event.isStopped()).toBe(false);
    event.stopEvent();
    expect(event.isStopped()).toBe(true);
  });

  it('should store and retrieve extras', () => {
    const event = new MessageEvent({
      messageStr: 'hello',
      messageObj: makeMessage(),
      platformMeta,
      sessionId: 'chat-1',
    });

    event.setExtra('key', 'value');
    expect(event.getExtra('key')).toBe('value');
    expect(event.getExtra('nonexistent', 'default')).toBe('default');
  });

  it('should get message outline', () => {
    const msg = makeMessage();
    const event = new MessageEvent({
      messageStr: 'hello world',
      messageObj: msg,
      platformMeta,
      sessionId: msg.sessionId,
    });

    const outline = event.getMessageOutline();
    expect(outline).toContain('hello');
  });
});
