/**
 * `al:watchdog` 模块（★ 2026-10-19，change: `watch-for-stuck-work`，A2 档）。
 *
 * ## 它做什么
 *
 * 每 `intervalSec`（默认 60s）跑一次**只读**判据；发现问题就**让她自己**发一条很短的消息给主人
 * （模型措辞失败 ⇒ 回落机械模板）。
 *
 * ## 为什么不是一个"定时任务"而是模块
 *
 * 它需要三样东西的同一份来源：core（任务库 + 她的措辞能力）、config（阈值/开关）、push（通道）。
 * 三者都是内核服务，装配顺序已由 `inject` 表达（见 `openspec/specs/module-kernel/spec.md`）。
 *
 * ## 边界（比功能重要）
 *
 * - **只读**：不重启、不清任务、不改任何东西。要动手得用户点头（那是 B 档）。
 * - **不刷屏**：同一问题 30 分钟只说一次（冷却按 key），恢复再说一次。
 * - **不编**：没有读数就不报（`runnerBeatSec === null` 只说"从没收到过"，不猜它挂了）。
 */

import type { Module } from '@alysia/core/kernel';
import type { AlysiaCore } from '@alysia/core';
import type { RuntimeConfig } from './config.js';
import type { PushChannel } from '../push.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '@alysia/core';
import { hostPagesCache } from '../host-pages.js';
import {
  DEFAULT_THRESHOLDS,
  WatchdogService,
  type WatchdogInput,
  type WatchdogIssue,
  type WatchdogPersistedState,
} from '../watchdog.js';

/** 通知里最多带几条事实（多了就不像"随口说一句"，也吃 QQ 分段） */
const MAX_FACTS_IN_NOTICE = 3;

