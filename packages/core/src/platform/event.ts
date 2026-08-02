import { MessageType, type PlatformMetadata } from './types.js';
import { MessageSession } from './types.js';
import type { Message, MessageComponent } from './message.js';
import { MessageChain } from './chain.js';
import type { PlainComponent, AtComponent } from './message.js';
import type { PipelineExtras } from '../pipeline/types.js';

// Supplementary component types not defined in message.ts
interface FaceComponent {
  type: 'face';
  id: string;
}

interface AtAllComponent {
  type: 'at_all';
}

interface ForwardComponent {
  type: 'forward';
}

export interface MessageEventOptions {
  messageStr: string;
  messageObj: Message;
  platformMeta: PlatformMetadata;
  sessionId: string;
}

export class MessageEvent {
  messageStr: string;
  messageObj: Message;
  platformMeta: PlatformMetadata;
  session: MessageSession;
  role: string = 'member';
  isWake: boolean = false;
  isAtOrWakeCommand: boolean = false;

  private _extras: Map<string, unknown> = new Map();
  private _forceStopped: boolean = false;
  private _hasSendOper: boolean = false;
  callLlm: boolean = false;

  /** Pipeline 模式：chat = 聊天模式（默认），code = 编程模式（桌面端切换） */
  pipelineMode: 'chat' | 'code' = 'chat';

  constructor(opts: MessageEventOptions) {
    this.messageStr = opts.messageStr;
    this.messageObj = opts.messageObj;
    this.platformMeta = opts.platformMeta;
    this.session = new MessageSession(
      opts.platformMeta.id,
      opts.messageObj.type,
      opts.sessionId,
    );
  }

  get unifiedMsgOrigin(): string {
    return this.session.toString();
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  getPlatformName(): string {
    return this.platformMeta.name;
  }

  getPlatformId(): string {
    return this.platformMeta.id;
  }

  getMessageStr(): string {
    return this.messageStr;
  }

  getMessageOutline(): string {
    const chain = this.messageObj.content;
    if (!chain || chain.length === 0) return '';
    const parts: string[] = [];
    for (const comp of chain) {
      const typeName: string = comp.type;
      switch (typeName) {
        case 'plain':
          parts.push((comp as PlainComponent).text);
          break;
        case 'image':
          parts.push('[图片]');
          break;
        case 'at':
          parts.push(`[At:${(comp as AtComponent).qq}]`);
          break;
        case 'face':
          parts.push(`[表情:${(comp as unknown as FaceComponent).id}]`);
          break;
        default:
          parts.push(`[${typeName}]`);
      }
      parts.push(' ');
    }
    return parts.join('');
  }

  getMessages(): MessageComponent[] {
    return this.messageObj.content ?? [];
  }

  getMessageType(): MessageType {
    return this.messageObj.type;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getGroupId(): string {
    return this.messageObj.groupId ?? '';
  }

  getSelfId(): string {
    return '';
  }

  getSenderId(): string {
    return this.messageObj.sender?.userId ?? '';
  }

  getSenderName(): string {
    return this.messageObj.sender?.nickname ?? '';
  }

  /** ★ 类型安全的 Pipeline extras 写入。key 必须是 PipelineExtras 的合法属性名。 */
  setExtra<K extends keyof PipelineExtras>(key: K, value: PipelineExtras[K]): void {
    this._extras.set(key, value);
  }

  /** ★ 类型安全的 Pipeline extras 读取。返回类型自动推断。 */
  getExtra<K extends keyof PipelineExtras>(key: K): PipelineExtras[K] | undefined;
  getExtra<K extends keyof PipelineExtras>(key: K, defaultValue: PipelineExtras[K]): PipelineExtras[K];
  getExtra<K extends keyof PipelineExtras>(key: K, defaultValue?: PipelineExtras[K]): PipelineExtras[K] | undefined {
    return (this._extras.get(key) as PipelineExtras[K]) ?? defaultValue;
  }

  /** Escape hatch: 存储非 Pipeline 契约的临时数据（adapter 内部使用） */
  setArbitraryExtra(key: string, value: unknown): void {
    this._extras.set(key, value);
  }

  /** Escape hatch: 读取非 Pipeline 契约的临时数据 */
  getArbitraryExtra<T = unknown>(key: string): T | undefined;
  getArbitraryExtra<T = unknown>(key: string, defaultValue: T): T;
  getArbitraryExtra<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return (this._extras.get(key) as T) ?? defaultValue;
  }

  clearExtra(): void {
    this._extras.clear();
  }

  isPrivateChat(): boolean {
    return this.getMessageType() === MessageType.PRIVATE;
  }

  isAdmin(): boolean {
    return this.role === 'admin';
  }

  stopEvent(): void {
    this._forceStopped = true;
  }

  isStopped(): boolean {
    return this._forceStopped;
  }

  shouldCallLlm(call: boolean): void {
    this.callLlm = call;
  }

  hasSendOper(): boolean {
    return this._hasSendOper;
  }

  // send is delegated by Platform adapter
  async send(chain: MessageChain): Promise<void> {
    this._hasSendOper = true;
    throw new Error('send() must be overridden by Platform adapter');
  }
}
