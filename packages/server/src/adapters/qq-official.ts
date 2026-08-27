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
import { logger } from '@alysia/core';

// ── 表情包标记协议：文案内 [表情包:名字] → 图片发送 ──────
// 提取为纯函数便于单测（不依赖 adapter 实例）。
// ★ 8-27 兼容全角括号/冒号（LLM 偶发输出 ［表情包:名字］/［表情包：名字］——
//   8-27 实测全角标记未被解析、原样发给用户 → 双保险解析）
export function parseStickerMarks(text: string): { text: string; marks: string[] } {
  const marks: string[] = [];
  for (const m of text.matchAll(/[\[［]\s*表情包\s*[:：]\s*([^\]］]+)\s*[\]］]/g)) {
    marks.push(m[1].trim());
  }
  // 移除标记后可能残留相邻空格/换行，压缩为单个
  const clean = text
    .replace(/[\[［]\s*表情包\s*[:：]\s*[^\]］]+[\]］]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
  return { text: clean, marks };
}

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

/** ★ 8-09 长文案分段（模拟实时打字节奏）。
 *  换行符 = **强制段边界**（LLM 输出的自然段，8-09 用户建议）；行内按标点切句 →
 *  贪心合段 ≤maxLen → 超长句按弱停顿（，；、）拆 → 字符硬切兜底；尾部碎段（<8 字）并入。
 *  导出供测试。 */
export function segmentText(text: string, maxLen = 40): string[] {
  // ① 先按换行强制分段（\n 是自然段边界，合段时不得跨行合并）
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    return lines.flatMap(l => (l.length <= maxLen ? [l] : segmentByPunct(l, maxLen)));
  }
  return segmentByPunct(lines[0] ?? text, maxLen);
}