const watchdogModule: Module = {
  name: 'al:watchdog',
  inject: ['al:core', 'al:config', 'al:push'],
  apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;
    const core = ctx.get<AlysiaCore>('al:core')!;
    const push = ctx.get<PushChannel>('al:push')!;
    const wd = config.watchdog ?? {};

    // 默认**开**（这是用户明确要的东西）；显式 false 才关
    if (wd.enabled === false) {
      ctx.logger.info('[Watchdog] 已在配置里关闭（watchdog.enabled: false）');
      return;
    }
    if (!push.available) {
      ctx.logger.warn('[Watchdog] ⚠️ 没有推送通道 —— 判据照跑、只记日志，不会打扰任何人');
    }

    const thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...(wd.stuckMinutes !== undefined ? { stuckMinutes: wd.stuckMinutes } : {}),
      ...(wd.queueOldestMinutes !== undefined ? { queueOldestMinutes: wd.queueOldestMinutes } : {}),
      ...(wd.queueDepth !== undefined ? { queueDepth: wd.queueDepth } : {}),
      ...(wd.runnerHoleSec !== undefined ? { runnerHoleSec: wd.runnerHoleSec } : {}),
    };

    /** 机械模板：干，但诚实（**不**假装她处理过） */
    const templateOf = (issues: WatchdogIssue[], recovered: Array<{ key: string; title: string }>): string => {
      if (issues.length === 0 && recovered.length > 0) {
        return `刚才那件事好了：${recovered.map(r => r.title).join('；')}。（这是自动检查发的，不是我做了什么）`;
      }
      const lines = issues.map(i => `· ${i.title}：${i.detail}`);
      return [`我这边看着有点不对（自动检查，不是你要我做的事）：`, ...lines].join('\n');
    };

    const notify = async (
      issues: WatchdogIssue[],
      recovered: Array<{ key: string; title: string }>,
    ): Promise<void> => {
      const facts = issues.slice(0, MAX_FACTS_IN_NOTICE);
      let text: string | null = null;
      if (facts.length > 0) {
        try {
          text = await core.memoryManager.composeWatchdogNotice({
            facts: facts.map(i => ({ key: i.key, level: i.level, title: i.title, detail: i.detail })),
            // 用主人最近的会话语气？这里没有会话上下文，交给提示词里的人设即可
          });
        } catch (err: any) {
          ctx.logger.warn(`[Watchdog] 措辞异常：${err?.message ?? err}`);
        }
      }
      const body = text?.trim() || templateOf(facts, recovered);

      // ★ 先记录（不等推送）：部署后要能无副作用地确认"她说的像不像话"
      ctx.logger.info(
        `[Watchdog] 通知草稿（${issues.length} 新 / ${recovered.length} 恢复，${body.length} 字）：` +
          body.replace(/\n/g, ' ⏎ '),
      );

      if (!push.available) return;
      try {
        const ok = await push.sendProactive(config.bot.ownerId, body, { maxSegments: 1 });
        ctx.logger.info(`[Watchdog] 通知推送${ok ? '成功' : '失败（通道返回 false）'}`);
      } catch (err: any) {
        ctx.logger.warn(`[Watchdog] 通知推送异常：${err?.message ?? err}`);
      }
    };

    /** 取读数（**不调模型**）：库 + 缓存 + 进程自身 */
    const gather = (): WatchdogInput => {
      const mm = core.memoryManager;
      const tasks = mm.listRecentProjectTasks(20);
      const idx = hostPagesCache.get();
      const beat = idx?.receivedAt
        ? Math.round((Date.now() - Date.parse(idx.receivedAt)) / 1000)
        : null;
      return {
        nowMs: Date.now(),
        tasks,
        counts: mm.countProjectTasksByStatus(),
        runnerBeatSec: beat,
        site: idx?.site ?? null,
        uptimeSec: Math.round(process.uptime()),
        bootsLastHour,
      };
    };

    /**
     * 记一次"开机"，返回最近一小时的开机次数（崩溃循环的判据）。
     *
     * 为什么落盘：进程内计数活不过重启，而"崩溃循环"恰恰就是**反复重启** ——
     * 只有把每次开机写下才能看出这个形状。失败就退回 1（宁可漏报，不要误报）。
     */
    const registerBoot = (): number => {
      const file = `${config.server.dataDir}/watchdog-boots.json`;
      const cutoff = Date.now() - 60 * 60 * 1000;
      let boots: number[] = [];
      try {
        const raw = readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) boots = parsed.filter((n): n is number => typeof n === 'number');
      } catch {
        boots = []; // 第一次跑 / 文件坏了：从空开始
      }
      boots = boots.filter(t => t >= cutoff);
      boots.push(Date.now());
      try {
        writeFileSync(file, JSON.stringify(boots), 'utf8');
      } catch (err: any) {
        ctx.logger.warn(`[Watchdog] 开机记录写不进 ${file}：${err?.message ?? err}（崩溃循环判据会退化）`);
      }
      return boots.length;
    };
    const bootsLastHour = registerBoot();

    /** 看门狗状态：跨重启保持"说过什么"，否则每次部署都会把同一件事重发一遍（真机踩过） */
    const stateFile = `${config.server.dataDir}/watchdog-state.json`;
    const loadState = (): WatchdogPersistedState | null => {
      try {
        return JSON.parse(readFileSync(stateFile, 'utf8')) as WatchdogPersistedState;
      } catch {
        return null;
      }
    };
    const saveState = (state: WatchdogPersistedState): void => {
      try {
        writeFileSync(stateFile, JSON.stringify(state), 'utf8');
      } catch (err: any) {
        ctx.logger.warn(`[Watchdog] 状态写不进 ${stateFile}：${err?.message ?? err}（重启后会重复通知）`);
      }
    };

    const service = new WatchdogService({
      intervalSec: wd.intervalSec ?? 60,
      cooldownMs: (wd.cooldownMinutes ?? 30) * 60000,
      thresholds,
      gather,
      notify,
      loadState,
      saveState,
      failedCooldownMs: (wd.failedCooldownHours ?? 6) * 60 * 60 * 1000,
      log: (m: string) => logger.info(m),
    });
    ctx.effect(() => {
      service.start();
      return () => service.stop();
    });
  },
};

export { watchdogModule };
