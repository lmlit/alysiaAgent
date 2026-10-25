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

/**
 * ★ 2026-10-25（change: `disable-publishing`）：页面 / 博客发布能力的**总开关**。
 *
 * 用户要求先停掉「昔涟自己生成网站、发博客」这条链路（要先想清楚怎么改再开）。
 * 默认 **false** —— `features.publish` 必须**显式设 true** 才恢复。
 *
 * 关掉它会同时去掉：
 * - 委托工具（`start_project_task` / `continue_project_task` / `accept_project_task` / `get_project_task`）
 * - 页面清单工具（`list_my_pages` / `find_page`）与服务健康（`check_server_status`）
 *
 * ⚠️ **不删配置、不删数据**：`config.projects:` 保留，宿主上已有的页面也不动 ——
 *   这是"关功能"，不是"清账"。要恢复就 `features.publish: true`。
 */
export function publishingEnabled(config: { features?: { publish?: boolean } }): boolean {
  return config.features?.publish === true;
}

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
       *
       * ★ 2026-10-25（change: `disable-publishing`）：**页面/博客发布能力总开关**。
       *   用户要求先停掉「她自己生成网站、发博客」这条链路（要先想清楚怎么改再开）。
       *   `features.publish !== true` ⇒ 传空数组 ⇒ 委托工具（start_project_task /
       *   continue / accept / get）**全部不注册**；配置里的 `projects:` 仍保留（不删数据）。
       */
      projectIds: publishingEnabled(config) ? Object.keys(config.projects ?? {}) : [],
    // ★ 2026-10-18（gate-project-tasks-to-offpeak）：工具回执要能说清"到点自己会跑"
    projectTasks: config.projectTasks,
    // ★ 2026-10-19（wake-her-on-task-result）：自动返工上限（只拦"她看着结果自己决定改"）
    maxAutoRework: config.subagentWake?.maxAutoRework ?? 2,
    /**
     * ★ 2026-10-19（change: `let-her-query-what-she-made`）：她的页面清单（只读投影）。
     * 数据结构单一来源是宿主上的 `pages.json`；容器看不到 ⇒ 由 runner 每轮
     * `POST /api/host/pages` 推上来，这里读进程内缓存。
     * ★ 2026-10-25：发布能力关闭时**连"看她做过什么"也一起不注册** ——
     *   否则她仍会拿到页面清单并试图"再做一个"。发布关了就不给这条线索。
     */
    ...(publishingEnabled(config) ? { hostPages: () => hostPagesCache.get() } : {}),
    /** ★ 2026-10-19（let-her-query-what-she-made）：服务/宿主健康快照（只读）。 */
    ...(publishingEnabled(config) ? { serverStatus: () => getServerStatusSnapshot() } : {}),
    });

    await core.start();
    core.eventBus.setDefaultScheduler(core.scheduler);

    // ★ 2026-10-25（change: `disable-publishing`）：**开关状态必须说得出来** ——
    //   否则"她怎么不给我发博客了"与"她本来就没做"在日志里同形（这个病本仓栽过多次）。
    if (publishingEnabled(config)) {
      ctx.logger.info(
        `[al:core] 页面/博客发布能力：**开**（projects=${Object.keys(config.projects ?? {}).join(',') || '无'}）`,
      );
    } else {
      ctx.logger.warn(
        '[al:core] 页面/博客发布能力：**已关闭**（features.publish 不为 true）' +
        ' — 委托工具 / 页面清单 / 服务健康工具均未注册；config.projects 与宿主页面保留不动',
      );
    }

    ctx.provide('al:core', core);

    ctx.effect(() => () => core.stop().catch(err => {
      ctx.logger.error('Shutdown:', err);
    }), 'core.stop');
  },
};
