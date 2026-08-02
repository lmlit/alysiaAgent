import type { Stage, PipelineContext } from './types.js';
import type { MessageEvent } from '../platform/event.js';
import { isAsyncGenerator } from '../utils/async.js';
import { logger } from '../utils/logger.js';

export class PipelineScheduler {
  private stages: Stage[] = [];

  constructor(
    private ctx: PipelineContext,
    stages: Stage[] = [],
  ) {
    this.stages = stages;
  }

  async initialize(): Promise<void> {
    for (const stage of this.stages) {
      await stage.initialize(this.ctx);
    }
  }

  addStage(stage: Stage): void {
    this.stages.push(stage);
  }

  async execute(event: MessageEvent): Promise<void> {
    await this.processStages(event, 0);
  }

  private async processStages(event: MessageEvent, from: number): Promise<void> {
    for (let i = from; i < this.stages.length; i++) {
      const stage = this.stages[i];
      try {
        const result = stage.process(event);

        if (isAsyncGenerator(result)) {
          for await (const _ of result) {
            if (event.isStopped()) break;
            await this.processStages(event, i + 1);
            if (event.isStopped()) break;
          }
          return; // all inner stages processed recursively
        } else {
          await result;
          if (event.isStopped()) break;
        }
      } catch (err) {
        // 单 Stage 失败不阻断整体 Pipeline，记录日志后继续下一个 Stage
        logger.error(`Pipeline stage [${stage.constructor.name}] failed:`, err);
      }
    }
  }
}
