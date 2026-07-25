import type { MessageEvent } from '../platform/event.js';
import type { PipelineScheduler } from '../pipeline/scheduler.js';

export class EventBus {
  private queue: MessageEvent[] = [];
  private schedulerMap: Map<string, PipelineScheduler> = new Map();
  private defaultScheduler?: PipelineScheduler;
  private running = false;
  private resolveWaiters: Array<() => void> = [];

  setDefaultScheduler(scheduler: PipelineScheduler): void {
    this.defaultScheduler = scheduler;
  }

  registerScheduler(umo: string, scheduler: PipelineScheduler): void {
    this.schedulerMap.set(umo, scheduler);
  }

  unregisterScheduler(umo: string): void {
    this.schedulerMap.delete(umo);
  }

  put(event: MessageEvent): void {
    this.queue.push(event);
    for (const resolve of this.resolveWaiters) resolve();
    this.resolveWaiters = [];
  }

  async dispatch(): Promise<void> {
    this.running = true;
    while (this.running) {
      if (this.queue.length === 0) {
        await new Promise<void>(resolve => { this.resolveWaiters.push(resolve); });
        continue;
      }
      const event = this.queue.shift()!;
      const umo = event.unifiedMsgOrigin;
      // Exact match first, then prefix match, then default
      let scheduler = this.schedulerMap.get(umo);
      if (!scheduler) {
        // Try prefix match: "qq-official-1:private:123" should match "qq-official-1"
        for (const [key, s] of this.schedulerMap) {
          if (umo.startsWith(key)) { scheduler = s; break; }
        }
      }
      if (!scheduler) scheduler = this.defaultScheduler;
      if (!scheduler) {
        console.warn(`No scheduler for ${umo}, ignored.`);
        continue;
      }
      try {
        await scheduler.execute(event);
      } catch (err) {
        console.error('Pipeline error:', err);
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
