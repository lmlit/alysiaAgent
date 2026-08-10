// ★ 8-10 输入合并 + 打断（input-coalescing-and-abort）
//
// 落点：pipeline 内 stage（memory-ingest 之后、worldbook 之前）——单点实现，
// 全部适配器自动覆盖。依赖 scheduler 对 async generator 的既有语义：
// "不 yield 直接 return → 后续 stage 不执行"（scheduler.ts:36-43）。
//
// 行为：
// - 私聊：第一条消息入桶起 debounce 窗口（默认 2s，每次新消息重置）+ 上限（默认 5s
//   强制 flush，防涓流）；flush 时换行拼接多条消息 → 合并事件（coalesced 标记）重入
//   EventBus（串行处理，避免 pipeline 并发）；图片描述 flush 时 await 全部再拼文本
// - 打断：任何新消息到达（无论窗口内/外）→ AbortRegistry.abort(sessionId)（在飞 LLM 请求中断）
// - 群聊：不合并不打断，仅统一 await 图片描述拼接后放行（保持现状逐条回复）

import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { MessageEvent as MessageEventClass } from '../../platform/event.js';
import type { Message } from '../../platform/message.js';
import { logger } from '../../utils/logger.js';
import { AbortRegistry } from '../abort-registry.js';
import type { EventBus } from '../../eventbus/EventBus.js';

export interface CoalescerOptions {
  /** 合并窗口：新消息重置定时器 */
  debounceMs?: number;
  /** 窗口上限：到点强制 flush，防涓流无止境 */
  maxWaitMs?: number;
}

interface Bucket {
  events: MessageEvent[];
  timer: NodeJS.Timeout | null;
  capTimer: NodeJS.Timeout | null;
}

export class CoalescerStage implements Stage {
  private ctx!: PipelineContext;
  private eventBus: EventBus | null = null;
  private buckets = new Map<string, Bucket>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(
    private abortRegistry: AbortRegistry = new AbortRegistry(),
    opts: CoalescerOptions = {},
  ) {
    // ★ 8-10（用户拍板）合并窗口 10s：debounce-on-last 10s + 上限 10s（涓流时每 10s 必 flush）
    this.debounceMs = opts.debounceMs ?? 10_000;
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
  }

  getAbortRegistry(): AbortRegistry {
    return this.abortRegistry;
  }

  /** 由 AlysiaCore 接线（flush 的合并事件放回 EventBus，串行处理） */
  setEventBus(bus: EventBus): void {
    this.eventBus = bus;
  }

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
  }

  async *process(event: MessageEvent): AsyncGenerator<void> {
    // 合并事件重入：已含全部原始消息，直接放行（后续 stage 正常跑）
    if (event.getExtra('coalesced')) {
      yield;
      return;
    }

    // 群聊：不合并不打断（用户拍板保守方案），但统一在这里 await 图片描述拼接
    //（适配器改为 fire-and-forget 后，描述拼接集中到本 stage）
    if (!event.isPrivateChat()) {
      await this.attachImageDescs(event);
      yield;
      return;
    }

    // 私聊：打断在飞 + 入桶缓冲（不 yield → 后续 stage 不执行，等 flush）
    const sessionId = event.unifiedMsgOrigin;
    this.abortRegistry.abort(sessionId);
    const bucket = this.getOrCreateBucket(sessionId);
    bucket.events.push(event);
    this.resetTimers(sessionId, bucket);
    logger.debug(`[Coalescer] buffered (${bucket.events.length}): ${event.messageStr.slice(0, 40)}`);
  }

  /** 非合并路径：await 图片描述 → 描述文本前置拼入 messageStr（保持原适配器行为） */
  private async attachImageDescs(event: MessageEvent): Promise<void> {
    const pending = event.getExtra('pending_image_descs') ?? [];
    if (pending.length === 0) return;
    const results = await Promise.all(pending);
    const descs = results.filter((r): r is string => !!r).map(r => `[图片内容: ${r}]`);
    if (descs.length > 0) {
      event.messageStr = descs.join('\n') + (event.messageStr ? '\n' + event.messageStr : '');
    }
  }

  private getOrCreateBucket(sessionId: string): Bucket {
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = { events: [], timer: null, capTimer: null };
      this.buckets.set(sessionId, bucket);
    }
    return bucket;
  }

  private resetTimers(sessionId: string, bucket: Bucket): void {
    if (bucket.timer) clearTimeout(bucket.timer);
    // debounce-on-last：每次新消息重置
    bucket.timer = setTimeout(() => {
      this.flush(sessionId).catch(err => logger.error(`[Coalescer] flush error: ${err.message}`));
    }, this.debounceMs);
    // 上限：首条消息起计时，到点强制 flush（防涓流）
    if (!bucket.capTimer) {
      bucket.capTimer = setTimeout(() => {
        this.flush(sessionId).catch(err => logger.error(`[Coalescer] flush error: ${err.message}`));
      }, this.maxWaitMs);
    }
  }

  private async flush(sessionId: string): Promise<void> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return;
    this.buckets.delete(sessionId);
    if (bucket.timer) clearTimeout(bucket.timer);
    if (bucket.capTimer) clearTimeout(bucket.capTimer);
    const events = bucket.events;
    if (events.length === 0) return;

    // 1. 图片预热：await 全部 pending 描述 → 描述文本前置
    const descs: string[] = [];
    for (const ev of events) {
      const pending = ev.getExtra('pending_image_descs') ?? [];
      const results = await Promise.all(pending);
      for (const r of results) if (r) descs.push(`[图片内容: ${r}]`);
    }
    const descText = descs.join('\n');
    const texts = events.map(e => e.messageStr).filter(t => t.trim());
    const mergedStr = [descText, ...texts].filter(Boolean).join('\n');

    // 2. 合并事件：components 聚合为纯文本（图片已转描述，DeepSeek 只看文字，不带 image 组件）
    const first = events[0];
    const mergedMessage: Message = {
      ...first.messageObj,
      messageId: `coalesced-${Date.now()}-${sessionId.slice(-8)}`,
      content: [{ type: 'plain', text: mergedStr }],
    };
    const mergedEvent = new MessageEventClass({
      messageStr: mergedStr,
      messageObj: mergedMessage,
      platformMeta: first.platformMeta,
      sessionId: first.sessionId,
    });
    mergedEvent.setExtra('coalesced', true);

    // 3. 重入 EventBus（串行处理，避免 pipeline 并发）
    if (!this.eventBus) {
      logger.error('[Coalescer] eventBus not wired, merged messages dropped');
      return;
    }
    this.eventBus.put(mergedEvent);
    logger.info(`[Coalescer] flush ${events.length} msg(s) as one → ${mergedStr.slice(0, 60).replace(/\n/g, ' ')}`);
  }
}
