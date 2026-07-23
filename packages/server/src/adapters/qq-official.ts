/**
 * QQ 官方第三方 Agent 接入适配器
 *
 * 基于 QQ 开放平台 Webhook 协议。
 * QQ 服务器通过 HTTP POST 推送用户消息到我们的 webhook 端点，
 * 我们在回复中同步返回消息内容。
 *
 * 注册: https://q.qq.com → 创建机器人 → 第三方Agent接入
 *
 * 配置:
 *   platforms:
 *     qq_official:
 *       app_id: "你的AppID"
 *       app_secret: "你的AppSecret"
 *       webhook_port: 6187        # 本地监听端口
 *       webhook_path: "/qq/webhook"
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { Platform, PlatformMetadata, MessageSession } from '@alysia/core/platform';
import { MessageEvent, MessageType, MessageChain } from '@alysia/core/platform';
import type { Message, MessageSender, MessageComponent } from '@alysia/core/platform';
import type { EventBus } from '@alysia/core/eventbus';

interface QQOfficialConfig {
  app_id: string;
  app_secret: string;
  webhook_port: number;
  webhook_path: string;
}

// ── QQ 官方消息类型 ──────────────────────────────
interface QQOfficialPayload {
  op: number;           // 0=事件, 13=验证回调
  d?: {
    id: string;
    author: { id: string; username?: string; avatar?: string };
    content: string;
    timestamp: string;
    channel_id?: string;  // 群聊/频道
    guild_id?: string;
  };
}

// 群聊消息 (C2C=私聊, GROUP=群聊, GUILD=频道)
type QQChatType = 'C2C' | 'GROUP' | 'GUILD';

export class QQOfficialAgentAdapter implements Platform {
  meta: PlatformMetadata;
  private eventBus!: EventBus;
  private config: QQOfficialConfig;
  private accessToken: string = '';
  private tokenExpiry: number = 0;
  private pendingReplies: Map<string, (reply: string) => void> = new Map();

  constructor(config: QQOfficialConfig, private adapterId: string = 'qq-official') {
    this.config = config;
    this.meta = {
      name: 'qq_official',
      description: 'QQ 官方第三方 Agent (Webhook)',
      id: adapterId,
    };
  }

  setEventBus(bus: EventBus): void { this.eventBus = bus; }

  async run(): Promise<void> {
    const port = this.config.webhook_port || 6187;
    const path = this.config.webhook_path || '/qq/webhook';

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' || req.url !== path) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf-8');

      try {
        const payload: QQOfficialPayload = JSON.parse(body);

        // 验证回调 (op=13)
        if (payload.op === 13) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ plain_token: payload.d?.id || '', signature: '' }));
          return;
        }

        // 消息事件 (op=0)
        if (payload.op === 0 && payload.d) {
          const msg = payload.d;
          const chatType: QQChatType = msg.guild_id ? 'GUILD' : msg.channel_id ? 'GROUP' : 'C2C';
          const sessionId = chatType === 'C2C'
            ? `private_${msg.author.id}`
            : `group_${msg.channel_id || msg.guild_id}`;

          const sender: MessageSender = {
            userId: msg.author.id,
            nickname: msg.author.username || msg.author.id,
          };

          const message: Message = {
            sessionId,
            groupId: chatType === 'C2C' ? '' : (msg.channel_id || msg.guild_id || ''),
            sender,
            messageId: msg.id,
            type: chatType === 'C2C' ? MessageType.PRIVATE : MessageType.GROUP,
            content: [{ type: 'plain', text: msg.content }],
            raw: payload,
          };

          const event = new MessageEvent({
            messageStr: msg.content,
            messageObj: message,
            platformMeta: this.meta,
            sessionId,
          });

          // 收集回复：Pipeline 处理完后，send() 会把消息存到 replyText
          let replyText = '';
          event.send = async (chain: MessageChain) => {
            for (const comp of chain) {
              if (comp.type === 'plain') replyText += (comp as any).text;
            }
          };

          // 同步处理（QQ webhook 要求在超时前返回回复）
          try {
            await this.eventBus['schedulerMap']
              ?.get?.(`qq_official::${chatType === 'C2C' ? 'private' : 'group'}:${sessionId}`)
              ?.execute(event) ??
              // Fallback: 直接用默认 scheduler
              Promise.resolve();

            // 如果没有通过 scheduler，直接手动推
            if (!replyText) {
              // 用 setTimeout 异步处理，先回复占位
              this.processAsync(event, msg.id).catch(console.error);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 0, msg: 'processing' }));
              return;
            }
          } catch (err: any) {
            replyText = `出错了: ${err.message}`;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            data: { content: replyText, msg_id: msg.id },
          }));
          return;
        }

        res.writeHead(200);
        res.end('{}');
      } catch (err: any) {
        console.error('[QQ Official] Error:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ code: 500, msg: err.message }));
      }
    });

    server.listen(port, () => {
      console.log(`[QQ Official] Webhook server on :${port}${path}`);
    });
  }

  // 异步处理：用于需要工具调用的复杂消息
  private async processAsync(event: MessageEvent, msgId: string): Promise<void> {
    // TODO: 调用完 LLM 后通过 QQ API 主动回复
    console.log(`[QQ Official] Async processing msg ${msgId}`);
  }

  async send(session: MessageSession, chain: MessageChain): Promise<void> {
    // Active send via QQ API (需要 access_token)
    // 目前仅支持被动回复（webhook response 中直接返回）
    const text = [...chain].filter(c => c.type === 'plain').map(c => (c as any).text).join('\n');
    if (text) {
      await this.callQQApi(`/v2/users/${session.sessionId}/messages`, {
        content: text,
        msg_type: 0,
      });
    }
  }

  private async callQQApi(path: string, body: unknown): Promise<void> {
    if (!this.accessToken || Date.now() > this.tokenExpiry) {
      await this.refreshToken();
    }
    try {
      const resp = await fetch(`https://api.sgroup.qq.com${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `QQBot ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) console.error(`[QQ Official] API error: ${resp.status}`);
    } catch (err: any) {
      console.error(`[QQ Official] API call failed: ${err.message}`);
    }
  }

  private async refreshToken(): Promise<void> {
    try {
      const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: this.config.app_id,
          clientSecret: this.config.app_secret,
        }),
      });
      const data = await resp.json() as any;
      if (data.access_token) {
        this.accessToken = data.access_token;
        this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      }
    } catch (err: any) {
      console.error('[QQ Official] Token refresh failed:', err.message);
    }
  }

  async terminate(): Promise<void> {
    console.log('[QQ Official] Adapter terminated');
  }
}
