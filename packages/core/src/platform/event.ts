import type { Message } from './message.js';
import type { MessageSession } from './types.js';

// 平台无关的消息事件 — 统一 Pipeline 数据流
export interface MessageEvent {
  message: Message;
  session: MessageSession;
  platformName: string;
  timestamp: number;
}
