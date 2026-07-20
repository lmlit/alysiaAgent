import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';

export class RespondStage implements Stage {
  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    const responseChain = event.getExtra<any>('response_chain');
    if (responseChain && !responseChain.isEmpty()) {
      try {
        await event.send(responseChain);
      } catch {
        // send 失败不阻断 pipeline
      }
    }
  }
}
