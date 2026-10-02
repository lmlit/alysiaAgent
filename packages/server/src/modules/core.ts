/**
 * server 模块 —— `al:core`
 *
 * 对应 `bootstrap.ts` 的 `new AlysiaCore({...})` + `await core.start()` +
 * `core.eventBus.setDefaultScheduler(core.scheduler)`。
 *
 * ★ `core.stop()` 注册成 `ctx.effect` —— 停机清理由宿主统一驱动，
 *   不再散在 bootstrap 的 SIGINT/SIGTERM 处理里。
 */

import { AlysiaCore } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';
import type { RuntimeConfig } from './config.js';

export const coreModule: Module = {
  name: 'al:core',
  // `al:logDir` 是**排序令牌**（见 logging.ts）：core 的启动日志必须走已配置好的文件日志
  inject: ['al:config', 'al:logDir'],
  async apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;

    const core = new AlysiaCore({
      dbPath: `${config.server.dataDir}/alysia.db`,
      ownerId: config.bot.ownerId,
      workspaceDir: config.server.workspaceDir,
      llmConfig: config.llm,
      embedConfig: config.embed,
      features: config.features ?? { codeMode: false },
      // ★ 8-10 采样参数统一配置（DEFAULT floor + config.yml sampling: 节覆盖）
      sampling: config.sampling,
    });

    await core.start();
    core.eventBus.setDefaultScheduler(core.scheduler);

    ctx.provide('al:core', core);

    ctx.effect(() => () => core.stop().catch(err => {
      ctx.logger.error('Shutdown:', err);
    }), 'core.stop');
  },
};
