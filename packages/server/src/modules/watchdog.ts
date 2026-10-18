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
 * 它需要两样东西：core（任务库）、config（阈值/开关）。**不需要 push** —— 它不推送。
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
import { readFileSync, writeFileSync } from 'node:fs';
import { logger, setSelfNotices } from '@alysia/core';
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
  // ⚠️ 不再 inject 'al:push'：看门狗**不推送**（发现交给她，由她决定说不说）
  inject: ['al:core', 'al:config'],
  apply(ctx) {
    const { config } = ctx.get<RuntimeConfig>('al:config')!;
    const core = ctx.get<AlysiaCore>('al:core')!;
    const wd = config.watchdog ?? {};

    // 默认**开**（这是用户明确要的东西）；显式 false 才关
    if (wd.enabled === false) {
      ctx.logger.info('[Watchdog] 已在配置里关闭（watchdog.enabled: false）');
      return;
    }

    const thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...(wd.stuckMinutes !== undefined ? { stuckMinutes: wd.stuckMinutes } : {}),
      ...(wd.queueOldestMinutes !== undefined ? { queueOldestMinutes: wd.queueOldestMinutes } : {}),
      ...(wd.queueDepth !== undefined ? { queueDepth: wd.queueDepth } : {}),
      ...(wd.runnerHoleSec !== undefined ? { runnerHoleSec: wd.runnerHoleSec } : {}),
    };

    /**
     * ★ 2026-10-19（用户当场纠正方向）：**不推送**，而是"交给她"。
     *
     * 用户原话：「这个不是推送给我的，是告诉昔涟让她自行决策或者来找我商量的吧，
     * 不要太多专业名词和上面数字，很奇怪啊」。
     *
     * ⇒ 把发现写进她的上下文（`setSelfNotices`），下一轮她就会在
     * `[你刚注意到的事]` 里看到；她可以自己处理（手上有工具），也可以用自己的话来问人。
     * 我们**不发**任何消息 —— 说不说、什么时候说、怎么说，是她的决定。
     *
     * 恢复也一样：问题没了，清单里自然就没有了，不需要"报个平安"。
     */
    let lastSignature = '';
    const notify = async (
      issues: WatchdogIssue[],
      _recovered: Array<{ key: string; title: string }>,
    ): Promise<void> => {
      // ★ 同类合并：三件"没做完就断了"不该念三遍（她会觉得像报错清单）。
      //   同 key 前缀（`failed:` / `stuck:` …）只留一条，其余的在日志里逐条留痕。
      const byKind = new Map<string, WatchdogIssue>();
      for (const i of issues) {
        const kind = i.key.split(':')[0] ?? i.key;
        if (!byKind.has(kind)) byKind.set(kind, i);
      }
      const facts = [...byKind.values()].slice(0, MAX_FACTS_IN_NOTICE);

      // 只登记"她该知道的"，不带 id / 分钟 / 状态码
      setSelfNotices(facts.map(i => ({ key: i.key, text: i.plain })));

      // ★ 只在"清单变了"时记一行：清单是**当前状态**，不是消息 ——
      //   每轮都打就是日志噪声（而"她看到没有"由 PromptAssembler 的 `[Prompt] 她这一轮看到了 N 条` 证明）。
      const signature = facts.map(i => i.key).join('|');
      if (signature !== lastSignature) {
        lastSignature = signature;
        ctx.logger.info(
          `[Watchdog] 交给她的（${facts.length} 条，合并前 ${issues.length} 条）：` +
            (facts.length === 0 ? '（已清空，问题都不在了）' : facts.map(i => i.plain).join(' | ')),
        );
        for (const i of issues) ctx.logger.debug(`[Watchdog] 事实（排障用）：${i.title} · ${i.detail}`);
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
