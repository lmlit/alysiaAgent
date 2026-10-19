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
import { hostPagesCache } from '../host-pages.js';
import { getServerStatusSnapshot } from '../server-status.js';

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
      /**
       * ★ 2026-10-17（change: `add-project-task-delegation`）：把登记的项目 id 交给 core，
       *   决定**委托工具注册不注册**（空 ⇒ 不注册）。
       * ⚠️ 只给 id：工作目录与 dsh profile 留在服务端（runner 从认领响应里拿）。
       */
      projectIds: Object.keys(config.projects ?? {}),
    // ★ 2026-10-18（gate-project-tasks-to-offpeak）：工具回执要能说清"到点自己会跑"
    projectTasks: config.projectTasks,
    // ★ 2026-10-19（wake-her-on-task-result）：自动返工上限（只拦"她看着结果自己决定改"）
    maxAutoRework: config.subagentWake?.maxAutoRework ?? 2,
    /**
     * ★ 2026-10-19（change: `let-her-query-what-she-made`）：她的页面清单（只读投影）。
     * 数据结构单一来源是宿主上的 `pages.json`；容器看不到 ⇒ 由 runner 每轮
     * `POST /api/host/pages` 推上来，这里读进程内缓存。
     */
    hostPages: () => hostPagesCache.get(),
    /** ★ 2026-10-19（let-her-query-what-she-made）：服务/宿主健康快照（只读）。 */
    serverStatus: () => getServerStatusSnapshot(),
    });

    await core.start();
    core.eventBus.setDefaultScheduler(core.scheduler);

    ctx.provide('al:core', core);

    ctx.effect(() => () => core.stop().catch(err => {
      ctx.logger.error('Shutdown:', err);
    }), 'core.stop');
  },
};
