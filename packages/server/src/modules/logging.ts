/**
 * server 模块 —— `al:logging`
 *
 * 对应 `bootstrap.ts` 的 `logger.configure({ logDir })` + `startDailyLogCleanup()`。
 *
 * ★ 它必须排在 `al:config` 之后、其余模块之前——否则那些模块的启动日志
 *   不会落到文件里（原实现也是这个顺序）。
 */

import { logger, startDailyLogCleanup } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';
import type { RuntimeConfig } from './config.js';

export const loggingModule: Module = {
  name: 'al:logging',
  /**
   * ★ 提供 `al:logDir`（日志目录）—— 它同时是**排序令牌**。
   *
   *   内核只按 `inject` 拓扑排序，没有「只排序、不依赖服务」的表达方式。
   *   而「core 的启动日志必须落进文件」是一个真实的前置关系，
   *   所以让本模块提供一个真值、让 core 注入它，而不是靠声明顺序（顺序不可靠）。
   */
  provides: ['al:logDir'],
  inject: ['al:config'],
  apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;
    const logDir = `${config.server.dataDir}/logs`;

    logger.configure({ logDir });
    ctx.provide('al:logDir', logDir);
    ctx.logger.info(`Log file: ${logDir}/alysia-${new Date().toISOString().slice(0, 10)}.log`);

    // ★ 8-10 长跑容器内每日清理（`configure` 已清一次；保留 7 天——用户要求保留
    //   足够日志供异常分析，清理太频繁会丢失信息）
    const timer = startDailyLogCleanup();
    if (timer) {
      ctx.effect(() => () => clearInterval(timer), 'daily-log-cleanup');
    }
  },
};
