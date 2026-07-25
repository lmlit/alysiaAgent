import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';

export class WorldbookStage implements Stage {
  async initialize(_ctx: PipelineContext): Promise<void> {}
  async process(_event: MessageEvent): Promise<void> {
    // Worldbook 已改为 Agent 工具 lookup_worldbook
    // Agent 主动调用工具查询，不再注入 System Prompt 或在此阶段匹配
  }
}
