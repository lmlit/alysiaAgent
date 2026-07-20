// 消息类型
export enum MessageType {
  PRIVATE = 'private',
  GROUP = 'group',
}

// 消息会话标识
export class MessageSession {
  constructor(
    public platformName: string,
    public messageType: MessageType,
    public sessionId: string,
  ) {}

  toString(): string {
    return `${this.platformName}:${this.messageType}:${this.sessionId}`;
  }

  static fromString(str: string): MessageSession {
    const [platformName, messageType, sessionId] = str.split(':');
    return new MessageSession(platformName, messageType as MessageType, sessionId);
  }
}

// 平台元数据
export interface PlatformMetadata {
  name: string;
  description: string;
  id: string;
}

// 平台适配器接口
import type { MessageChain } from './chain.js';
import type { MessageEvent } from './event.js';

export interface Platform {
  meta: PlatformMetadata;
  run(): Promise<void>;
  send(session: MessageSession, chain: MessageChain): Promise<void>;
  terminate?(): Promise<void>;
}
