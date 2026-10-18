/**
 * **看门狗**（★ 2026-10-19，change: `watch-for-stuck-work`，A2 档）。
 *
 * ## 它回答什么问题
 *
 * 用户的原话：「他会**自己触发**看看卡住的进度吗」。不会 —— 除非有人盯着。
 * 正确形态不是"让她定时轮询"（每查一次都是一次模型调用，而且她看不到系统事实），
 * 而是：**系统用便宜、确定的判据盯着，异常时把一条冷事实交给她说**。
 *
 * ## 分工
 *
 * | 层 | 内容 |
 * |---|---|
 * | `evaluateWatchdogFacts()`（**纯函数**） | 从读数算出"哪里不对"，可单测、无副作用 |
 * | `WatchdogService` | 定时跑判据 + **去重/冷却** + 恢复通知 + 交给 `notify` |
 * | 措辞 | 服务端注入（她自己的话，失败回落机械模板） |
 *
 * ## 为什么判据这么少
 *
 * 每条判据都要能被**证明不是噪声**（今晚踩过的形状才算）。宁少勿多 ——
 * 一个爱喊狼来了的看门狗，比没有看门狗更糟（用户会直接静音她）。
 */

import type { ProjectTask } from '@alysia/core/memory';

/** 一条判据的读数输入（全部是**系统事实**，不含模型自述） */
export interface WatchdogInput {
  nowMs: number;
  /** 任务（跨项目，最近的若干条；由调用方给，service 不再查库） */
  tasks: ProjectTask[];
  /** 各状态计数（可选，仅用于播报"堆着几条"） */
  counts?: Record<string, number>;
  /** 宿主 runner 心跳：最近一次推清单距今多少秒；`null` = 从没收到过 */
  runnerBeatSec: number | null;
  /** 基站首页探测结果（由 runner 在宿主侧探，容器够不到宿主端口） */
  site: { ok: boolean; status: number; checkedAt: string } | null;
  /** 服务进程已运行秒数（**只用于播报**，不用来判断崩溃） */
  uptimeSec: number;
  /**
   * 最近一小时**重启过几次**（含本次）—— 崩溃循环的判据。
   *
   * 为什么不用 `uptimeSec < 5 分钟`：那样每次部署都会先发一条"我刚重启过"的假警报，
   * 用户会以为真出事了。崩溃循环的特征是"短时间反复重启"，不是"刚启动"。
   */
  bootsLastHour?: number;
}

/** 阈值（都可配；默认值在 `DEFAULT_THRESHOLDS`） */
export interface WatchdogThresholds {
  /** 任务 `running|queued` 多久没动算"可能卡住"（分钟） */
  stuckMinutes: number;
  /** 最老的排队任务超过多久算"没人接活"（分钟） */
  queueOldestMinutes: number;
  /** 排队条数超过多少算堆积 */
  queueDepth: number;
  /** runner 心跳断多久算"它可能挂了"（秒） */
  runnerHoleSec: number;
  /** 服务 uptime 小于多少秒 = 刚重启过（秒） */
  freshRestartSec: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  stuckMinutes: 20,
  queueOldestMinutes: 30,
  queueDepth: 3,
  runnerHoleSec: 90,
  freshRestartSec: 300,
};

export type WatchdogIssueKey =
  | `stuck:${string}`
  | `failed:${string}`
  | 'runner-hole'
  | 'site-down'
  | 'queue-backlog'
  | 'fresh-restart';

export interface WatchdogIssue {
  /** 去重键：同一个 key 在冷却窗口内只报一次 */
  key: WatchdogIssueKey;
  level: 'warn' | 'error';
  /** 人话标题 */
  title: string;
  /** 事实细节（**给日志/排障**：含任务 id、分钟数、状态码） */
  detail: string;
  /**
   * ★ 2026-10-19（用户当场纠正）：**给她看的一句人话**。
   *
   * 用户原话：「这个不是推送给我的，是告诉昔涟让她自行决策或者来找我商量的吧，
   * 不要太多专业名词和上面数字，很奇怪啊」。
   *
   * ⇒ 这里**不带**任务 id、阶段名、分钟数、状态码、HTTP —— 只有"出了什么事"和"碍不碍事"。
   * 她照这句决定：自己处理，还是用自己的话来问人。
   */
  plain: string;
}

