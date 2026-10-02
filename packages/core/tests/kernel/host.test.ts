import { describe, it, expect, vi } from 'vitest';
import { ModuleHost } from '../../src/kernel/index.js';
import type { Module } from '../../src/kernel/index.js';
import {
  makeTestLogger,
  makeTrace,
  dbModule,
  vectorModule,
  memoryModule,
  eventbusModule,
  coalescerModule,
  pipelineModule,
} from './fixtures.js';

/** 建一个 host（日志不刷屏） */
function newHost(): ModuleHost {
  return new ModuleHost({ logger: makeTestLogger() });
}

describe('ModuleHost / 拓扑排序', () => {
  it('依赖先于依赖方 —— 声明顺序打乱也成立（依赖方先声明）', async () => {
    const trace = makeTrace();
    const host = newHost();
    host.use(memoryModule(trace)).use(vectorModule(trace)).use(dbModule(trace));

    await host.start();

    expect(trace.log.indexOf('install:al:memory')).toBeGreaterThan(trace.log.indexOf('install:al:db'));
    expect(trace.log.indexOf('install:al:memory')).toBeGreaterThan(trace.log.indexOf('install:al:vector'));
  });

  it('依赖先于依赖方 —— 声明顺序打乱也成立（依赖先声明）', async () => {
    const trace = makeTrace();
    const host = newHost();
    host.use(dbModule(trace)).use(vectorModule(trace)).use(memoryModule(trace));

    await host.start();

    expect(trace.log.indexOf('install:al:memory')).toBe(2);
  });

  it('循环依赖 → throw，错误信息含完整环路径', async () => {
    const host = newHost();
    const noop = (): void => undefined;
    host
      .use({ name: 'al:a', inject: ['al:b'], apply: noop })
      .use({ name: 'al:b', inject: ['al:c'], apply: noop })
      .use({ name: 'al:c', inject: ['al:a'], apply: noop });

    await expect(host.start()).rejects.toThrow(/循环依赖/);
    await expect(host.start()).rejects.toThrow(/al:a → al:b → al:c → al:a/);
  });
});

describe('ModuleHost / 消息处理链（真实形状：eventbus → coalescer → pipeline）', () => {
  it('单向链按依赖顺序安装，且每个模块 apply 内拿得到依赖的服务', async () => {
    const trace = makeTrace();
    const wire: { bus?: Record<string, unknown> } = {};
    const host = newHost();
    // 故意乱序声明
    host.use(pipelineModule(trace)).use(coalescerModule(trace, wire)).use(eventbusModule(trace, wire));

    await host.start();

    expect(trace.log).toEqual([
      'install:al:eventbus',
      'install:al:coalescer',
      'install:al:pipeline',
    ]);
    // coalescer 在 apply 里真的拿到了 bus（拿不到会 throw）
    expect(wire.bus?.coalescer).toBe(true);
  });

  it('分叉依赖：两个消费者共享同一个提供者，提供者只装一次', async () => {
    const trace = makeTrace();
    const wire: { bus?: Record<string, unknown> } = {};
    const host = newHost();
    let coalescerInstalls = 0;
    host.use(eventbusModule(trace, wire));
    host.use({
      name: 'al:coalescer',
      inject: ['al:eventbus'],
      apply: (ctx) => {
        coalescerInstalls++;
        ctx.provide('al:coalescer', {});
      },
    });
    host.use({ name: 'al:pipeline', inject: ['al:coalescer'], apply: (ctx) => { ctx.provide('al:pipeline', {}); } });
    host.use({ name: 'al:webui', inject: ['al:coalescer'], apply: (ctx) => { ctx.provide('al:webui', {}); } });

    await host.start();

    expect(coalescerInstalls).toBe(1);
    expect(trace.log.filter(l => l === 'install:al:eventbus')).toHaveLength(1);
  });
});

