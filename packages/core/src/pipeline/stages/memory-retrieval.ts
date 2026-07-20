import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import type { MemoryManager } from '../../memory/MemoryManager.js';

export class MemoryRetrievalStage implements Stage {
  constructor(private memoryManager: MemoryManager) {}

  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    const systemPrompt = await this.memoryManager.assemble('chat');
    event.setExtra('memory_context', systemPrompt);
  }
}
