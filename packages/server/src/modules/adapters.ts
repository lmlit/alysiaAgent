/**
 * server 模块 —— `al:adapters`
 *
 * 对应 `bootstrap.ts` 的三段适配器启动（Telegram / QQ OneBot / QQ 官方）。
 *
 * ★ 行文与顺序**逐行对照原实现**——这是活的入口，任何「顺手优化」都是行为变更。
 *   唯一的实质改动：把「往 QQ 主动发消息」抽成 `al:push`（PushChannel）供
 *   life / proactive / reminder 消费，它们不再需要持有整个适配器。
 */

import { TelegramAdapter } from '../adapters/telegram.js';
import { QQOneBotAdapter } from '../adapters/qq-onebot.js';
import { QQOfficialAgentAdapter } from '../adapters/qq-official.js';
import { NO_PUSH_CHANNEL } from '../push.js';
import type { PushChannel } from '../push.js';
import type { AlysiaCore } from '@alysia/core';
import type { VisionBridge } from '@alysia/core/vision';
import type { Module } from '@alysia/core/kernel';
import type { RuntimeConfig } from './config.js';

export const adaptersModule: Module = {
  name: 'al:adapters',
  // 对外真正提供的是推送通道（不是 `al:adapters` 本身）——`provides` 必须照实声明，
  // 否则 `al:push` 的注入方在启动校验阶段就被拒（内核会抓住）
  provides: ['al:push'],
  inject: ['al:core', 'al:config', 'al:vision'],
  async apply(ctx) {
    const { config, isDesktop } = ctx.get<RuntimeConfig>('al:config')!;
    const core = ctx.get<AlysiaCore>('al:core')!;
    const vision = ctx.get<VisionBridge | undefined>('al:vision');

    // ── Telegram ──
    if (!isDesktop && config.telegram?.token) {
      const telegram = new TelegramAdapter(config.telegram, 'telegram-1');
      core.registerPlatform('telegram::private', core.scheduler);
      telegram.setEventBus(core.eventBus);
      await telegram.run();
      ctx.logger.info('Telegram bot started');
    }

    // ── QQ OneBot v11（第三方 NapCat/LLOneBot）──
    if (!isDesktop && config.qq) {
      const qq = new QQOneBotAdapter(config.qq, 'qq-1');
      core.registerPlatform('onebot_v11::private', core.scheduler);
      core.registerPlatform('onebot_v11::group', core.scheduler);
      qq.setEventBus(core.eventBus);
      await qq.run();
      ctx.logger.info(`QQ OneBot WS on port ${config.qq.ws_port}`);
    }

    // ── QQ 官方 Agent（WebSocket 客户端，不需要公网 IP）──
    let qqOff: QQOfficialAgentAdapter | null = null;
    if (!isDesktop && config.qq_official) {
      qqOff = new QQOfficialAgentAdapter(config.qq_official, 'qq-official-1');
      core.registerPlatform('qq-official-1::private', core.scheduler);
      core.registerPlatform('qq-official-1::group', core.scheduler);
      qqOff.setEventBus(core.eventBus);

      // ★ 表情包解析回调：文案标记 [表情包:名字] → 图片路径
      qqOff.setStickerResolver((name) => core.memoryManager.findSticker(name)?.content ?? null);

      // ★ Vision Bridge：用户发图片 → GLM-4V-Flash 描述 → 文本喂给 DeepSeek
      if (vision) qqOff.setVisionBridge(vision);

      await qqOff.run();
    }

    ctx.provide('al:push', qqOff ? wrapQqOfficial(qqOff) : NO_PUSH_CHANNEL);
  },
};

/** 把 QQ 官方适配器收窄成 PushChannel —— 消费方只看得到 sendProactive */
function wrapQqOfficial(qqOff: QQOfficialAgentAdapter): PushChannel {
  return {
    available: true,
    sendProactive: (openid, message) => qqOff.sendProactive(openid, message),
  };
}
