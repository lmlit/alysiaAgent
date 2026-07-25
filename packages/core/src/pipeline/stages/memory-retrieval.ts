import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import type { MemoryManager } from '../../memory/MemoryManager.js';
import type { WorldbookEntry, SearchResult } from '../../memory/types.js';

export class MemoryRetrievalStage implements Stage {
  constructor(private memoryManager: MemoryManager) {}

  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    // 收集 WorldbookStage 异步匹配结果（如果有）
    const triggers = (event.getExtra('worldbook_triggers') || []) as WorldbookEntry[];
    const retrieved = (event.getExtra('search_results') || []) as SearchResult[];

    // 长期记忆 + Worldbook 注入
    const longTermMemory = await this.memoryManager.assembleWithWorldbook('chat', triggers, retrieved);

    // 短期记忆：EventLog 最近消息
    let recentContext = '';
    try {
      const recent = this.memoryManager.getRecentMessages(event.unifiedMsgOrigin, 10);
      if (recent.length > 0) {
        recentContext = recent.map(r => r.content).join('\n');
      }
    } catch { /* EventLog may not be ready */ }

    const memoryContext = [longTermMemory, recentContext ? `\n## 最近对话\n${recentContext}` : '']
      .filter(Boolean)
      .join('\n');

    event.setExtra('memory_context', memoryContext);
  }
}
