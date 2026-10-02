/**
 * 模块单测的共用脚手架。
 *
 * 目标：**不启动整个 AlysiaCore** 就能单独跑一个模块——
 * 把它的依赖用 stub 服务喂进去，断言它的产出。
 * （整机装配由 `tests/index.smoke.test.ts` 守，两者互补。）
 */

import { ModuleHost } from '../../src/kernel/index.js';
import type { Module, ModuleLogger } from '../../src/kernel/index.js';

export interface TestLogger extends ModuleLogger {
  lines: Array<{ level: string; msg: string }>;
}

export function makeTestLogger(): TestLogger {
  const lines: Array<{ level: string; msg: string }> = [];
  const rec = (level: string) => (msg: string): void => {
    lines.push({ level, msg });
  };
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

/**
 * 一个只提供某个服务、不做别的事的桩模块。
 * 名字即服务名（`provides` 默认取模块名）。
 */
export function stub(name: string, value: unknown): Module {
  return {
    name,
    apply(ctx) {
      ctx.provide(name, value);
    },
  };
}

export interface RunResult {
  host: ModuleHost;
  logger: TestLogger;
  /** 取宿主里的服务 */
  get<T = unknown>(name: string): T | undefined;
  stop(): Promise<void>;
}

/** seed 项：裸模块（无配置）或 `[模块, 配置]` */
export type SeedItem = Module | [Module, unknown];

/**
 * 在隔离宿主里跑一个模块。
 *
 * @param module 被测模块
 * @param config 传给模块的配置
 * @param deps   预置的依赖服务 `[服务名, 值]`
 * @param seed   额外模块（真模块，带配置；用于补全依赖链或断言副作用）
 */
export async function runModule<S>(
  module: Module<S>,
  config: S,
  deps: Array<[string, unknown]> = [],
  seed: SeedItem[] = [],
): Promise<RunResult> {
  const logger = makeTestLogger();
  const host = new ModuleHost({ logger });
  for (const [name, value] of deps) host.use(stub(name, value));
  for (const item of seed) {
    if (Array.isArray(item)) host.use(item[0], item[1]);
    else host.use(item);
  }
  host.use(module, config);
  await host.start();
  return {
    host,
    logger,
    get: <T = unknown>(name: string): T | undefined => host.get<T>(name),
    stop: () => host.stop(),
  };
}
