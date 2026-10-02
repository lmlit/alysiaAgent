/**
 * server 模块 —— `al:vision`
 *
 * 对应 `bootstrap.ts` 里构造 `VisionBridge` 那一段（用户发图片 → GLM-4V-Flash 描述）。
 *
 * ★ 无 `embed.apiKey` 时**提供 undefined** 而不是中止——这是原实现的语义
 *   （`if (config.embed?.apiKey) { ... }`，不满足就整段跳过）。
 *   消费方（`al:adapters`）据此决定要不要接线。
 */

import { DEFAULT_SAMPLING } from '@alysia/core';
import { VisionBridge } from '@alysia/core/vision';
import type { Module } from '@alysia/core/kernel';
import type { RuntimeConfig } from './config.js';

export const visionModule: Module = {
  name: 'al:vision',
  critical: false,
  inject: ['al:config'],
  apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;
    if (!config.embed?.apiKey) {
      // 原语义：没有 vision 能力就整段跳过，不是错误
      ctx.provide('al:vision', undefined);
      return;
    }
    ctx.provide('al:vision', new VisionBridge({
      baseUrl: config.embed.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: config.embed.apiKey,
      // ★ 8-10 采样槽：DEFAULT(0.1/200) + config.sampling.vision.describe 覆盖
      sampling: { ...DEFAULT_SAMPLING.vision.describe, ...(config.sampling?.vision?.describe ?? {}) },
    }));
  },
};
