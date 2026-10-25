/**
 * 上下文事实层 —— 「此刻的她和这段关系」的**唯一计算出处**。
 *
 * ★ 2026-10-24（change: `converge-context-facts`，PLAN 的 P8 第 1+3 步）
 *
 * ## 为什么要有它
 *
 * 同一个事实此前被**多处各算一遍**，而且其中一处算错了：
 *
 * | 事实 | 实现 A（对） | 实现 B（错/缺） |
 * |---|---|---|
 * | 多久没说话 | `getLastUserMessageAt()`（全表，无窗口） | 在 `getRecentMessages(…, now−7d)` 里反查 ⇒ **窗口 7 天把上限钉死，衰减永不触发**（藏了 2 个月） |
 * | 亲密度 | `life.ts` 的 `relationshipBlock()`：带**档位** + idle | `proactive.ts` 的 `contextSnippet()`：只有光秃秃的 `62/100`，**看不出冷了几天** |
 * | 用户近况 | 组装层的 `[关于你的事实]`：去重 + 时间标注 | `getUserActivitySummary()`：facts 前 5 条直出，**绕过去重与时间标注** |
 *
 * `eligibility.ts` 头注释把这类问题命名为「判据被四份代码各答一次」——本文件是同一手法，
 * 只不过对象是**关于此刻的事实**，不是关于"能不能学"。
 *
 * ## 纪律（照抄 `eligibility.ts`）
 *
 * - **纯计算**：本文件不写库、不发请求、**不产出任何面向用户的句子**（措辞永远在调用方/体裁那边）
 * - **不静默**：读源失败不吞 —— 记进 `problems[]`，由调用方决定怎么出声
 * - **只读收窄接口**：`FactsSource` 只有 4 个方法，便于单测（不需要造 2500 行的 MemoryManager 门面）
 */

import { localDateKey, localDateKeyFromISO } from '@alysia/core/memory';

// ── 亲密度档位（原在 life.ts，2026-10-24 移到这里 —— 事实层是唯一出处）──────

export type IntimacyTierName = 'close' | 'normal' | 'distant' | 'silent';

export interface IntimacyTierDef {
  tier: IntimacyTierName;
  /** 日志/字段里给人看的名字 */
  label: string;
  /** 进入本档所需的**最低**亲密度（降档判据） */
  min: number;
  /** 本档每日 chat 推送上限（只用来**压低**配置值） */
  cap: number;
  /** 本档推送冷却（小时）；`silent` 档不推送，故为 0 */
  cooldownHours: number;
}

/**
 * 阈值取 70 / 40 / 25 的依据：
 * - 亲密度公式 `clamp(30 + 频率 + 时长 + 主动, 10, 100)`，初值 30、下限 10、上限 100
 * - **70** = "稳定互动"的量级（需要近 7 天持续有来有回）
 * - **25** = 贴近下限 10 的"快要断线"
 * - **40** 落在中间，避免在边界抖动（配合 `INTIMACY_UPGRADE_MARGIN` 迟滞）
 */
export const INTIMACY_TIERS: IntimacyTierDef[] = [
  { tier: 'close', label: '亲近', min: 70, cap: 5, cooldownHours: 1 },
  { tier: 'normal', label: '平常', min: 40, cap: 3, cooldownHours: 2 },
  { tier: 'distant', label: '疏远', min: 25, cap: 1, cooldownHours: 4 },
  { tier: 'silent', label: '久无往来', min: 0, cap: 0, cooldownHours: 0 },
];

/** 升档要越过阈值这么多个点才生效 —— 防在 40 上下反复横跳（用户会看到频率在抖） */
export const INTIMACY_UPGRADE_MARGIN = 5;

/** 恢复转折：从 `silent` 回到这个值以上才算「他回来了」 */
export const INTIMACY_RECOVERY_MIN = 45;

