import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';

export class WorldbookStage implements Stage {
  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    // MVP: Worldbook 匹配已在 MemoryManager.read() 中处理
    // 这个 Stage 为未来独立拆分预留
    event.setExtra('worldbook_triggered', false);
  }
}
