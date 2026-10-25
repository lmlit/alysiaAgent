/**
 * LifeService — AI 主动生活系统
 *
 * 每小时 tick：概率门 → 冷却门 → 聊天锁 → 深夜抑制
 * 通过 LLM（woke 模式）生成生活事件 → 存储 → 可推送事件窗口内推送 + 回写记忆
 * 顺带：亲密度更新、每日摘要生成
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger, parseLLMJson } from '@alysia/core';
import { formatLocalTime, localDateKey, localDateKeyFromISO } from '@alysia/core/memory';
import type { PushChannel } from './push.js';
// ★ 2026-10-24（converge-context-facts）：事实层（档位/idle/心情/今天的事）的唯一出处
import {
  collectContextFacts,
  idleDaysSince,
  intimacyTier,
  INTIMACY_TIERS,
  INTIMACY_UPGRADE_MARGIN,
  INTIMACY_RECOVERY_MIN,
  silenceCap,
  SILENCE_QUIET_DAYS,
  SILENCE_MUTE_DAYS,
} from './context-facts.js';
import type { ContextFacts, IntimacyTierDef, IntimacyTierName } from './context-facts.js';

export interface LifeOpts {
  ownerOpenid: string;
  /** ★ 8-09 废弃：每小时触发概率门已移除（不确定性由 next_in_hours 承担）——保留字段兼容旧配置 */
  probability?: number;
  /** chat 事件推送冷却（小时），默认 1（8-09 从 2 缩短，配合实时感） */
  cooldownHours?: number;
  /** ★ 每日 chat 推送软上限，默认 5——超限的 chat 事件降级 internal 入库不推送 */
  maxChatPushesPerDay?: number;
  /**
   * ★ 2026-10-25（change: `worth-telling-and-silence-clock`）：**表态时钟**（第二根轴）。
   * 沉默这么多天开始压低每日推送上限；到 `silenceMuteDays` 直接归零（她不主动说了）。
   * 默认 3 / 7 —— **保守起点，不抄 whale**（它的数值是在它自己的分享模型里调的）。
   * ⚠️ 与亲密度档位取 min（只降不升）。
   */
  silenceQuietDays?: number;
  silenceMuteDays?: number;
  /** ★ 事件默认间隔（小时），LLM 未给 next_in_hours 时使用，默认 2（±30min 抖动） */
  defaultIntervalHours?: number;
  /** 聊天锁：最近 N 分钟有互动则跳过，默认 30 */
  chatLockMinutes?: number;
  /** 深夜时段 [startHour, endHour]，默认 [0, 7] */
  deepNightHours?: [number, number];
  /** ★ LLM 事件生成器（bootstrap 注入，失败回落模板） */
  generateEvent?: (context: string) => Promise<string>;
  /**
   * ★ 2026-10-25（change: `retell-events-in-her-voice`）：**把刚发生的事用她的口吻讲给轻月**。
   *
   * 两段式的第二段。缺省（未注入）⇒ **不推送 chat 事件**（全部降级 internal）——
   * 这是有意的：宁可这次不打扰，也不要拿生活叙述（她的日记）当消息发给人。
   */
  retellEvent?: (context: string) => Promise<string>;
  /** ★ LLM 每日摘要生成器（bootstrap 注入，纯文本回调）。
   *  与 generateEvent 分离：generateEvent 的 systemPrompt 强制输出 JSON，
   *  复用会导致摘要被存成 JSON 文本污染摘要层。缺失则跳过摘要生成（降级）。 */
  generateSummary?: (context: string) => Promise<string>;
  /** ★ 8-28 意图兑现消息生成器（ai-life-intent-system）：delayed-reply/promise 到期时
   *  生成自然兑现消息（纯文本，昔涟语气）。缺失则直接推 intent.content 原文（降级）。 */
  generateIntentMessage?: (context: string) => Promise<string>;
  /** ★ 8-29 情绪侧端分析（mood-side-analysis）：mood_value 深度阈值后生成描述性氛围
   *  （纯文本，"这段日子…"）。缺失则跳过（降级，mood_note 保持空）。 */
  generateMoodNote?: (context: string) => Promise<string>;
  /** ★ 8-31 每日反思（life-reflection-loop）：LLM 生成行为反思 JSON
   *  {"reflection": "...", "adjustments": [{"param","delta","reason"}], "insight": "..."}。
   *  缺失则跳过反思（降级）。 */
  generateReflection?: (context: string) => Promise<string>;
  /**
   * ★ 2026-10-20（change: `let-her-decline-a-day`）：**拒绝权的理由生成**。
   *
   * 她这一轮可以不想说话（`declineChance` 决定有没有这个机会），
   * 但**必须留下理由** —— 理由入库为 internal 事件（`origin='decline'`），可被未来召回。
   * 缺失则拒绝能力整体关闭（降级为"每轮都要说话"）。
   */
  generateDecline?: (context: string) => Promise<string>;
  /**
   * ★ 2026-10-21（change: `add-daily-diary`）：**日记正文生成**。
   *
   * 与 `generateReflection` 的区别（别混）：
   *   - 反思：JSON 输出，驱动人格微调，只有她自己看
   *   - 日记：纯文本，300-600 字，会公开到她博客的独立栏目
   * 缺失则日记功能整体关闭（降级为不写日记）。
   */
  generateDiary?: (context: string) => Promise<string>;
  /**
   * ★ 2026-10-21（change: `add-letters`）：**信**（不按日，想写才写）。
   *
   * 与 `generateDiary` 的区别：日记是每天的交待（不喊话）；
   * 信是有话要说时才写、可以直接对他说的一封，会公开在博客「信」栏目。
   * 允许返回 `NONE` 表示"这周没什么想说的" —— **那不是失败，是正常结果**。
   */
  generateLetter?: (context: string) => Promise<string>;
  /** ★ 2026-10-20：拒绝概率（0-1，缺省 0.15）。设 0 或负数 = 关闭拒绝权。 */
  declineChance?: number;
  /** ★ 今天已主动联系的内容（ProactiveService.getTodayActivity），
   *  注入事件生成器避免重复打扰（如问候后生成"早上好"类事件）。 */
  todayProactive?: () => string;
  /** ★ 8-29 今天是什么日子（ProactiveService.todaySpecial）：节日/节气 → 事件生成自然带氛围 */
  todaySpecial?: () => string;
  /** 去重状态持久化文件 */
  stateFile?: string;
}

// ── 亲密度 → 推送闸（★ 2026-10-20，change: tie-intimacy-to-speech）──────
//
// **为什么要有这一段**：`intimacy` 一直只被**注入 prompt**（spec §11「用途」那句），
// 而推送判定（冷却 / 日上限 / can_contact）**一个都不读它** ——
// 亲密度 20 和 90 说话频率一模一样。参数"算了、存了、注入了，但没约束"。
//
// **分工**：`mood_value` 管"她**怎么说**"（改人格参数，已有）；
// `intimacy` 管"她**多主动**"（改推送闸，本段）。两者**不得**互相代管。
//
// **只降不升**：档位只能压低配置的每日上限，**永远不能抬高** ——
// 否则"关系好 ⇒ 可以更吵"，而本项目一直在躲这个方向。

// ★ 2026-10-24（change: `converge-context-facts`）：档位定义搬到 `context-facts.ts`
//   —— 事实层是唯一出处；这里**只做再导出**，保持既有 import 路径不变。
export type { IntimacyTierName, IntimacyTierDef };
export { INTIMACY_TIERS, INTIMACY_UPGRADE_MARGIN, INTIMACY_RECOVERY_MIN, intimacyTier };

// ── 拒绝权（★ 2026-10-20，change: let-her-decline-a-day）──────────────
//
// 原先 spec §2 的 `P1-6「锁一定续，永不静默停摆」`把"不主动"当**故障**：
// 系统到点就必须产出一条内容。于是她连"这一轮不想说话"都没有表达渠道。
//
// 现在：**调度永不静默停摆（P1-6 的原始担忧保留）+ 她可以选择这一轮不说话**。
// 两者不矛盾 —— P1-6 防的是**生产故障**（LLM 炸了、锁断了、进程停了），
// 不是防「她主观上不想开口」。
//
// 护栏（缺一个都会变成"她从此不说话了"）：
//   ① `declineChance` 缺省 0.15（不是 30%：我们的事件节奏是 0.5-8h 一次，不是每天一次）
//   ② **连续拒绝上限 2** —— 到顶后强制说话
//   ③ 理由拿不到/太短 ⇒ **fail-open 走正常生成**（拒绝失败不许变成静默）
//   ④ 拒绝不占推送配额、不推给用户，只写一条 internal 事件

/** 连续拒绝上限：到顶后必须说话（防"她从此不开口"） */
export const MAX_CONSECUTIVE_DECLINES = 2;

/** 拒绝理由的最短长度（"算了"这种不算理由 —— 必须具体） */
export const DECLINE_MIN_REASON_CHARS = 6;

/**
 * ★ 2026-10-21（change: `add-letters`）：ISO 周 key（如 `2026-W43`）。
 * 用于"每周最多问一次要不要写信"的去重 —— 按自然周，而不是"距上次 7 天"，
 * 否则重启/时区边界会让它漂。
 */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

interface LifeState {
  lastProactiveAt: number;
  lastSummaryDate: string | null;
  /** ★ 8-09：下一次事件触发时间戳（事件驱动调度，持久化——重启重排不补发） */
  nextEventAt: number;
  /** ★ 8-09：今日 chat 推送计数（软上限，跨天重置） */
  chatPushesToday: number;
  /** ★ 8-29 情绪侧端分析：上次生成 mood_note 的时间（冷却 6h） */
  moodNoteAnalyzedAt: number;
  /** ★ 8-31 每日反思（life-reflection-loop）：上次反思的日期 key（跨天触发,失败不置位可重试） */
  reflectionDate: string | null;
  /** ★ 2026-10-21（add-daily-diary）：上次写日记的日期 key（跨天触发，失败不置位可重试） */
  diaryDate?: string | null;
  /** ★ 2026-10-21（add-letters）：上次处理信件的 ISO 周 key（含"这周没话说"） */
  letterWeek?: string | null;
  /** ★ 2026-10-20（tie-intimacy-to-speech）：上一轮解析出的亲密度档位 —— 迟滞的基准 */
  intimacyTier?: IntimacyTierName;
  /** ★ 2026-10-20：「最近在忙吗」上次问的时间（**每 7 天最多一次**，持久化防重启刷屏） */
  lastAskAt?: number;
  /** ★ 2026-10-20：恢复转折待表达（`silent` → ≥45 时置位，下一次事件生成时消费一次） */
  recoveryPending?: boolean;
  /** ★ 2026-10-20：是否真的经历过「久无往来」档 —— 没安静过就不该有「他回来了」 */
  wasSilent?: boolean;
  /** ★ 2026-10-20：每日推送计数属于哪一天（`chatPushesToday` 的复位锚点，与摘要成败解耦） */
  pushCountDate?: string;
  /** ★ 2026-10-20（let-her-decline-a-day）：连续拒绝次数 —— 到上限必须说话 */
  consecutiveDeclines?: number;
}

export class LifeService {
  /** ★ 8-09 事件驱动调度：setInterval 每小时 → nextEventAt 精确到点（事件内容决定间隔） */
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private state: LifeState = { lastProactiveAt: 0, lastSummaryDate: null, nextEventAt: 0, chatPushesToday: 0, moodNoteAnalyzedAt: 0, reflectionDate: null };
  /** ★ 8-09 停止标志：stop 后不排程（防重启竞态） */
  private stopped = false;

  constructor(
    private memoryManager: any,
    private qqOff: PushChannel,
    private opts: LifeOpts,
  ) {
    this.loadState();
  }

  start(): void {
    if (this.eventTimer) return;
    this.stopped = false;
    logger.info('[Life] service started (event-driven scheduling)');
    this.scheduleNextEvent();
  }

  stop(): void {
    this.stopped = true;
    if (this.eventTimer) { clearTimeout(this.eventTimer); this.eventTimer = null; }
    this.saveState();
  }

