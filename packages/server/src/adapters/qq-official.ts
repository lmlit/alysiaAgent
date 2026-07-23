/**
 * QQ 官方第三方 Agent 接入适配器 (WebSocket 客户端模式)
 *
 * 参考 AstrBot 的 botpy 方案：bot 主动连接 QQ 网关，
 * 不需要公网 IP / ngrok / webhook 回调。
 *
 * 流程:
 *   1. GET  /gateway          → 获取 WebSocket 地址
 *   2. POST /appAccessToken   → 获取 access_token
 *   3. 连接 WSS，发送 IDENTIFY
 *   4. 收到 DISPATCH 消息事件 → MessageEvent → Pipeline
 *
 * 注册: https://q.qq.com → 创建机器人 → 第三方Agent接入
 *
 * 配置:
 *   platforms:
 *     qq_official:
 *       app_id: "你的AppID"
 *       app_secret: "你的AppSecret"
 */
import type { Platform, PlatformMetadata, MessageSession } from '@alysia/core/platform';
import { MessageEvent, MessageType, MessageChain } from '@alysia/core/platform';
import type { Message, MessageSender, MessageComponent } from '@alysia/core/platform';
import type { EventBus } from '@alysia/core/eventbus';

// ── QQ WebSocket 协议常量 ─────────────────────────
const QQ_API_HOST = 'https://api.sgroup.qq.com';
const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const HEARTBEAT_INTERVAL = 40_000; // 40s

interface QQConfig {
  app_id: string;
  app_secret: string;
}

// QQ 网关消息格式
interface QQGatewayPayload {
  op: number;          // 0=dispatch, 10=hello, 11=heartbeat_ack
  d?: any;
  s?: number;          // 序列号
  t?: string;          // 事件类型: C2C_MESSAGE_CREATE, GROUP_AT_MESSAGE_CREATE, etc.
}

interface QQWssData {
  url: string;
}

interface QQTokenData {
  access_token: string;
  expires_in: number;
}

export class QQOfficialAgentAdapter implements Platform {
  meta: PlatformMetadata;
  private eventBus!: EventBus;
  private config: QQConfig;
  private accessToken = '';
  private tokenExpiry = 0;
  private seq: number | null = null;
  private ws: any = null;
  private heartbeatTimer: any = null;
  private reconnectTimer: any = null;
  private sessionId = '';
  private running = false;

  constructor(config: QQConfig, private adapterId = 'qq-official') {
    this.config = config;
    this.meta = {
      name: 'qq_official',
      description: 'QQ 官方 Agent (WebSocket 客户端)',
      id: adapterId,
    };
  }

  setEventBus(bus: EventBus): void { this.eventBus = bus; }

  async run(): Promise<void> {
    this.running = true;

    // 1. 获取 access_token
    await this.refreshToken();
    if (!this.accessToken) {
      console.error('[QQ Official] Failed to get access token');
      return;
    }

    // 2. 获取 WebSocket 地址
    const wssUrl = await this.getGatewayUrl();
    if (!wssUrl) {
      console.error('[QQ Official] Failed to get gateway URL');
      return;
    }

    // 3. 连接 WebSocket
    await this.connectWss(wssUrl);
  }