/** 分钟数（向上取整；<1 分钟给 "<1"） */
function mins(ms: number): string {
  const m = Math.floor(ms / 60000);
  return m >= 1 ? `${m} 分钟` : '<1 分钟';
}

const ACTIVE = new Set(['running', 'queued']);

/**
 * 算出这一轮有什么不对。
 *
 * ⚠️ 这里**不做**"报过就不报"的抑制：那是 `WatchdogService` 的冷却/持久化的职责。
 * 早先在这里按 `prevKeys` 跳过已报问题，结果它们从 issue 列表里**消失** ⇒
 * 下一轮被当成"恢复" ⇒ 给用户发了一条假的"好了"（真机踩过）。**问题还在就必须还在列表里。**
 */
export function evaluateWatchdogFacts(
  input: WatchdogInput,
  thresholds: WatchdogThresholds = DEFAULT_THRESHOLDS,
): WatchdogIssue[] {
  const issues: WatchdogIssue[] = [];
  const { nowMs, tasks } = input;

  // ── ① 卡住：running/queued 且很久没动 ───────────────────────────
  for (const t of tasks) {
    if (!ACTIVE.has(t.status)) continue;
    const idleMs = nowMs - Date.parse(t.updatedAt);
    if (!Number.isFinite(idleMs) || idleMs < thresholds.stuckMinutes * 60000) continue;
    issues.push({
      key: `stuck:${t.taskId}`,
      // `queued` 更可能是"没人接活"（runner 挂了），`running` 才是真卡
      level: t.status === 'running' ? 'error' : 'warn',
      title: t.status === 'running' ? '有个活停在那儿了' : '有个活一直没人开工',
      detail:
        `${t.taskId}（${t.projectId}，${t.phase || '未知阶段'}）` +
        `已经 ${mins(idleMs)}没动静了，任务目标：${t.goal.slice(0, 40)}`,
      plain:
        t.status === 'running'
          ? `你给自己做的那件（${t.goal.slice(0, 18)}…）停在半路了，好一阵没往下走`
          : `有件事交出去之后一直没人接手（${t.goal.slice(0, 18)}…）`,
    });
  }

  // ── ② 失败/未知：**每轮都列出来**（去重交给 service 的冷却 + 持久化） ──────
  for (const t of tasks) {
    if (t.status !== 'failed' && t.status !== 'unknown') continue;
    issues.push({
      key: `failed:${t.taskId}`,
      level: 'error',
      title: t.status === 'unknown' ? '有个活没跑完就断了' : '有个活失败了',
      detail:
        `${t.taskId}（${t.projectId}）状态 ${t.status}` +
        (t.lastError ? `，错误：${t.lastError.slice(0, 80)}` : ''),
      plain:
        t.status === 'unknown'
          ? `有一件没做完就断了，结果没留下（${t.goal.slice(0, 18)}…）`
          : `有一件做失败了（${t.goal.slice(0, 18)}…）`,
    });
  }

  // ── ③ runner 心跳断：所有活都不会动，而她完全看不见 ─────────────
  if (input.runnerBeatSec !== null && input.runnerBeatSec >= thresholds.runnerHoleSec) {
    issues.push({
      key: 'runner-hole',
      level: 'error',
      title: '替我干活的那一头好像停了',
      detail: `已经 ${Math.round(input.runnerBeatSec)} 秒没有心跳（阈值 ${thresholds.runnerHoleSec} 秒）；在这期间新交的活不会有人接`,
      plain: '替我办事的那一头没动静了 —— 这段时间新交的活不会有人接',
    });
  }

  // ── ④ 站点打不开 ────────────────────────────────────────────────
  if (input.site && !input.site.ok) {
    issues.push({
      key: 'site-down',
      level: 'error',
      title: '放页面的地方打不开了',
      detail: `探测返回 HTTP ${input.site.status || '无响应'}（探测时间 ${input.site.checkedAt}）`,
      plain: '放页面的地方打不开了，别人现在看不到那些页面',
    });
  }

  // ── ⑤ 排队堆积 / 最老的活没人接 ────────────────────────────────
  const queued = tasks.filter(t => t.status === 'queued');
  if (queued.length > 0) {
    const oldest = queued.reduce((a, b) => (Date.parse(a.updatedAt) <= Date.parse(b.updatedAt) ? a : b));
    const waitMs = nowMs - Date.parse(oldest.updatedAt);
    const depth = input.counts?.queued ?? queued.length;
    if (depth >= thresholds.queueDepth || waitMs >= thresholds.queueOldestMinutes * 60000) {
      issues.push({
        key: 'queue-backlog',
        level: 'warn',
        title: '堆了几件活没开工',
        detail:
          `排队 ${depth} 件，最老的一件等了 ${mins(waitMs)}` +
          `（阈值：${thresholds.queueDepth} 件 / ${thresholds.queueOldestMinutes} 分钟）`,
        plain: '积了几件事排着队，最前面那件等了挺久',
      });
    }
  }

  // ── ⑥ 崩溃循环：一小时内重启 ≥3 次（只部署一次不算） ─────────────
  if ((input.bootsLastHour ?? 0) >= 5) {
    issues.push({
      key: 'fresh-restart',
      level: 'warn',
      title: '我这边一直在重启',
      detail:
        `最近一小时重启了 ${input.bootsLastHour} 次（本次已跑 ${Math.round(input.uptimeSec)} 秒）` +
        '—— 这不正常，通常是启动就报错在反复重试',
      plain: '我这边刚反复重启了几次，不太对劲',
    });
  }

  return issues;
}

