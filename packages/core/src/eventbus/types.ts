import type { MessageEvent } from '../platform/event.js';

// EventBus 接口 — 消息事件 pub/sub
export interface EventBus {
  emit(event: MessageEvent): Promise<void>;
  subscribe(handler: (event: MessageEvent) => Promise<void>): void;
}
