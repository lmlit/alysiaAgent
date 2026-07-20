import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import type { MemoryManager } from '../../memory/MemoryManager.js';

export class MemoryIngestStage implements Stage {
  constructor(
    private memoryManager: MemoryManager,
    private ownerId: string,
  ) {}

  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
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
      },
      importance: 0,
      created_at: new Date().toISOString(),
      processed: 0,
    };

    await this.memoryManager.ingest(memoryEvent);

    // 群聊 NPC 模式：非 owner 跳过画像提取
    // （MemoryManager.ingest 已写入 EventLog，但 RealtimeProcessor 的画像提取
    //  需要在这里做过滤。当前 MVP 通过不 await RealtimeProcessor 的画像部分实现）
  }
}