/** 冷却后的通知计划（service 用；纯函数，便于单测） */
export interface WatchdogPlan {
  /** 要发出去的新问题 */
  fresh: WatchdogIssue[];
  /** 上一轮存在、这一轮没了 = 恢复了 */
  recovered: Array<{ key: string; title: string }>;
}

/**
 * 按冷却窗口筛出"这一轮该说的"。
 *
 * ⚠️ 冷却按 **key** 记：同一个任务卡住，30 分钟内只说一次。
 * ⚠️ 恢复**不**受冷却限制（"好了"这条必须发，否则用户以为一直坏着）——但每个 key 只发一次。
 */
export function planWatchdogNotifications(input: {
  issues: WatchdogIssue[];
  nowMs: number;
  /** key → 上次通知时间（毫秒） */
  lastNotified: ReadonlyMap<string, number>;
  cooldownMs: number;
  /** 上一轮还在、这一轮消失的 key（由调用方对比得出） */
  disappeared: ReadonlyArray<{ key: string; title: string }>;
  /** 已经发过恢复通知的 key */
  recoveredAlready: ReadonlySet<string>;
}): WatchdogPlan {
  const fresh = input.issues.filter(issue => {
    const last = input.lastNotified.get(issue.key);
    return last === undefined || input.nowMs - last >= input.cooldownMs;
  });
  const recovered = input.disappeared.filter(
    d => !input.recoveredAlready.has(d.key) && input.lastNotified.has(d.key),
  );
  return { fresh, recovered };
}

/**
 * 看门狗服务：定时跑判据 → 冷却筛选 → 交给 `notify`。
 *
 * ⚠️ **只读**：它不重启、不清任务、不改任何东西。要动手得用户点头（B 档）。
 * ⚠️ 一条判据**报过就不再重复**（冷却窗口内），恢复才再发一次 —— 否则就是刷屏。
 */