  private async refreshToken(): Promise<void> {
    try {
      const resp = await fetch(QQ_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: this.config.app_id,
          clientSecret: this.config.app_secret,
        }),
      });
      const data = await resp.json() as QQTokenData;
      if (data.access_token) {
        this.accessToken = data.access_token;
        this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
        console.log('[QQ Official] Token obtained');
      }
    } catch (err: any) {
      console.error('[QQ Official] Token error:', err.message);
    }
  }

  private async getGatewayUrl(): Promise<string | null> {
    try {
      const resp = await fetch(`${QQ_API_HOST}/gateway`, {
        headers: { Authorization: `QQBot ${this.accessToken}` },
      });
      const raw = await resp.text();
      console.log('[QQ Official] Gateway response:', resp.status, raw.slice(0, 500));
      const data = JSON.parse(raw) as QQWssData;
      return data.url || null;
    } catch (err: any) {
      console.error('[QQ Official] Gateway error:', err.message);
      return null;
    }
  }

  private async connectWss(wssUrl: string): Promise<void> {
    // 使用 Node.js 原生 WebSocket 连接 (Node 22+ 内置, Node 20 用 ws 或者手写客户端)
    // 目标: 连接到 wss://api.sgroup.qq.com/websocket
    const url = new URL(wssUrl);

    console.log(`[QQ Official] Connecting to ${url.hostname}...`);

    // 使用我们自己的 ws-impl 作为客户端连接
    const tls = await import('tls');
    const socket = tls.connect({
      host: url.hostname,
      port: 443,
      servername: url.hostname,
    });

    this.ws = socket;

    // WebSocket 握手 (客户端)
    const nonce = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) nonce[i] = Math.floor(Math.random() * 256);
    const key = nonce.toString('base64');
    // QQ 网关的 WSS URL 已包含鉴权信息，不需要额外 Authorization 头
    socket.write(
      `GET ${url.pathname}${url.search || ''} HTTP/1.1\r\n` +
      `Host: ${url.hostname}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`
    );

    let handshakeBuffer = '';
    let handshakeDone = false;

    socket.on('data', (data: Buffer) => {
      if (!handshakeDone) {
        handshakeBuffer += data.toString('utf-8');
        if (handshakeBuffer.includes('\r\n\r\n')) {
          const statusLine = handshakeBuffer.split('\r\n')[0];
          if (statusLine.includes('101')) {
            handshakeDone = true;
            console.log('[QQ Official] WebSocket connected');
            this.startHeartbeat();
            this.sendIdentify();
          } else {
            const bodyStart = handshakeBuffer.indexOf('\r\n\r\n') + 4;
            const body = bodyStart < handshakeBuffer.length ? handshakeBuffer.slice(bodyStart) : '';
            console.error('[QQ Official] WS handshake failed:', statusLine);
            console.error('[QQ Official] Response body:', body.slice(0, 500));
            socket.destroy();
          }
        }
        return;
      }

      // WebSocket 帧解析
      this.parseFrame(data, (payload) => {
        try {
          const msg: QQGatewayPayload = JSON.parse(payload);
          this.handleGatewayMessage(msg);
        } catch {}
      });
    });

    socket.on('close', () => {
      console.log('[QQ Official] WebSocket disconnected');
      this.stopHeartbeat();
      if (this.running) {
        this.scheduleReconnect(wssUrl);
      }
    });

    socket.on('error', (err: Error) => {
      console.error('[QQ Official] WS error:', err.message);
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && !this.ws.destroyed) {
        this.sendFrame(1, JSON.stringify({ op: 1, d: this.seq }));
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendIdentify(): void {
    this.sendFrame(1, JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${this.accessToken}`,
        intents: (1 << 25) | (1 << 0) | (1 << 1), // C2C + GUILDS + GUILD_MEMBERS + GROUP
        shard: [0, 1],
      },
    }));
  }

  private sendFrame(opcode: number, payload: string): void {
    if (!this.ws || this.ws.destroyed) return;
    const data = Buffer.from(payload, 'utf-8');
    const frame = Buffer.alloc(2 + data.length);
    frame[0] = 0x81; // FIN + text opcode
    frame[1] = data.length < 126 ? data.length : (data.length < 65536 ? 126 : 127);

    let offset = 2;
    if (data.length >= 65536) {
      frame.writeBigUInt64BE(BigInt(data.length), 2);
      offset = 10;
    } else if (data.length >= 126) {
      frame.writeUInt16BE(data.length, 2);
      offset = 4;
    }
    Buffer.from(payload, 'utf-8').copy(frame, offset);
    this.ws.write(frame);
  }

  private frameBuffer = Buffer.alloc(0);

  private parseFrame(chunk: Buffer, onMessage: (text: string) => void): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);

    while (this.frameBuffer.length >= 2) {
      const opcode = this.frameBuffer[0] & 0x0f;
      const fin = (this.frameBuffer[0] & 0x80) !== 0;
      let payloadLen = this.frameBuffer[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.frameBuffer.length < 4) return;
        payloadLen = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.frameBuffer.length < 10) return;
        payloadLen = Number(this.frameBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (this.frameBuffer.length < offset + payloadLen) return;

      const payload = this.frameBuffer.subarray(offset, offset + payloadLen);
      this.frameBuffer = this.frameBuffer.subarray(offset + payloadLen);

      if (opcode === 0x1 && fin) {
        onMessage(payload.toString('utf-8'));
      } else if (opcode === 0x8) {
        // Close frame
        if (this.ws && !this.ws.destroyed) this.ws.destroy();
        return;
      } else if (opcode === 0x9) {
        // Ping → Pong
        const pongFrame = Buffer.alloc(2 + payloadLen);
        pongFrame[0] = 0x8A; // FIN + pong
        pongFrame[1] = payloadLen;
        payload.copy(pongFrame, 2);
        if (this.ws && !this.ws.destroyed) this.ws.write(pongFrame);
      }
    }
  }

  private handleGatewayMessage(msg: QQGatewayPayload): void {
    switch (msg.op) {
      case 10: // Hello — 心跳间隔
        console.log('[QQ Official] Ready (heartbeat interval:', msg.d?.heartbeat_interval, 'ms)');
        break;

      case 11: // Heartbeat ACK
        break;

      case 0: // Dispatch — 消息事件
        this.seq = msg.s ?? this.seq;
        this.handleEvent(msg.t || '', msg.d || {});
        break;

      default:
        console.log('[QQ Official] Unknown op:', msg.op);
    }
  }

  private handleEvent(eventType: string, data: any): void {
    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'C2C_MESSAGE_CREATE';
    const chatType = eventType === 'C2C_MESSAGE_CREATE' ? 'private' :
                     eventType.startsWith('GROUP') ? 'group' : 'channel';

    const userId = data.author?.user_openid || data.author?.id || '';
    const groupId = data.group_openid || data.channel_id || '';
    const sessionId = chatType === 'private' ? `private_${userId}` : `group_${groupId}`;

    const sender: MessageSender = {
      userId,
      nickname: data.author?.username || userId,
    };

    const content = data.content || '';
    const message: Message = {
      sessionId,
      groupId: chatType === 'private' ? '' : groupId,
      sender,
      messageId: data.id || '',
      type: chatType === 'private' ? MessageType.PRIVATE : MessageType.GROUP,
      content: [{ type: 'plain', text: content }],
      raw: data,
    };

    const event = new MessageEvent({
      messageStr: content,
      messageObj: message,
      platformMeta: this.meta,
      sessionId,
    });

    // 回复通过 QQ HTTP API 发送
    event.send = async (chain: MessageChain) => {
      await this.sendReply(data, chain, chatType);
    };

    this.eventBus.put(event);
  }

  private async sendReply(data: any, chain: MessageChain, chatType: string): Promise<void> {
    await this.ensureToken();

    // 组装回复内容
    const text = [...chain].filter(c => c.type === 'plain').map(c => (c as any).text).join('\n');
    if (!text) return;

    const payload: any = {
      content: text,
      msg_type: 0,
    };

    try {
      if (chatType === 'group') {
        payload.msg_id = data.id;
        await fetch(`${QQ_API_HOST}/v2/groups/${data.group_openid}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `QQBot ${this.accessToken}`,
          },
          body: JSON.stringify(payload),
        });
      } else if (chatType === 'private') {
        payload.msg_id = data.id;
        await fetch(`${QQ_API_HOST}/v2/users/${data.author?.user_openid || data.author?.id}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `QQBot ${this.accessToken}`,
          },
          body: JSON.stringify(payload),
        });
      }
    } catch (err: any) {
      console.error('[QQ Official] Send error:', err.message);
    }
  }

  private async ensureToken(): Promise<void> {
    if (Date.now() > this.tokenExpiry) {
      await this.refreshToken();
    }
  }

  private scheduleReconnect(_wssUrl: string): void {
    if (this.reconnectTimer) return;
    console.log('[QQ Official] Reconnecting in 5s...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.run().catch(console.error);
    }, 5000);
  }

  async send(session: MessageSession, chain: MessageChain): Promise<void> {
    await this.ensureToken();
    const text = [...chain].filter(c => c.type === 'plain').map(c => (c as any).text).join('\n');
    if (!text) return;

    const isGroup = session.messageType === MessageType.GROUP;
    const id = session.sessionId.replace(/^(private_|group_)/, '');

    try {
      await fetch(`${QQ_API_HOST}/v2/${isGroup ? 'groups' : 'users'}/${id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `QQBot ${this.accessToken}`,
        },
        body: JSON.stringify({ content: text, msg_type: 0 }),
      });
    } catch (err: any) {
      console.error('[QQ Official] Send error:', err.message);
    }
  }

  async terminate(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws && !this.ws.destroyed) this.ws.destroy();
    console.log('[QQ Official] Terminated');
  }
}
