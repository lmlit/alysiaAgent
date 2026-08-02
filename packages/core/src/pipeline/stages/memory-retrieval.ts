import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import type { MemoryManager } from '../../memory/MemoryManager.js';
import { logger } from '../../utils/logger.js';

export class MemoryRetrievalStage implements Stage {
  constructor(private memoryManager: MemoryManager) {}

  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    const mode = event.pipelineMode;

    // ★ 主动调用 MemoryManager.read() 执行向量搜索 + Worldbook 匹配
    const readResult = await this.memoryManager.read({
      query: event.messageStr,
      mode,
      limit: 5,
    });

    // 写入类型安全的 extras 供下游 Stage 消费
    event.setExtra('search_results', readResult.retrieved);
    event.setExtra('worldbook_triggers', readResult.worldbook_triggers);

    // 组装长期记忆（Persona + Profile + vector results + Worldbook）
    const longTermMemory = await this.memoryManager.assembleWithWorldbook(
      mode,
      readResult.worldbook_triggers,
      readResult.retrieved,
    );

    // 短期记忆：EventLog 最近消息（最近 2 小时窗口 + 最多 20 条，防高频聊天把早间信息挤出）
    let recentContext = '';
    try {
      const recent = this.memoryManager.getRecentMessages(
        event.unifiedMsgOrigin, 20, new Date(Date.now() - 2 * 3600 * 1000),
      );
      if (recent.length > 0) {
        recentContext = recent.map(r => r.content).join('\n');
      }
    } catch (err) {
      logger.warn('Failed to read recent messages from EventLog:', err);
    }

    const memoryContext = [longTermMemory, recentContext ? `\n## 最近对话\n${recentContext}` : '']
      .filter(Boolean)
      .join('\n');

    event.setExtra('memory_context', memoryContext);
  }
}
