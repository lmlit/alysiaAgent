/**
 * QQ OneBot v11 适配器 (反向 WebSocket + HTTP API)
 *
 * 支持 NapCat / LLOneBot / Lagrange 等 OneBot 实现。
 * QQ 客户端作为 WebSocket 客户端连接到 Alysia，收发消息。
 *
 * 配置:
 *   platforms:
 *     qq:
 *       protocol: "onebot_v11"
 *       ws_port: 6199          # WebSocket 监听端口
 *       http_port: 6186        # QQ HTTP API 端口 (NapCat 默认 3000)
 *       access_token: ""       # 可选
 *
 * 客户端配置 (NapCat):
 *   WS 地址: ws://127.0.0.1:6199
 */
import { WebSocketServer, WebSocket } from './ws-impl.js';
import type { Platform, PlatformMetadata, MessageSession } from '@alysia/core/platform';
import { MessageEvent, MessageType, MessageChain } from '@alysia/core/platform';
import type { Message, MessageSender, MessageComponent } from '@alysia/core/platform';
import type { EventBus } from '@alysia/core/eventbus';

interface QQConfig {
  protocol: 'onebot_v11';
  ws_port: number;
  http_port: number;
  access_token?: string;
}

interface OneBotMessage {
  post_type: 'message' | 'notice' | 'request';
  message_type?: 'private' | 'group';
  user_id: number;
  group_id?: number;
  message: string | OneBotSegment[];
  raw_message: string;
  sender: { user_id: number; nickname: string; card?: string };
  message_id: number;
  self_id: number;
}

interface OneBotSegment {
  type: 'text' | 'image' | 'at' | 'face' | 'reply' | 'record' | 'video' | 'file';
  data: Record<string, string>;
}

export class QQOneBotAdapter implements Platform {
  meta: PlatformMetadata;
  private eventBus!: EventBus;
  private wss!: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();

  constructor(private config: QQConfig, private adapterId: string = 'qq') {
    this.meta = {
      name: 'onebot_v11',
      description: 'QQ (OneBot v11 / NapCat / LLOneBot)',
      id: adapterId,
    };
  }

  setEventBus(bus: EventBus): void { this.eventBus = bus; }

  async run(): Promise<void> {
    const port = this.config.ws_port || 6199;

    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws: WebSocket, req: any) => {
      // Token 验证
      if (this.config.access_token) {
        const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
        const token = url.searchParams.get('access_token')
          || (req.headers?.authorization || '').replace('Bearer ', '');
        if (token !== this.config.access_token) {
          ws.close(4001, 'Unauthorized');
          return;
        }
      }

      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.clients.set(clientId, ws);
      console.log(`[QQ] Connected: ${clientId}`);

      ws.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        this.handleMessage(text).catch(err =>
          console.error('[QQ] Error:', err.message)
        );
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        console.log(`[QQ] Disconnected: ${clientId}`);
      });
    });

    console.log(`[QQ] OneBot WS server on :${port}`);
  }

  private async handleMessage(raw: string): Promise<void> {
    try {
      const data = JSON.parse(raw) as OneBotMessage;
      if (data.post_type !== 'message') return;

      const event = this.toMessageEvent(data);
      if (event) this.eventBus.put(event);
    } catch {
      // Non-JSON or non-message frame, ignore
    }
  }

  private toMessageEvent(data: OneBotMessage): MessageEvent | null {
    const isGroup = data.message_type === 'group';
    const groupId = isGroup ? String(data.group_id!) : '';
    const sessionId = isGroup ? `group_${groupId}` : `private_${data.user_id}`;

    const sender: MessageSender = {
      userId: String(data.sender.user_id),
      nickname: data.sender.nickname || data.sender.card || String(data.sender.user_id),
    };

    const content = this.parseSegments(data.message);
    const messageStr = typeof data.message === 'string'
      ? data.message
      : data.message.map(s => s.data?.text || `[${s.type}]`).join('');

    const message: Message = {
      sessionId, groupId, sender,
      messageId: String(data.message_id),
      type: isGroup ? MessageType.GROUP : MessageType.PRIVATE,
      content, raw: data,
    };

    const event = new MessageEvent({
      messageStr: messageStr || '',
      messageObj: message,
      platformMeta: this.meta,
      sessionId,
    });

    event.send = async (chain: MessageChain) => {
      await this.doSend(data, chain);
    };
    return event;
  }

  private parseSegments(message: string | OneBotSegment[]): MessageComponent[] {
    if (typeof message === 'string') {
      return message.trim() ? [{ type: 'plain', text: message }] : [];
    }
    return message.map(seg => {
      switch (seg.type) {
        case 'text':  return { type: 'plain' as const, text: seg.data?.text || '' };
        case 'image': return { type: 'image' as const, url: seg.data?.url || seg.data?.file || '' };
        case 'at':    return { type: 'at' as const, qq: seg.data?.qq || 'all' };
        case 'face':  return { type: 'face' as const, id: seg.data?.id || '' };
        case 'reply': return { type: 'reply' as const, id: seg.data?.id || '' };
        case 'record':return { type: 'voice' as const, url: seg.data?.file || '' };
        default:      return { type: 'plain' as const, text: `[${seg.type}]` };
      }
    });
  }

  async doSend(data: OneBotMessage, chain: MessageChain): Promise<void> {
    const httpPort = this.config.http_port || 6186;

    const segments: OneBotSegment[] = [];
    for (const comp of chain) {
      if (comp.type === 'plain') segments.push({ type: 'text', data: { text: comp.text } });
      else if (comp.type === 'image') segments.push({ type: 'image', data: { file: comp.url } });
      else if (comp.type === 'at') segments.push({ type: 'at', data: { qq: comp.qq } });
      else if (comp.type === 'reply') segments.push({ type: 'reply', data: { id: comp.id } });
    }

    const isGroup = data.message_type === 'group';
    const endpoint = isGroup
      ? `/send_group_msg?group_id=${data.group_id}`
      : `/send_private_msg?user_id=${data.user_id}`;

    try {
      const resp = await fetch(`http://127.0.0.1:${httpPort}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: segments, auto_escape: false }),
      });
      if (!resp.ok) console.error(`[QQ] Send failed: ${resp.status}`);
    } catch (err: any) {
      console.error(`[QQ] Send error: ${err.message}`);
    }
  }

  async send(session: MessageSession, chain: MessageChain): Promise<void> {
    const httpPort = this.config.http_port || 6186;
    const isGroup = session.messageType === MessageType.GROUP;
    const id = session.sessionId.replace(/^(group_|private_)/, '');
    const endpoint = isGroup
      ? `/send_group_msg?group_id=${id}`
      : `/send_private_msg?user_id=${id}`;

    const segments: OneBotSegment[] = [];
    for (const comp of chain) {
      if (comp.type === 'plain') segments.push({ type: 'text', data: { text: comp.text } });
      else if (comp.type === 'image') segments.push({ type: 'image', data: { file: comp.url } });
    }

    try {
      await fetch(`http://127.0.0.1:${httpPort}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: segments, auto_escape: false }),
      });
    } catch (err: any) {
      console.error(`[QQ] Send error: ${err.message}`);
    }
  }

  async terminate(): Promise<void> {
    this.wss?.close();
  }
}
