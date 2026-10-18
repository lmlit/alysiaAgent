/**
 * server 模块 —— `al:self-activity`
 *
 * ★ 2026-10-18（change: `let-her-start-her-own-projects`）：让她在闲置时**自己**发起
 * 一件小事（做个小页面）。用户原话：
 *   「让她的生活/主动事件系统也能发起"做网站"（比如她自己在 idle 时决定做个小页面）」
 *
 * 为什么单独成一个模块而不是塞进 `al:proactive`：
 *   - `al:proactive` 是"往用户那边发消息"，本模块是"往她自己的工作区里派活"，
 *     方向和风险都不同；
 *   - 它需要 `al:config` 里的项目表与执行窗口，塞进 proactive 会让那个模块多背一份状态。
 *
 * ⚠️ **默认关闭**（`selfActivity.enabled`）：这是"她自己花钱干活"，必须显式打开。
 */
import { SelfActivityService } from '../self-activity.js';
import type { AlysiaCore } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';
import type { RuntimeConfig } from './config.js';

export const selfActivityModule: Module = {
  name: 'al:self-activity',
  /**
   * ⚠️ 必须**声明**它：下面会 `ctx.provide('al:self-activity', service)`。
   * 写成 `provides: false` 会被 kernel 拒绝（"试图 provide 未声明的服务"），
   * 而那是 **apply 失败 ⇒ 整个 Alysia 起不来 ⇒ 容器崩溃重启**。
   * （这不是假设：2026-10-18 真机就是这么崩的，7 次重启。）
   */
  provides: ['al:self-activity'],
  inject: ['al:core', 'al:config'],
  apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;
    const core = ctx.get<AlysiaCore>('al:core')!;
    const cfg = config.selfActivity;

    if (!cfg?.enabled) {
      ctx.logger.info('[SelfActivity] 未配置或未开启 —— 跳过（这是默认值）');
      return;
    }
    if (!config.bot.ownerId) {
      // 没有 owner 会话 ⇒ 结果无处可回，她也得不到反馈
      ctx.logger.warn('[SelfActivity] 没有 bot.ownerId —— 不开（结果无处可回）');
      return;
    }

    const service = new SelfActivityService(core, {
      enabled: true,
      projectId: cfg.projectId,
      projectIds: Object.keys(config.projects ?? {}),
      dailyCap: cfg.dailyCap ?? 1,
      minIdleHours: cfg.minIdleHours ?? 6,
      minGapHours: cfg.minGapHours ?? 24,
      allowPublish: cfg.allowPublish ?? false,
      intervalMinutes: cfg.intervalMinutes ?? 30,
      taskWindow: config.projectTasks,
      // 结果回送到用户私聊会话：她做完会自己告诉用户
      ownerSessionId: `qq-official-1:private:private_${config.bot.ownerId}`,
    });
    service.start();
    ctx.effect(() => () => service.stop());
    ctx.provide('al:self-activity', service);
  },
};
