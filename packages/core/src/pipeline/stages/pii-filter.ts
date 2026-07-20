import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { filterPII } from '../../memory/PIIFilter.js';

export class PIIFilterStage implements Stage {
  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    event.messageStr = filterPII(event.messageStr);
  }
}