describe('ModuleHost / inject 校验', () => {
  it('inject 指向无人声明的服务 → 启动前就抛错（不进入任何 apply）', async () => {
    const applySpy = vi.fn();
    const host = newHost();
    host.use({ name: 'al:x', inject: ['al:nope'], apply: applySpy });

    await expect(host.start()).rejects.toThrow(/没有任何模块声明 provides/);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('inject 声明的服务未被 provide → 抛错且该模块 apply 未被调用', async () => {
    const applySpy = vi.fn();
    const host = newHost();
    host.use({
      name: 'al:missing',
      apply: () => {
        /* 声明了 provides（默认取模块名）却忘了 provide */
      },
    });
    host.use({ name: 'al:consumer', inject: ['al:missing'], apply: applySpy });

    await expect(host.start()).rejects.toThrow(/尚未就绪/);
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe('ModuleHost / 失败策略', () => {
  it('critical 模块失败 → 中止整树，已装的逆序回滚', async () => {
    const trace = makeTrace();
    const host = newHost();
    host.use(dbModule(trace));
    host.use({
      name: 'al:boom',
      inject: ['al:db'],
      apply: () => {
        trace.log.push('install:al:boom');
        throw new Error('boom');
      },
    });

    await expect(host.start()).rejects.toThrow(/al:boom" apply 失败/);
    expect(trace.log).toContain('dispose:al:db');
    expect(host.get('al:db')).toBeUndefined(); // 回滚后服务表已清空
  });

  it('critical:false 失败 → 不中止整树，依赖方拿到 undefined（LanceDB 降级语义）', async () => {
    const trace = makeTrace();
    const seen: { vector?: unknown } = {};
    const host = newHost();
    host.use(dbModule(trace)).use(vectorModule(trace, { fail: true })).use(memoryModule(trace, seen));

    await host.start();

    expect(trace.log).toContain('install:al:memory'); // 依赖方照样装上
    expect(seen.vector).toBeUndefined(); // 拿到降级值
    expect(host.get('al:memory')).toBeDefined();
  });

  it('critical:false 失败会记 error 日志（不静默吞）', async () => {
    const trace = makeTrace();
    const logger = makeTestLogger();
    const host = new ModuleHost({ logger });
    host.use(vectorModule(trace, { fail: true }));

    await host.start();

    expect(logger.lines.some(l => l.level === 'error' && /critical:false/.test(l.msg))).toBe(true);
  });
});

describe('ModuleHost / 重复检测', () => {
  it('模块名重复 → use() 立刻抛错', () => {
    const host = newHost();
    host.use({ name: 'al:x', apply: () => undefined });
    expect(() => host.use({ name: 'al:x', apply: () => undefined })).toThrow(/模块名重复/);
  });

  it('两个模块声明同一个服务名 → use() 立刻抛错', () => {
    const host = newHost();
    host.use({ name: 'al:a', provides: ['al:shared'], apply: () => undefined });
    expect(() => host.use({ name: 'al:b', provides: ['al:shared'], apply: () => undefined }))
      .toThrow(/服务名重复声明/);
  });

  it('provides: false 的模块不占用服务名（别的模块仍可提供同名服务）', () => {
    const host = newHost();
    // 纯副作用模块（seed / cron 这类），不对外提供任何服务
    host.use({ name: 'al:seed', provides: false, apply: () => undefined });
    // 于是 `al:seed` 这个服务名是空闲的，别的模块可以占用它
    expect(() =>
      host.use({ name: 'al:other', provides: ['al:seed'], apply: () => undefined }),
    ).not.toThrow();
  });
});

describe('ModuleHost / 生命周期', () => {
  it('stop 严格逆序卸载', async () => {
    const trace = makeTrace();
    const host = newHost();
    host.use(dbModule(trace));
    host.use({
      name: 'al:second',
      inject: ['al:db'],
      apply: (ctx) => {
        trace.log.push('install:al:second');
        ctx.effect(() => () => {
          trace.log.push('dispose:al:second');
        });
      },
    });

    await host.start();
    await host.stop();

    const installTail = trace.log.filter(l => l.startsWith('install:'));
    expect(installTail).toEqual(['install:al:db', 'install:al:second']);
    expect(trace.log.slice(-2)).toEqual(['dispose:al:second', 'dispose:al:db']);
  });

  it('stop 幂等 —— 重复调用不重复卸载', async () => {
    const trace = makeTrace();
    const host = newHost();
    host.use(dbModule(trace));

    await host.start();
    await host.stop();
    await host.stop();

    expect(trace.log.filter(l => l === 'dispose:al:db')).toHaveLength(1);
  });

  it('start 之后 use() → 抛错', async () => {
    const host = newHost();
    host.use({ name: 'al:x', apply: () => undefined });
    await host.start();

    expect(() => host.use({ name: 'al:y', apply: () => undefined })).toThrow(/不能.*use/);
  });

  it('stop 之后 use() / start()  → 抛错', async () => {
    const host = newHost();
    host.use({ name: 'al:x', apply: () => undefined });
    await host.start();
    await host.stop();

    expect(() => host.use({ name: 'al:y', apply: () => undefined })).toThrow(/不能.*use/);
    await expect(host.start()).rejects.toThrow(/已 stop/);
  });
});