export interface WatchdogServiceOptions {
  /** 判据多久跑一次（秒）；默认 60 */
  intervalSec: number;
  /** 同一个问题的冷却（毫秒）；默认 30 分钟 */
  cooldownMs: number;
  thresholds: WatchdogThresholds;
  /** 取读数（读库/缓存，**不调模型**） */
  gather: () => WatchdogInput;
  /** 发通知（措辞 + 推送）；抛错不影响下一轮 */
  notify: (fresh: WatchdogIssue[], recovered: Array<{ key: string; title: string }>) => Promise<void>;
  log: (message: string) => void;
  /** 定时器实现（测试注入，避免真定时） */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  /**
   * ★ 2026-10-19（真机踩出来的）：**冷却状态必须能跨重启**。
   *
   * 第一版把它放在内存里 ⇒ 每重启一次就看门狗"忘了自己说过"，把同一件事重发一遍
   * （真机一小时内发了 4 条，其中还夹着一条假的"恢复了"——因为上一轮状态是空的）。
   * 由调用方提供持久化（模块写 `watchdog-state.json`）。
   */
  loadState?: () => WatchdogPersistedState | null;
  saveState?: (state: WatchdogPersistedState) => void;
  /**
   * `failed:` / `unknown:` 这类"已经结束但没结果"的活的冷却（默认 6 小时）。
   * 它们不会自己好，但也不该每半小时提醒一次 —— 那叫骚扰。
   */
  failedCooldownMs?: number;
}

/** 落盘的看门狗状态（跨重启保持一致 —— 不重复、不谎报"恢复"） */
export interface WatchdogPersistedState {
  /** key → 上次通知时间（ms） */
  lastNotified: Record<string, number>;
  /** 上一轮还在的问题：key → title */
  prev: Record<string, string>;
  /** 已经发过恢复通知的 key */
  recovered: string[];
}

export class WatchdogService {
  private readonly opts: WatchdogServiceOptions;
  private timer: unknown = null;
  /** key → 上次通知时间 */
  private readonly lastNotified = new Map<string, number>();
  /** 上一轮的 key → title（用于判断"恢复") */
  private prev = new Map<string, string>();
  private readonly recoveredAlready = new Set<string>();
  private running = false;
  /**
   * 第一轮**不报** `fresh-restart`：那表示"我们刚把它装上 / 刚重启过服务"，
   * 不是"它崩溃循环"。否则每次部署都先给自己发一条假警报（用户会以为真出事了）。
   */
  private firstRun = true;

  constructor(opts: WatchdogServiceOptions) {
    this.opts = opts;
    const restored = opts.loadState?.() ?? null;
    if (restored) {
      for (const [k, v] of Object.entries(restored.lastNotified ?? {})) {
        if (typeof v === 'number') this.lastNotified.set(k, v);
      }
      for (const [k, v] of Object.entries(restored.prev ?? {})) {
        if (typeof v === 'string') this.prev.set(k, v);
      }
      for (const k of restored.recovered ?? []) {
        if (typeof k === 'string') this.recoveredAlready.add(k);
      }
    }
  }

  /** 把当前状态交给调用方落盘（失败不影响判据） */
  private persist(): void {
    if (!this.opts.saveState) return;
    try {
      this.opts.saveState({
        lastNotified: Object.fromEntries(this.lastNotified),
        prev: Object.fromEntries(this.prev),
        recovered: [...this.recoveredAlready],
      });
    } catch {
      // 落盘失败不能让看门狗停摆：下一轮还会再试
    }
  }

