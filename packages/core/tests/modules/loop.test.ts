/**
 * 消息循环模块（`modules/loop.ts`）单测。
 *
 * ★ 这里守的是一条**破坏了不会报错**的装配性质——见 `al:pipeline` 那组断言。
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/eventbus/EventBus.js';
import { CoalescerStage } from '../../src/pipeline/stages/coalescer.js';
import { PipelineScheduler } from '../../src/pipeline/scheduler.js';
import { eventbusModule, coalescerModule, pipelineModule, bootModule } from '../../src/modules/loop.js';
import { runModule, stub, makeTestLogger } from './helpers.js';
import { ModuleHost } from '../../src/kernel/index.js';

/** pipeline 的四个非循环依赖（构造期只存引用，process 时才用到内部实现） */
const pipelineDeps: Array<[string, unknown]> = [
  ['al:memory', {}],
  ['al:provider', {}],
  ['al:tools', {}],
  ['al:commands', {}],
];

describe('al:eventbus / al:coalescer', () => {
  it('coalescer 拿到的是 eventbus 提供的那个实例', async () => {
    const r = await runModule(coalescerModule, undefined, [], [eventbusModule]);
    const bus = r.get('al:eventbus');
    expect(bus).toBeInstanceOf(EventBus);
    expect(r.get('al:coalescer')).toBeInstanceOf(CoalescerStage);
    await r.stop();
  });

  it('eventbus 无依赖，单独也能装', async () => {
    const r = await runModule(eventbusModule, undefined);
    expect(r.get('al:eventbus')).toBeInstanceOf(EventBus);
    await r.stop();
  });
});

describe('al:pipeline', () => {
  it('★ Coalescer 是同一个实例：既进 PipelineContext，又作 stage', async () => {
    // 这条性质**破坏了不会报错**——拆成两个 `new CoalescerStage()` 后管线照跑，
    // 只是 LLMAgentStage 拿不到打断 signal，`isGenerating()` 永远 false。
    // 只有断言能守住它。
    const r = await runModule(
      pipelineModule,
      { sampling: undefined as never, ownerId: 'owner-1' },
      pipelineDeps,
      [eventbusModule, coalescerModule],
    );

    const scheduler = r.get<PipelineScheduler>('al:pipeline')!;
    const coalescer = r.get<CoalescerStage>('al:coalescer')!;
    // PipelineScheduler.ctx/.stages 是 TS private —— 运行时仍可访问，
    // 这是装配正确性唯一的可观察出口。
    const s = scheduler as unknown as { ctx: { coalescer?: unknown }; stages: unknown[] };

    expect(s.ctx.coalescer).toBe(coalescer);
    expect(s.stages).toContain(coalescer);
    await r.stop();
  });

  it('7 段管线按固定顺序装好', async () => {
    const r = await runModule(
      pipelineModule,
      { sampling: undefined as never, ownerId: 'owner-1' },
      pipelineDeps,
      [eventbusModule, coalescerModule],
    );
    const s = r.get<PipelineScheduler>('al:pipeline') as unknown as { stages: Array<{ constructor: { name: string } }> };
    expect(s.stages.map(x => x.constructor.name)).toEqual([
      'PIIFilterStage',
      'MemoryIngestStage',
      'CoalescerStage',
      'WorldbookStage',
      'MemoryRetrievalStage',
      'LLMAgentStage',
      'RespondStage',
    ]);
    await r.stop();
  });

  it('缺配置时立刻抛错（不带着 undefined 跑起来）', async () => {
    const host = new ModuleHost({ logger: makeTestLogger() });
    for (const [n, v] of pipelineDeps) host.use(stub(n, v));
    host.use(eventbusModule).use(coalescerModule).use(pipelineModule);
    await expect(host.start()).rejects.toThrow(/缺少配置/);
  });
});

describe('al:boot', () => {
  it('依次调用 scheduler.initialize 与 eventBus.dispatch', async () => {
    const calls: string[] = [];
    const scheduler = { initialize: vi.fn(async () => { calls.push('initialize'); }) };
    const bus = {
      dispatch: vi.fn(() => { calls.push('dispatch'); return Promise.resolve(); }),
      stop: vi.fn(() => { calls.push('stop'); }),
    };

    const r = await runModule(bootModule, undefined, [['al:pipeline', scheduler], ['al:eventbus', bus]]);

    expect(calls).toEqual(['initialize', 'dispatch']);
    expect(scheduler.initialize).toHaveBeenCalledTimes(1);
    expect(bus.dispatch).toHaveBeenCalledTimes(1);

    await r.stop();
    // ★ eventBus.stop 是 boot 的 ctx.effect —— 卸载时必须跑到，
    //   否则派发循环永远不停（`core.stop()` 的语义就靠这个）
    expect(bus.stop).toHaveBeenCalledTimes(1);
  });

  it('派发循环 reject 不炸宿主（挂 error 日志）', async () => {
    const logger = makeTestLogger();
    const scheduler = { initialize: vi.fn(async () => undefined) };
    const bus = {
      dispatch: vi.fn(() => Promise.reject(new Error('dispatch exploded'))),
      stop: vi.fn(),
    };

    const host = new ModuleHost({ logger });
    host.use(stub('al:pipeline', scheduler)).use(stub('al:eventbus', bus)).use(bootModule);
    await host.start();

    // 让 rejection 冒出来
    await new Promise(r => setTimeout(r, 10));
    expect(logger.lines.some(l => l.level === 'error' && /EventBus dispatch error/.test(l.msg))).toBe(true);
    await host.stop();
  });
});