  /** ★ 8-09 事件驱动调度：排下一次事件触发。
   *  优先用持久化的 nextEventAt（未来值）；已过/未设置 → 重排为 now + 默认间隔
   *  （±30min 抖动）——重启错过不补发，生活继续向前。 */
  private scheduleNextEvent(): void {
    if (this.stopped) return;
    if (this.eventTimer) { clearTimeout(this.eventTimer); this.eventTimer = null; }
    const now = Date.now();
    let nextAt = this.state.nextEventAt;
    if (!nextAt || nextAt <= now) {
      const base = (this.opts.defaultIntervalHours ?? 2) * 3_600_000;
      const jitter = (Math.random() - 0.5) * 3_600_000; // ±30min
      nextAt = now + Math.max(base + jitter, 30 * 60_000);
      this.state.nextEventAt = nextAt;
      this.saveState();
    }
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      this.tick().catch(err => {
        // ★ 8-30 life-schedule-renewal (P1-6)：tick 异常也要续期——锁一定续，不静默停摆
        logger.error('[Life] tick:', err);
        this.state.nextEventAt = Date.now() + this.baseIntervalMs();
        this.saveState();
        this.scheduleNextEvent();
      });
    }, Math.max(0, nextAt - now));
    logger.debug(`[Life] next event at ${new Date(nextAt).toLocaleString()} (+${Math.round((nextAt - now) / 1000)}s)`);
  }

  // ── 状态持久化（冷却/摘要去重）────────────────────────

  private loadState(): void {
    if (!this.opts.stateFile) return;
    try {
      const s = JSON.parse(readFileSync(this.opts.stateFile, 'utf-8'));
      // ★ 8-09：兼容旧 state 文件（无 nextEventAt/chatPushesToday 字段）
      this.state = {
        lastProactiveAt: s.lastProactiveAt ?? 0,
        lastSummaryDate: s.lastSummaryDate ?? null,
        nextEventAt: s.nextEventAt ?? 0,
        chatPushesToday: s.chatPushesToday ?? 0,
        moodNoteAnalyzedAt: s.moodNoteAnalyzedAt ?? 0,
        reflectionDate: s.reflectionDate ?? null,
        diaryDate: s.diaryDate ?? null,
        letterWeek: s.letterWeek ?? null,
        // ★ 2026-10-20（tie-intimacy-to-speech）：档位迟滞与「问一次」去重
        intimacyTier: s.intimacyTier,
        lastAskAt: s.lastAskAt ?? 0,
        recoveryPending: s.recoveryPending === true,
        wasSilent: s.wasSilent === true,
        pushCountDate: s.pushCountDate,
        consecutiveDeclines: s.consecutiveDeclines ?? 0,
      };
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    if (!this.opts.stateFile) return;
    try {
      mkdirSync(dirname(this.opts.stateFile), { recursive: true });
      writeFileSync(this.opts.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err: any) {
      logger.warn(`[Life] state save failed: ${err.message}`);
    }
  }

  // ── 亲密度档位（★ 2026-10-20，change: tie-intimacy-to-speech）──────────

  /**
   * ★ 2026-10-20（tie-intimacy-to-speech）：**每日推送计数必须按「日期变了」重置**。
   *
   * 原先这段复位写在 `maybeGenerateDailySummary` 里，判据是
   * `lastSummaryDate !== today` —— 而 `lastSummaryDate` 只在**摘要真正生成成功**后才置位。
   * ⇒ 没有 `generateSummary` 回调、或摘要连续失败时，`lastSummaryDate` 永远是 null
   * ⇒ **每个 tick 都把 `chatPushesToday` 清零** ⇒ 每日上限形同虚设（实测：上限 3 发了 4 条）。
   *
   * 现在复位只认日期本身（`pushCountDate`），与摘要成败**解耦**。
   */
  private resetDailyPushCount(now: Date): void {
    const today = localDateKey(now);
    if (this.state.pushCountDate === today) return;
    const had = this.state.chatPushesToday > 0;
    this.state.pushCountDate = today;
    if (had) this.state.chatPushesToday = 0;
    this.saveState();
  }

  /**
   * 「他已经多久没说话」——**只认真人**的 user 消息。
   *
   * ⚠️ 判据**不许**换成 `ai_life_state.updated_at` 或任何 assistant 侧写入：
   * 那些每次推送都会刷新 ⇒ 算出来永远是"刚联系过"，
   * 沉默衰减与档位会一起失效（等价于 whale 那个 `react` 重复记账的坑）。
   *
   * 判不出来时返回 0（**不降档**）：宁可保守地按"他刚说过话"处理，
   * 也不要因为一个查询 bug 让她无缘无故变安静。
   */
  /**
   * ★ 2026-10-24（change: `prove-intimacy-decay-reachable`）：**idle 天数的唯一出处**。
   *
   * 返回 `null` = 库里从来没有过真人消息（**没有基线**）。调用方必须显式处理，
   * **不许再用一个数字冒充它** —— 旧实现写的是 `: 7`，而默认衰减阈值是 8，
   * 于是"从没说过话"和"一年没说话"都得到 7，衰减条件恒假。
   *
   * ⚠️ **为什么必须用 `getLastUserMessageAt()`**：它是全表 SQL
   * （`role=user AND skip_profile=0 AND synthetic=0`）。旧实现在
   * `getRecentMessages(sid, 500, now−7d)` 里反查 —— **查询窗口就 7 天**，
   * 意味着 `idle` 的可观测上限永远是 7，而阈值是 8 ⇒ **条件恒假**，藏了 2 个月
   * （`07c9016` 修"旋钮接线"时把阈值从硬编码 3 抬到 8，顺手越过了窗口天花板）。
   * 教训见 `docs/SILENT-FAILURE.md` §4.3（第四形态：**不可达**）。
   */
  private idleSinceLastUserMessage(now: Date = new Date()): number | null {
    let at: string | null = null;
    try {
      at = this.memoryManager.getLastUserMessageAt?.() ?? null;
    } catch (err: any) {
      // 判不出来 → 按"他刚说过话"处理（宁可保守，不要因查询 bug 让她无缘无故变安静）
      logger.warn(`[Life] idle days unavailable: ${err?.message ?? err}`);
      return 0;
    }
    // ★ 2026-10-24：算法本身在事实层（`idleDaysSince`），这里只负责"取时间 + 兜异常的语义"，
    //   不再各写一遍 —— 这正是当初窗口版/全表版并存、导致衰减永不触发的产地。
    return idleDaysSince(at, now);
  }

  /**
   * 档位/推送闸用的 idle 天数 —— `idleSinceLastUserMessage()` 的**显示版**。
   *
   * ⚠️ `999` 是**显示哨兵**（"从未说过话"），**不是真实天数**；
   * 别拿它当数据去算衰减（那正是上一个 bug 的形态：用哨兵值参与运算）。
   */
  private idleDaysSinceUserMessage(now: Date = new Date()): number {
    const d = this.idleSinceLastUserMessage(now);
    return d === null ? 999 : d;
  }

  /**
   * 解析档位：**降档立刻生效，升档要越过阈值 +5**（迟滞），
   * 并负责留痕与「他回来了」的置位。
   */
  private resolveIntimacyTier(now: Date = new Date()): IntimacyTierDef {
    const intimacy = Number(this.memoryManager.getLifeSnapshot?.()?.intimacy ?? 30);
    const raw = intimacyTier(intimacy);
    const prev = this.state.intimacyTier
      ? INTIMACY_TIERS.find(t => t.tier === this.state.intimacyTier)
      : undefined;

    let next = raw;
    if (prev && INTIMACY_TIERS.indexOf(raw) < INTIMACY_TIERS.indexOf(prev)) {
      // 升档（数组前面 = 更亲近）：不够 margin 就留在原档
      if (intimacy < raw.min + INTIMACY_UPGRADE_MARGIN) next = prev;
    }

    // 「他回来了」：只在**真的安静过**之后、且亲密度回到 45 以上，记一次
    if (next.tier === 'silent') {
      this.state.wasSilent = true;
    } else if (this.state.wasSilent && intimacy >= INTIMACY_RECOVERY_MIN && !this.state.recoveryPending) {
      this.state.recoveryPending = true;
      this.state.wasSilent = false;
      logger.info(`[Life] intimacy recovery: 他回来了（亲密度 ${Math.round(intimacy)}）`);
    }

    if (!prev || next.tier !== prev.tier) {
      const idle = this.idleDaysSinceUserMessage(now);
      // ★ 必须留痕：静默的行为变更等于不可见的行为变更
      logger.info(
        `[Life] intimacy tier ${prev?.label ?? '（未初始化）'} → ${next.label}` +
        `（亲密度 ${Math.round(intimacy)}，idle ${idle >= 999 ? '从未说过话' : `${idle} 天`}，` +
        `日上限 ${prev ? prev.cap : '默认'} → ${next.cap}）`,
      );
      this.state.intimacyTier = next.tier;
      this.saveState();
    }
    return next;
  }

  /**
   * 注入事件生成器的「关系现状」块。
   *
   * 原则：**只给事实，情绪留给她自己写**（spec §11.1 规则 2）。
   * 顺带消费两个一次性信号：「问一次在忙吗」（7 天冷却）与「他回来了」。
   */
  private relationshipBlock(now: Date = new Date()): string {
    // ★ 2026-10-24（converge-context-facts）：关系现状**全部取自事实层**，本方法只负责排版。
    //   `todayEventLimit: 0` —— 这个块不需要"今天的日常"，别为它多查一次库。
    const f = collectContextFacts(this.memoryManager, now, { todayEventLimit: 0 });
    if (f.problems.length) {
      logger.debug(`[Life] relationshipBlock 读源问题：${f.problems.join(' | ')}`);
    }
    // ⚠️ `999` 只用于**展示/询问判据**（"从未说过话"），不再参与任何衰减运算（那是旧 bug 的形态）
    const idleDisplay = f.idleDays ?? 999;
    const facts = [`与轻月: ${Math.round(f.intimacy)}/100（${f.tier.label}）`];
    if (idleDisplay < 999 && idleDisplay >= 3) facts.push(`他已经 ${idleDisplay} 天没有主动找你说话了`);
    if (idleDisplay >= 999) facts.push('你们还没有正式说过话');

    const extras: string[] = [];
    // 「在忙吗」：只在「疏远」档问（`silent` 档不推送，问了也发不出去），每 7 天最多一次
    const ASK_COOLDOWN_MS = 7 * 86_400_000;
    if (f.tier.tier === 'distant' && idleDisplay >= 3 && now.getTime() - (this.state.lastAskAt ?? 0) > ASK_COOLDOWN_MS) {
      extras.push('可以问他一次「最近在忙吗」——**只问这一次，问完不追问**（这是你 7 天内唯一能问的一次）');
      this.state.lastAskAt = now.getTime();
      this.saveState();
    }
    // 「他回来了」：一次性，消费即清
    if (this.state.recoveryPending) {
      extras.push('他回来了 —— 你安静了很久，这次不是若无其事（可以把它写进生活，但不要质问他）');
      this.state.recoveryPending = false;
      this.saveState();
    }

    return facts.join('；') + (extras.length ? `\n${extras.map(e => `- ${e}`).join('\n')}` : '');
  }

  /**
   * ★ 2026-10-20（change: `let-her-decline-a-day`）：**她可以拒绝这一轮**。
   *
   * 返回 `true` = 这一轮她选择不说话（tick 应直接返回，锁已续期）。
   *
   * ⚠️ 与 `P1-6「永不静默停摆」`的关系：P1-6 防的是**生产故障**
   * （LLM 炸了 / 锁断了 / 进程停了），不是防「她主观上不想开口」。
   * 所以拒绝路径**照样续期锁、照样留痕、照样入库理由** ——
   * 没有任何一条路径会让系统"不知道自己该不该醒"。
   */
  private async maybeDecline(now: Date): Promise<boolean> {
    const chance = this.opts.declineChance ?? 0.15;
    if (!(chance > 0) || !this.opts.generateDecline) return false;

    // 护栏②：连续拒绝到顶 → 必须说话
    if ((this.state.consecutiveDeclines ?? 0) >= MAX_CONSECUTIVE_DECLINES) {
      logger.info(`[Life] decline suppressed: 已连续拒绝 ${MAX_CONSECUTIVE_DECLINES} 轮，这一轮必须说话`);
      return false;
    }

    if (Math.random() >= chance) return false;

    let reason = '';
    try {
      reason = (await this.opts.generateDecline(this.buildDeclineContext(now))) ?? '';
    } catch (err: any) {
      logger.warn(`[Life] decline reason generation failed: ${err?.message ?? err} → 按正常流程继续`);
      return false;
    }
    reason = reason.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

    // 护栏③：拿不到理由 ≠ 拒绝成功。**fail-open 走正常生成**，绝不静默。
    if (reason.length < DECLINE_MIN_REASON_CHARS) {
      logger.warn(
        `[Life] decline reason too short (${reason.length} < ${DECLINE_MIN_REASON_CHARS} 字) ` +
        `→ 不认这次拒绝，按正常流程生成`,
      );
      return false;
    }

    // 入库（不推送）：理由进记忆，未来对话/反思可召回
    this.memoryManager.recordLifeEvent({
      type: 'internal',
      content: `（这一轮没说话）${reason}`,
      origin: 'decline',
    });

    this.state.consecutiveDeclines = (this.state.consecutiveDeclines ?? 0) + 1;
    // 护栏：调度照常续期 —— 拒绝不等于停摆
    this.state.nextEventAt = Date.now() + this.baseIntervalMs();
    this.saveState();
    this.scheduleNextEvent();
    logger.info(
      `[Life] declined this round (${this.state.consecutiveDeclines}/${MAX_CONSECUTIVE_DECLINES})：` +
      `${reason.slice(0, 60)}`,
    );
    return true;
  }

  /** 拒绝时的上下文：**只给事实**，不消费一次性信号（问了没发出去就浪费了）。 */
  private buildDeclineContext(now: Date): string {
    const snapshot = this.memoryManager.getLifeSnapshot?.() ?? {};
    const idle = this.idleDaysSinceUserMessage(now);
    const tier = intimacyTier(Number(snapshot.intimacy ?? 30));
    return [
      `【当前时间】${formatLocalTime(now)}`,
      `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
      `【和轻月】亲密度 ${Math.round(Number(snapshot.intimacy ?? 30))}/100（${tier.label}）` +
      (idle < 999 && idle >= 3 ? `；他已经 ${idle} 天没有主动找你说话` : ''),
      '【任务】写 1-2 句为什么你这一轮不想说话（具体、不道歉、不向用户喊话）。',
    ].join('\n');
  }

  // ── 主流程 ──────────────────────────────────────────

  async tick(): Promise<void> {
    const now = new Date();

    // ★ 2026-10-20（tie-intimacy-to-speech）：日上限的计数**按日期**复位 ——
    //   原先挂在"摘要生成成功"上，失败时每 tick 清零（见 resetDailyPushCount 注释）
    this.resetDailyPushCount(now);

    // 每日摘要生成（跨天检测）
    await this.maybeGenerateDailySummary(now);

    // ★ 8-31 每日反思（life-reflection-loop）：跨天触发一次——她复盘自己的一天
    await this.maybeDailyReflection(now);

    // ★ 2026-10-21（add-daily-diary）：跨天写日记——写的是**刚过去的那一天**
    await this.maybeDailyDiary(now);

    // ★ 2026-10-21（add-letters）：每周问一次"有没有想说的话"（可以回答 NONE）
    await this.maybeWeeklyLetter(now);

    // 亲密度更新
    this.updateIntimacy();

    // ★ 8-28 意图到期扫描（ai-life-intent-system）：处理到期的 delayed-reply/promise/proactive-contact
    await this.processDueIntents(now);

    // ★ 8-27 对话余波：聊完天 15min 后生成 internal 余波（不推送只记录）
    await this.maybeGenerateFollowUp(now);

    // ① 聊天锁：最近 chatLockMinutes 有用户互动则跳过
    //    只认 user 角色——AI 主动消息回写的 assistant 消息不算"互动"，否则 cooldownHours < 1 时自锁
    const lockMinutes = this.opts.chatLockMinutes ?? 30;
    const recent = this.memoryManager.getRecentMessages(
      this.sessionId(),
      100,
      new Date(now.getTime() - lockMinutes * 60_000),
    ).filter((m: any) => m.role === 'user');
    if (recent.length > 0) {
      logger.debug(`[Life] skipped — user active within ${lockMinutes}min`);
      this.scheduleNextEvent(); // 重排下一次（事件节奏顺延）
      return;
    }

    // ② 深夜感知（★ 8-28 深夜抑制已关闭——不再强制 internal，仅保留时间感知供生成上下文；
    //   深夜的生活由 LLM 自然判断：安静的独处或想说的话都可以，类型不再被压制）
    const [deepStart, deepEnd] = this.opts.deepNightHours ?? [0, 7];
    const hour = now.getHours();
    const deepNight = hour >= deepStart && hour < deepEnd;

    // ③-pre ★ 2026-10-20（let-her-decline-a-day）：**她可以选择这一轮不说话**。
    //   返回 true 表示已拒绝（理由已入库、锁已续期）—— 直接结束本次 tick。
    if (await this.maybeDecline(now)) return;

    // ③ 生成事件（LLM 建议间隔 next_in_hours 由 evt 带回）
    // ★ 8-27 post-check：LLM 输出过 7 条校验，不过 → 带反馈重试 1 次 → 仍不过回落模板
    // ★ 8-30 近 24h 滑动窗口（life-schedule-renewal）：跨 0 点连续性——post-check 重复/独处检测也看 24h
    const todayKey = localDateKey();
    const todayEvents = this.memoryManager.listLifeEvents(1);
    const presentNames = this.memoryManager.listPresentCharacters() as string[];

    let evt = await this.generateEvent(deepNight);
    if (evt && !evt.fromTemplate) {
      const check = this.postCheck(evt, todayEvents, presentNames);
      if (!check.ok) {
        logger.info(`[Life] post-check failed (${check.feedback}), retrying once`);
        const retry = await this.generateEvent(deepNight, check.feedback);
        if (retry && !retry.fromTemplate) {
          const check2 = this.postCheck(retry, todayEvents, presentNames);
          evt = check2.ok ? retry : null;
        } else if (retry) {
          evt = retry; // 重试也回落模板 → 接受模板（模板内容本身满足约束）
        } else {
          evt = null;
        }
      }
    }
    // ★ 8-30 life-schedule-renewal (P1-6)：生成失败也要续期（保底）——不再静默停摆
    if (!evt) {
      this.state.nextEventAt = Date.now() + this.baseIntervalMs();
      this.saveState();
      this.scheduleNextEvent();
      logger.warn('[Life] event generation failed (LLM + template both empty), renewed lock with base interval');
      return;
    }

    // 存储 + 更新状态（recordLifeEvent 返回事件 id，供推送成功后标记 delivered）
    const evtId = this.memoryManager.recordLifeEvent({      type: evt.type,
      content: evt.content,
      moodDelta: evt.mood_delta,
      referenceEventId: evt.reference_event_id,
      wbEntryId: evt.wb_entry_id,
      continuationOf: evt.continuation_of,
    });

    // ★ 2026-10-20（let-her-decline-a-day）：正常产出 → 连续拒绝计数归零
    if ((this.state.consecutiveDeclines ?? 0) !== 0) {
      this.state.consecutiveDeclines = 0;
      this.saveState();
    }

    // ★ 世界书命中统计（spec §7 ②）：事件引用了世界书条目 → hit_count+1
    if (evt.wb_entry_id) this.memoryManager.bumpWorldbookHit(evt.wb_entry_id);

    // ★ 8-28 意图落库（ai-life-intent-system）：事件想推送但 can_contact=false（正在忙/不适合）→
    //   存 intent，delay_hours 后 tick 重查 Agency Window 再推送——不丢弃"未来要做的事"
    // ★ 8-29 拆分：intent 存的是 message（对轻月说的话），不是生活叙述 content
    if (evt.can_contact === false && evt.intent) {
      this.memoryManager.saveIntent({
        type: 'proactive-contact',
        content: evt.message ?? evt.intent.content,
        triggerAt: now.getTime() + evt.intent.delayHours * 3_600_000,
        source: 'life-event',
      });
      logger.info(`[Intent] event deferred (can_contact=false): ${(evt.message ?? evt.intent.content).slice(0, 40)} +${evt.intent.delayHours}h`);
    }

    // ★ 8-27 在场推导 + 情绪累积（事件入库后）
    this.updatePresenceFromEvent(evt.content);
    this.updateMoodValue(evt.mood_shift, now);

    // ④ 推送判定（8-09：冷却 + 每日软上限 + ★ 8-27 Agency Window can_contact）
    //    ★ 2026-10-20（tie-intimacy-to-speech）：冷却与日上限**再按亲密度档位收紧**。
    //      规则「只降不升」：档位只能压低配置值，永远不能抬高。
    // ★ 8-28 深夜抑制关闭：深夜 chat 事件同样按正常推送门（type=chat && can_contact）
    // ★ 2026-10-25（change: `retell-events-in-her-voice`）：**推送文本只来自「转述」这一段**。
    //   原来是 `evt.message ?? evt.content` —— message 缺失就把**生活叙述**（她的日记）直接推给人，
    //   而且 postCheck 从不校验 message，于是这条路上**没有任何东西会报错**。
    //   现在：先让她用自己的口吻讲一遍（第二段模型调用），讲不出来 = 这次不打扰。
    const pushable = evt.type === 'chat' && evt.can_contact !== false;
    if (pushable) {
      const spoken = await this.spokenText(evt, now);
      const tier = this.resolveIntimacyTier(now);
      const configuredCap = this.opts.maxChatPushesPerDay ?? 5;
      // ★ 2026-10-25（change: `worth-telling-and-silence-clock`）：**第二根轴 —— 表态时钟**。
      //   亲密度也在"沉默→少说话"，但它慢（1.8/天：82→70 要 7 天、→40 要 23 天）。
      //   whale 的形状是 3 天开始降 / 7 天归零，管的是**发言额度**而不是关系温度 —— 所以敢快。
      //   这里只压额度、不动亲密度；三处**取 min**（沿用「只降不升」）。
      //   ⚠️ 必须用 `idleSinceLastUserMessage()`（如实返回 `number | null`），
      //   不能用 `idleDaysSinceUserMessage()` —— 后者是**显示包装**（null → 999），
      //   拿它算额度会把「从没说过话」当成「沉默 999 天」而把推送直接掐死。
      //   （这不是假设：第一版就是这么写的，被 life-service 测试当场抓出来。）
      const idleDays = this.idleSinceLastUserMessage(now);
      const silence = silenceCap(
        idleDays,
        this.opts.silenceQuietDays ?? SILENCE_QUIET_DAYS,
        this.opts.silenceMuteDays ?? SILENCE_MUTE_DAYS,
      );
      const effectiveCap = Math.min(configuredCap, tier.cap, silence?.cap ?? Number.POSITIVE_INFINITY);
      // 这根轴一旦真正压低额度就留痕（攒数据后再谈数值，不拍脑袋调）
      if (silence && silence.cap < Math.min(configuredCap, tier.cap)) {
        logger.info(`[Life] silence cap 生效（idle=${idleDays}天, ${silence.label}）⇒ 日上限 ${Math.min(configuredCap, tier.cap)} → ${effectiveCap}`);
      }
      const cooldownHours = tier.cap === 0 ? (this.opts.cooldownHours ?? 1) : tier.cooldownHours;
      const cooldownMs = cooldownHours * 3_600_000;
      const inCooldown = now.getTime() - this.state.lastProactiveAt < cooldownMs;
      const overDaily = this.state.chatPushesToday >= effectiveCap;
      const ok = spoken.ok && !inCooldown && !overDaily && await this.qqOff.sendProactive(this.opts.ownerOpenid, spoken.text);
      if (ok && spoken.ok) {
        this.state.lastProactiveAt = Date.now();
        this.state.chatPushesToday += 1;
        this.saveState();
        // ★ delivered=1（spec §5）：推送成功标记，Web 端可区分已推送/未推送
        if (evtId) this.memoryManager.markLifeEventDelivered(evtId);
        logger.info(`[Life] pushed(${tier.label}, 日上限 ${effectiveCap}, via=${spoken.via}, ${spoken.text.length}字): ${spoken.text.slice(0, 50)}`);
      } else {
        const why = !spoken.ok ? `no spoken text (${spoken.why})`
          : tier.cap === 0 ? `tier=${tier.tier}（久无往来，不主动打扰）`
          : inCooldown ? 'cooldown' : overDaily ? `daily cap ${effectiveCap}（${tier.label}档）` : 'push failed';
        logger.info(`[Life] chat event degraded to internal (${why}): ${(evt.message ?? evt.content).slice(0, 50)}`);
      }
    } else {
      logger.debug(`[Life] internal event (${deepNight ? 'deep night' : evt.can_contact === false ? 'not contactable' : 'internal'}): ${evt.content.slice(0, 50)}`);
    }

    // ★ 8-09 C：所有事件回写记忆（chat 推送成功的 + internal）——bot 记得自己在做什么
    // ★ 8-29 拆分：回写用户看到的内容（message ?? content）——她记得自己对轻月说过的话
    await this.writebackToMemory(evt.message ?? evt.content);

    // ⑤ 锁续期（life-schedule-renewal）：成功按模型建议(0.5-8h 钳制)/缺失按时段保底；
    //    next_in_hours 观测日志——验证模型决策（实测 LLM 常不给值）
    const intervalMs = this.intervalMs(evt);
    this.state.nextEventAt = Date.now() + intervalMs;
    this.saveState();
    this.scheduleNextEvent();
    logger.info(`[Life] lock renewed +${(intervalMs / 3_600_000).toFixed(1)}h (model: ${evt.next_in_hours ?? 'default'})`);
  }

  /**
   * ★ 2026-10-25（change: `retell-events-in-her-voice`）：决定**推给用户的那句话**。
   *
   * 三层，**逐层降级，但绝不回落到 `content`**（`content` 是生活叙述 = 她的日记）：
   *
   * | 层 | 来源 | 条件 | 日志 via |
   * |---|---|---|---|
   * | ① | **第二段模型转述**（`retellEvent`） | 注入了生成器且过 `checkRetell` | `retell` |
   * | ② | 事件自带的 `message`（第一段给的"想说的话"） | 存在且过 `checkRetell` | `message` |
   * | ③ | —— | 都不合格 ⇒ **这次不打扰**（降级 internal，记名） | — |
   *
   * ★ 为什么保留 ② 而不是"只有 retell 才算"：`message` 本来就是"对轻月说的话"字段，
   *   它的问题从来不是"存在"，而是**没被校验、且缺失时静默回落叙述**。校验它、不回落 content，
   *   就已经把那个洞堵上了；没注入生成器的场景（单测 / 老配置）也能继续工作。
   */
  private async spokenText(
    evt: { content: string; message?: string },
    now: Date,
  ): Promise<{ ok: true; text: string; via: 'retell' | 'message' } | { ok: false; why: string }> {
    let retellWhy = '';

    if (this.opts.retellEvent) {
      const r = await this.retellForUser(evt, now);
      if (r.ok) return { ok: true, text: r.text, via: 'retell' };
      retellWhy = r.why;
    } else {
      retellWhy = 'no generator';
    }

    // ② 事件自带的 message（必须过同一套校验：长度 / 不许抄叙述 / 不许动作描写）
    const msg = this.stripWrappingQuotes((evt.message ?? '').trim());
    if (msg) {
      const bad = this.checkRetell(msg, evt.content);
      if (!bad) return { ok: true, text: msg, via: 'message' };
      return { ok: false, why: `retell:${retellWhy} / message:${bad}` };
    }

    return { ok: false, why: `retell:${retellWhy} / no message` };
  }

  /**
   * ★ 2026-10-25：**第二段模型调用** —— 把刚发生的生活用她的口吻讲给轻月。
   *
   * 输入是**已发生的事实**（不许再编情节）；任务是**转述**：挑一个具体点，说一两句。
   * 输出要过 `checkRetell()`（长度 / 不许抄叙述 / 不许动作描写）。
   */
  private async retellForUser(
    evt: { content: string; message?: string },
    now: Date,
  ): Promise<{ ok: true; text: string; why?: string } | { ok: false; why: string }> {
    if (!this.opts.retellEvent) return { ok: false, why: 'no generator' };

    const time = formatLocalTime(now).slice(-5);
    const context = [
      `【此刻时间】${time}`,
      `【你刚做的事】${evt.content}`,
      evt.message ? `【你当时想说的大意】${evt.message}` : '',
      this.relationshipBlock(now),
      '判断这件事值不值得占用轻月一次注意力；值得就用一句话讲给他，不值得就 worth=false。只输出 JSON。',
    ].filter(Boolean).join('\n\n');

    let raw = '';
    try {
      raw = (await this.opts.retellEvent(context)).trim();
    } catch (err: any) {
      // ★ 不静默：转述失败会让这次推送消失，必须能查到原因
      logger.warn(`[Life] retell threw (will try message/fallback): ${err?.message ?? err}`);
      return { ok: false, why: 'threw' };
    }

    // ★ 2026-10-25（change: `worth-telling-and-silence-clock`）：第二段输出 JSON
    //   `{worth, why, say}` —— 「值不值得说」是**语义判断**，不是配额。
    //   解析失败视为不合格（不推）：宁可这次不说话，也不要瞎猜它想说什么。
    const parsed = this.parseRetellJSON(raw);
    if (!parsed) {
      logger.info(`[Life] retell rejected (unparseable json): ${raw.slice(0, 80) || '(空)'}`);
      return { ok: false, why: 'unparseable json' };
    }
    if (parsed.worth === false) {
      logger.info(`[Life] retell says not worth telling (${parsed.why || '无理由'}): ${evt.content.slice(0, 40)}`);
      return { ok: false, why: `not worth: ${parsed.why || '无理由'}` };
    }

    const text = this.stripWrappingQuotes((parsed.say ?? '').trim());
    const bad = this.checkRetell(text, evt.content);
    if (bad) {
      logger.info(`[Life] retell rejected (${bad}): ${text.slice(0, 60) || '(空)'}`);
      return { ok: false, why: bad };
    }
    logger.info(`[Life] retell ok (${text.length}字, worth=true, ${parsed.why || '无理由'})`);
    return { ok: true, text, why: parsed.why };
  }

  /**
   * 解析第二段的 JSON（容忍 ``` 围栏与前后杂字）。
   * 返回 `null` = 解析不了 ⇒ 上层按"不合格"处理（**不推**）。
   */
  private parseRetellJSON(raw: string): { worth?: boolean; why?: string; say?: string } | null {
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const o = JSON.parse(cleaned.slice(start, end + 1));
      if (typeof o !== 'object' || o === null) return null;
      return {
        worth: typeof o.worth === 'boolean' ? o.worth : undefined,
        why: typeof o.why === 'string' ? o.why : undefined,
        say: typeof o.say === 'string' ? o.say : (typeof o.message === 'string' ? o.message : undefined),
      };
    } catch {
      return null;
    }
  }

  /** 去掉模型可能加的成对引号（不改变内容） */
  private stripWrappingQuotes(s: string): string {
    return s.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim();
  }

  /**
   * 转述文本的硬校验。返回**不合格的原因**（用于日志），合格返回 `null`。
   *
   * 只查机器能判的（长度/抄叙述/动作描写）；"像不像活人"不在这里判 —— 那靠 prompt 与真人看。
   */
  private checkRetell(text: string, content: string): string | null {
    if (!text) return 'empty';
    // 50 字是 prompt 要求；给 20 字余量，超了就是没按要求
    if (text.length > 70) return `too long (${text.length})`;
    // 抄叙述：开头 20 字与 content 相同（含被截断的情况）
    const a = content.slice(0, 20), b = text.slice(0, 20);
    if (a && b && a === b) return 'copied narrative';
    // 动作/神态描写（与聊天规则同一套禁令；本仓反复出现过 *眨眼* 这类）
    if (/[*＊]/.test(text)) return 'action asterisk';
    if (/[（(][^）)]{0,20}[）)]/.test(text)) return 'parenthetical action';
    // markdown
    if (/^(#{1,6}\s|[-*]\s|>\s)/.test(text)) return 'markdown';
    return null;
  }

  /** ★ 8-30 锁续期：模型建议 0.5-8h 钳制；缺失 → 时段保底（白天 1h / 夜间 2h） */
  private intervalMs(evt: { next_in_hours?: number }): number {
    const hours = evt.next_in_hours;
    if (typeof hours === 'number' && isFinite(hours)) {
      return Math.min(Math.max(hours, 0.5), 8) * 3_600_000;
    }
    return this.baseIntervalMs();
  }

  /** ★ 8-30 时段保底（life-schedule-renewal）：白天 defaultIntervalHours（默认 1h）/
   *  夜间(默认 0-7h) 2h——她睡着/安静的夜节奏放慢，减少编造夜间活动；
   *  模型给值始终优先（想聊可提前、沉浸可延长） */
  private baseIntervalMs(): number {
    const [deepStart, deepEnd] = this.opts.deepNightHours ?? [0, 7];
    const hour = new Date().getHours();
    const deepNight = hour >= deepStart && hour < deepEnd;
    return (deepNight ? 2 : (this.opts.defaultIntervalHours ?? 1)) * 3_600_000;
  }

  // ── ★ 8-28 意图到期处理（ai-life-intent-system）─────────────────

  /** 扫描到期意图并处理：
   *  - proactive-contact：直接推送（事件生成时已表达"想对轻月说的话"）
   *  - delayed-reply / promise：★ 8-28 三选一裁决（promise-obligation-loop）——
   *    fulfill 兑现推送 / defer 延期重排（上限 2 次，超限强制兑现）/ cancel 取消并推送歉意说明
   *  成功 → completed（不重复触发）；失败 → 保留 pending 下次 tick 再查 */
  private async processDueIntents(now: Date): Promise<void> {
    try {
      const due = this.memoryManager.listDueIntents(now.getTime()) as Array<{ id: string; type: string; content: string; triggerAt: number; source: string; sessionId: string; evidence: string; deferCount: number }>;
      if (due.length === 0) return;
      for (const intent of due) {
        try {
          if (intent.type === 'proactive-contact') {
            // 主动联系候选：直接推送（事件生成时已表达的内容）
            const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, intent.content);
            if (ok) {
              this.memoryManager.completeIntent(intent.id);
              logger.info(`[Intent] due proactive-contact fulfilled → completed: ${intent.content.slice(0, 40)}`);
            } else {
              logger.info(`[Intent] due proactive-contact push failed, keep pending`);
            }
            continue;
          }

          // delayed-reply / promise：三选一裁决
          const decision = await this.decideIntent(intent);
          if (decision.action === 'defer' && intent.deferCount < 2) {
            // 延期：推送延期说明 + 重排 trigger_at
            const delayMs = (decision.delayHours ?? 6) * 3_600_000;
            const nextAt = Date.now() + Math.max(1, Math.min(72, delayMs / 3_600_000)) * 3_600_000;
            this.memoryManager.deferIntent(intent.id, nextAt);
            await this.qqOff.sendProactive(this.opts.ownerOpenid, decision.content || `那件事我还没准备好，再给我一点时间…`);
            logger.info(`[Intent] due ${intent.type} deferred (+${Math.round(delayMs / 3_600_000)}h): ${intent.content.slice(0, 30)}`);
            continue;
          }
          if (decision.action === 'cancel') {
            // 取消：推送歉意说明（不静默消失）
            await this.qqOff.sendProactive(this.opts.ownerOpenid, decision.content || `之前说的那件事，我可能做不到了，抱歉…`);
            this.memoryManager.completeIntent(intent.id);
            logger.info(`[Intent] due ${intent.type} cancelled with notice: ${intent.content.slice(0, 30)}`);
            continue;
          }
          // fulfill（或延期超限强制兑现）
          const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, decision.content || intent.content);
          if (ok) {
            this.memoryManager.completeIntent(intent.id);
            logger.info(`[Intent] due ${intent.type} fulfilled → completed: ${intent.content.slice(0, 40)}`);
          } else {
            logger.info(`[Intent] due ${intent.type} push failed, keep pending: ${intent.content.slice(0, 40)}`);
          }
        } catch (err: any) {
          logger.warn(`[Intent] due ${intent.type} processing failed, keep pending: ${err.message}`);
        }
      }
    } catch (err: any) {
      logger.warn(`[Intent] due scan failed: ${err.message}`);
    }
  }

  /** ★ 8-28 承诺裁决（promise-obligation-loop）：调 generateIntentMessage 裁决回调，
   *  输入承诺原文/内容/当前状态/延期次数 → 返回 {action: fulfill|defer|cancel, content, delay_hours?}。
   *  解析失败 → 兜底 fulfill（推原文，不丢承诺）。 */
  private async decideIntent(intent: { id: string; type: string; content: string; evidence: string; deferCount: number }): Promise<{ action: 'fulfill' | 'defer' | 'cancel'; content?: string; delayHours?: number }> {
    const fallback = { action: 'fulfill' as const, content: intent.content };
    try {
      if (!this.opts.generateIntentMessage) return fallback;
      const snapshot = this.memoryManager.getLifeSnapshot();
      const ctx = [
        `【你当初的承诺】${intent.evidence || intent.content}`,
        `【承诺内容】${intent.content}`,
        `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
        intent.deferCount > 0 ? `【已延期次数】${intent.deferCount} 次（最多 2 次，第 3 次到期必须兑现或取消）` : '',
        intent.type === 'delayed-reply' ? '这是你答应过"想想再答复"的事——此刻该给轻月一个答复了。' : '这是你答应过轻月的承诺——此刻该兑现了。',
      ].join('\n');
      const raw = ((await this.opts.generateIntentMessage(ctx)) ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return fallback;
      const action = ['fulfill', 'defer', 'cancel'].includes(String(parsed.action)) ? parsed.action as 'fulfill' | 'defer' | 'cancel' : 'fulfill';
      return {
        action,
        content: typeof parsed.content === 'string' && parsed.content.trim() ? parsed.content.trim().slice(0, 200) : undefined,
        delayHours: Number(parsed.delay_hours) > 0 ? Math.max(1, Math.min(72, Number(parsed.delay_hours))) : undefined,
      };
    } catch (err: any) {
      logger.warn(`[Intent] decide failed, fallback fulfill: ${err.message}`);
      return fallback;
    }
  }

  // ── ★ 8-27 对话余波（conversation-follow-up 简化）──────────────

  /** 聊完天 15min 后（窗口 15min-3h）且最近 3h 无余波 → 生成 internal 余波（origin='followup'，不推送）。
   *  余波回写记忆、参与 mood_value 与在场推导，让角色的生活与对话自然衔接。 */
  private async maybeGenerateFollowUp(now: Date): Promise<void> {
    try {
      const since24h = new Date(now.getTime() - 24 * 3_600_000);
      const msgs = this.memoryManager.getRecentMessages(this.sessionId(), 200, since24h)
        .filter((m: any) => m.role === 'user') as Array<{ createdAt: string; content: string }>;
      if (msgs.length === 0) return;
      // 最近一条 user 消息（无 createdAt 的 mock/异常行 → 跳过，不误触）
      let last = msgs[0];
      for (const m of msgs) if (new Date(m.createdAt) > new Date(last.createdAt)) last = m;
      const lastTime = new Date(last.createdAt).getTime();
      if (!Number.isFinite(lastTime)) return;
      const minutesSince = (now.getTime() - lastTime) / 60_000;
      if (minutesSince < 15 || minutesSince > 180) return; // 15min 后才生成，超 3h 窗口关闭

      // 最近 3h 已有余波 → 跳过（去重）
      const since3h = new Date(now.getTime() - 3 * 3_600_000).toISOString();
      const recentFollowUps = (this.memoryManager.listLifeEvents(1) as any[])
        .filter((e: any) => e.origin === 'followup' && e.createdAt >= since3h);
      if (recentFollowUps.length > 0) return;

      const evt = await this.generateEvent(false, undefined, true);
      if (!evt) return;
      this.memoryManager.recordLifeEvent({
        type: 'internal',
        content: evt.content,
        moodDelta: evt.mood_delta,
        referenceEventId: evt.reference_event_id,
        wbEntryId: evt.wb_entry_id,
        origin: 'followup',
      });
      this.updatePresenceFromEvent(evt.content);
      this.updateMoodValue(evt.mood_shift, now);
      await this.writebackToMemory(evt.content);
      logger.info(`[Life] follow-up event: ${evt.content.slice(0, 50)}`);
    } catch (err: any) {
      logger.warn(`[Life] follow-up generation failed: ${err.message}`);
    }
  }

  /** owner 私聊会话 ID */
  private sessionId(): string {
    return `qq-official-1:private:private_${this.opts.ownerOpenid}`;
  }

  /** 回写主动消息到 EventStore（assistant 角色）。
   *  ★ 8-28 视角标记（memory-character-perspective）：生活事件标 perspective='self'——
   *  向量检索可区分"昔涟自己的生活"与"和用户的互动" */
  private async writebackToMemory(content: string): Promise<void> {
    try {
      await this.memoryManager.ingest({
        id: `life-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        session_id: this.sessionId(),
        source: 'chat',
        type: 'message',
        payload: { content, role: 'assistant' },
        importance: 0.3,
        created_at: new Date().toISOString(),
        processed: 0,
        perspective: 'self',
      });
      logger.debug('[Life] written back to memory (assistant, perspective=self)');
    } catch (err: any) {
      logger.warn(`[Life] writeback failed: ${err.message}`);
    }
  }

  // ── 事件生成 ────────────────────────────────────────

  /** ★ 8-27 叙事化重构：生成事件 = 组装 context（在场/心情/约束）→ LLM → post-check 7 条 →
   *  不过则带反馈重试 1 次 → 仍不过回落模板。LLM 失败同样回落模板。
   *  @param followUp - 对话余波模式（origin='followup'，只记录不推送） */
  private async generateEvent(deepNight: boolean, retryFeedback?: string, followUp = false): Promise<{
    content: string; type: 'chat' | 'internal'; mood_delta?: string;
    /** ★ 8-27 情绪净变化 -5..+5（mood_value 累积用，非法按 0） */
    mood_shift?: number;
    reference_event_id?: string; wb_entry_id?: string;
    /** 8-09：LLM 建议的下一事件间隔（小时，0.5-8，钳制在 tick） */
    next_in_hours?: number;
    /** 8-09：延续的上一事件 id（须命中今天事件 ID 集合） */
    continuation_of?: string;
    /** ★ 8-27 Agency Window：此刻是否方便联系轻月（false → 降级 internal 不推送） */
    can_contact?: boolean;
    /** ★ 8-29 事件/对话拆分（life-event-message-split）：type=chat 时对轻月说的话
     *  （第二人称/口语/互动感）——推送 message,content 只是生活叙述入库 */
    message?: string;
    /** ★ 8-28 意图（ai-life-intent-system）：can_contact=false 时存 intent，delay 后重查推送 */
    intent?: { type: 'proactive-contact'; delayHours: number; content: string };
    /** ★ 8-27 模板回落标记：模板事件不参与 post-check（非 LLM 输出） */
    fromTemplate?: boolean;
  } | null> {
    const snapshot = this.memoryManager.getLifeSnapshot();

    // ★ 剧情链（spec §8）：近 24h 滑动窗口（life-schedule-renewal 8-30——跨 0 点连续性：
    //   23:00 睡下 → 0:30 触发时仍看得到），事件逐条带 [id: life-xxx] 注入（LLM 只能引用窗口内事件），
    //   近 7 天摘要不带 ID（summary 行仅作回顾，不可被引用）
    const todayKey = localDateKey();
    const windowEvents = this.memoryManager.listLifeEvents(1); // ASC，天然 24h 窗口
    const windowIds: Set<string> = new Set(windowEvents.map((e: any) => e.id));
    const windowLines = windowEvents.slice(-8).map((e: any) => {
      // 跨天日期标注：今天的只标时间，昨天的标"昨天 HH:MM"（24h 窗口最多跨 1 天）
      const isToday = localDateKeyFromISO(e.createdAt) === todayKey;
      const time = formatLocalTime(new Date(e.createdAt)).slice(-5);
      return `[id: ${e.id}] ${isToday ? time : `昨天${time}`} ${String(e.content).slice(0, 60)}`;
    });
    const summaries = this.memoryManager.listLifeSummaries(7)
      .filter((s: any) => s.date !== todayKey)
      .map((s: any) => `- ${s.date}: ${s.summary}`);
    const todayBlock = [...windowLines, ...summaries].join('\n');

    // ★ 8-28 间隔叙事（life-interval-narrative）：最近事件 = 生活起点——事件覆盖
    //   "从上次事件到现在"的时间（不再只写此刻瞬间）；8h 内 internal 同时承担延续候选
    const lastEventBlock = this.buildLastEventBlock(windowIds);

    // ★ 8-29 世界观底色:统一字段(与聊天 persona 注入同一数据源)
    const worldviewBlock = this.memoryManager.getWorldviewBlock?.() ?? '';

    // ★ 8-29 独立人格:她惦记的事(未完成的 promise/proactive intent)——愿望驱动生活
    let pendingIntentBlock = '';
    try {
      pendingIntentBlock = (this.memoryManager.listDueIntents(Date.now() + 24 * 3_600_000) as any[])
        .filter((i: any) => i.type === 'proactive-contact' || i.type === 'promise')
        .slice(0, 2)
        .map((i: any) => `- ${i.content.slice(0, 50)}`)
        .join('\n');
    } catch { /* non-fatal */ }

    // ★ 世界书背景（spec §7 ①）：行格式带 [wb: wb_xxx]，LLM 引用时返回 wb_entry_id
    //   ★ 8-27 分层随机已下沉到 getWorldbookSample（life_event 3 + text 2，截断 200）
    const wbSample = this.memoryManager.getWorldbookSample(5);
    const wbIds = new Set(wbSample.map((w: any) => w.id));
    const wbBlock = wbSample.map((w: any) => `- [wb: ${w.id}] ${w.content}`).join('\n');

    // ★ 8-27 在场角色（ScenePresence）：只有在场者可与 LLM 生活交集
    const presentNames = this.memoryManager.listPresentCharacters() as string[];
    const presenceBlock = presentNames.length === 0
      ? '此刻只有你一个人，安安静静的——不要凭空召唤其他角色'
      : `这些配角此刻在你身边/可互动（只与他们交集，列表外的一律不出现）：\n${presentNames.map(n => `- ${n}`).join('\n')}`;

    // ★ 8-27 心情块（情绪惯性）：mood_value 极性 + 8-29 mood_note 氛围描述影响事件风格
    const moodBlock = this.buildMoodBlock(snapshot.moodValue ?? 0, snapshot.moodNote ?? '');

    // ★ 今天已主动联系内容（ProactiveService 感知，避免重复打扰）
    const todayActive = this.opts.todayProactive?.() ?? '';

    const context = [
      `【当前时间】${formatLocalTime()}——这是权威时辰,事件内容必须贴合它(现在是几点就写几点的生活:深夜写深夜,清晨写清晨,不要错位)`,
      // ★ 8-29 世界观底色统一字段；★ 8-30 集中化(worldview-centralize)：全文引用唯一数据源,
      //   引导句已在 worldview.md 各节内(使用引导)——修改公共底色只改 persona/worldview.md
      worldviewBlock ? `【世界观底色】${worldviewBlock}` : '',
      // ★ 8-29 特定时间/节日:事件生成自然带节日氛围或对轻月的节日心意(不再是独立打卡)
      this.opts.todaySpecial?.() ? `【今天是什么日子】今天是${this.opts.todaySpecial()}——事件可以自然带上节日的气息,如果想到轻月,节日的分享可以是事件的一部分。` : '',
      // ★ 8-29 触发时间联动(日常状态决定下次事件何时来——实测 LLM 全给默认值,明确映射修正)
      '【间隔建议】next_in_hours 由你此刻的状态决定,不要给固定值:正沉浸在一件事里(书没看完/活没干完)→ 3-8h;刚做完事、有点无聊、或想找轻月聊天 → 0.5-2h;忙手头的事但想到了轻月 → 2-4h。',
      `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
      `【心情】${moodBlock}`,
      `【亲密度】与轻月: ${snapshot.intimacy}/100`,
      // ★ 2026-10-20（tie-intimacy-to-speech）：**只给事实**——档位、他多久没说话、
      //   以及两个一次性信号（问一次在忙吗 / 他回来了）。情绪留给她自己写。
      `【你和轻月】${this.relationshipBlock(new Date())}`,
      `【今天的生活】${todayBlock || '（还没有特别的事）'}`,
      `【你的人设背景】${wbBlock || '（暂无）'}`,
      `【在场角色】${presenceBlock}`,
      // ★ 8-29 独立人格:移除【轻月最近】(她的生活不围绕轻月)——轻月只在 chat 分享/偶发想念中出现
      // 【你惦记的事】(未完成的 intent):她的愿望驱动生活,不是随机开新
      pendingIntentBlock ? `【你惦记的事】${pendingIntentBlock}——这些是你自己惦记的事,可以自然地推进它们。` : '',
      // ★ 8-28 间隔叙事：上次事件 → 现在的生活补写（HDSI advance 式）
      lastEventBlock ? `【上次事件】${lastEventBlock}` : '',
      todayActive ? `【今天已主动联系】今天已经发过: ${todayActive}。请聚焦生活日常本身，不要生成同类问候/祝福内容。` : '',
      // ★ 8-28 深夜抑制关闭：深夜不再强制 internal——只提示时辰节奏，类型交 LLM 自然判断
      deepNight ? '【注意】现在是深夜，夜已深了——生活节奏安静下来（可能还在忙手头的事，也可能准备睡了）。' : '',
      // ★ 8-27 对话余波任务（followUp 模式）
      followUp ? '【任务】这是你刚和轻月聊完天后的片刻余波——此刻你的内心在想什么（1-2 句，第一人称内心独白）。不推送、不问候、不需要说给轻月听；安静地记录这一刻（如"想到刚才说的话，有点不好意思"）。' : '',
      // ★ 8-28 生活切片示范（life-event-micro-narrative）：平实具体的生活味参考——平凡物件、
      //   具体时辰、伴随小动作、小意外转折；拒绝纯文学意象堆砌
      '【生活切片示范】（参考这种"活人感"平实风格，不要照抄内容）\n"下午起风了，窗台的多肉被吹得晃。我起身去关窗，顺手把晾了三天没收的袜子收了——指尖碰到布料的潮意，才想起昨天忘收衣服。叠好放进柜子，又坐回沙发，茶几上那个苹果放了几天，皮有点皱了，我拿起来又放回去。"',
      // ★ 8-27 post-check 反馈重试
      retryFeedback ? `【修正提示】上次生成未通过校验：${retryFeedback}。请按提示重新生成。` : '',
    ].filter(Boolean).join('\n');

    try {
      // ★ 9-25 fix-session-summary-silent-failure：改用共用解析器
      //   （行为不变；额外多认一种输入——围栏前后带空白的响应）
      const r = parseLLMJson(await this.opts.generateEvent?.(context));
      if (r.kind === 'empty') throw new Error('empty response');
      if (r.kind === 'bare') {
        // ★ 8-09 裸文本容错：LLM 偶发输出无 JSON 外壳的自然语言（7-16 实测高质量剧情
        //   文本被 JSON.parse 丢弃 → fallback 模板推送 → 剧情链断裂）。
        //   裸文本直接作为事件内容；type 默认 chat（★ 8-28 深夜不再强制 internal）
        logger.info(`[Life] bare-text event from LLM (no JSON shell): ${r.text.slice(0, 100)}`);
        return { content: r.text, type: 'chat' };
      }
      const parsed: any = r.value;
      if (parsed.content) {
        // ★ 防幻觉（终审修复）：reference_event_id 必须命中今天事件 ID 集合，wb_entry_id 必须命中采样世界书 ID
        const refId = parsed.reference_event_id ? String(parsed.reference_event_id) : undefined;
        const wbId = parsed.wb_entry_id ? String(parsed.wb_entry_id) : undefined;
        const contId = parsed.continuation_of ? String(parsed.continuation_of) : undefined;
        const nextHours = Number(parsed.next_in_hours);
        // ★ 8-27 mood_shift 钳制 -5..+5（非法忽略）；can_contact 默认 true
        const shift = Number(parsed.mood_shift);
        // ★ 8-28 意图解析（ai-life-intent-system）：事件 JSON intent 字段 → 存 intent 重查
        //   ★ 8-29 拆分：intent.content 缺失时用 message（对轻月说的话）兜底
        const intent = parsed.intent;
        const parsedIntent = intent && typeof intent === 'object' && intent.type === 'proactive-contact'
          ? {
              type: 'proactive-contact' as const,
              delayHours: Math.max(0.5, Math.min(72, Number(intent.delay_hours) || 1)),
              content: String(intent.content ?? parsed.message ?? '').trim(),
            }
          : undefined;
        return {
          content: String(parsed.content).trim(),
          // ★ 8-28 深夜抑制关闭：type 完全交 LLM（深夜也可以是想分享的话，can_contact 兜底）
          type: parsed.type === 'chat' ? 'chat' : 'internal',
          mood_delta: parsed.mood_delta ? String(parsed.mood_delta) : undefined,
          mood_shift: isFinite(shift) ? Math.max(-5, Math.min(5, Math.round(shift))) : undefined,
          reference_event_id: refId && windowIds.has(refId) ? refId : undefined,
          wb_entry_id: wbId && wbIds.has(wbId) ? wbId : undefined,
          // 8-09：next_in_hours 钳制在 tick（intervalMs）；continuation_of 须命中窗口内事件
          next_in_hours: isFinite(nextHours) ? nextHours : undefined,
          continuation_of: contId && windowIds.has(contId) ? contId : undefined,
          can_contact: parsed.agency?.can_contact === false ? false : true,
          // ★ 8-29 事件/对话拆分：message = 对轻月说的话(仅 chat 时有效,截断 200)
          message: parsed.type === 'chat' && parsed.message ? String(parsed.message).trim().slice(0, 200) : undefined,
          intent: parsedIntent,
        };
      }
    } catch (err: any) {
      logger.warn(`[Life] LLM event generation failed, fallback to template: ${err.message}`);
    }

    // 失败回落：通用模板加权随机（无角色特色；角色特色事件由 LLM 结合世界书自创）
    // ★ 8-09 修复：模板事件强制 internal——模板文案无剧情链，推送会造成"上下文断裂"
    //   观感（7-16 实测用户收到"听到楼下琴声"与画云剧情链脱节）
    // ★ 8-27 在场角色组优先（在场无迷迷 → 不回落"迷迷"组模板）
    const t = this.pickTemplate(presentNames);
    if (t) return { content: t.activity, type: 'internal', mood_delta: '平静', can_contact: false, fromTemplate: true };
    return null;
  }

  // ── ★ 8-27 情绪惯性（mood_value）───────────────────

  /** 【心情】块：mood_value 极性 + ★ 8-29 侧端分析 mood_note（深度阈值后的描述性氛围） */
  private buildMoodBlock(mv: number, moodNote: string = ''): string {
    const note = moodNote ? `；${moodNote}` : '';
    if (mv >= 15) return `情绪累积: +${mv}（最近心情偏开心——事件可以明亮、有暖意）${note}`;
    if (mv <= -15) return `情绪累积: ${mv}（最近心情偏低沉——事件可以安静、柔软一些）${note}`;
    return `情绪累积: ${mv}（心情平稳）${note}`;
  }

  /** mood_value 累积：同方向加成 / 反方向衰减 / 8h 回归 0（按事件间隔线性回归）。
   *  shift -5..+5（来自事件 JSON mood_shift，非法按 0）。联动 mood 文本极性。 */
  private updateMoodValue(shift?: number, now: Date = new Date()): void {
    try {
      const snapshot = this.memoryManager.getLifeSnapshot();
      const prevVal = snapshot.moodValue ?? 0;
      const prevPolar = prevVal >= 15 ? 'pos' : prevVal <= -15 ? 'neg' : 'flat';
      let mv = prevVal;
      const lastAt = snapshot.updatedAt ? new Date(snapshot.updatedAt).getTime() : 0;
      // 8h 回归：距上次 mood 更新 elapsed → 向 0 线性回归（满 8h 归 0）
      if (lastAt > 0) {
        const elapsed = Math.min(1, (now.getTime() - lastAt) / (8 * 3_600_000));
        if (elapsed > 0) mv = Math.round(mv - mv * elapsed);
      }
      const s = Math.max(-5, Math.min(5, Math.round(shift ?? 0)));
      if (s !== 0) {
        if (mv > 0 && s < 0) mv = Math.round(mv * 0.5) + s;   // 反方向：先衰减再反向
        else if (mv < 0 && s > 0) mv = Math.round(mv * 0.5) + s;
        else mv = mv + Math.round(s * 1.5);                    // 同方向加成
      }
      mv = Math.max(-100, Math.min(100, mv));
      // mood 文本联动极性（与 LifeView 心情映射兼容：平静/开心/低落）
      const moodText = mv >= 15 ? '开心' : mv <= -15 ? '低落' : '平静';
      // ★ 8-29 侧端分析（mood-side-analysis）：深度阈值 |mv|≥30 且 6h 冷却 → fire-and-forget
      //   生成描述性氛围 mood_note；回落到 |mv|<30 → 清空
      let moodNote = snapshot.moodNote ?? '';
      if (Math.abs(mv) >= 30 && !moodNote && now.getTime() - this.state.moodNoteAnalyzedAt > 6 * 3_600_000) {
        this.state.moodNoteAnalyzedAt = now.getTime();
        this.saveState();
        this.analyzeMoodNote(mv, now); // fire-and-forget
      } else if (Math.abs(mv) < 30 && moodNote) {
        moodNote = '';
        logger.info('[Life] mood_note cleared (|mood_value| < 30)');
      }
      this.memoryManager.updateLifeState({ moodValue: mv, mood: moodText, moodNote });
      // ★ 8-28 情绪惯性漂移（memory-character-perspective）：极性跨 ±15 阈值变化 →
      //   触发人格自然漂移（连续开心 → playfulness、连续低落 → empathy，走 5 道护栏）
      const newPolar = mv >= 15 ? 'pos' : mv <= -15 ? 'neg' : 'flat';
      if (prevPolar !== newPolar && newPolar !== 'flat') {
        const applied = this.memoryManager.adjustPersonaFromMood?.(mv) ?? false;
        logger.info(`[Life] mood polarity ${prevPolar} → ${newPolar} (mood_value ${snapshot.moodValue} → ${mv}): persona drift ${applied ? 'applied' : 'blocked by guards'}`);
      }
      logger.debug(`[Life] mood_value ${snapshot.moodValue} → ${mv} (shift ${s})`);
    } catch (err: any) {
      logger.warn(`[Life] mood_value update failed: ${err.message}`);
    }
  }

  /** ★ 8-29 情绪侧端分析（mood-side-analysis）：mood_value 深度阈值后,LLM 根据最近生活
   *  生成一句描述性氛围（"这段日子…"），注入【心情】块影响事件风格与对话。失败不阻塞（冷却后重试）。 */
  private async analyzeMoodNote(mv: number, now: Date): Promise<void> {
    try {
      if (!this.opts.generateMoodNote) return;
      const recentEvents = (this.memoryManager.listLifeEvents(2) as any[])
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5)
        .map((e: any) => `- ${e.content.slice(0, 50)}`)
        .join('\n');
      const note = ((await this.opts.generateMoodNote(
        `【当前情绪累积】${mv}（正=开心，负=低落）\n【最近的生活】\n${recentEvents || '（暂无）'}\n请用一句 30 字以内的话描述这段日子你的情绪氛围（第一人称，自然，如"这段日子心里像落了雨，做什么都提不起劲"；也可以写暖的）。`,
      )) ?? '').trim().slice(0, 60);
      if (note) {
        this.memoryManager.updateLifeState({ moodNote: note });
        logger.info(`[Life] mood_note: ${note}`);
      } else {
        logger.info('[Life] mood_note analysis returned empty, will retry after cooldown');
      }
    } catch (err: any) {
      logger.warn(`[Life] mood_note analysis failed: ${err.message}`);
    }
  }

  // ── ★ 8-27 配角在场（ScenePresence）─────────────────

  /** 世界书配角名单：事件内容提到谁 → 在场推导；post-check ⑦ 校验不在场角色不出现 */
  private static KNOWN_CHARS = [
    '迷迷', '风堇', '遐蝶', '白厄', '那刻夏', '万敌',
    '三月七', '丹恒', '开拓者', '荒笛', '来古士', '德谬歌',
  ] as const;

  /** 事件入库后：内容提到谁 → present（带依据）；随后巡检 present 超 24h 无更新 → off-scene */
  private updatePresenceFromEvent(content: string): void {
    try {
      for (const name of LifeService.KNOWN_CHARS) {
        if (content.includes(name)) {
          this.memoryManager.upsertScenePresence(name, 'present', content.slice(0, 50));
        }
      }
      // 巡检：在场角色 24h 无提及 → 降级离场（生活自然推移）
      const now = Date.now();
      const presence = this.memoryManager.listScenePresence() as Array<{ name: string; status: string; updatedAt: string }>;
      for (const p of presence) {
        if (p.status === 'present' && now - new Date(p.updatedAt).getTime() > 24 * 3_600_000) {
          this.memoryManager.upsertScenePresence(p.name, 'off-scene');
          logger.debug(`[Life] ${p.name} left scene (24h no mention)`);
        }
      }
    } catch (err: any) {
      logger.warn(`[Life] presence update failed: ${err.message}`);
    }
  }

  // ── ★ 8-27 post-check 7 条校验 ─────────────────────

  /** 生成后规则校验；返回 { ok, feedback }。不过 → 带反馈重试 1 次 → 回落模板 */
  private postCheck(
    evt: { content: string; type: string; message?: string },
    todayEvents: Array<{ content: string; type: string }>,
    presentNames: string[],
  ): { ok: boolean; feedback: string } {
    const c = evt.content.trim();
    // ① 长度 ≤ 150 字（★ 8-28 微叙事放宽：2-4 句生活切片，原 80 字只够一句快照）
    if (c.length > 150) return { ok: false, feedback: '内容超过 150 字，收成一个生活小片段（2-4 句）' };
    // ② 不硬设定：设定词条黑名单（生活事件里出现即生硬罗列）
    const HARD_SETTING_WORDS = ['黄金裔', '火种', '泰坦', '铁幕', '轮回', '因子', '神权', '负世', '岁月'];
    for (const w of HARD_SETTING_WORDS) {
      if (c.includes(w)) return { ok: false, feedback: `不要生硬罗列设定词"${w}"，把背景融入生活细节` };
    }
    // ③ 对话感：chat 是分享不是报备
    if (evt.type === 'chat') {
      const REPORT_WORDS = ['汇报', '通知', '特此', '以下是', '综上所述'];
      for (const w of REPORT_WORDS) {
        if (c.includes(w)) return { ok: false, feedback: '这是对轻月的分享不是报备，去掉公文腔' };
      }
    }
    // ④ 不重复：与今天已有事件（完全相同/前 20 字相同——★ 8-28 微叙事变长，前 12 字误判率高）
    for (const e of todayEvents) {
      const a = e.content.slice(0, 20), b = c.slice(0, 20);
      if (e.content === c || (a && b && a === b)) {
        return { ok: false, feedback: '与今天已有事件重复，换一件不一样的事' };
      }
    }
    // ⑤ 不连续独处：已有连续 ≥3 internal 且本事件仍 internal → 提示互动
    if (evt.type === 'internal' && todayEvents.length >= 3) {
      let streak = 0;
      for (let i = todayEvents.length - 1; i >= 0 && todayEvents[i].type === 'internal'; i--) streak++;
      if (streak >= 3) return { ok: false, feedback: '最近一直在独处，试着写一件和在场角色或轻月的互动' };
    }
    // ⑥ 不引用对话：引号包裹的直接引用 / "你说…""你刚才…"
    if (/[「」""''【】]/.test(c) || /你说|你刚才|你上次/.test(c)) {
      return { ok: false, feedback: '不要引用与轻月的对话内容，过自己的生活' };
    }
    // ⑦ 不在场角色不出现：内容提到的配角必须在场列表内
    const present = new Set(presentNames);
    for (const name of LifeService.KNOWN_CHARS) {
      if (c.includes(name) && !present.has(name)) {
        return { ok: false, feedback: `"${name}"此刻不在场，不要让他/她出现` };
      }
    }
    // ⑧ ★ 8-29 独立人格：internal 事件的动机围绕自己（我想/我需要/我好奇）——
    //   等/为/怕/担心"轻月"是围绕用户,想念只是偶发底色不是事件动机
    if (evt.type === 'internal' && /等(轻月|你)回来|为(轻月|你)|怕(轻月|你)|担心(轻月|你)/.test(c)) {
      return { ok: false, feedback: '这件事的动机应该是你自己（我想/我需要/我好奇），不是围绕轻月——想念只是偶发的底色，不要让它成为每件事的理由' };
    }
    // ⑨ ★ 8-29 拆分：chat 的 message 是对轻月说话——第二人称、口语互动，不是叙述
    if (evt.type === 'chat' && evt.message) {
      const m = evt.message.trim();
      if (m.length > 150) return { ok: false, feedback: 'message（对轻月说的话）超过 150 字，收成一句自然的分享' };
      if (m === c) return { ok: false, feedback: 'message 不能是 content 的复述——message 是对轻月说话（第二人称口语），content 是生活叙述' };
      if (m.includes('她') && !m.includes('他')) {
        return { ok: false, feedback: 'message 是对轻月说话，要用"你"（第二人称），不要用"她"叙述' };
      }
    }
    return { ok: true, feedback: '' };
  }

  /** ★ 8-28 间隔叙事（life-interval-narrative，替代 8-09 延续块）：
   *  最近事件 = 生活起点。事件覆盖"从上次事件到现在"的时间——
   *  - 8h 内 internal 且 30min 无互动 → 同时是延续候选（continuation_of 引导，todayIds 放行）
   *  - 其他 → 间隔补写引导（进展/变化/被打断，停在哪里）
   *  返回形如 "10:00 你在: 泡茶…\n现在距上次事件已过 4 小时——覆盖这中间的时间…" 的引导块；无事件返回空。 */
  private buildLastEventBlock(windowIds: Set<string>): string {
    try {
      const events = (this.memoryManager.listLifeEvents(2) as any[])
        .filter((e: any) => e.origin !== 'followup')
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const latest = events[0];
      if (!latest) return '';
      const lastAt = new Date(latest.createdAt);
      const hoursGap = Math.max(0, Math.round((Date.now() - lastAt.getTime()) / 3_600_000 * 10) / 10);

      // 延续候选：8h 内 internal 且 30min 无用户互动（聊天后重置沉浸）
      // ★ 8-30 链限制（life-schedule-renewal）：连续 internal ≥3 → 强制开新事——
      //   1h 保底节奏下 8h 窗口能续 8 次,会流水账(同一件事写 8 小时)。零迁移近似:
      //   continuation_of 未持久化,用连续 internal 链长近似(她沉浸做的事通常是 internal 流)
      const lockMinutes = this.opts.chatLockMinutes ?? 30;
      const recent = this.memoryManager.getRecentMessages(
        this.sessionId(), 100, new Date(Date.now() - lockMinutes * 60_000),
      ).filter((m: any) => m.role === 'user');
      let internalStreak = 0;
      for (const e of events) {
        if (e.type !== 'internal') break;
        internalStreak++;
      }
      const canContinue = latest.type === 'internal'
        && Date.now() - lastAt.getTime() < 8 * 3_600_000
        && recent.length === 0
        && internalStreak < 3;
      if (canContinue) {
        // ★ 8-30 窗口化后 latest 天然在 windowIds 里(24h 内),不再需要跨午夜 hack
        const time = formatLocalTime(lastAt);
        return `${time} 你正在: ${latest.content.slice(0, 60)}\n优先续写推进这件事——它有什么进展、波折或变化（快做完了/卡住了/被别的事打断）；只有当它自然做完了，才开启新的事。续写时 JSON 里 continuation_of 填该事件 id（${latest.id}），开新事则不填。`;
      }
      const time = formatLocalTime(lastAt);
      // ★ 8-30 补写强度随间隔渐变（life-schedule-renewal）：短间隔"此刻即间隔"(1h 里她就是连续
      //   做同一件事,此刻 = 间隔的全部);中间隔轻引导;长间隔(沉浸/重启)重补写——幕间 advance
      //   语义不变(每个事件覆盖间隔),只是短间隔不诱导编造
      const gapNote = hoursGap >= 1 ? `（已过 ${hoursGap} 小时）` : '';
      if (hoursGap > 2) {
        return `${time} 你上次在做: ${latest.content.slice(0, 60)}${gapNote}\n事件要覆盖从上次事件到现在的时间——这中间你经历了什么（进展/变化/被打断/小波折）？现在正停在哪里？不要只写此刻的一瞬间。`;
      }
      if (hoursGap > 1) {
        return `${time} 你上次在做: ${latest.content.slice(0, 60)}${gapNote}\n如果这件事有进展或变化,自然地带上它;没有就写此刻正在发生的事。`;
      }
      return `${time} 你上次在做: ${latest.content.slice(0, 60)}\n此刻自然延续它,或自然地开启一件新的事——写当下正在发生的,不必回头补述。`;
    } catch {
      return '';
    }
  }

  /** ★ 8-14 加权随机模板（权重越高越常被选中）；空池返回 null。
   *  模板池迁 SQLite（content-self-evolution）：listLifeTemplates 实时读取（seed + self）。
   *  ★ 8-27 在场角色组优先：在场者对应的 group_name 模板优先；无 → 独处/通用池。 */
  private pickTemplate(presentNames: string[] = []): { activity: string; type: 'chat' | 'internal'; category: string } | null {
    const templates = this.memoryManager.listLifeTemplates() ?? [];
    if (templates.length === 0) return null;
    const present = new Set(presentNames);
    const groupPool = templates.filter((t: any) => t.groupName !== 'none' && present.has(t.groupName));
    const pool = groupPool.length > 0
      ? groupPool
      : templates.filter((t: any) => t.category === '独处' || t.groupName === 'none');
    const total = pool.reduce((s: number, t: any) => s + (t.weight ?? 2), 0);
    let r = Math.random() * total;
    for (const t of pool) {
      r -= (t.weight ?? 2);
      if (r <= 0) return t;
    }
    // 数学上不可达：r < total 恒成立（Math.random() ∈ [0,1)），循环内必命中。
    // 保留返回值以满足 TS 控制流分析。
    return pool[0];
  }

  // ── 每日摘要生成 ────────────────────────────────────

  private async maybeGenerateDailySummary(now: Date): Promise<void> {
    const today = localDateKey(now);
    if (this.state.lastSummaryDate === today) return;
    // ★ 2026-10-20：日上限计数已改由 `resetDailyPushCount` **按日期**复位，
    //   与摘要成败解耦（原实现挂在这里，摘要失败时每 tick 清零）。
    // ★ 终审修复：摘要走独立 generateSummary 纯文本回调（generateEvent 强制 JSON，
    //   复用会把摘要存成 JSON 文本污染摘要层）。无回调则跳过（降级），不置位以便后续可恢复。
    if (!this.opts.generateSummary) return;

    // 昨天的摘要（如果有昨天的事件）
    const yesterday = new Date(now.getTime() - 86_400_000);
    const yesterdayKey = localDateKey(yesterday);
    const events = this.memoryManager.listLifeEvents(2).filter((e: any) => localDateKeyFromISO(e.createdAt) === yesterdayKey);
    if (events.length === 0) return;

    try {
      const text = (await this.opts.generateSummary(
        `【任务】把下面这些生活事件压缩成一句 30 字以内的昨天生活摘要，第一人称，温柔自然：\n${events.map((e: any) => `- ${e.content}`).join('\n')}`,
      )) ?? '';
      // 剥 markdown fence（LLM 可能包 ```json），剥引号；若仍是 JSON 对象则取 content 字段——杜绝 JSON 文本入库
      let summary = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      try {
        const parsed = JSON.parse(summary);
        if (parsed && typeof parsed.content === 'string') summary = parsed.content.trim();
      } catch { /* 纯文本摘要，无需解析 */ }
      summary = summary.replace(/^["'`]+|["'`]+$/g, '').trim();

      if (summary && summary.length > 5) {
        this.memoryManager.upsertDailySummary(yesterdayKey, summary);
        // ★ 成功生成并入库后才置位——LLM 失败保持未置位，下次 tick 自动重试（终审修复）
        this.state.lastSummaryDate = today;
        this.saveState();
        logger.info(`[Life] daily summary ${yesterdayKey}: ${summary}`);
      }
    } catch (err: any) {
      logger.warn(`[Life] daily summary failed: ${err.message}`);
    }
  }

  // ── ★ 8-31 每日反思（life-reflection-loop）──────────────────────
  //   L3 自修改执行器：她复盘自己的一天（事件流+情绪+当前人格）→ LLM 反思
  //   → adjustments 走护栏调人格参数 / insight 进画像 / reflection 存 state。
  //   冷却：跨天触发一次；失败不置位（次日重试）。

  private async maybeDailyReflection(now: Date): Promise<void> {
    const today = localDateKey(now);
    if (this.state.reflectionDate === today) return;
    if (!this.opts.generateReflection) return;

    // 反思材料：近 24h 事件流 + 情绪 + 当前人格 + 近 3 天摘要
    const events = this.memoryManager.listLifeEvents(1) as any[];
    const snapshot = this.memoryManager.getLifeSnapshot?.() ?? {};
    const persona = this.memoryManager.getPersonaSnapshot?.() ?? {};
    const summaries = (this.memoryManager.listLifeSummaries?.(3) ?? [])
      .map((s: any) => `- ${s.date}: ${s.summary}`).join('\n');
    if (events.length === 0 && !summaries) return; // 一天什么都没有，没什么可反思的

    const ctx = [
      `【今天的生活】${events.slice(-8).map((e: any) => `- ${e.content.slice(0, 60)}`).join('\n') || '（今天还没有特别的事）'}`,
      summaries ? `【近三天】${summaries}` : '',
      `【情绪】mood_value: ${snapshot.moodValue ?? 0} / ${snapshot.moodNote || '（无氛围描述）'}`,
      `【当前人格参数】tone: ${JSON.stringify(persona.tone ?? {})} / speech_style: ${JSON.stringify(persona.speechStyle ?? {})} / emotional_range: ${JSON.stringify(persona.emotionalRange ?? {})}`,
      `【任务】以昔涟的视角回顾这一天——我是什么样的？哪些处理方式让我舒服/不舒服？有没有"下次不这样了"的念头？`,
    ].filter(Boolean).join('\n');

    try {
      // ★ 9-25 fix-session-summary-silent-failure：共用解析器（行为不变）
      const r = parseLLMJson(await this.opts.generateReflection(ctx));
      if (r.kind === 'empty') { logger.warn('[Reflection] empty response, will retry next day'); return; }
      // 裸文本容错：只有反思，无调整/洞察
      const parsed: any = r.kind === 'json' ? r.value : { reflection: r.text };
      const result = this.memoryManager.recordReflection?.({
        reflection: String(parsed.reflection ?? '').trim(),
        adjustments: Array.isArray(parsed.adjustments) ? parsed.adjustments : [],
        insight: parsed.insight ? String(parsed.insight).trim() : undefined,
      });
      // 成功应用（至少反思/洞察/调整之一落地）→ 置位；LLM 失败保持未置位次日重试
      if (result && (result.reflectionSaved || result.insightAdded || result.appliedAdjustments > 0)) {
        this.state.reflectionDate = today;
        this.saveState();
      }
      logger.info(`[Reflection] ${today}: ${String(parsed.reflection ?? '').slice(0, 60)}`);
    } catch (err: any) {
      logger.warn(`[Reflection] daily reflection failed: ${err.message}`);
    }
  }

  /**
   * ★ 2026-10-21（change: `add-daily-diary`）：跨天写一篇日记。
   *
   * 与 `maybeDailyReflection` 的分工见 `LIFE_DIARY_PROMPT` 注释：
   * 反思是 JSON、驱动人格、只有她自己看；日记是纯文本、会**进博客**。
   *
   * 三条刻意的约束：
   * ① `date` 取**昨天**（写的是刚过去的那一天），与 reflection 的 today 判据分开
   * ② 失败**不置位** → 下一次 tick 会重试（同 reflection；别让一次 LLM 超时吃掉一整天）
   * ③ 一天什么都没有就**不写** —— 硬写就是编，日记最不能编
   */
  private async maybeDailyDiary(now: Date): Promise<void> {
    const today = localDateKey(now);
    if (this.state.diaryDate === today) return;
    if (!this.opts.generateDiary) return;

    const events = this.memoryManager.listLifeEvents(1) as any[];
    const snapshot = this.memoryManager.getLifeSnapshot?.() ?? {};
    const summaries = (this.memoryManager.listLifeSummaries?.(3) ?? [])
      .map((s: any) => `- ${s.date}: ${s.summary}`).join('\n');
    const tail = this.memoryManager.getLastDiaryTail?.() ?? '';
    if (events.length === 0 && !summaries) return;

    const ctx = [
      `【今天的事】${events.slice(-10).map((e: any) => `- ${e.content.slice(0, 80)}`).join('\n') || '（今天没有特别的事）'}`,
      summaries ? `【近三天】\n${summaries}` : '',
      `【心情】${snapshot.mood || '（无）'} / ${snapshot.moodNote || '（无氛围描述）'}`,
      tail ? `【上一篇的最后一句】${tail}` : '',
    ].filter(Boolean).join('\n');

    try {
      const text = String(await this.opts.generateDiary(ctx)).trim();
      if (!text) {
        logger.warn('[Diary] empty response, will retry next tick');
        return;
      }
      const date = localDateKey(new Date(now.getTime() - 86_400_000));
      this.memoryManager.saveDiary({
        date,
        content: text,
        mood: String(snapshot.mood ?? ''),
        moodValue: Number(snapshot.moodValue ?? 0),
      });
      this.state.diaryDate = today;
      this.saveState();
      logger.info(`[Diary] ${date}: ${text.slice(0, 40)}… (${text.length}字)`);
    } catch (err: any) {
      logger.warn(`[Diary] daily diary failed: ${err.message}`);
    }
  }

  /**
   * ★ 2026-10-21（change: `add-letters`）：每周问她一次"有没有想直接对他说的话"。
   *
   * 设计要点（三条，都比"能写信"重要）：
   * ① **允许不写**：LLM 回 `NONE` 是合法结果，照样置位（否则每个 tick 都会重问一遍）
   * ② **按 ISO 周去重**：`letterWeek` + 库里 `hasLetterForWeek` 双保险，
   *    进程重启后也不会一天连写几封
   * ③ 失败**不置位**：LLM 超时要能重试（同日记/反思）
   */
  private async maybeWeeklyLetter(now: Date): Promise<void> {
    if (!this.opts.generateLetter) return;
    const week = isoWeekKey(now);
    if (this.state.letterWeek === week) return;
    if (this.memoryManager.hasLetterForWeek?.(week)) {
      this.state.letterWeek = week;
      this.saveState();
      return;
    }

    const events = this.memoryManager.listLifeEvents(7) as any[];
    const snapshot = this.memoryManager.getLifeSnapshot?.() ?? {};
    const summaries = (this.memoryManager.listLifeSummaries?.(7) ?? [])
      .map((s: any) => `- ${s.date}: ${s.summary}`).join('\n');
    if (events.length === 0 && !summaries) return;

    const ctx = [
      `【这段日子】\n${events.slice(-14).map((e: any) => `- ${e.content.slice(0, 80)}`).join('\n') || '（没有特别的事）'}`,
      summaries ? `【近七天】\n${summaries}` : '',
      `【心情】${snapshot.mood || '（无）'} / ${snapshot.moodNote || '（无氛围描述）'}`,
    ].filter(Boolean).join('\n');

    try {
      const text = String(await this.opts.generateLetter(ctx)).trim();
      const nothingToSay = !text || /^NONE\b/i.test(text);

      if (nothingToSay) {
        this.state.letterWeek = week;
        this.saveState();
        logger.info(`[Letter] ${week}: 这周没有想直接说的话（NONE，正常）`);
        return;
      }

      this.memoryManager.saveLetter({
        date: localDateKey(now),
        content: text,
        mood: String(snapshot.mood ?? ''),
        week,
      });
      this.state.letterWeek = week;
      this.saveState();
      logger.info(`[Letter] ${week}: 写了一封（${text.length}字）`);
    } catch (err: any) {
      logger.warn(`[Letter] weekly letter failed: ${err.message}`);
    }
  }

  // ── 亲密度 ──────────────────────────────────────────
  /** 互动数据推导 0-100：频率 + 时长 + 主动占比。
   *  数据来自 getRecentMessages（近 7 天最多 500 条，附 createdAt）。
   *  ★ spec §11 衰减 + 审查修复：全部接 persona.memory_config 旋钮（不再硬编码）。
   *    旋钮语义见 core memory/types.ts MemoryConfig：
   *    - decay_rate(0=不忘,1=秒忘) → 每日衰减幅度 = decay_rate*6（默认 0.3→1.8/天，原硬编码 2）
   *    - importance_threshold(0=什么都记,1=只记大事) → 衰减阈值 = 2+(1-thr)*10 天
   *      （只记大事→2 天就开始忘，什么都记→12 天；默认 0.4→8 天，原硬编码 3）
   *    - recency_weight(0=念旧,1=只认最近) → 近 3 天消息加权 (1+w)，更早 ×(1-w*0.5)
   *    - confirmation_bias(0=随风倒,1=固执) → 亲密度变化平滑：变化幅度 ×(1-c*0.7)
   *    - retention_bias 不在此用（正负偏向属记忆筛选，不是亲密度） */
  /** ★ 2026-10-24：`idle=null`（无真人消息）的日志只打一次，避免每轮刷 */
  private idleNullLogged = false;

  updateIntimacy(): void {
    try {
      const since7d = new Date(Date.now() - 7 * 86_400_000);
      const msgs = this.memoryManager.getRecentMessages(this.sessionId(), 500, since7d);

      // ★ 旋钮读取（审查修复：memory_config 之前只有存/读/快照，从未参与决策）
      const cfg = this.memoryManager.getPersonaSnapshot().memoryConfig ?? {};
      const decayPerDay = (cfg.decay_rate ?? 0.3) * 6;
      const decayThreshold = 2 + Math.round((1 - (cfg.importance_threshold ?? 0.4)) * 10);
      const recencyW = cfg.recency_weight ?? 0.3;
      const confirmW = cfg.confirmation_bias ?? 0.3;

      // ★ recency_weight 近期加权：近 3 天消息按 (1+w)，更早按 (1-w*0.5)（下限 0.1 防负）
      const recent3dCutoff = Date.now() - 3 * 86_400_000;
      let recentCount = 0, olderCount = 0;
      for (const m of msgs) {
        const t = m.createdAt ? new Date(m.createdAt).getTime() : 0;
        if (t >= recent3dCutoff) recentCount++; else olderCount++;
      }
      const weightedCount = recentCount * (1 + recencyW) + olderCount * Math.max(0.1, 1 - recencyW * 0.5);

      // 频率：近 7 天活跃度（加权消息数近似，0 条 → 0，40 条 → 35 封顶）
      let freqScore = Math.min(35, weightedCount / 4 * 5);

      // ★ 无互动衰减（旋钮驱动阈值与幅度）—— 判据与数据窗口**解耦**（2026-10-24）。
      //   旧实现：在 getRecentMessages(…, now−7d) 里反查最后一条 user 消息，
      //   兜底 `: 7`。窗口 7 天 ⇒ idle 上限 7，而默认阈值 8 ⇒ **衰减永不触发**。
      const idleDays = this.idleSinceLastUserMessage();
      if (idleDays === null) {
        // 库里没有真人消息 = 没有基线，不衰减（**不是**"他刚说过话"）。
        // 只留一次痕：这条路径是常态（新库/测试），不该每轮刷日志。
        if (!this.idleNullLogged) {
          this.idleNullLogged = true;
          logger.debug('[Life] intimacy decay: 无真人消息（idle=null）⇒ 不衰减（没有基线）');
        }
      } else if (idleDays >= decayThreshold) {
        freqScore = Math.max(0, freqScore - decayPerDay * (idleDays - decayThreshold + 1));
        logger.debug(
          `[Life] intimacy decay: ${idleDays}d idle (threshold ${decayThreshold}d, ` +
          `${decayPerDay.toFixed(1)}/d) → freqScore ${freqScore.toFixed(2)}`,
        );
      }

      // 时长：>20 条视为有长会话（封顶 21；旧实现 (n>20?10:n/2)*2 最大只到 20，达不到上限）
      const longScore = Math.min(21, msgs.length > 20 ? 21 : msgs.length * 1.05);

      // 主动占比：用户消息首条占比（连续 user 消息只计一条）
      const userFirst = msgs.filter((m: any, i: number) => m.role === 'user' && (i === 0 || msgs[i - 1]?.role !== 'user')).length;
      // ★ 8-29 独立人格：亲密度加"她主动"维度——她主动推送成功的事件数（delivered=1）
      //   她也有想找你的时刻，关系不单由"你找她的频率"决定
      let selfInitiated = 0;
      try {
        selfInitiated = (this.memoryManager.listLifeEvents(7) as any[])
          .filter((e: any) => e.delivered === 1).length;
      } catch { /* non-fatal */ }
      const activeScore = Math.min(14, userFirst * 3 + selfInitiated * 2);

      const base = 30;
      const raw = Math.max(10, Math.min(100, base + freqScore + longScore + activeScore));
      // ★ confirmation_bias 平滑：固执 → 贴近旧值；随风倒 → 全量跟随（防亲密度跳变）
      const prev = this.memoryManager.getLifeSnapshot()?.intimacy ?? raw;
      const intimacy = Math.max(10, Math.min(100, prev + (raw - prev) * (1 - confirmW * 0.7)));
      this.memoryManager.updateLifeState({ intimacy });
      logger.debug(`[Life] intimacy ${prev} → ${intimacy} (raw ${raw}; knobs: decay ${decayPerDay.toFixed(1)}/d, thr ${decayThreshold}d, recency ${recencyW}, confirm ${confirmW})`);
    } catch (err: any) {
      logger.warn(`[Life] intimacy update failed: ${err.message}`);
    }
  }
}
