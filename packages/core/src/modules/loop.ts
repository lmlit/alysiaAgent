/**
 * 消息循环模块 —— `AlysiaCore.start()` 的第 12-15 步（change: modularize-core-assembly）。
 *
 * `eventbus → coalescer → pipeline → boot`，严格单向（`drop-kernel-peer` 核实）。
 */

import { EventBus } from '../eventbus/EventBus.js';
import { PipelineScheduler } from '../pipeline/scheduler.js';
import { createPipelineContext } from '../pipeline/context.js';
import { CoalescerStage } from '../pipeline/stages/coalescer.js';
import { PIIFilterStage } from '../pipeline/stages/pii-filter.js';
import { MemoryIngestStage } from '../pipeline/stages/memory-ingest.js';
import { WorldbookStage } from '../pipeline/stages/worldbook.js';
import { MemoryRetrievalStage } from '../pipeline/stages/memory-retrieval.js';
import { LLMAgentStage } from '../pipeline/stages/llm-agent.js';
import { RespondStage } from '../pipeline/stages/respond.js';
import type { SamplingConfig } from '../provider/sampling.js';
import type { Module } from '../kernel/index.js';

// ── al:eventbus ───────────────────────────────────────────────

/** 事件总线。对应 `index.ts:256`。**无依赖**——它不引用 Coalescer */
export const eventbusModule: Module = {
  name: 'al:eventbus',
  apply(ctx) {
    ctx.provide('al:eventbus', new EventBus());
  },
};

// ── al:coalescer ──────────────────────────────────────────────

/**
 * 输入合并 + 打断。对应 `index.ts:232` + `:257`（`setEventBus`）。
 *
 * ★ 依赖 eventbus：合并事件要 `eventBus.put(merged, {priority:true})` 重入管线
 *   （`coalescer.ts:185`）。**单向**。
 */
export const coalescerModule: Module = {
  name: 'al:coalescer',
  inject: ['al:eventbus'],
  apply(ctx) {
    const eventBus = ctx.get<EventBus>('al:eventbus')!;
    const coalescer = new CoalescerStage();
    coalescer.setEventBus(eventBus);
    ctx.provide('al:coalescer', coalescer);
  },
};

// ── al:pipeline ───────────────────────────────────────────────

export interface PipelineConfig {
  sampling: SamplingConfig;
  ownerId: string;
}

/**
 * 7 段管线。对应 `index.ts:236-253`。
 *
 * ⚠️ **CoalescerStage 是同一个实例**：它既在 `PipelineContext.coalescer` 里
 *   （供 LLMAgentStage 取打断 signal），又是 pipeline 的第 3 个 stage。
 *   原实现就是这个形状（`index.ts:242` 与 `:248` 传的是同一个 `coalescer` 变量）。
 *   拆成两个实例会让打断链路静默失效——这正是冒烟测试要守的东西。
 */
export const pipelineModule: Module<PipelineConfig> = {
  name: 'al:pipeline',
  inject: ['al:memory', 'al:provider', 'al:tools', 'al:commands', 'al:coalescer'],
  apply(ctx, config) {
    if (!config) throw new Error('[al:pipeline] 缺少配置 { sampling, ownerId }');
    const memoryManager = ctx.get('al:memory');
    const coalescer = ctx.get<CoalescerStage>('al:coalescer')!;

    const pipelineCtx = createPipelineContext({
      memoryManager: memoryManager as any,
      providerManager: ctx.get('al:provider') as any,
      toolRegistry: ctx.get('al:tools') as any,
      commandRegistry: ctx.get('al:commands') as any,
      sampling: config.sampling,
      coalescer: coalescer as any,
    });

    const scheduler = new PipelineScheduler(pipelineCtx, [
      new PIIFilterStage(),
      new MemoryIngestStage(memoryManager as any, config.ownerId),
      coalescer,
      new WorldbookStage(),
      new MemoryRetrievalStage(memoryManager as any),
      new LLMAgentStage(),
      new RespondStage(),
    ]);

    ctx.provide('al:pipeline', scheduler);
  },
};

// ── al:boot ───────────────────────────────────────────────────

/**
 * 启动动作：`scheduler.initialize()` + `eventBus.dispatch()`。对应 `index.ts:260-261`。
 *
 * ★ 独立成模块的理由（proposal 决策 1）：
 *   ① 顺序由 `inject` 保证（必须等 pipeline 与 eventbus 都就绪），不靠调用位置；
 *   ② `eventBus.stop()` 成为它的 `ctx.effect()`，生命周期闭环——
 *      这样 `ModuleHost.stop()` 能真的把派发循环停掉。
 */
export const bootModule: Module = {
  name: 'al:boot',
  provides: false,
  inject: ['al:pipeline', 'al:eventbus'],
  async apply(ctx) {
    const scheduler = ctx.get<PipelineScheduler>('al:pipeline')!;
    const eventBus = ctx.get<EventBus>('al:eventbus')!;

    await scheduler.initialize();
    // ★ 用 `ctx.logger`（内核注入）而非模块级导入的全局 logger——
    //   后者绕过宿主，模块在隔离测试里注入的日志器就收不到它。
    eventBus.dispatch().catch(err => ctx.logger.error('EventBus dispatch error:', err));

    ctx.effect(() => () => {
      eventBus.stop();
    }, 'eventbus.stop');
  },
};
