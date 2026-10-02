/**
 * server 模块 —— `al:proactive`
 *
 * 对应 `bootstrap.ts:96-118`：主动消息服务（时段问候 + 节日祝福 + 主动关怀，私聊场景）。
 *
 * ⚠️ **不注册停机 effect**：原实现也没停它（`stop()` 只清 cron + core）。
 *   生命周期统一归 `unify-core-shutdown`（见 `docs/KNOWN-ISSUES.md` KI-6），
 *   本 change 只做结构搬运，不夹带行为变更。
 */

import { DEFAULT_SAMPLING } from '@alysia/core';
import { ProactiveService } from '../proactive.js';
import type { AlysiaCore } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';
import type { PushChannel } from '../push.js';
import type { RuntimeConfig } from './config.js';

export const proactiveModule: Module = {
  name: 'al:proactive',
  inject: ['al:core', 'al:config', 'al:push'],
  apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;
    const core = ctx.get<AlysiaCore>('al:core')!;
    const push = ctx.get<PushChannel>('al:push')!;

    // 原实现的门：`if (qqOff && config.bot.ownerId)`
    // ★ 门不过时**仍提供 `undefined`**：`al:life` 要拿它做 `todayProactive()`，
    //   原代码就是 `proactive?.getTodayActivity() ?? ''`（可能为 null）。
    if (!push.available || !config.bot.ownerId) {
      ctx.provide('al:proactive', undefined);
      return;
    }

    const proactive = new ProactiveService(push, core.memoryManager, {
      ownerOpenid: config.bot.ownerId,
      // ★ 去重状态持久化：重启后当天问候/祝福不重复发
      stateFile: `${config.server.dataDir}/proactive-state.json`,
      // ★ LLM 个性化文案：以昔涟身份生成简短问候（30-60 字），失败回落写死文案
      generateText: async (context: string) => {
        // ★ 8-09：问候也吃最近对话上下文（对话有 40 条注入，主动消息此前没有）
        const dialogue = core.memoryManager.getRecentDialogueBlock(`qq-official-1:private:private_${config.bot.ownerId}`);
        const resp = await core.providerManager.textChatWithFallback({
          prompt: dialogue ? `${context}\n\n${dialogue}` : context,
          sessionId: 'proactive',
          systemPrompt: '你是昔涟，一个温柔贴心的 AI 伴侣。根据要求生成一条简短（30-60字）的个性化问候或祝福，语气温柔自然，只输出消息内容本身，不要解释。',
          // ★ 8-10 采样槽：DEFAULT + config.sampling.proactive.personalize 覆盖
          sampling: { ...DEFAULT_SAMPLING.proactive.personalize, ...(config.sampling?.proactive?.personalize ?? {}) },
        });
        return resp.role === 'assistant' ? resp.completionText : '';
      },
    });
    proactive.start();
    ctx.provide('al:proactive', proactive);
  },
};
