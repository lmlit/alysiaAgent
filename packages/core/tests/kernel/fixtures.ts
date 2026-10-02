/**
 * module-kernel 测试 fixtures。
 *
 * ★ 刻意用 **alysia 真实的模块形状**（db→memory 的依赖链、vector 的失败降级、
 *   coalescer↔eventbus 的双向依赖），而不是抽象 A/B —— 否则契约正确性无法在 P1 兑现。
 *   对应关系见 `docs/dsh-plugin-architecture.md` §4.2 的模块清单。
 */

import type { Module, ModuleLogger } from '../../src/kernel/index.js';

export interface TestLogger extends ModuleLogger {
  /** 已记录的日志行（测试断言用） */
  lines: Array<{ level: string; msg: string }>;
}

/** 不刷屏的测试日志器 */
export function makeTestLogger(): TestLogger {
  const lines: Array<{ level: string; msg: string }> = [];
  const rec = (level: string) => (msg: string): void => {
    lines.push({ level, msg });
  };
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

/** 记录安装/卸载顺序，便于断言生命周期 */
export interface Trace {
  log: string[];
}

export function makeTrace(): Trace {
  return { log: [] };
}

// ── 基础资源层（对应 AlysiaCore.start() 第 1-3 步）──────────────

/** `al:db` —— better-sqlite3 + initializeDatabase（index.ts:103-106） */
export function dbModule(trace: Trace): Module<{ path: string }> {
  return {
    name: 'al:db',
    apply(ctx) {
      trace.log.push('install:al:db');
      ctx.provide('al:db', { handle: `sqlite:${ctx.config?.path ?? ':memory:'}` });
      ctx.effect(() => () => {
        trace.log.push('dispose:al:db');
      }, 'db.close');
    },
  };
}

/**
 * `al:vector` —— LanceDB，**失败降级**（index.ts:110-124 的 try/catch + logger.warn）。
 * `critical: false` + 失败后依赖方拿到 `undefined` = 现有「文本检索兜底」语义。
 */
export function vectorModule(trace: Trace, opts: { fail?: boolean } = {}): Module {
  return {
    name: 'al:vector',
    critical: false,
    apply(ctx) {
      trace.log.push('install:al:vector');
      if (opts.fail) throw new Error('LanceDB unavailable: missing native lib');
      ctx.provide('al:vector', { kind: 'lancedb' });
    },
  };
}

/** `al:memory` —— 依赖基础资源（index.ts:179） */
export function memoryModule(trace: Trace, seen: { vector?: unknown } = {}): Module {
  return {
    name: 'al:memory',
    inject: ['al:db', 'al:vector'],
    apply(ctx) {
      trace.log.push('install:al:memory');
      seen.vector = ctx.get('al:vector');
      // 真实代码把 vectorStore 当可空用（index.ts:179 `vectorStore as any`）
      ctx.provide('al:memory', { vectorStore: seen.vector ?? null });
    },
  };
}

// ── 消息处理链（严格单向，无环 —— change: drop-kernel-peer 核实）──────

/**
 * `al:eventbus` —— **无依赖**。
 *
 * ★ 核实过：`EventBus.ts` 全文不引用 Coalescer。`setDefaultScheduler` 是
 *   `bootstrap.ts:52` 在 `start()` 之后接的线，不在构造期。
 *   （spec 曾错误声称「EventBus 需要 Coalescer 的 AbortRegistry」，已纠正。）
 */
export function eventbusModule(trace: Trace, wire: { bus?: Record<string, unknown> } = {}): Module {
  return {
    name: 'al:eventbus',
    apply(ctx) {
      trace.log.push('install:al:eventbus');
      const bus: Record<string, unknown> = { put: () => undefined };
      wire.bus = bus;
      ctx.provide('al:eventbus', bus);
    },
  };
}

/**
 * `al:coalescer` —— 依赖 eventbus：合并事件要 `eventBus.put(merged, {priority:true})`
 * 重入管线（`coalescer.ts:185`）。这是**单向**依赖。
 */
export function coalescerModule(trace: Trace, wire: { bus?: Record<string, unknown> } = {}): Module {
  return {
    name: 'al:coalescer',
    inject: ['al:eventbus'],
    apply(ctx) {
      trace.log.push('install:al:coalescer');
      const bus = ctx.get<Record<string, unknown>>('al:eventbus');
      if (!bus) throw new Error('coalescer 拿不到 eventbus —— inject 契约被破坏');
      bus.coalescer = true; // 真实代码：coalescer.setEventBus(bus)
      ctx.provide('al:coalescer', { isInFlight: () => false });
    },
  };
}

/**
 * `al:pipeline` —— 依赖 coalescer：`LLMAgentStage` 经 `ctx.coalescer` 取打断 signal 与
 * AbortRegistry（`llm-agent.ts:159`、`:254`）。
 */
export function pipelineModule(trace: Trace): Module {
  return {
    name: 'al:pipeline',
    inject: ['al:coalescer'],
    apply(ctx) {
      trace.log.push('install:al:pipeline');
      const coalescer = ctx.get('al:coalescer');
      if (!coalescer) throw new Error('pipeline 拿不到 coalescer —— inject 契约被破坏');
      ctx.provide('al:pipeline', { stages: 7 });
    },
  };
}
