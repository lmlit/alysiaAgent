/**
 * 她自己发起「做点小东西」——**服务**（定时考虑一次）。
 *
 * ★ 2026-10-18（change: `let-her-start-her-own-projects`）。用户要求：
 *   「让她的生活/主动事件系统也能发起"做网站"（比如她自己在 idle 时决定做个小页面）」
 *
 * 这个服务只做三件事：**收集现状 → 让纯函数判 → 判过了就建任务**。
 * 所有规则都在 `decideSelfActivity()` 里（可单测）；这里不夹带判断。
 *
 * ⚠️ 三条硬边界（不能靠"她自觉"）：
 *   1. **高峰时段一律不做**（钱按执行时间算）
 *   2. **默认不发布**（她可以决定做什么；上线留给对话里的人）
 *   3. **有在途任务/今日已做过/间隔不够 → 不做**（不许堆叠、不许天天自己发）
 */
import { logger } from '@alysia/core';
import {
  computeTaskWindow,
  decideSelfActivity,
  selfActivityRequestKey,
  selfActivityAcceptanceCriteria,
} from '@alysia/core/memory';
import type { AlysiaCore } from '@alysia/core';

export interface SelfActivityOptions {
  enabled: boolean;
  /** 在哪个项目里做（留空 = 用 `projectIds` 的最后一个，即新登记的那个） */
  projectId?: string;
  /** 登记过的项目（由 config 提供；空 = 不发） */
  projectIds: string[];
  /** 每天最多自发起几次 */
  dailyCap: number;
  /** 用户安静多久后才考虑 */
  minIdleHours: number;
  /** 两次自发起之间至少隔多久 */
  minGapHours: number;
  /** 允许它在任务里自己发布（默认 **false**） */
  allowPublish: boolean;
  /** 考虑间隔（分钟） */
  intervalMinutes: number;
  /** 执行窗口配置（与认领闸门同一份，保证判定一致） */
  taskWindow?: { holidays?: string[]; peakWindows?: Array<[number, number]> };
  /** 用户会话 id（收结果的会话 + 判断"多久没说话"） */
  ownerSessionId: string;
  /** 【排障用】把"现在"固定在某时刻，验证用（生产别配） */
  nowOverride?: () => Date;
}

