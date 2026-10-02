import { describe, it, expect } from 'vitest';
import { createModuleContext } from '../../src/kernel/index.js';
import type { EffectDisposer } from '../../src/kernel/index.js';
import { makeTestLogger } from './fixtures.js';

type Handler = (...args: unknown[]) => void;

/** 直接搭一个模块上下文（绕过 host，便于单测边界行为） */
function newCtx(opts: {
  declared?: readonly string[] | false;
  /** 预置服务（模拟别的模块已 provide） */
  seed?: Array<[string, unknown, string]>;
} = {}) {
  const services = new Map<string, unknown>();
  const serviceOwners = new Map<string, string>();
  for (const [name, value, owner] of opts.seed ?? []) {
    services.set(name, value);
    serviceOwners.set(name, owner);
  }
  const events = new Map<string, Set<Handler>>();
  const effects: EffectDisposer[] = [];
  let stopped = false;
  const logger = makeTestLogger();

  const ctx = createModuleContext({
    name: 'al:test',
    config: { hello: 'world' },
    services,
    serviceOwners,
    logger,
    declared: opts.declared ?? ['al:test'],
    effects,
    events,
    isStopped: () => stopped,
  });

  return { ctx, services, effects, events, logger, stop: () => { stopped = true; } };
}

describe('ModuleContext / 服务', () => {
  it('get 未注册的服务 → undefined（允许可选依赖探测）', () => {
    const { ctx } = newCtx();
    expect(ctx.get('al:nope')).toBeUndefined();
  });

  it('get 能拿到别的模块已提供的服务', () => {
    const { ctx } = newCtx({ seed: [['al:db', { handle: 'sqlite' }, 'al:db']] });
    expect(ctx.get<{ handle: string }>('al:db')?.handle).toBe('sqlite');
  });

  it('provide 未在 Module.provides 声明的服务名 → 抛错（防拼写错误）', () => {
    const { ctx } = newCtx({ declared: ['al:test'] });
    expect(() => ctx.provide('al:typo', 1)).toThrow(/未声明的服务/);
  });

  it('provides: false 的模块 provide 任何东西 → 抛错', () => {
    const { ctx } = newCtx({ declared: false });
    expect(() => ctx.provide('al:test', 1)).toThrow(/provides: false/);
  });

  it('服务名冲突 → 抛错（不静默覆盖），错误信息含原提供者', () => {
    const { ctx } = newCtx({ seed: [['al:test', { old: true }, 'al:other']] });
    expect(() => ctx.provide('al:test', { new: true })).toThrow(/服务名冲突/);
    expect(() => ctx.provide('al:test', { new: true })).toThrow(/al:other/);
  });

  it('正常 provide 后 get 拿得到', () => {
    const { ctx, services } = newCtx();
    ctx.provide('al:test', { v: 42 });
    expect(services.get('al:test')).toEqual({ v: 42 });
    expect(ctx.get('al:test')).toEqual({ v: 42 });
  });
});

describe('ModuleContext / effect', () => {
  it('setup 立即执行，返回的函数被收集', () => {
    const { ctx, effects } = newCtx();
    ctx.effect(() => () => undefined);
    expect(effects).toHaveLength(1);
  });

  it('setup 不返回函数 → 不收集（允许只做副作用）', () => {
    const { ctx, effects } = newCtx();
    ctx.effect(() => undefined);
    expect(effects).toHaveLength(0);
  });

  it('宿主 stop 之后调用 effect → 抛错（对应 cordis 的 INACTIVE_EFFECT）', () => {
    const { ctx, stop } = newCtx();
    stop();
    expect(() => ctx.effect(() => undefined)).toThrow(/stop\(\) 之后/);
  });

  it('宿主 stop 之后 on / provide → 抛错', () => {
    const { ctx, stop } = newCtx();
    stop();
    expect(() => ctx.on('x', () => undefined)).toThrow(/stop\(\) 之后/);
    expect(() => ctx.provide('al:test', 1)).toThrow(/stop\(\) 之后/);
  });
});

describe('ModuleContext / 事件', () => {
  it('on / emit 基本通路', () => {
    const { ctx } = newCtx();
    const seen: unknown[] = [];
    ctx.on('ping', (v) => seen.push(v));
    ctx.emit('ping', 1, 2);
    expect(seen).toEqual([1]);
  });

  it('没有订阅者时 emit 不抛错', () => {
    const { ctx } = newCtx();
    expect(() => ctx.emit('nobody-listens')).not.toThrow();
  });

  it('off() 能取消订阅', () => {
    const { ctx } = newCtx();
    const seen: unknown[] = [];
    const off = ctx.on('ping', () => seen.push(1));
    off();
    ctx.emit('ping');
    expect(seen).toEqual([]);
  });

  it('单个 handler 抛错不中断其他 handler，且进 error 日志', () => {
    const { ctx, logger } = newCtx();
    const seen: string[] = [];
    ctx.on('ping', () => {
      throw new Error('handler exploded');
    });
    ctx.on('ping', () => seen.push('second'));

    expect(() => ctx.emit('ping')).not.toThrow();
    expect(seen).toEqual(['second']);
    expect(logger.lines.some(l => l.level === 'error' && /handler 抛错/.test(l.msg))).toBe(true);
  });

  it('handler 内部 off() 自己不会打乱本次派发', () => {
    const { ctx } = newCtx();
    const seen: string[] = [];
    const off = ctx.on('ping', () => {
      seen.push('a');
      off();
    });
    ctx.on('ping', () => seen.push('b'));

    ctx.emit('ping');
    expect(seen).toEqual(['a', 'b']);
  });
});
