/**
 * server 模块 —— `al:cron`
 *
 * 对应 `bootstrap.ts:253-267`：每 6 小时跑一次记忆压缩
 * （`memoryManager.cron()` + `archiveStaleSessions()`）。
 *
 * ★ 与原实现等价：原 `shutdown()` 里 `clearInterval(cronInterval)`，
 *   这里改成 `ctx.effect` —— 宿主 stop 时清理，路径不同、结果相同。
 */

import type { AlysiaCore } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';

const SIX_HOURS_MS = 6 * 3600_000;

export const cronModule: Module = {
  name: 'al:cron',
  provides: false,
  inject: ['al:core'],
  apply(ctx) {
    const core = ctx.get<AlysiaCore>('al:core')!;

    // ★ 8-08 优化：in-flight 锁——cron() 含 LLM 深度画像重写，单次执行超 6h 时防重叠重入
    let cronRunning = false;
    const timer = setInterval(() => {
      // Guard against running on a stopped core
      if (!core.eventBus || cronRunning) return;
      cronRunning = true;
      Promise.all([
        core.memoryManager.cron(),
        // ★ 8-09 定期归档活跃会话（修"短对话永不归档"的空洞）
        core.memoryManager.archiveStaleSessions(),
      ])
        .catch(err => ctx.logger.error('Cron:', err))
        .finally(() => { cronRunning = false; });
    }, SIX_HOURS_MS);

    ctx.effect(() => () => clearInterval(timer), 'cron.clearInterval');
  },
};
