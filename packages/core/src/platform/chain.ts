import type { MessageComponent } from './message.js';

// 消息链 — 用于向外发送消息
export class MessageChain {
  private components: MessageComponent[] = [];

  message(text: string): this {
    this.components.push({ type: 'plain', text });
    return this;
  }

  image(url: string): this {
    this.components.push({ type: 'image', url });
    return this;
  }

  at(qq: string, name?: string): this {
    this.components.push({ type: 'at', qq, name });
    return this;
  }

  voice(url: string): this {
    this.components.push({ type: 'voice', url });
    return this;
  }

  file(url: string, name: string): this {
    this.components.push({ type: 'file', url, name });
    return this;
  }

  getComponents(): MessageComponent[] {
    return this.components;
  }

  isEmpty(): boolean {
    return this.components.length === 0;
  }

  [Symbol.iterator](): Iterator<MessageComponent> {
    return this.components[Symbol.iterator]();
  }
}
