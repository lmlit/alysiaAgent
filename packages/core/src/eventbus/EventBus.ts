import type { MessageEvent } from '../platform/event.js';
import type { PipelineScheduler } from '../pipeline/scheduler.js';

export class EventBus {
  private queue: MessageEvent[] = [];
  private schedulerMap: Map<string, PipelineScheduler> = new Map();
  private running = false;
  private resolveWaiters: Array<() => void> = [];

  registerScheduler(umo: string, scheduler: PipelineScheduler): void {
    this.schedulerMap.set(umo, scheduler);
  }

  unregisterScheduler(umo: string): void {
    this.schedulerMap.delete(umo);
  }

  put(event: MessageEvent): void {
    this.queue.push(event);
    // Wake up dispatch loop
    for (const resolve of this.resolveWaiters) {
      resolve();
    }
    this.resolveWaiters = [];
  }

  async dispatch(): Promise<void> {
    this.running = true;
    while (this.running) {
      if (this.queue.length === 0) {
        await new Promise<void>(resolve => {
          this.resolveWaiters.push(resolve);
        });
        continue;
      }
      const event = this.queue.shift()!;
      const umo = event.unifiedMsgOrigin;
      const scheduler = this.schedulerMap.get(umo);
      if (!scheduler) {
        console.warn(`No scheduler registered for ${umo}, event ignored.`);
        continue;
      }
      try {
        await scheduler.execute(event);
      } catch (err) {
        console.error('Pipeline execution error:', err);
      }
    }
  }

  stop(): void {
    this.running = false;
    for (const resolve of this.resolveWaiters) {
      resolve();
    }
    this.resolveWaiters = [];
  }
}