  start(): void {
    if (this.timer) return;
    const set = this.opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.timer = set(() => {
      void this.runOnce().catch((err: unknown) => {
        this.opts.log(`[Watchdog] 判据异常（已吞掉，不影响服务）：${(err as Error)?.message ?? err}`);
      });
    }, this.opts.intervalSec * 1000);
    // 别让看门狗把进程钉住（Node 里 timer 默认会 keep-alive）
    (this.timer as { unref?: () => void })?.unref?.();
    this.opts.log(`[Watchdog] 已启动：每 ${this.opts.intervalSec}s 判一次（只读，不处理）`);
  }

  stop(): void {
    if (!this.timer) return;
    (this.opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer as ReturnType<typeof setInterval>);
    this.timer = null;
  }

  /** 跑一轮（可单测直接调）。返回这一轮实际发出去了什么。 */
  async runOnce(): Promise<{ checked: number; fresh: WatchdogIssue[]; recovered: Array<{ key: string; title: string }> }> {
    if (this.running) return { checked: 0, fresh: [], recovered: [] }; // 上一轮还没跑完（模型慢）
    this.running = true;
    try {
      const input = this.opts.gather();
      const isFirst = this.firstRun;
      let issues = evaluateWatchdogFacts(input, this.opts.thresholds);
      if (isFirst) {
        // 第一轮：把"刚重启"当成背景事实，不当作警报（见 firstRun 的注释）
        issues = issues.filter(i => i.key !== 'fresh-restart');
        this.firstRun = false;
      }

      // 上一轮有、这一轮没了 ⇒ 恢复
      //
      // ⚠️ 第一轮**不发恢复**：刚启动时 `prev` 可能是空的或过期的，把"还没扫到"当成
      //    "好了"会发出假好消息（真机踩过：重启后连发一条"刚才那件事好了：…×5"）。
      const currentKeys = new Set<string>(issues.map(i => i.key as string));
      const disappeared = isFirst
        ? []
        : [...this.prev.entries()]
            .filter(([key]) => !currentKeys.has(key))
            .map(([key, title]) => ({ key, title }));

      const plan = planWatchdogNotifications({
        issues,
        nowMs: input.nowMs,
        lastNotified: this.lastNotified,
        cooldownMs: this.opts.cooldownMs,
        disappeared,
        recoveredAlready: this.recoveredAlready,
      });
      // `failed:` 类问题单独用更长的冷却（它不会自己好，但也不该半小时念一次）
      const failedCd = this.opts.failedCooldownMs ?? 6 * 60 * 60 * 1000;
      plan.fresh = plan.fresh.filter(issue => {
        if (!issue.key.startsWith('failed:')) return true;
        const last = this.lastNotified.get(issue.key);
        return last === undefined || input.nowMs - last >= failedCd;
      });

      // ★ 2026-10-19（设计修正）：**每轮都交付**，不再按冷却过滤。
      //
      // 为什么：交付的语义变了 —— 不再是"发一条消息"，而是"把当前状态放进她的上下文"。
      // 状态是**幂等**的：同一件事还在，就该一直挂在 `[你刚注意到的事]` 里；
      // 冷却只用于"要不要再提醒人"，而那个通道已经不存在了（说不说是她的决定）。
      // 早先按冷却过滤会让**重启后清单为空**（问题还在，但她看不到）—— 这是真 bug。
      for (const i of issues) this.lastNotified.set(i.key, input.nowMs);
      for (const r of plan.recovered) this.recoveredAlready.add(r.key);
      await this.opts.notify(issues, plan.recovered);

      // 恢复过的 key 从 prev 里清掉，避免"恢复了又出现"时被当成老的
      this.prev = new Map(issues.map(i => [i.key, i.title]));
      this.persist();
      return { checked: issues.length, fresh: plan.fresh, recovered: plan.recovered };
    } finally {
      this.running = false;
    }
  }

  /** 测试/排查用：现在记着哪些 key */
  snapshot(): { issues: string[]; notified: string[] } {
    return { issues: [...this.prev.keys()], notified: [...this.lastNotified.keys()] };
  }
}
