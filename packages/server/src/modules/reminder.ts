/**
 * server 模块 —— `al:reminder`
 *
 * 对应 `bootstrap.ts:212-251`：提醒主动推送（到点用 QQ 主动消息发给设置者）。
 *
 * ★★ **它依赖一个隐性行为**：`core` 的 `al:tools` 已经注册过
 *    `set_reminder` / `list_reminders` / `cancel_reminder`（no-op persist），
 *    本模块用**同名覆盖**把它们换成真实持久化 + 真实推送的版本。
 *    `ToolRegistry` 是 `Map` 同名覆盖，所以**顺序必须是 core 先、本模块后**——
 *    `inject: ['al:core']` 保证了这一点。
 *    （见 `openspec/specs/module-kernel/spec.md` §5 的验收基线）
 */

import {
  createReminderTool,
  createListRemindersTool,
  createCancelReminderTool,
  restoreReminders,
} from '@alysia/core/tools';
import type { AlysiaCore } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';
import type { PushChannel } from '../push.js';

const REMINDER_PUSH_PROMPT = '用户之前设了提醒："${TEXT}"。现在时间到了，请用昔涟的语气（温柔、自然、30-60字）提醒用户。只输出提醒文案本身，不要解释。';
const REMINDER_PUSH_SYSTEM = '你是昔涟，一个温柔贴心的 AI 伴侣。用自然的口语提醒用户，可以加一两个 emoji，语气轻松亲切。';

export const reminderModule: Module = {
  name: 'al:reminder',
  provides: false,
  inject: ['al:core', 'al:push'],
  apply(ctx) {
    const core = ctx.get<AlysiaCore>('al:core')!;
    const push = ctx.get<PushChannel>('al:push')!;

    // 原实现的门：`if (qqOff)`
    if (!push.available) return;

    // ★ 过 LLM 用昔涟语气生成自然提醒文案，失败回落原始文本
    const notifyFn = async (text: string, sessionId?: string): Promise<boolean> => {
      if (!sessionId) {
        ctx.logger.info(`Reminder (no session): ${text}`);
        return true;
      }
      const m = sessionId.match(/:private:private_(.+)$/);
      if (!m) {
        ctx.logger.info(`Reminder (non-private): ${text}`);
        return true;
      }

      let message = `⏰ ${text}`;
      try {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: REMINDER_PUSH_PROMPT.replace('${TEXT}', text),
          sessionId: 'reminder-push',
          systemPrompt: REMINDER_PUSH_SYSTEM,
        });
        if (resp.role === 'assistant' && resp.completionText) {
          message = resp.completionText.trim();
        }
      } catch { /* LLM 失败用原始文案 */ }

      const ok = await push.sendProactive(m[1], message);
      ctx.logger.info(`Reminder push → ${m[1].slice(0, 8)}...: ${ok ? 'sent' : 'failed'}`);
      return ok;
    };

    // ★ 8-12 持久化（reminder-sqlite-persistence）：save/remove → MemoryManager（SQLite reminders 表）
    const persist = {
      save: (id: string, r: { text: string; triggerAt: Date; sessionId?: string; retryCount?: number }) =>
        core.memoryManager.saveReminder(id, r),
      remove: (id: string) => core.memoryManager.removeReminder(id),
    };

    core.toolRegistry.register(createReminderTool(notifyFn, persist));
    core.toolRegistry.register(createListRemindersTool());
    core.toolRegistry.register(createCancelReminderTool(persist));

    // ★ 8-12 启动恢复：容器重启后未触发的提醒重新调度（过期立即补发）
    restoreReminders(notifyFn, persist, core.memoryManager.listPendingReminders());
  },
};
