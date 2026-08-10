import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { MessageType } from '../../platform/types.js';
import { logger } from '../../utils/logger.js';
import type { MemoryManager } from '../../memory/MemoryManager.js';

/** 不应写入 EventLog 的消息模式 */
const SKIP_INGEST_PATTERNS = [
  /^\//,         // 命令: /stats /clear /new /reset /exit
  /^\/\/privacy/, // 隐私指令
];

function shouldSkipIngest(messageStr: string): boolean {
  const trimmed = messageStr.trim();
  if (!trimmed) return true; // 空消息 (空 @、纯图片等)
  return SKIP_INGEST_PATTERNS.some(p => p.test(trimmed));
}

export class MemoryIngestStage implements Stage {
  constructor(
    private memoryManager: MemoryManager,
    private ownerId: string,
  ) {}

  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    // ★ 8-10 合并事件跳过：原始消息已各自 ingest（不双计合并文本）
    if (event.getExtra('coalesced')) {
      logger.debug('[MemoryIngest] skip (coalesced)');
      return;
    }
    // 过滤：命令、空消息、隐私指令不写入长期记忆
    if (shouldSkipIngest(event.messageStr)) {
      logger.debug(`[MemoryIngest] skip (filtered): ${event.messageStr.slice(0, 50)}`);
      return;
    }

    // 群聊 NPC 模式：非 owner 的消息跳过画像提取（Persona + Profile）
    const isGroup = event.getMessageType() === MessageType.GROUP;
    const isOwner = event.getSenderId() === this.ownerId;
    const skipProfile = isGroup && !isOwner;

    const memoryEvent = {
      id: event.messageObj.messageId,
      session_id: event.unifiedMsgOrigin,
      source: 'chat' as const,
      type: 'message' as const,
      payload: {
        content: event.messageStr,
        sender_id: event.getSenderId(),
        sender_name: event.getSenderName(),
        message_type: event.getMessageType(),
        // ★ role 字段：SessionEndProcessor / ProfileExtractor 按此区分用户消息
        role: event.getSenderId() ? 'user' : 'assistant',
        // ★ NPC 模式标记：RealtimeProcessor 据此跳过画像提取
        ...(skipProfile ? { skip_profile: true } : {}),
      },
      importance: 0,
      created_at: new Date().toISOString(),
      processed: 0,
    };

    await this.memoryManager.ingest(memoryEvent);
    logger.debug(`[MemoryIngest] saved event ${memoryEvent.id} (${skipProfile ? 'skip_profile' : 'full'})`);
  }
}