// ── 表态时钟（第二根轴，★ 2026-10-25，change: `worth-telling-and-silence-clock`）──
//
// ## 为什么需要第二根轴
//
// 亲密度那条轴也在"沉默 → 少说话"，但它**慢**：decay 1.8/天，从 82 掉到 70 要 7 天、
// 掉到 40 要 23 天、掉到 25 要 32 天。而 whale 的形状是 **3 天开始降 / 7 天归零** ——
// 它管的是"发言额度"，不是"关系温度"，所以敢快。
//
// 我们**不改亲密度衰减速率**（那会让"关系温度"也掉得飞快，是另一件事），
// 而是加一根独立的、**只压额度**的轴：沉默天数 → 每日推送上限。
//
// ⚠️ **数值不是抄 whale 的**：它的 3/7 天是在它自己的分享模型里调的。
// 我们的 3/7 天是**保守起点**，可被 `LifeService` 的 opts 覆盖；
// 每次这根轴真正生效都会打日志（`silence cap`），攒数据后再谈要不要调。
//
// ⚠️ 与亲密度档位**取 min**（沿用「只降不升」）：两根轴谁也抬不高对方。

/** 表态时钟的默认值：3 天开始降、7 天归零 */
export const SILENCE_QUIET_DAYS = 3;
export const SILENCE_MUTE_DAYS = 7;
/** 3–6 天时的额度上限 */
export const SILENCE_QUIET_CAP = 3;

export interface SilenceCap {
  /** 本档允许的每日推送上限 */
  cap: number;
  /** 第一人称处境的标签（写进日志与关系块） */
  label: string;
}

/**
 * 纯函数：由 idle 天数算**表态时钟**给出的额外额度上限。
 *
 * | idleDays | 返回 |
 * |---|---|
 * | `null`（从没说过话） | `null` —— 没有基线，不额外压（交给亲密度档位） |
 * | 0–2 天 | `null` —— 满额 |
 * | 3–6 天 | `{cap: 3, label: '有点久没说话了'}` |
 * | ≥7 天 | `{cap: 0, label: '很久没说话，安静下来'}` |
 */
export function silenceCap(
  idleDays: number | null,
  quietDays: number = SILENCE_QUIET_DAYS,
  muteDays: number = SILENCE_MUTE_DAYS,
): SilenceCap | null {
  if (idleDays === null || !Number.isFinite(idleDays)) return null;
  if (idleDays >= muteDays) return { cap: 0, label: '很久没说话，安静下来' };
  if (idleDays >= quietDays) return { cap: SILENCE_QUIET_CAP, label: '有点久没说话了' };
  return null;
}

/** 纯函数：给定亲密度落在哪一档（**不含**迟滞，迟滞在 `LifeService.resolveIntimacyTier`）。 */
export function intimacyTier(intimacy: number): IntimacyTierDef {
  const v = Number.isFinite(intimacy) ? intimacy : 30;
  for (const t of INTIMACY_TIERS) if (v >= t.min) return t;
  return INTIMACY_TIERS[INTIMACY_TIERS.length - 1];
}

/**
 * 纯函数：由「最后一条真人消息的时间」算 idle 天数。
 *
 * `lastUserAt === null` ⇒ 返回 `null`（**没有基线**），调用方必须显式处理。
 * ⚠️ **不许**再拿一个数字冒充它（旧实现是 `: 7`，正好卡在阈值 8 之下 ⇒ 衰减永不触发）。
 */
