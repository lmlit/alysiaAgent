/**
 * 她自己发起「做点小东西」——**决策部分**（纯函数，可测）。
 *
 * ★ 2026-10-18（change: `let-her-start-her-own-projects`）。用户要求：
 *   「让她的生活/主动事件系统也能发起"做网站"（比如她自己在 idle 时决定做个小页面）」
 *
 * ★ 为什么把决策单独抽成纯函数：
 *   这个功能的每一条规则**都在花真钱**（烧 API）并且**会改变对外可见的东西**（她的站点）。
 *   那种逻辑不能埋在定时器里靠"观察行为"来验 —— 必须能被单测逐条钉住。
 *
 * ★ 默认**保守**：宁可少做，也不要"每天自己发一堆任务"。
 */

export interface SelfActivityDecisionInput {
  /** 总开关 */
  enabled: boolean;
  /** 现在是不是**空闲时段**（复用 `computeTaskWindow` 的判定，高峰一律不做） */
  offPeak: boolean;
  /** 项目里是否已有排队/在跑的任务（有就先不做，避免堆叠） */
  hasActiveTask: boolean;
  /** 今天已经自己发起过几次 */
  selfTasksToday: number;
  /** 每日上限（默认 1） */
  dailyCap: number;
  /** 距离她上一次自己发起，过了多少小时（从没发起过 ⇒ `null`） */
  hoursSinceLastSelfTask: number | null;
  /** 距离用户上一次说话，过了多少小时（从没说过 ⇒ `null`） */
  hoursSinceLastUserMessage: number | null;
  /** 要求闲置多久才考虑（默认 6 小时） */
  minIdleHours: number;
  /** 每次发起之间的最小间隔（默认 24 小时） */
  minGapHours: number;
}

export type SelfActivitySkipReason =
  | 'disabled'
  | 'peak-hour'
  | 'active-task'
  | 'daily-cap'
  | 'too-soon'
  | 'not-idle';

export interface SelfActivityDecision {
  /** `true` = 可以考虑发起 */
  proceed: boolean;
  /** 不做时给机器看的原因（**不给人看** —— 不打扰用户） */
  reason?: SelfActivitySkipReason;
  /** 给日志的一句话（中文，含关键数值，排障用） */
  detail: string;
}

/**
 * 判断"现在该不该让她自己找活干"。
 *
 * 判定顺序（**先看便宜的**，再做数值比较）：
 *   开关 → 高峰 → 有在途任务 → 今日上限 → 距上次自发起 → 是否够闲
 */
export function decideSelfActivity(input: SelfActivityDecisionInput): SelfActivityDecision {
  const cap = Number.isFinite(input.dailyCap) ? input.dailyCap : 1;
  const minGap = Number.isFinite(input.minGapHours) ? input.minGapHours : 24;
  const minIdle = Number.isFinite(input.minIdleHours) ? input.minIdleHours : 6;

  if (!input.enabled) {
    return { proceed: false, reason: 'disabled', detail: '自发起未开启' };
  }
  if (!input.offPeak) {
    // 高峰一律不做 —— 钱按执行时间算，这条没有例外
    return { proceed: false, reason: 'peak-hour', detail: '现在是高峰时段（不在空闲窗口内）' };
  }
  if (input.hasActiveTask) {
    return { proceed: false, reason: 'active-task', detail: '已有任务在排队/执行，先不叠加' };
  }
  if (input.selfTasksToday >= cap) {
    return {
      proceed: false,
      reason: 'daily-cap',
      detail: `今天已自己发起 ${input.selfTasksToday} 次（上限 ${cap}）`,
    };
  }
  if (input.hoursSinceLastSelfTask !== null && input.hoursSinceLastSelfTask < minGap) {
    return {
      proceed: false,
      reason: 'too-soon',
      detail: `距上次自发起才 ${input.hoursSinceLastSelfTask.toFixed(1)}h（要求 ≥ ${minGap}h）`,
    };
  }
  // 没聊过天并不等于"闲" —— 刚说过话就更不该自己跑去干活（用户在的时候应该陪用户）
  if (input.hoursSinceLastUserMessage !== null && input.hoursSinceLastUserMessage < minIdle) {
    return {
      proceed: false,
      reason: 'not-idle',
      detail: `用户 ${input.hoursSinceLastUserMessage.toFixed(1)}h 前还在说话（要求闲置 ≥ ${minIdle}h）`,
    };
  }

  return {
    proceed: true,
    detail:
      `可以自己找点活：今日 ${input.selfTasksToday}/${cap}，` +
      `距上次自发起 ${input.hoursSinceLastSelfTask === null ? '（无）' : `${input.hoursSinceLastSelfTask.toFixed(1)}h`}，` +
      `距用户上次说话 ${input.hoursSinceLastUserMessage === null ? '（无）' : `${input.hoursSinceLastUserMessage.toFixed(1)}h`}`,
  };
}

/**
 * 自发起任务的 **requestKey**（去重键）。
 *
 * 形如 `self:2026-10-18:alysia-toys` —— 同一天同一项目只发起一次，
 * 即使定时器抖了/重启了也不会重复建任务。
 */
export function selfActivityRequestKey(dateKey: string, projectId: string): string {
  return `self:${dateKey}:${projectId}`;
}

/**
 * 自发起任务的**验收标准**（写死的护栏，不由模型决定）。
 *
 * ★ 关键取舍：**默认不要发布**。
 *   她可以自己决定做什么、做成什么样；但"往公开站点上放东西"这一步留给对话里的人和事。
 *   理由：展示层要稳，才能可靠地反映"她做了什么"；偷偷上线会破坏这个前提。
 *   （`allowPublish: true` 时才会放开，且仍然是她自己在任务里跑 `publish.sh`。）
 *
 * ★ 2026-10-18 追加（用户指出「她调用工具生成的东西，没有她自己的味道」+「她和工具应该有交互」）：
 *   把**循环**写进验收标准 —— 一次成型就交是不合格的。味道在来回里。
 */
export function selfActivityAcceptanceCriteria(opts: { allowPublish: boolean }): string {
  const process =
    '**必须走循环**：① 先在 NOTES.md 写三行意图（感觉/为什么/和上次哪里不同）；' +
    '② 出 2-3 个草图（drafts/*.html，每个 ≤40 行，换的是根本性的东西）；' +
    '③ 每个草图都 `./shot.sh drafts/x.html --name draft-x` **自己看**；' +
    '④ 写下哪张最像你、为什么（要落到颜色/字体/留白/语气，不要写"感觉"）；' +
    '⑤ 挑一张做完整版，**再拍一次**，挑一处最不满意的改掉（至少改一处）；' +
    '⑥ 用一句话说出「这件东西哪里像我」，说不出来就别交。';
  const quality =
    '页面是纯静态（零外链：不许 CDN / 外链字体 / 外部图片 / 外部脚本）。';
  return opts.allowPublish
    ? `${quality}${process}；最后用 ./publish.sh 发布，四条判据必须全过`
    : `${quality}${process}；**不要发布**（不要跑 publish.sh）—— 做好留在工作区，等对话里再决定要不要放上去`;
}
