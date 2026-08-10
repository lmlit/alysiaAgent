import type { MessageEvent } from '../platform/event.js';
import type { PipelineScheduler } from '../pipeline/scheduler.js';
import { logger } from '../utils/logger.js';

export class EventBus {
  private queue: MessageEvent[] = [];
  private schedulerMap: Map<string, PipelineScheduler> = new Map();
  private defaultScheduler?: PipelineScheduler;
  private running = false;
  private resolveWaiters: Array<() => void> = [];
  private dispatchPromise?: Promise<void>;
  /** 队列上限，防止内存无限增长 */
  private static MAX_QUEUE = 500;

  setDefaultScheduler(scheduler: PipelineScheduler): void {
    this.defaultScheduler = scheduler;
  }

  registerScheduler(umo: string, scheduler: PipelineScheduler): void {
    this.schedulerMap.set(umo, scheduler);
  }

  unregisterScheduler(umo: string): void {
    this.schedulerMap.delete(umo);
  }

  /**
   * @param opts.priority 插队（unshift 到队首）——Coalescer flush 的合并事件用，
   *   优先于排队中的其他消息处理（不乱序、不延迟）
   */
  put(event: MessageEvent, opts?: { priority?: boolean }): void {
    // Rate limit: drop oldest event if queue is full
    if (this.queue.length >= EventBus.MAX_QUEUE) {
      logger.warn(`EventBus queue full (${EventBus.MAX_QUEUE}), dropping oldest event`);
      this.queue.shift();
    }
    logger.debug(`EventBus put: ${event.unifiedMsgOrigin} queue=${this.queue.length + 1}${opts?.priority ? ' (priority)' : ''}`);
    if (opts?.priority) this.queue.unshift(event);
    else this.queue.push(event);
    // Wake up dispatch loop. JS single-threaded → no race on resolveWaiters.
    const waiters = this.resolveWaiters;
    this.resolveWaiters = [];
    for (const resolve of waiters) resolve();
  }

  dispatch(): Promise<void> {
    if (this.dispatchPromise) return this.dispatchPromise;
    this.dispatchPromise = this._dispatchLoop();
    return this.dispatchPromise;
  }

  private async _dispatchLoop(): Promise<void> {
    this.running = true;
    while (this.running) {
      if (this.queue.length === 0) {
        await new Promise<void>(resolve => { this.resolveWaiters.push(resolve); });
        continue;
      }
      // Drain queue atomically to avoid holding the lock
      const batch: MessageEvent[] = [];
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (event) batch.push(event);
      }

      for (const event of batch) {
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
          logger.warn(`No scheduler for ${umo}, event ignored.`);
          continue;
        }
        try {
          logger.info(`EventBus dispatch → ${umo} (pipeline ${event.pipelineMode ?? 'chat'})`);
          // ★ 8-10 私聊并发（eventbus-concurrent-private-dispatch）：不 await——
          //   每条私聊消息立即进 pipeline，A 在飞时 B 到达 → Coalescer isInFlight
          //   判定成立 → abort + 合并（串行下 B 排队等 A 完成，合并永不触发）。
          //   群聊保持 await 串行（用户拍板"群聊逐条回复"）。
          if (event.isPrivateChat()) {
            scheduler.execute(event).catch(err => logger.error('Pipeline error:', err));
          } else {
            await scheduler.execute(event);
          }
        } catch (err) {
          logger.error('Pipeline error:', err);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    this.dispatchPromise = undefined;
    for (const resolve of this.resolveWaiters) {
      resolve();
    }
    this.resolveWaiters = [];
  }
}