export class SelfActivityService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 上一次打的判定摘要 —— 同样的结论不重复刷日志 */
  private lastDecisionLine = '';

  constructor(
    private core: AlysiaCore,
    private opts: SelfActivityOptions,
  ) {}

  start(): void {
    if (!this.opts.enabled) {
      logger.info('[SelfActivity] 未开启（selfActivity.enabled=false）—— 她不会自己找活干');
      return;
    }
    if (!this.opts.ownerSessionId) {
      logger.warn('[SelfActivity] 没有 ownerSessionId —— 不发起了（否则结果无处可回）');
      return;
    }
    // ★ 必须指明"在哪个项目里做"：她自己在哪个工作区里写文件，不能由代码去猜
    if (!this.opts.projectId?.trim()) {
      logger.warn(
        '[SelfActivity] 没有配置 projectId —— **不发起**。' +
          '她自己在哪个工作区里写文件必须显式指定（别猜，猜错就会写进正式项目）。',
      );
      return;
    }
    const ms = Math.max(5, this.opts.intervalMinutes) * 60_000;
    // 启动后先等一个间隔再考虑，避免"一重启就发任务"
    this.timer = setInterval(() => {
      void this.consider().catch((err) =>
        logger.warn(`[SelfActivity] consider 异常：${err?.message ?? err}`),
      );
    }, ms);
    logger.info(
      `[SelfActivity] 已启动：每 ${this.opts.intervalMinutes} 分钟考虑一次（project=${this.opts.projectId ?? '(自动)'}，` +
        `日上限 ${this.opts.dailyCap}，闲置≥${this.opts.minIdleHours}h，间隔≥${this.opts.minGapHours}h，` +
        `allowPublish=${this.opts.allowPublish}）`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 考虑一次（也被测试/排障直接调用） */
  async consider(): Promise<{ created: boolean; decision: string }> {
    const now = this.opts.nowOverride?.() ?? new Date();
    const win = computeTaskWindow({ ...(this.opts.taskWindow ?? {}), now });
    const mm = this.core.memoryManager;
    const stats = mm.projectTaskStats('self');

    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const todayCount = mm.countProjectTasksSince('self', dayStart.toISOString());

    const hoursSince = (iso: string | null): number | null =>
      iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : null;

    // 用户上次说话：`getRecentMessages` 返回最近的（含她自己的），取最后一条 user
    let lastUserAt: string | null = null;
    try {
      const recent = mm.getRecentMessages(this.opts.ownerSessionId, 30);
      for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i].role === 'user' && recent[i].createdAt) {
          lastUserAt = recent[i].createdAt!;
          break;
        }
      }
    } catch {
      /* 读不到就当"没聊过" */
    }

    const decision = decideSelfActivity({
      enabled: this.opts.enabled,
      offPeak: win.offPeak,
      hasActiveTask: stats.hasActive,
      selfTasksToday: todayCount,
      dailyCap: this.opts.dailyCap,
      hoursSinceLastSelfTask: hoursSince(stats.latestAt),
      hoursSinceLastUserMessage: hoursSince(lastUserAt),
      minIdleHours: this.opts.minIdleHours,
      minGapHours: this.opts.minGapHours,
    });

    const line = `${decision.proceed ? '✅' : '⏭'} ${decision.reason ?? 'proceed'}：${decision.detail}`;
    if (line !== this.lastDecisionLine) {
      logger.info(`[SelfActivity] ${line}`);
      this.lastDecisionLine = line;
    }
    if (!decision.proceed) return { created: false, decision: line };

    const projectId = this.resolveProjectId();
    if (!projectId) {
      logger.warn('[SelfActivity] 没有可用项目 —— 不发起了');
      return { created: false, decision: 'no-project' };
    }

    // 让她自己说想做什么（失败就**放弃这次**，不瞎凑需求）
    const idea = await mm.composeSelfActivityIdea({ projectId });
    if (!idea) {
      logger.warn('[SelfActivity] 她说不出想做什么（LLM 失败）—— 这次算了');
      return { created: false, decision: 'no-idea' };
    }

    const out = mm.createProjectTask({
      projectId,
      // 同一天同一项目只发起一次：定时器抖了/重启了也不会重复
      requestKey: selfActivityRequestKey(this.localDateKey(now), projectId),
      goal: idea,
      acceptanceCriteria: selfActivityAcceptanceCriteria({ allowPublish: this.opts.allowPublish }),
      originSessionId: this.opts.ownerSessionId,
      origin: 'self',
    });

    if (out.kind === 'busy') {
      logger.info(`[SelfActivity] 项目正忙，这次不发（${out.task.taskId}）`);
      return { created: false, decision: 'busy' };
    }
    if (out.kind === 'deduped') {
      logger.info(`[SelfActivity] 今天已经发起过（${out.task.taskId}）—— 正常，不是错误`);
      return { created: false, decision: 'deduped' };
    }

    logger.info(
      `[SelfActivity] ★ 她自己发起了一个小东西：${out.task.taskId}（项目 ${projectId}）\n  想做：${idea}`,
    );
    return { created: true, decision: 'created' };
  }

  /**
   * 项目选择：**只认配置里写明的那个**，不猜。
   *
   * ⚠️ 真机教训（2026-10-18）：先前"留空 = 用登记列表最后一个"，
   * 结果她落到了 `alysia-blog`（精心做的「关于我」页）而不是练手项目 ——
   * **一个测试触发的任务去改正式页面，这个险不该冒**。
   * ⇒ 现在留空就**不发**（并在模块启动时警告）。
   */
  private resolveProjectId(): string | null {
    return this.opts.projectId?.trim() || null;
  }

  private localDateKey(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
}
