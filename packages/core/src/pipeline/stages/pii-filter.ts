import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { filterPII } from '../../memory/PIIFilter.js';

export class PIIFilterStage implements Stage {
  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    // ★ 8-10 合并事件跳过：原始消息已在各自 pipeline 里脱敏过，合并文本直接继承
    if (event.getExtra('coalesced')) return;
    event.messageStr = filterPII(event.messageStr);
  }
}
