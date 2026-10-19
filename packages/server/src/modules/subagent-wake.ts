/**
 * server 模块 —— `al:subagent-wake`
 *
 * ★ 2026-10-19（change: `wake-her-on-task-result`）：把「后台结果」变成「她下一轮要处理的事」。
 *
 * 装配很薄（规则都在 `subagent-dispatch.ts` 与 core 的 outbox 里）：
 *   读配置 → 建调度器 → 起定时器 → 停机时清掉。
 *
 * ⚠️ 三条边界：
 *   1. **关掉不影响任何别的东西**（`enabled:false` ⇒ 结果只落库；回退通知路径由 webui 模块判断）；
 *   2. **不持有自己的执行框架** —— 它只调 `core.scheduler`，与用户消息走同一条管线；
 *   3. **不向用户直发** —— 走 `al:push`（与生活/提醒同一个通道），这样"谁能发消息"只有一处。
 */

import { logger } from '@alysia/core';
import type { AlysiaCore } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';
import type { RuntimeConfig } from './config.js';
import { SubagentWake, type WakePushChannel } from '../subagent-dispatch.js';

export const subagentWakeModule: Module = {
  name: 'al:subagent-wake',
  // ⚠️ `provides` 必须声明（漏了不是"模块挂了"，是**整个服务起不来**；本项目踩过）。
  //   形状是 string[]（`false` 表示不提供任何令牌；见 Module 契约）。
  provides: ['al:subagent-wake'],
  inject: ['al:core', 'al:config', 'al:push'],
  apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;
    const core = ctx.get<AlysiaCore>('al:core')!;
    const push = ctx.get<WakePushChannel>('al:push');

    const cfg = config.subagentWake ?? {};
    const enabled = cfg.enabled !== false;

    // ★ 验收开关落在 MemoryManager 上（工具是 core 的，配置是 server 的，
    //   唯一能同时看到两边的地方是这里）
    core.memoryManager.setAcceptEnabled(cfg.autoAccept !== false);

    const wake = new SubagentWake(
      { core, push, log: logger },
      {
        enabled,
        intervalMs: cfg.intervalMs ?? 5000,
        turnTimeoutMs: cfg.turnTimeoutMs ?? 180_000,
      },
    );
    wake.start();

    if (enabled) {
      const counts = core.memoryManager.countProjectTaskEventsByStatus();
      logger.info(
        `[subagent-wake] 结果事件队列现状：${JSON.stringify(counts)}` +
          '（重启后仍在库里的会继续投递）',
      );
    }

    ctx.provide('al:subagent-wake', wake);
    ctx.effect(() => () => wake.stop(), 'subagent-wake.stop');
  },
};
