// ★ 8-10 输入合并 + 打断（input-coalescing-and-abort，8-10 修订：即时生成 + 打断累计）
//
// 落点：pipeline 内 stage（memory-ingest 之后、worldbook 之前）——单点实现，
// 全部适配器自动覆盖。依赖 scheduler 对 async generator 的既有语义：
// "不 yield 直接 return → 后续 stage 不执行"（scheduler.ts:36-43）。
//
// 行为（用户 8-10 拍板，修订自固定 10s 窗口）：
// - 首条消息【立即放行】触发 LLM 生成——不等任何窗口，无固定延迟
// - 新消息到达时若该 session 有在飞生成（回复未出）→ 打断它 + 消息入桶累计，
//   被打断的生成结束后（onGenerationAborted）立即 flush 合并事件重发
// - "没有回复就能累计"：生成期间每来一条消息都会打断合并重发，直到回复真正出来
// - 10s 上限仅作兜底（防 onGenerationAborted 丢失时桶悬挂）；回复已出时新消息
//   就是独立首条消息，立即放行
// - 群聊：不合并不打断（保持现状逐条回复）
//
// EventLog 忠实：每条原始消息照常 ingest；合并事件带 coalesced 标记跳过 pii/ingest。

import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { MessageEvent as MessageEventClass } from '../../platform/event.js';
import type { Message } from '../../platform/message.js';
import { logger } from '../../utils/logger.js';
import { AbortRegistry } from '../abort-registry.js';
import type { EventBus } from '../../eventbus/EventBus.js';

export interface CoalescerOptions {
  /** 兜底上限：入桶后到点强制 flush（防被打断事件回调丢失时桶悬挂） */
  maxWaitMs?: number;
}

interface Bucket {
  /** 被打断后累计的新消息（未进入生成的消息） */
  events: MessageEvent[];
  capTimer: NodeJS.Timeout | null;
}

export class CoalescerStage implements Stage {
  private ctx!: PipelineContext;
  private eventBus: EventBus | null = null;
  private buckets = new Map<string, Bucket>();
  /** 当前在飞生成对应的事件（放行时记录，打断时取其文本做合并基底） */
  private inFlightEvents = new Map<string, MessageEvent>();
  private readonly maxWaitMs: number;

  constructor(
    private abortRegistry: AbortRegistry = new AbortRegistry(),
    opts: CoalescerOptions = {},
  ) {
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
      this.inFlightEvents.set(event.unifiedMsgOrigin, event);
      yield;
      return;
    }

    // 群聊：不合并不打断（用户拍板保守方案），统一在这里 await 图片描述拼接
    if (!event.isPrivateChat()) {
      await this.attachImageDescs(event);
      yield;
      return;
    }

    // 私聊
    const sessionId = event.unifiedMsgOrigin;
    if (this.abortRegistry.isInFlight(sessionId)) {
      // 回复未出：打断在飞 + 消息入桶累计（不 yield → 后续 stage 不执行，等 flush）
      this.abortRegistry.abort(sessionId);
      const bucket = this.getOrCreateBucket(sessionId);
      bucket.events.push(event);
      if (!bucket.capTimer) {
        // 兜底上限：正常路径由 onGenerationAborted 即时 flush，此处防回调丢失悬挂
        bucket.capTimer = setTimeout(() => {
          this.flushBucket(sessionId).catch(err => logger.error(`[Coalescer] flush error: ${err.message}`));
        }, this.maxWaitMs);
      }
      logger.debug(`[Coalescer] aborted in-flight, buffered (${bucket.events.length}): ${event.messageStr.slice(0, 40)}`);
      return;
    }

    // 无在飞（首条或上次回复已出）：立即放行，不等窗口
    await this.attachImageDescs(event);
    this.inFlightEvents.set(sessionId, event);
    yield;
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
      bucket = { events: [], capTimer: null };
      this.buckets.set(sessionId, bucket);
    }
    return bucket;
  }

  /**
   * ★ 8-10 打断后的即时 flush 触发点：由 llm-agent 在被打断的生成结束（aborted）时回调。
   * 合并文本 = 被打断事件的文本（含其图片描述）+ 桶内累计的新消息（换行拼接）。
   */
  /** 返回 Promise 便于测试等待；llm-agent 侧 fire-and-forget（不阻塞被打断 pipeline 收尾） */
  onGenerationAborted(sessionId: string, abortedEvent: MessageEvent): Promise<void> {
    this.inFlightEvents.delete(sessionId);
    // 桶不存在（无累计消息）→ 打断后无合并对象，忽略
    if (!this.buckets.has(sessionId)) return Promise.resolve();
    return this.flushBucket(sessionId, abortedEvent).catch(err => {
      logger.error(`[Coalescer] flush error: ${err.message}`);
    });
  }

  /** 合并 flush：await 全部图片描述 → 拼接合并事件 → 重入 EventBus */
  private async flushBucket(sessionId: string, abortedEvent?: MessageEvent): Promise<void> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return;
    this.buckets.delete(sessionId);
    if (bucket.capTimer) clearTimeout(bucket.capTimer);
    if (bucket.events.length === 0) return;

    const base = abortedEvent ?? this.inFlightEvents.get(sessionId);
    if (!base) {
      logger.warn(`[Coalescer] no base event to merge with (session ${sessionId.slice(-16)})`);
      return;
    }

    // 图片预热：await 被打断事件 + 桶内全部 pending 描述
    const descs: string[] = [];
    for (const ev of [base, ...bucket.events]) {
      const pending = ev.getExtra('pending_image_descs') ?? [];
      const results = await Promise.all(pending);
      for (const r of results) if (r) descs.push(`[图片内容: ${r}]`);
    }
    const descText = descs.join('\n');
    const texts = [base.messageStr, ...bucket.events.map(e => e.messageStr)].filter(t => t.trim());
    const mergedStr = [descText, ...texts].filter(Boolean).join('\n');

    // 合并事件：components 聚合为纯文本（图片已转描述，DeepSeek 只看文字）
    const mergedMessage: Message = {
      ...base.messageObj,
      messageId: `coalesced-${Date.now()}-${sessionId.slice(-8)}`,
      content: [{ type: 'plain', text: mergedStr }],
    };
    const mergedEvent = new MessageEventClass({
      messageStr: mergedStr,
      messageObj: mergedMessage,
      platformMeta: base.platformMeta,
      sessionId: base.sessionId,
    });
    mergedEvent.setExtra('coalesced', true);

    if (!this.eventBus) {
      logger.error('[Coalescer] eventBus not wired, merged messages dropped');
      return;
    }
    this.eventBus.put(mergedEvent);
    logger.info(`[Coalescer] merged ${1 + bucket.events.length} msg(s) as one → ${mergedStr.slice(0, 60).replace(/\n/g, ' ')}`);
  }
}
