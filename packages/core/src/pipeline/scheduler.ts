import type { Stage, PipelineContext } from './types.js';
import type { MessageEvent } from '../platform/event.js';
import { isAsyncGenerator } from '../utils/async.js';

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
      const result = stage.process(event);

      if (isAsyncGenerator(result)) {
        for await (const _ of result) {
          if (event.isStopped()) break;
          await this.processStages(event, i + 1);
          if (event.isStopped()) break;
        }
        // All inner stages processed recursively; exit, don't re-process them.
        return;
      } else {
        await result;
        if (event.isStopped()) break;
      }
    }
  }
}
