import { Telegraf, Context } from 'telegraf';
import type { Platform, PlatformMetadata } from '@alysia/core/platform';
import {
  MessageType,
  MessageSession,
  MessageChain,
  MessageEvent,
} from '@alysia/core/platform';
import type {
  Message,
  MessageSender,
  MessageComponent,
} from '@alysia/core/platform';
import type { EventBus } from '@alysia/core/eventbus';

interface TelegramConfig {
  token: string;
}

/**
 * Telegram Bot adapter implementing the Platform interface.
 * Converts Telegram messages into MessageEvents and dispatches
 * MessageChain components via the Telegram Bot API.
 */
export class TelegramAdapter implements Platform {
  meta: PlatformMetadata;
  private bot: Telegraf;
  private eventBus!: EventBus;

  constructor(
    private config: TelegramConfig,
    private adapterId: string = 'telegram',
  ) {
    this.meta = {
      name: 'telegram',
      description: 'Telegram Bot adapter',
      id: adapterId,
    };
    this.bot = new Telegraf(config.token);
  }

  setEventBus(bus: EventBus): void {
    this.eventBus = bus;
  }

  async run(): Promise<void> {
    this.bot.on('message', (ctx) => this.onMessage(ctx));
    // Graceful shutdown
    process.once('SIGINT', () => {
      this.bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      this.bot.stop('SIGTERM');
    });
    await this.bot.launch();
    console.log('[Telegram] Bot started');
  }

  async terminate(): Promise<void> {
    this.bot.stop('terminate');
    console.log('[Telegram] Bot stopped');
  }

  // ── Incoming message handling ──────────────────────────────

  private async onMessage(ctx: Context): Promise<void> {
    const event = this.toMessageEvent(ctx);
    if (!event) return;
    this.eventBus.put(event);
  }

  private toMessageEvent(ctx: Context): MessageEvent | null {
    const msg = ctx.message;
    if (!msg || !('chat' in msg) || !('from' in msg)) return null;

    const chat = msg.chat as any;
    const from = msg.from as any;

    const chatType =
      chat.type === 'private' ? MessageType.PRIVATE : MessageType.GROUP;
    const content = this.parseContent(ctx);

    const sender: MessageSender = {
      userId: String(from.id),
      nickname: from.first_name || from.username || 'Unknown',
    };

    const message: Message = {
      sessionId: String(chat.id),
      groupId: chatType === MessageType.GROUP ? String(chat.id) : '',
      sender,
      messageId: String(msg.message_id),
      type: chatType,
      content,
      raw: ctx,
    };

    const anyMsg = msg as any;
    const messageStr =
      'text' in msg
        ? (msg.text || anyMsg.caption || '')
        : anyMsg.caption || '';

    const event = new MessageEvent({
      messageStr,
      messageObj: message,
      platformMeta: this.meta,
      sessionId: message.sessionId,
    });

    // Override event.send to route through the platform
    const origSend = event.send.bind(event);
    event.send = async (chain: MessageChain) => {
      await this.doSend(event.session, chain);
      // Call origSend to set _hasSendOper flag (may throw, which is safe to ignore)
      try {
        await origSend(chain);
      } catch {
        // origSend throws "must be overridden by Platform adapter"
        // which is expected — the actual send is handled by doSend above
      }
    };

    return event;
  }

  // ── Message content parsing ────────────────────────────────

