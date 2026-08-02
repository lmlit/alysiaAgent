import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';

/**
 * WorldbookStage — deprecated no-op placeholder.
 *
 * Worldbook matching was moved to the Agent's `lookup_worldbook` tool;
 * the Agent queries worldbook entries on-demand rather than injecting
 * them into the system prompt through this pipeline stage.
 *
 * Kept in the pipeline to avoid breaking existing scheduler configurations,
 * but does nothing (no-op).
 *
 * @deprecated Replace with direct Agent tool usage. Remove when all
 *             pipeline configs are updated.
 */
export class WorldbookStage implements Stage {
  async initialize(_ctx: PipelineContext): Promise<void> {}
  async process(_event: MessageEvent): Promise<void> {
    // Worldbook 已改为 Agent 工具 lookup_worldbook
    // Agent 主动调用工具查询，不再注入 System Prompt 或在此阶段匹配
  }
}
