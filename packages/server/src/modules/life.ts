/**
 * server 模块 —— `al:life`
 *
 * AI 主动生活系统（每小时生成生活事件，可主动推送）。
 * 原在 `bootstrap.ts:120-210`，P3 搬来此处。
 *
 * ★ 五段 systemPrompt 已外置到 `../prompts/life.ts`（P4）——
 *   它们曾是 2000+ 字的内联字符串，混在接线里。内容**逐字未改**。
 *
 * ⚠️ 不注册停机 effect：原实现也没停 LifeService（见 `proactive.ts` 同款说明）。
 */

import { DEFAULT_SAMPLING, logger } from '@alysia/core';
import { LifeService } from '../life.js';
// ★ 提示词资产在 ../prompts/life.ts（从本文件搬出，内容逐字未改）
import {
  LIFE_EVENT_PROMPT,
  LIFE_SUMMARY_PROMPT,
  LIFE_INTENT_PROMPT,
  LIFE_MOOD_NOTE_PROMPT,
  LIFE_REFLECTION_PROMPT,
} from '../prompts/life.js';
import type { ProactiveService } from '../proactive.js';
import type { AlysiaCore } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';
import type { PushChannel } from '../push.js';
import type { RuntimeConfig } from './config.js';

// ── 模块 ──────────────────────────────────────────────────────

export const lifeModule: Module = {
  name: 'al:life',
  provides: false,
  inject: ['al:core', 'al:config', 'al:push', 'al:proactive'],
  apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;
    const core = ctx.get<AlysiaCore>('al:core')!;
    const push = ctx.get<PushChannel>('al:push')!;
    const proactive = ctx.get<ProactiveService | undefined>('al:proactive');

    // 原实现的门：`if (qqOff && config.bot.ownerId)`
    if (!push.available || !config.bot.ownerId) return;

    /** 最近对话上下文（事件生成 / 问候都吃它）—— 原实现里这段在两个回调里各写了一遍 */
    const dialogueBlock = (): string =>
      core.memoryManager.getRecentDialogueBlock(`qq-official-1:private:private_${config.bot.ownerId}`);

    const life = new LifeService(core.memoryManager, push, {
      ownerOpenid: config.bot.ownerId,
      // ★ 8-09 事件驱动调度：概率门已移除（life.ts 内部不再消费 probability）；
      //   chat 推送冷却 1h；★ 8-30 每日 chat 软上限 5 → 20（life-schedule-renewal：
      //   实测问候 3 条/天零错误码,QQ 配额无忧;打扰由 1h 冷却 + 20 上限 + 时段保底控制）
      cooldownHours: 1,
      maxChatPushesPerDay: 20,
      chatLockMinutes: 30,
      stateFile: `${config.server.dataDir}/life-state.json`,

      // ★ LLM 事件生成：woke 模式，昔涟身份
      // ★ 8-09：responseFormat: 'json' 强制 json_object 模式（DeepSeek 层面保证输出合法
      //   JSON，根治 8-09 07:16 裸文本问题；life.ts 仍保留 fence 剥离 + 裸文本容错双保险）
      generateEvent: async (context: string) => {
        // ★ 8-09：事件生成也吃最近对话上下文（贴合最近聊了什么）
        const dialogue = dialogueBlock();
        const started = Date.now();
        const resp = await core.providerManager.textChatWithFallback({
          prompt: dialogue ? `${context}\n\n${dialogue}` : context,
          sessionId: 'life-event',
          systemPrompt: LIFE_EVENT_PROMPT,
          responseFormat: 'json',
          // ★ 8-10 采样槽：DEFAULT(0.9 偏高/活) + config.sampling.life.generateEvent 覆盖
          sampling: { ...DEFAULT_SAMPLING.life.generateEvent, ...(config.sampling?.life?.generateEvent ?? {}) },
        });

        // ★ 2026-10-02（add-llm-budget-observability）
        //   ① role==='err' 以前直接 `return ''` —— 网络故障/超时/HTTP 报错被压成空串，
        //      上层只看到 "empty response"，**把排查方向指向"模型没输出"**。不再静默吞错。
        if (resp.role !== 'assistant') {
          logger.warn(
            `[Life] event LLM call failed (${Date.now() - started}ms): ${resp.completionText || '(无错误文本)'}` +
            ' → 会走模板回落，但根因是调用失败，不是模型没输出'
          );
          return '';
        }

        //   ② 每次调用留下一行预算现场：finish=length + content=0字 ⇒ 预算被推理吃光（KI-1 判据）
        const u = resp.usage;
        const text = resp.completionText ?? '';
        logger.info(
          `[Life] event LLM: finish=${resp.finishReason ?? '?'}` +
          ` tokens=${u ? `${u.input}+${u.output}` : '?'} reasoning=${u?.reasoningTokens ?? '?'}` +
          ` content=${text.length}字 (${Date.now() - started}ms)`
        );
        return text;
      },

      // ★ LLM 每日摘要：独立纯文本回调（不复用 generateEvent——其 systemPrompt 强制 JSON，
      //   复用会把摘要存成 JSON 文本污染摘要层）
      generateSummary: async (context: string) => {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: context,
          sessionId: 'life-summary',
          systemPrompt: LIFE_SUMMARY_PROMPT,
          // ★ 8-10 采样槽：DEFAULT(0.3 低温/忠) + config.sampling.life.generateSummary 覆盖
          sampling: { ...DEFAULT_SAMPLING.life.generateSummary, ...(config.sampling?.life?.generateSummary ?? {}) },
        });
        return resp.role === 'assistant' ? resp.completionText : '';
      },

      // ★ 8-28 承诺裁决（promise-obligation-loop）：到期三选一——兑现 / 延期（说明+重排）/ 取消（歉意说明）
      generateIntentMessage: async (context: string) => {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: context,
          sessionId: 'life-intent',
          systemPrompt: LIFE_INTENT_PROMPT,
          responseFormat: 'json',
          // 低温/忠
          sampling: { ...DEFAULT_SAMPLING.life.generateSummary },
        });
        return resp.role === 'assistant' ? resp.completionText.trim() : '';
      },

      // ★ 8-29 情绪侧端分析（mood-side-analysis）：深度阈值后生成描述性氛围（"这段日子…"）
      generateMoodNote: async (context: string) => {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: context,
          sessionId: 'life-mood-note',
          systemPrompt: LIFE_MOOD_NOTE_PROMPT,
          // 低温/忠
          sampling: { ...DEFAULT_SAMPLING.life.generateSummary },
        });
        return resp.role === 'assistant' ? resp.completionText.trim() : '';
      },

      // ★ 8-31 每日反思（life-reflection-loop）：她复盘自己的一天——L3 自修改执行器
      generateReflection: async (context: string) => {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: context,
          sessionId: 'life-reflection',
          systemPrompt: LIFE_REFLECTION_PROMPT,
          responseFormat: 'json',
          // 低温/忠（反思要真实,不要高采样率的发挥）
          sampling: { ...DEFAULT_SAMPLING.life.generateSummary },
        });
        return resp.role === 'assistant' ? resp.completionText.trim() : '';
      },

      // ★ 感知今天已发的问候/节日（ProactiveService），事件生成避免重复打扰
      todayProactive: () => proactive?.getTodayActivity() ?? '',
      // ★ 8-29 今天是什么日子（节日/节气 → 事件生成自然带氛围,不再独立打卡）
      todaySpecial: () => proactive?.todaySpecial() ?? '',
    });
    life.start();
  },
};