export function idleDaysSince(lastUserAt: string | null | undefined, now: Date): number | null {
  if (!lastUserAt) return null;
  const ms = now.getTime() - new Date(lastUserAt).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

// ── 只读源（收窄接口）────────────────────────────────────────────────

/**
 * 事实层需要的最小读接口。`MemoryManager` 天然满足（用可选方法，缺了不炸）。
 *
 * 收窄的意义：单测不需要造整个 MemoryManager；将来换存储也只改这一处适配。
 */
export interface FactsSource {
  getLifeSnapshot?(): {
    intimacy?: number;
    mood?: string;
    moodValue?: number;
    moodNote?: string;
  } | null;
  /** ★ idle 的**唯一**判据（全表 SQL，排除 `synthetic`/`skip_profile`） */
  getLastUserMessageAt?(): string | null;
  listLifeEvents?(days: number): Array<{ content?: string; createdAt?: string }>;
  getUserActivitySummary?(): string;
}

/** 此刻的事实的**纯数据**形状。没有任何一句面向用户的文案。 */
export interface ContextFacts {
  now: Date;
  intimacy: number;
  /**
   * `getLifeSnapshot()` 是否**真的有值**。
   * 用来区分「她真在这儿，亲密度 30」和「读不到快照，回落默认 30」——
   * 否则调用方没法判断"这一项算不算素材"（问候曾经因此把空库也当成有话说）。
   */
  snapshotPresent: boolean;
  tier: IntimacyTierDef;
  /** `null` = 库里没有真人消息（**没有基线**，不是"他刚说过话"） */
  idleDays: number | null;
  lastUserAt: string | null;
  mood: { mood: string; value: number; note: string };
  /** 今天（本地日期）的日常，最多 `todayEventLimit` 条 */
  todayEvents: string[];
  /** 用户近况（facts 摘要；可能为空串） */
  userActivity: string;
  /**
   * 读源时遇到的问题（**不静默吞**）。空数组 = 一切正常。
   * 调用方按自己的体裁决定怎么出声（生活事件 debug、问候 warn 都可以）。
   */
  problems: string[];
}

/**
 * 采集此刻的事实。**纯计算 + 只读**，不发请求、不写库。
 *
 * 单次调用会做 ≤4 次只读查询（snapshot / lastUserMessage / life events / activity），
 * 调用方节奏是「每小时」或「每条消息」，量级无忧。
 */
export function collectContextFacts(
  src: FactsSource,
  now: Date = new Date(),
  opts: { todayEventLimit?: number } = {},
): ContextFacts {
  const problems: string[] = [];

  let snapshot: { intimacy?: number; mood?: string; moodValue?: number; moodNote?: string } | null = null;
  try {
    snapshot = src.getLifeSnapshot?.() ?? null;
  } catch (err: any) {
    problems.push(`getLifeSnapshot: ${err?.message ?? err}`);
  }
  const snapshotPresent = !!snapshot && snapshot.intimacy != null;
  const rawIntimacy = Number(snapshot?.intimacy ?? 30);
  const intimacy = Number.isFinite(rawIntimacy) ? rawIntimacy : 30;

  let lastUserAt: string | null = null;
  try {
    lastUserAt = src.getLastUserMessageAt?.() ?? null;
  } catch (err: any) {
    // 读不出来 ≠ 没说过话：两者都会走 `null`，但原因必须能被看见
    problems.push(`getLastUserMessageAt: ${err?.message ?? err}`);
  }
  const idleDays = idleDaysSince(lastUserAt, now);

  const limit = opts.todayEventLimit ?? 3;
  let todayEvents: string[] = [];
  if (limit > 0) {
    try {
      const todayKey = localDateKey(now);
      const all = src.listLifeEvents?.(1) ?? [];
      todayEvents = all
        .filter((e) => e?.createdAt && localDateKeyFromISO(e.createdAt) === todayKey)
        .map((e) => String(e.content ?? ''))
        .filter(Boolean)
        .slice(-limit);
    } catch (err: any) {
      problems.push(`listLifeEvents: ${err?.message ?? err}`);
    }
  }

  let userActivity = '';
  try {
    userActivity = src.getUserActivitySummary?.() ?? '';
  } catch (err: any) {
    problems.push(`getUserActivitySummary: ${err?.message ?? err}`);
  }

  return {
    now,
    intimacy,
    snapshotPresent,
    tier: intimacyTier(intimacy),
    idleDays,
    lastUserAt,
    mood: {
      mood: String(snapshot?.mood ?? ''),
      value: Number(snapshot?.moodValue ?? 0),
      note: String(snapshot?.moodNote ?? ''),
    },
    todayEvents,
    userActivity,
    problems,
  };
}