/** 行内标点切分：强停顿（。！？…）切句 → 贪心合段 → 弱停顿拆超长句 → 字符硬切兜底 */
function segmentByPunct(text: string, maxLen: number): string[] {
  const sentences = text.match(/[^。！？….]+[。！？….]?/g)?.map(s => s.trim()).filter(Boolean) ?? [];
  const segments: string[] = [];
  let buf = '';
  for (let s of sentences) {
    if (s.length > maxLen) {
      // 超长句：弱停顿拆 → 字符硬切兜底
      if (buf.trim()) segments.push(buf.trim());
      buf = '';
      const pieces = s.match(/[^，；、]+[，；、]?/g) ?? [s];
      for (let p of pieces) {
        while (p.length > maxLen) { segments.push(p.slice(0, maxLen)); p = p.slice(maxLen); }
        if ((buf + p).length > maxLen) { if (buf.trim()) segments.push(buf.trim()); buf = p; }
        else buf += p;
      }
      continue;
    }
    if ((buf + s).length > maxLen) { if (buf.trim()) segments.push(buf.trim()); buf = s; }
    else buf += s;
  }
  if (buf.trim()) segments.push(buf.trim());
  // 尾部碎段并入上一段（避免单独一段"好。"）
  if (segments.length > 1 && segments[segments.length - 1].length < 8) {
    const tail = segments.pop()!;
    segments[segments.length - 1] = (segments[segments.length - 1] + tail).trim();
  }
  return segments;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class QQOfficialAgentAdapter implements Platform {
  meta: PlatformMetadata;
  private eventBus!: EventBus;
  private config: QQConfig;
  private accessToken = '';
  private tokenExpiry = 0;
  private seq: number | null = null;
  private ws: any = null;
  private heartbeatTimer: any = null;
  private _watchdog: any = null;
  private reconnectTimer: any = null;
  private reconnectDelayMs = 5_000;
  private sessionId = '';
  private running = false;
  private lastHeartbeatAck = 0;
  /** 表情包解析回调：名字 → 图片路径（由 bootstrap 注入 core.memoryManager.findSticker） */
  private stickerResolver: ((name: string) => string | null) | null = null;
  /** Vision Bridge：用户发图片 → 视觉模型转文字描述 → 喂给 DeepSeek */
  private visionBridge: { describe: (url: string, prompt?: string) => Promise<string | null> } | null = null;

  setStickerResolver(fn: (name: string) => string | null): void {
    this.stickerResolver = fn;
  }

  setVisionBridge(bridge: { describe: (url: string, prompt?: string) => Promise<string | null> }): void {
    this.visionBridge = bridge;
  }

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
      logger.error('[QQ Official] Failed to get access token');
      // ★ 失败必须继续重试：断网时 token 获取失败，若不调度重连，断网恢复后服务永久停摆
      this.scheduleReconnect('');
      return;
    }

    // 2. 获取 WebSocket 地址
    const wssUrl = await this.getGatewayUrl();
    if (!wssUrl) {
      logger.error('[QQ Official] Failed to get gateway URL');
      this.scheduleReconnect('');
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
        logger.info('[QQ Official] Token obtained');
      }
    } catch (err: any) {
      logger.error('[QQ Official] Token error:', err.message);
    }
  }

  private async getGatewayUrl(): Promise<string | null> {
    try {
      const resp = await fetch(`${QQ_API_HOST}/gateway`, {
        headers: { Authorization: `QQBot ${this.accessToken}` },
      });
      const raw = await resp.text();
      logger.info('[QQ Official] Gateway response:', resp.status, raw.slice(0, 500));
      const data = JSON.parse(raw) as QQWssData;
      return data.url || null;
    } catch (err: any) {
      logger.error('[QQ Official] Gateway error:', err.message);
      return null;
    }
  }

  private async connectWss(wssUrl: string): Promise<void> {
    // 使用 Node.js 原生 WebSocket 连接 (Node 22+ 内置, Node 20 用 ws 或者手写客户端)
    // 目标: 连接到 wss://api.sgroup.qq.com/websocket
    const url = new URL(wssUrl);

    logger.info(`[QQ Official] Connecting to ${url.hostname}...`);

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

    let handshakeBuffer = Buffer.alloc(0);
    let handshakeDone = false;

    socket.on('data', (data: Buffer) => {
      if (!handshakeDone) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, data]);
        const text = handshakeBuffer.toString('utf-8');
        if (text.includes('\r\n\r\n')) {
          const statusLine = text.split('\r\n')[0];
          if (statusLine.includes('101')) {
            handshakeDone = true;
            logger.info('[QQ Official] WebSocket connected');
            // ★ 同一 TCP chunk 中 HTTP 头后的 WebSocket 帧字节（如 Hello op:10）
            //   不会再次触发 data 事件，必须立即喂给帧解析器，否则 Hello 永久丢失 → bot 不上线
            const headerEnd = text.indexOf('\r\n\r\n') + 4;
            if (headerEnd < handshakeBuffer.length) {
              const trailing = handshakeBuffer.subarray(headerEnd);
              logger.debug(`[QQ Official] handshake: ${trailing.length} trailing bytes after header`);
              this.parseFrame(trailing, (payload) => {
                try { const msg: QQGatewayPayload = JSON.parse(payload); this.handleGatewayMessage(msg); } catch {}
              });
            }
          } else {
            const bodyStart = text.indexOf('\r\n\r\n') + 4;
            const body = bodyStart < text.length ? text.slice(bodyStart) : '';
            logger.error('[QQ Official] WS handshake failed:', statusLine);
            logger.error('[QQ Official] Response body:', body.slice(0, 500));
            socket.destroy();
          }
        }
        return;
      }

      // WebSocket 帧解析
      this.parseFrame(data, (payload) => {
        try {
          const msg: QQGatewayPayload = JSON.parse(payload);
          this.handleGatewayMessage(msg).catch(err => logger.error('[QQ Official] gateway error:', err));
        } catch {}
      });
    });

    socket.on('close', () => {
      logger.info('[QQ Official] WebSocket disconnected');
      this.stopHeartbeat();
      if (this.running) {
        this.scheduleReconnect(wssUrl);
      }
    });

    socket.on('error', (err: Error) => {
      logger.error('[QQ Official] WS error:', err.message);
    });
  }

  private startHeartbeat(intervalMs?: number): void {
    const interval = intervalMs || HEARTBEAT_INTERVAL;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && !this.ws.destroyed) {
        this.sendFrame(1, JSON.stringify({ op: 1, d: this.seq }));
      }
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
  }

  private sendIdentify(): void {
    const payload = JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${this.accessToken}`,
        intents: (1 << 25) | (1 << 12) | (1 << 0),
        shard: [0, 1],
        properties: {},
      },
    });
    logger.info('[QQ Official] → IDENTIFY, payload length:', payload.length);
    this.sendFrame(1, payload);
  }

  private sendFrame(opcode: number, payload: string): void {
    if (!this.ws || this.ws.destroyed) return;
    const data = Buffer.from(payload, 'utf-8');
    const headerLen = data.length < 126 ? 2 : (data.length < 65536 ? 4 : 10);
    const maskLen = 4; // Client frames MUST be masked (RFC 6455 §5.3)
    const frame = Buffer.alloc(headerLen + maskLen + data.length);
    frame[0] = 0x81; // FIN + text opcode
    frame[1] = 0x80 | // MASK bit set
      (data.length < 126 ? data.length : (data.length < 65536 ? 126 : 127));

    let offset = 2;
    if (data.length >= 65536) {
      frame.writeBigUInt64BE(BigInt(data.length), 2);
      offset = 10;
    } else if (data.length >= 126) {
      frame.writeUInt16BE(data.length, 2);
      offset = 4;
    }
    // 4-byte random mask
    const mask = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);
    mask.copy(frame, offset);
    // Masked payload
    for (let i = 0; i < data.length; i++) {
      frame[offset + maskLen + i] = data[i] ^ mask[i % 4];
    }
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

  private async handleGatewayMessage(msg: QQGatewayPayload): Promise<void> {
    logger.info('[QQ Official] ← op:', msg.op, msg.t || '');
    switch (msg.op) {
      case 10: // Hello → send IDENTIFY
        logger.info('[QQ Official] Hello (heartbeat:', msg.d?.heartbeat_interval, 'ms)');
        this.sendIdentify();
        this.stopHeartbeat();
        const interval = msg.d?.heartbeat_interval || 41250;
        this.lastHeartbeatAck = Date.now();
        // Send heartbeat
        this.heartbeatTimer = setInterval(() => {
          if (this.ws && !this.ws.destroyed) {
            this.sendFrame(1, JSON.stringify({ op: 1, d: this.seq }));
          }
        }, interval);
        // Watchdog: if no ACK for 2x interval, force reconnect
        this._watchdog = setInterval(() => {
          if (Date.now() - this.lastHeartbeatAck > interval * 2) {
            logger.info('[QQ Official] Heartbeat timeout — reconnecting');
            if (this.ws && !this.ws.destroyed) this.ws.destroy();
          }
        }, interval);
        break;

      case 11: // Heartbeat ACK
        this.lastHeartbeatAck = Date.now();
        break;

      case 12: // Ready / Resumed
        logger.info('[QQ Official] ✅ Bot is now ONLINE — session:', msg.d?.session_id);
        this.sessionId = msg.d?.session_id || '';
        break;

      case 7: // Reconnect
        logger.info('[QQ Official] Server requested reconnect');
        break;

      case 9: // Invalid session
        logger.info('[QQ Official] ❌ Invalid session — re-identifying...');
        this.sendIdentify();
        break;

      case 0: // Dispatch — 消息事件
        this.seq = msg.s ?? this.seq;
        this.handleEvent(msg.t || '', msg.d || {}).catch(err => logger.error('[QQ Official] handleEvent error:', err));
        break;

      default:
        logger.info('[QQ Official] Op:', msg.op, 't:', msg.t, 'd:', JSON.stringify(msg.d || {}).slice(0, 200));
    }
  }

  private async handleEvent(eventType: string, data: any): Promise<void> {
    // Log ALL events for debugging
    logger.info('[QQ Official] Event:', eventType, 'keys:', Object.keys(data || {}).join(','));

    // Only process message events, not gateway events (READY, RESUMED, etc.)
    if (eventType === 'READY' || eventType === 'RESUMED') {
      logger.info('[QQ Official] ✅ Bot ONLINE —', eventType, 'session:', data?.session_id);
      // 连接成功：重置重连退避（下次断线从 5s 开始）
      this.reconnectDelayMs = 5_000;
      return;
    }
    if (!eventType.includes('MESSAGE') && !eventType.includes('C2C') && !eventType.includes('GROUP')) return;

    // 延迟 5 秒后发 "思考中" — 只有长时间处理时才触发
    const chatType = eventType.startsWith('GROUP') ? 'group' : 'private';
    let thinkingSent = false;
    const thinkingTimer = setTimeout(() => {
      thinkingSent = true;
      this.sendQuickReply(data, pickThinking(data.content || ''), chatType);
    }, 5000);

    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'C2C_MESSAGE_CREATE';
    const cType = eventType === 'C2C_MESSAGE_CREATE' ? 'private' :
                     eventType.startsWith('GROUP') ? 'group' : 'channel';

    const userId = data.author?.user_openid || data.author?.id || '';
    const groupId = data.group_openid || data.channel_id || '';
    const sessionId = chatType === 'private' ? `private_${userId}` : `group_${groupId}`;

    // ★ 消息正文日志：排查"谁发了什么"的关键
    logger.info(`[QQ Official] ← ${eventType} session=${sessionId.slice(-16)} author=${(data.author?.username || userId).slice(0, 12)} content="${(data.content || '').slice(0, 100)}"`);

    const sender: MessageSender = {
      userId,
      nickname: data.author?.username || userId,
    };

    let content = data.content || '';

    // ★ 图片 → 文字描述（Vision Bridge）：用户发图片时，QQ 放在 attachments[] 中。
    //   msg_elements 是嵌套富媒体（引用消息等），优先级低于 attachments。
    //   ★ 8-10 图片预热：不再同步 await——describe fire-and-forget 挂到事件上，
    //     由 Coalescer 在 flush（私聊合并窗口）/放行（群聊）时统一 await 拼接，
    //     合并窗口时间用来掩盖描述延迟（图文不阻塞）。
    const elements: any[] = [...(data.attachments || []), ...(data.msg_elements || [])];
    const pendingDescs: Promise<string | null>[] = [];
    if (elements.length > 0 && this.visionBridge) {
      for (const el of elements) {
        // QQ 附件 content_type 如 "image/jpeg"；msg_elements 用 msg_type
        const elType = el?.content_type ?? el?.msg_type ?? '';
        if (String(elType).startsWith('image')) {
          const url = el?.url || '';
          if (!url) continue;
          pendingDescs.push(
            this.visionBridge!.describe(typeof url === 'string' ? url : '', '请用一两句话描述这张图片，注意图中的文字、场景和情绪。')
              .catch(() => null),
          );
        }
      }
    } else if (elements.length > 0 && !this.visionBridge) {
      logger.debug('[QQ Official] image attachments present but visionBridge not configured, skipping');
    }

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

    // ★ 8-10 合并时取消本消息的"思考中"timer（coalescer-cancel-thinking）：
    //   消息被打断合并（pipeline 在 Coalescer 直接返回）时 adapter 不知情，
    //   timer 照发 → 冗余提示。Coalescer 打断入桶时调用本回调；在途事件
    //   （合并基底）的 timer 保留（回复确实在途，提示语义正确）。
    event.setExtra('cancel_thinking', () => {
      clearTimeout(thinkingTimer);
      thinkingSent = true;
    });

    // ★ 8-10 图片预热：描述 Promise 挂事件，Coalescer 负责 await 拼接
    if (pendingDescs.length > 0) {
      event.setExtra('pending_image_descs', pendingDescs);
    }

    // 短期记忆由 MemoryRetrievalStage 从 EventLog 读取，不再在适配器层维护
    let replyText = '';
    event.send = async (chain: MessageChain) => {
      clearTimeout(thinkingTimer);
      for (const comp of chain) {
        if (comp.type === 'plain') replyText += (comp as any).text;
      }
      await this.sendReply(data, chain, chatType);
    };

    this.eventBus.put(event);
  }

  private async sendReply(data: any, chain: MessageChain, chatType: string): Promise<void> {
    await this.ensureToken();

    // 解析 [表情包:名字] 标记 → 表情包图片；标记从正文中移除
    const rawText = [...chain].filter(c => c.type === 'plain').map(c => (c as any).text).join('\n');
    const parsed = parseStickerMarks(rawText);
    const stickerImages: string[] = [];
    if (this.stickerResolver) {
      for (const name of parsed.marks) {
        const imgPath = this.stickerResolver(name);
        if (imgPath) stickerImages.push(imgPath);
      }
    }
    const text = parsed.text;
    const images = stickerImages;

    if (!text && images.length === 0) { logger.info('[QQ Official] Reply empty, skipping send'); return; }
    logger.info('[QQ Official] Sending reply:', (text || '').slice(0, 80), '+', images.length, 'img →', chatType);

    const endpoint = chatType === 'group'
      ? `${QQ_API_HOST}/v2/groups/${data.group_openid}/messages`
      : `${QQ_API_HOST}/v2/users/${data.author?.user_openid || data.author?.id}/messages`;

    try {
      // 1. 文本回复（★ 8-09 统一分段发送；msg_seq 为被动回复必需的自增序号，逐段递增）
      if (text) {
        await this.sendSegmented(endpoint, text, {
          segmented: chatType !== 'group', // 群聊单条（防刷屏）
          extra: () => ({ msg_id: data.id, msg_seq: ++this.msgSeq }),
        });
      }

      // 2. 图片回复（表情包）：
      //    私聊 → 上传 srv_send_msg=true 直接发图（uploadImage 内部完成）
      //    群聊 → 上传拿 file_info → 发 msg_type=7 被动媒体消息
      //    文档要求：msg_type=7 时 content 字段必须填值（空格），否则 40011000
      for (const imgPath of images) {
        const fileInfo = await this.uploadImage(chatType, data, imgPath);
        if (!fileInfo || chatType !== 'group') continue;
        const mediaResp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${this.accessToken}` },
          body: JSON.stringify({ msg_type: 7, msg_id: data.id, msg_seq: ++this.msgSeq, media: fileInfo, content: ' ', event_id: 'GROUP_MSG_RECEIVE' }),
        });
        const mediaResult = await mediaResp.json().catch(() => ({}));
        logger.info('[QQ Official] Group media send:', mediaResp.status, JSON.stringify(mediaResult).slice(0, 200));
      }
    } catch (err: any) {
      logger.error('[QQ Official] Send error:', err.message);
    }
  }

  /** file_info 缓存：同一张图 TTL 内复用，避免重复上传（省流量） */
  private fileInfoCache = new Map<string, { fileInfo: string; expiresAt: number }>();
  private static FILE_INFO_TTL_MS = 90 * 60 * 1000; // 90 分钟（QQ TTL 约 2 小时，留余量）
  /** 被动回复自增序号（msg_seq，QQ API 必需，用于避免重复响应被去重） */
  private msgSeq = 0;

  /** 上传图片到 QQ 官方 API，返回 file_info（用于 msg_type=7 发图）。
   *  file_info 有 TTL，缓存复用避免重复上传 base64。 */
  private async uploadImage(chatType: string, data: any, imagePath: string): Promise<string | null> {
    try {
      const fs = await import('fs');
      const path = await import('path');
      // 支持绝对路径和相对路径（相对 server 启动目录）。
      // 注意：'/data/...' 在 Windows 会被当作盘符根路径，需去掉前导斜杠。
      const normalized = imagePath.replace(/^[\\/]+/, '');
      const absPath = path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized);
      if (!fs.existsSync(absPath)) {
        logger.warn(`[QQ Official] Image not found: ${absPath} (from ${imagePath})`);
        return null;
      }

      // ★ 缓存命中：TTL 内直接复用 file_info（图片没变就不用重新上传）
      const cached = this.fileInfoCache.get(absPath);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.fileInfo;
      }

      const uploadUrl = chatType === 'group'
        ? `${QQ_API_HOST}/v2/groups/${data.group_openid}/files`
        : `${QQ_API_HOST}/v2/users/${data.author?.user_openid || data.author?.id}/files`;

      // QQ API v2: 上传接口用 JSON body，图片以 base64 的 file_data 传输。
      // ★ 私聊：srv_send_msg=true 直接发图（被动窗口内有效，已验证成功）
      // ★ 群聊：srv_send_msg=true 触发主动消息会报 40034105 无权限，
      //   改为 srv_send_msg=false 拿 file_info → 调用方再发 msg_type=7 被动消息
      const isDirectSend = chatType === 'private';
      const base64 = fs.readFileSync(absPath).toString('base64');
      logger.info(`[QQ Official] Uploading image → ${uploadUrl.replace(QQ_API_HOST, '')} (${(base64.length / 1024).toFixed(0)}KB, ${isDirectSend ? 'direct-send' : 'get-file-info'})`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000); // 20s 超时，防止挂起
      const resp = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${this.accessToken}` },
        body: JSON.stringify({ file_type: 1, file_data: base64, srv_send_msg: isDirectSend }),
        signal: controller.signal,
      }).catch((err: any) => {
        logger.warn('[QQ Official] Upload image request failed:', err.name, err.message);
        return null;
      });
      clearTimeout(timeout);
      if (!resp) return null;
      const result = await resp.json() as any;
      // 兼容两种响应结构：{ data: { file_info } } 或顶层 { file_info }
      const fileInfo = result?.data?.file_info || result?.file_info;
      if (!fileInfo) {
        logger.warn('[QQ Official] Upload image failed:', resp.status, JSON.stringify(result).slice(0, 300));
        return null;
      }
      if (isDirectSend) {
        logger.info(`[QQ Official] Image sent via upload: ${path.basename(absPath)} (direct)`);
        return null; // 私聊已直接发送，无需再发消息
      }
      // ★ 写入缓存：TTL 内复用，避免每次发图都上传 base64
      this.fileInfoCache.set(absPath, { fileInfo, expiresAt: Date.now() + QQOfficialAgentAdapter.FILE_INFO_TTL_MS });
      return fileInfo;
    } catch (err: any) {
      logger.error('[QQ Official] Upload image error:', err.message);
      return null;
    }
  }

  private async ensureToken(): Promise<void> {
    if (Date.now() > this.tokenExpiry) {
      await this.refreshToken();
    }
  }

  /** ★ 主动消息发送（不带 msg_id，bot 主动发起）。
   *  私聊互动窗口（48h）内可用；支持 [表情包:名字] 标记（文本+图片分开发）。
   *  ★ 8-09 长文案自动分段（>60 字）：逐段发送模拟实时打字节奏——段间 500-900ms，
   *    任一段失败立即中断；≤3 段，超出回退合并（配额克制）。 */
  async sendProactive(openid: string, text: string, opts?: { maxSegments?: number }): Promise<boolean> {
    await this.ensureToken();
    const { text: cleanText, marks } = parseStickerMarks(text);
    const maxSegments = opts?.maxSegments ?? 3;

    // 先发文本（长文案分段：>60字 或含换行符）
    let sentAny = false;
    if (cleanText.trim()) {
      let segments = (cleanText.trim().length > 60 || cleanText.includes('\n')) ? segmentText(cleanText) : [cleanText.trim()];
      // 段数克制：超出上限 → 尾部合并进最后一段（不丢内容）
      if (segments.length > maxSegments) {
        segments[maxSegments - 1] += segments.slice(maxSegments).join('');
        segments.length = maxSegments;
      }
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i].trim();
        if (!seg) continue;
        const ok = await this.postMessage(openid, seg);
        if (!ok) return false; // ★ 任一段失败立即中断（窗口关/限流），不再发后续段
        sentAny = true;
        if (i < segments.length - 1) await sleep(500 + Math.random() * 400); // 模拟打字停顿
      }
    }

    // 再发表情包图片（私聊直发 srv_send_msg=true，uploadImage 内部完成发送）
    for (const name of marks) {
      const imgPath = this.stickerResolver?.(name) ?? null;
      if (!imgPath) continue;
      await this.uploadImage('private', { author: { user_openid: openid } }, imgPath);
      // 直发模式上传即发送（成功返回 null），uploadImage 内部已记录成败日志；
      // 失败也返回 null，info 行会误导——降为 debug，成败以 uploadImage 自身日志为准
      logger.debug(`[QQ Official] Proactive sticker sent: ${name}`);
    }

    // 文本和图片都为空 → 失败
    if (!sentAny && marks.length === 0) return false;
    return true;
  }

  /** 主动消息文本发送（POST /v2/users/{openid}/messages） */
  private async postMessage(openid: string, content: string): Promise<boolean> {
    try {
      const resp = await fetch(`${QQ_API_HOST}/v2/users/${openid}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${this.accessToken}` },
        body: JSON.stringify({ content, msg_type: 0 }),
      });
      const result = await resp.json().catch(() => ({}));
      const ok = resp.status === 200 && (result?.code === 0 || result?.code === undefined);
      logger.info(`[QQ Official] Proactive send → ${openid.slice(0, 8)}...: ${ok ? 'OK' : resp.status + ' ' + JSON.stringify(result).slice(0, 150)}`);
      return ok;
    } catch (err: any) {
      logger.error('[QQ Official] Proactive send error:', err.message);
      return false;
    }
  }

  /** 断线重连调度：指数退避 5s → 15s → 45s → 上限 5min；连接成功后重置 */
  private scheduleReconnect(_wssUrl: string): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    logger.info(`[QQ Official] Reconnecting in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 3, 300_000);
      if (this.running) this.run().catch(console.error);
    }, delay);
  }

  /** ★ 8-09 统一分段发送（对话回复 sendReply / 平台接口 send 共用，根治"改漏路径"）。
   *  私聊长文案（>60字 或含换行——LLM 输出按 \n 分自然段）逐段发送，段间 500-900ms；
   *  任一段失败（非 2xx）→ 打印状态码+响应体并中断后续段。
   *  @param extra 每段请求额外字段（如被动回复的 msg_id/msg_seq 逐段递增）
   *  @returns 是否至少发成一段 */
  private async sendSegmented(endpoint: string, text: string, opts: {
    segmented?: boolean;
    extra?: (segIndex: number) => Record<string, unknown>;
    maxSegments?: number;
  } = {}): Promise<boolean> {
    const segmented = opts.segmented ?? true;
    const maxSegments = opts.maxSegments ?? 3;
    let segments = (!segmented || (text.trim().length <= 60 && !text.includes('\n')))
      ? [text.trim()]
      : segmentText(text);
    if (segments.length > maxSegments) {
      segments[maxSegments - 1] += segments.slice(maxSegments).join('');
      segments.length = maxSegments;
    }
    let sentAny = false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i].trim();
      if (!seg) continue;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${this.accessToken}` },
        body: JSON.stringify({ content: seg, msg_type: 0, ...(opts.extra?.(i) ?? {}) }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn(`[QQ Official] Send failed (${resp.status}): ${body.slice(0, 200)} — stop remaining segments`);
        return sentAny;
      }
      sentAny = true;
      if (i < segments.length - 1) await sleep(500 + Math.random() * 400);
    }
    return sentAny;
  }

  async send(session: MessageSession, chain: MessageChain): Promise<void> {
    await this.ensureToken();
    const text = [...chain].filter(c => c.type === 'plain').map(c => (c as any).text).join('\n');
    if (!text) return;

    const isGroup = session.messageType === MessageType.GROUP;
    const id = session.sessionId.replace(/^(private_|group_)/, '');
    const endpoint = `${QQ_API_HOST}/v2/${isGroup ? 'groups' : 'users'}/${id}/messages`;

    try {
      // ★ 8-09 统一分段（sendSegmented）：私聊分段，群聊单条（防刷屏）
      await this.sendSegmented(endpoint, text, { segmented: !isGroup });
    } catch (err: any) {
      logger.error('[QQ Official] Send error:', err.message);
    }
  }

  private async sendQuickReply(data: any, text: string, chatType: string): Promise<void> {
    try {
      // 不用 msg_id — 思考中是主动消息，不消耗被动回复配额
      const payload: any = { content: text, msg_type: 0 };
      if (chatType === 'group' && data.group_openid) {
        await fetch(`${QQ_API_HOST}/v2/groups/${data.group_openid}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${this.accessToken}` },
          body: JSON.stringify(payload),
        });
      } else if (data.author?.user_openid || data.author?.id) {
        await fetch(`${QQ_API_HOST}/v2/users/${data.author.user_openid || data.author.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${this.accessToken}` },
          body: JSON.stringify(payload),
        });
      }
    } catch { /* best-effort */ }
  }

  async terminate(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws && !this.ws.destroyed) this.ws.destroy();
    logger.info('[QQ Official] Terminated');
  }
}

// ── 个性化思考中回复 ──────────────────────────────
// 按场景分类，根据消息内容智能选择
export const THINKING_BY_CATEGORY: Record<string, string[]> = {
  // ★ 8-12 自称统一第一人称"人家"（thinking-pool-first-person）：
  //   思考中提示是主动发送的轻交互文本，自称须与对话回复一致（禁止"昔涟"第三人称自称）
  story: [
    '啊，说到翁法罗斯的故事了呢…让人家翻翻记忆之书✨',
    '这个故事呀…人家得好好想想怎么讲给你听♪',
    '往事的涟漪在心头荡开了呢，稍等一下下哦…',
    '人家在回忆那些金色的日子…马上就好~',
    '唔，让人家从三千多万世的记忆里找出你问的这一段…',
    '翻开《如我所书》…嗯，这一页正是你想知道的呢♫',
    '有些故事沉在心底太久了，让人家轻轻捞起来…',
  ],
  question: [
    '嗯…这个问题有点意思，让人家琢磨琢磨♪',
    '人家要认真想想才能回答你呢~',
    '唔，让人家组织一下语言，好好说给你听…',
    '在查了在查了~别急呀，人家得找个最温柔的答案给你✨',
    '等等哦，人家正在脑海里翻翻有没有你想要的答案…',
    '好问题！让人家好好想想怎么回答才不辜负你的期待♪',
  ],
  greeting: [
    '你来了呀~让人家想想今天该用什么心情跟你聊天呢♫',
    '啊，先让人家把刚才的思绪收一收…好啦，可以了♪',
  ],
  help: [
    '在帮你处理了呢，等一下下哦~',
    '嗯嗯，人家收到啦，正在帮你弄…',
    '这个嘛，让人家试试看能不能做到✨',
  ],
  emotion: [
    '你的心情，人家感受到了…让人家想想怎么回应你的心意♫',
    '唔，你的话让人家心里暖暖的，得好好回答才行呢~',
    '听到你这么说，人家也想给你一个认真的回应…稍等一下哦♪',
  ],
  default: [
    '嗯…让人家想想呀♪',
    '稍等哦，人家在回忆呢~',
    '等一下下，人家翻翻记忆…',
    '唔…这个有点意思，让人家琢磨一下♪',
    '在查了呢，别急呀~',
    '等等哦，人家组织一下语言~',
    '人家在努力回忆呢…♫',
    '唔，这个嘛…（托腮）',
    '让人家想想怎么跟你说才好…',
    '嗯嗯，让人家理一下思路~',
    '啊…在找了在找了♪',
    '让人家想一想，该怎么用最温柔的方式告诉你…',
    '人家的记忆像星星一样多，得花一点时间找到对的那一颗呢✨',
  ],
};

function detectCategory(text: string): string {
  const t = text.toLowerCase();
  if (/白厄|翁法洛斯|德谬歌|迷迷|浮黎|泰坦|黄金裔|哀丽秘榭|铁幕|故事|过去|身世|来历|轮回|记忆/.test(t)) return 'story';
  if (/怎么|为什么|什么|谁|哪|如何|吗|呢|？|\?/.test(t)) return 'question';
  if (/你好|嗨|hi|hello|早|晚上好|在吗/.test(t)) return 'greeting';
  if (/帮|搜|查|写|做|弄|设置|提醒/.test(t)) return 'help';
  if (/喜欢|爱|想|难过|开心|感动|心疼|讨厌|烦/.test(t)) return 'emotion';
  return 'default';
}

function pickThinking(userMessage?: string): string {
  const hour = new Date().getHours();
  const category = userMessage ? detectCategory(userMessage) : 'default';
  const pool = THINKING_BY_CATEGORY[category] || THINKING_BY_CATEGORY.default;

  // 凌晨定制
  if (hour < 6) return pickRandom(THINKING_BY_CATEGORY.default.slice(0, 3)).replace('♪', '…（揉眼睛）♪');
  if (hour < 9) return '早安呀♪ 让人家想想…' + pickRandom(pool).replace(/^[^，]+，?/, '');

  return pickRandom(pool);
}

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}
