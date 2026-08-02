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
import { logger } from '@alysia/core';

interface TelegramConfig {
  token: string;
}

/** Split text by grapheme clusters to avoid breaking emoji/CJK mid-character */
function splitByGraphemes(text: string, maxLen: number): string[] {
  const segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' });
  const chunks: string[] = [];
  let current = '';
  for (const { segment } of segmenter.segment(text)) {
    if (current.length + segment.length > maxLen) {
      chunks.push(current);
      current = '';
    }
    current += segment;
  }
  if (current) chunks.push(current);
  return chunks;
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

  /** Dedup — track recently seen message IDs to avoid double-processing */
  private seenMessages = new Set<string>();
  private static MAX_SEEN = 1000;

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
    logger.info('[Telegram] Bot started');
  }

  async terminate(): Promise<void> {
    this.bot.stop('terminate');
    logger.info('[Telegram] Bot stopped');
  }

  // ── Incoming message handling ──────────────────────────────

  private async onMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg || !('message_id' in msg)) return;

    // Dedup: skip already-processed message IDs
    const msgId = String(msg.message_id);
    if (this.seenMessages.has(msgId)) return;
    this.seenMessages.add(msgId);
    if (this.seenMessages.size > TelegramAdapter.MAX_SEEN) {
      // Flush oldest half to bound memory
      const entries = [...this.seenMessages];
      this.seenMessages = new Set(entries.slice(Math.floor(entries.length / 2)));
    }

    const chat = msg.chat as any;
    const from = msg.from as any;
    const text = 'text' in msg ? (msg.text || '') : '';
    logger.info(`[Telegram] ← ${chat?.type === 'private' ? 'private' : 'group'} from=${from?.first_name || from?.username || from?.id} chat=${chat?.id} content="${String(text).slice(0, 100)}"`);

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

    // Platform adapters MUST override event.send() to route through the platform's
    // own send implementation. The base MessageEvent.send() throws by default.
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
        logger.error(`[Telegram] send error (${comp.type}): ${err.message}`);
      }
    }
    logger.info(`[Telegram] → sent ${[...chain].length} comps to ${session.sessionId.slice(-16)}: ${[...chain].filter(c => c.type === 'plain').map(c => (c as any).text).join(' ').slice(0, 80)}`);
  }

  /**
   * Send a text message, splitting if it exceeds Telegram's 4096-char limit.
   */
  private async sendText(chatId: string, text: string): Promise<void> {
    if (text.length === 0) return;

    const MAX_LENGTH = 4096;
    if (text.length > MAX_LENGTH) {
      // Use Intl.Segmenter to avoid splitting emoji/CJK mid-character
      const chunks = splitByGraphemes(text, MAX_LENGTH);
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
