/**
 * server 启动入口 —— **只做装配**。
 *
 * ★ 2026-10-01（change: modularize-server-assembly，P3）：
 *   原先这里是一份 ~330 行的总装脚本（配置 → core → 三个 IM 适配器 → vision →
 *   proactive → life（含 6 段巨型 systemPrompt）→ reminder → cron → webui → 信号处理）。
 *   现在每一步都搬进了 `src/modules/` 的模块，本文件只剩「建宿主 + 注册模块 + 跑」。
 *
 *   行为不变：所有模块都是**逐行搬运**，含条件门（`IS_DESKTOP` / `qqOff` / `ownerId`）
 *   与日志措辞。验证方式是真启动服务并 curl `/api/*`（见 change 的 tasks.md）。
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@alysia/core';
import { ModuleHost } from '@alysia/core/kernel';
import {
  configModule,
  loggingModule,
  coreModule,
  visionModule,
  adaptersModule,
  proactiveModule,
  lifeModule,
  reminderModule,
  cronModule,
  webuiModule,
} from './modules/index.js';
import type { RuntimeConfig } from './modules/index.js';

/**
 * 新前端（Next.js console）静态产物的候选路径。
 *
 * ⚠️ **必须在本文件算**：`import.meta.url` 在 dev 是 `src/bootstrap.ts`、
 *   prod 是 `dist/bootstrap.js`，上溯两级都到 `packages/`，才能定位 `console/out`。
 *   挪进 `src/modules/` 会多一层上溯 → 指向不存在的 `packages/server/console/out`
 *   → `existsSync` 为 false → **静态路由静默不注册**、SPA 白屏且无报错。
 *   （同类坑见 `docs/dsh-migration-guide.md` 坑 #2。）
 */
const serverDir = dirname(fileURLToPath(import.meta.url));
const consoleDist = resolve(serverDir, '../../console/out');

async function main(): Promise<void> {
  const host = new ModuleHost()
    .use(configModule)
    .use(loggingModule)
    .use(coreModule)
    .use(visionModule)
    .use(adaptersModule)
    .use(proactiveModule)
    .use(lifeModule)
    .use(reminderModule)
    .use(cronModule)
    // 只传候选路径；「用不用」由 webui 模块判（那里才知道 isDesktop）
    .use(webuiModule, { consoleDist });

  await host.start();

  // Graceful shutdown —— 宿主逆序卸载。
  // 顺序与原实现等价：cron 的 setInterval 先清，`core.stop()`（al:core 的 effect）后停。
  const shutdown = (): void => {
    host.stop().catch(err => logger.error('Shutdown:', err));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const { config } = host.get<RuntimeConfig>('al:config')!;
  logger.info(`Server started on port ${config.server.port}`);
}

main().catch((err) => {
  logger.error('Failed to start Alysia:', err);
  process.exit(1);
});
