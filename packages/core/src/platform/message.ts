import type { MessageType } from './types.js';

// 消息组件基类型
export type MessageComponent =
  | PlainComponent
  | ImageComponent
  | AtComponent
  | ReplyComponent
  | VoiceComponent
  | FileComponent
  | VideoComponent
  | StickerComponent;

export interface PlainComponent {
  type: 'plain';
  text: string;
}

export interface ImageComponent {
  type: 'image';
  url: string;
  file?: string;
}

export interface AtComponent {
  type: 'at';
  qq: string;
  name?: string;
}

export interface ReplyComponent {
  type: 'reply';
  id: string;
  senderId?: string;
  senderNickname?: string;
  messageStr?: string;
}

export interface VoiceComponent {
  type: 'voice';
  url: string;
  path?: string;
}

export interface FileComponent {
  type: 'file';
  url: string;
  name: string;
}

export interface VideoComponent {
  type: 'video';
  url: string;
}

export interface StickerComponent {
  type: 'sticker';
  emoji?: string;
  fileId?: string;
}

// 消息发送者
export interface MessageSender {
  userId: string;
  nickname: string;
}

// 统一消息对象（平台无关）
export interface Message {
  sessionId: string;
  groupId: string;
  sender: MessageSender;
  messageId: string;
  type: MessageType;
  content: MessageComponent[];
  raw: unknown; // 保留原始平台消息引用
}