  private parseContent(ctx: Context): MessageComponent[] {
    const msg = ctx.message as any;
    const components: MessageComponent[] = [];

    // Reply-to (inserted first so it appears before the content it references)
    if (msg.reply_to_message) {
      const reply = msg.reply_to_message as any;
      const replyStr = reply.text || reply.caption || '[non-text message]';
      components.push({
        type: 'reply',
        id: String(reply.message_id),
        senderId: String(reply.from?.id || ''),
        senderNickname: reply.from?.first_name || '',
        messageStr: replyStr,
      });
    }

    // Text with entity-aware mention parsing
    if (msg.text || msg.caption) {
      const rawText: string = msg.text || msg.caption || '';
      const entities: any[] = msg.entities || msg.caption_entities || [];

      if (entities.length > 0) {
        let cursor = 0;
        // Sort entities by offset for sequential processing
        const sorted = [...entities].sort(
          (a, b) => a.offset - b.offset,
        );
        for (const entity of sorted) {
          // Push plain text before this entity
          if (entity.offset > cursor) {
            const segment = rawText.slice(cursor, entity.offset);
            if (segment) {
              components.push({ type: 'plain', text: segment });
            }
          }

          const entityText = rawText.slice(
            entity.offset,
            entity.offset + entity.length,
          );

          switch (entity.type) {
            case 'mention': {
              const name = entityText.slice(1); // strip '@'
              components.push({ type: 'at', qq: name, name });
              break;
            }
            case 'text_mention': {
              // Explicit mention by user ID
              const uid = String(entity.user?.id ?? '');
              components.push({
                type: 'at',
                qq: uid,
                name: entity.user?.first_name || entityText,
              });
              break;
            }
            case 'bot_command': {
              // Treat as plain text — commands handled upstream
              components.push({ type: 'plain', text: entityText });
              break;
            }
            case 'hashtag':
            case 'cashtag':
            case 'url':
            case 'email':
            case 'phone': {
              components.push({ type: 'plain', text: entityText });
              break;
            }
            default: {
              // bold, italic, code, pre, underline, strikethrough, spoiler, etc.
              components.push({ type: 'plain', text: entityText });
              break;
            }
          }
          cursor = entity.offset + entity.length;
        }

        // Remaining text after last entity
        if (cursor < rawText.length) {
          const segment = rawText.slice(cursor);
          if (segment) {
            components.push({ type: 'plain', text: segment });
          }
        }
      } else if (rawText.trim()) {
        components.push({ type: 'plain', text: rawText.trim() });
      }
    }

    // Photo — largest size
    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      components.push({ type: 'image', url: photo.file_id });
    }

    // Voice
    if (msg.voice) {
      components.push({ type: 'voice', url: msg.voice.file_id });
    }

    // Sticker
    if (msg.sticker) {
      components.push({
        type: 'sticker',
        emoji: msg.sticker.emoji,
        fileId: msg.sticker.file_id,
      });
    }

    // Document (file)
    if (msg.document) {
      components.push({
        type: 'file',
        url: msg.document.file_id,
        name: msg.document.file_name || 'file',
      });
    }

    // Video
    if (msg.video) {
      components.push({ type: 'video', url: msg.video.file_id });
    }

    return components.length > 0
      ? components
      : [{ type: 'plain', text: '' }];
  }

  // ── Outgoing message sending ───────────────────────────────

  async doSend(
    session: MessageSession,
    chain: MessageChain,
  ): Promise<void> {
    const chatId = session.sessionId;

    for (const comp of chain) {
      try {
        switch (comp.type) {
          case 'plain':
            await this.sendText(chatId, comp.text);
            break;
          case 'image':
            await this.bot.telegram.sendPhoto(chatId, comp.url);
            break;
          case 'voice':
            await this.bot.telegram.sendVoice(chatId, comp.url);
            break;
          case 'sticker':
            if (comp.fileId) {
              await this.bot.telegram.sendSticker(chatId, comp.fileId);
            }
            break;
          case 'file':
            await this.bot.telegram.sendDocument(chatId, comp.url);
            break;
          case 'video':
            await this.bot.telegram.sendVideo(chatId, comp.url);
            break;
          case 'at': {
            // Render mention as plain text in group chats
            const mentionText = comp.name
              ? `@${comp.name}`
              : `@${comp.qq}`;
            await this.sendText(chatId, mentionText);
            break;
          }
          case 'reply': {
            // Reply by referencing the original message ID
            await this.bot.telegram.sendMessage(chatId, '', {
              reply_parameters: { message_id: Number(comp.id) },
            });
            break;
          }
        }
      } catch (err: any) {
        console.error(
          `[Telegram] Send error (${comp.type}):`,
          err.message,
        );
      }
    }
  }

  /**
   * Send a text message, splitting if it exceeds Telegram's 4096-char limit.
   */
  private async sendText(chatId: string, text: string): Promise<void> {
    if (text.length === 0) return;

    const MAX_LENGTH = 4096;
    if (text.length > MAX_LENGTH) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }
      for (const chunk of chunks) {
        await this.bot.telegram.sendMessage(chatId, chunk);
      }
    } else {
      await this.bot.telegram.sendMessage(chatId, text);
    }
  }

  // ── Platform interface ─────────────────────────────────────

  async send(
    session: MessageSession,
    chain: MessageChain,
  ): Promise<void> {
    await this.doSend(session, chain);
  }
}
