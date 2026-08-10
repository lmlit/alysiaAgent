import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { logger } from '../../utils/logger.js';

export class RespondStage implements Stage {
  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    const responseChain = event.getExtra('response_chain');
    if (responseChain && !responseChain.isEmpty()) {
      try {
        await event.send(responseChain);
      } catch (err: any) {
        // ★ 8-10 发送失败必须留痕（不静默吞错）——合并事件缺 send 回调等
        //   问题曾导致回复静默丢失，无日志无法排查
        logger.error(`[Respond] send failed (${event.unifiedMsgOrigin.slice(-16)}):`, err?.message ?? err);
      }
    }
  }
}
