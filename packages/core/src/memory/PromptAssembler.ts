// src/memory/PromptAssembler.ts
import type { ProfileStore } from './stores/ProfileStore.js';
import type { PersonaStore } from './stores/PersonaStore.js';
import type { ConversationStore } from './stores/ConversationStore.js';
import type { KnowledgeStore } from './stores/KnowledgeStore.js';
import type { WorldbookStore } from './stores/WorldbookStore.js';
import type { CodeContextStore } from './stores/CodeContextStore.js';
import type { SearchResult, WorldbookEntry } from './types.js';
import { TokenBudget } from './TokenBudget.js';
// ★ 2026-10-20（make-her-brief）：说话的分寸（产品级约束，放代码以免受库里的旧人设影响）
import { CHAT_BREVITY_DIRECTIVE } from '../prompts/chat.js';
// ★ 2026-10-19（change: watch-for-stuck-work）：她自己留意到的事（由看门狗写入）
import { getSelfNotices, renderSelfNoticeBlock } from './self-notice.js';
import { logger } from '../utils/logger.js';
import { warnThrottled } from '../utils/write-trace.js';

/**
 * 【关于我】块最多注入几条角色事实（★ 10-15 fix-reflection-insight-misroute）。
 *
 * 每日反思每天生成一条「我悟到的关于自己的事实」，天然会累积。线上实测 31 条
 * = 1058 字 ≈ 705 tokens，占满 3200 预算的 22%；而【关于我】是 assembleChat 里
 * **最后一个**做 canFit 检查的块（前面 persona / overlay / basics / prefs /
 * 关于你的事实 都已 reserve）→ 超预算时整块被丢弃，她一条都读不到。
 *
 * 去重不是解药：31 条的措辞差异超出 normalizeKey（前 20 字）与 normContains 的
 * 判定范围，实测 addCharacterFacts supersede 0 条。
 *
 * 故取**最近 N 条**——自省表达的是"我此刻是谁"，近期的才代表当下的她。
 * 更早的仍完整留在库里（只是不进 prompt）；长期方案是把陈旧自省归并成稳定的自我描述。
 */
const CHARACTER_FACTS_IN_PROMPT = 8;

/**
 * ★ 2026-10-28（change: `fix-long-session-compaction`）：关于用户的事实最多注入多少条。
 *
 * 线上 `facts` 已有 118 条；旧策略是 optional，3200 预算下 7 天被整块丢弃 89 次。
 * 改为 required 之后仍要限量：全量 118 条会挤掉 memories/life 等块。
 *
 * ★ 2026-10-28 18h 复盘：40 条 ≈ **1,146 tokens（占 3,200 的 36%）**，
 *   结果 facts 保住了，但 `recentConversations / life / memories` 被整块丢掉。
 *   ⇒ 降到 20 条 ≈ **595 tokens（19%）**，把预算留给“最近聊了什么”。
 *   取置信度前 20 条（`getActiveFacts` 已按 confidence 降序），其余仍在库、可被检索。
 */
const FACTS_IN_PROMPT = 20;

/**
 * `dropped` 数组 → 每块被丢时的 token 估算。
 * 用 WeakMap 是为了不改 `pushBlock` 的签名与 `AssembleReport.dropped: string[]` 的公开契约。
 */
const DROPPED_TOKENS = new WeakMap<string[], Map<string, number>>();

function formatDropped(dropped: string[]): string {
  const sizes = DROPPED_TOKENS.get(dropped);
  return dropped
    .map(k => {
      const t = sizes?.get(k);
      return t === undefined ? k : `${k}(${t}tok)`;
    })
    .join(', ');
}

// ── 块的投放策略（★ 2026-10-20，change: `tabular-prompt-blocks`）─────────────
//
// ## 为什么要有这张表
//
// 在此之前，"哪一块被丢"是**隐式**的：谁先 `reserve` 谁先活，顺序写在函数体里。
// 于是"人格绝不能被丢"这件事**没有任何一处写明** —— 它只是恰好排得早。
// 直到 10-15 那次事故（31 条自省把预算吃满、`[关于我]` 整块被丢、她一条都读不到）
// 才暴露：**顺序即优先级，而优先级没被记录过**。
//
// 现在两种策略显式化：
//   - `required`：**无条件先占预算**（丢它不是"预算不够"，是 bug）
//   - `optional`：`canFit` 通过才进；预算不足时**记名**（见 `assembleChat` 末尾的丢弃日志）
//
// ★ 2026-10-25（change: `assembler-block-registry`，P8 第 2 步）：
//   **这张表搬到了 `block-registry.ts`**，并升级为"注册表" —— 每块多了
//   `effect: 'read' | 'write'`（构建它会不会**写库**）与 `source`（数据源）。
//   本文件只 re-export，不再保留第二份定义（写两份必然漂移）。
//
// ⚠️ 改这张表 = **行为变更**，不是重构。改完必须更新 characterization 快照。

import { CHAT_BLOCK_POLICY, CODE_BLOCK_POLICY } from './block-registry.js';
import type { ChatBlockKey, CodeBlockKey } from './block-registry.js';
// ★ 2026-10-28（change: `extract-prompt-genres`）：预算不再写死在函数体
import { GENRES } from './genres.js';
export type { ChatBlockKey, CodeBlockKey, BlockEffect, BlockSpec } from './block-registry.js';
export {
  CHAT_BLOCKS, CODE_BLOCKS,
  CHAT_BLOCK_POLICY, CODE_BLOCK_POLICY,
  CHAT_BLOCK_ORDER, CODE_BLOCK_ORDER,
  WRITE_EFFECT_CHAT_BLOCKS,
} from './block-registry.js';

/**
 * 「给了 scope、也匹配到了世界书条目，却一条都注入不进去」的**诊断文案**（★ 2026-10-25）。
 *
 * 抽成纯函数的两个理由：
 *   ① 原来两种原因（全 image / scope 不符）混在一句里、**没有计数** ⇒ 看得见但诊断不了；
 *      而它们的处置完全不同：全 image 是 `content_type` 配错；scope 不符是**该 scope 没条目**
 *      （生产库实测 `scope='code'` 就是 0 条 —— 那是配置缺口，不是故障，不该去查代码）。
 *   ② 内联字符串**没法测**：`warnThrottled` 有限频，同一 tag 第二次调用会被吞，
 *      断言"文案里有 X" 在第二个用例里就会莫名其妙地空。
 *
 * @returns 需要告警时的文案；无需告警（没匹配到任何条目）返回 `null`
 */
export function worldbookSkipDiagnosis(
  triggers: WorldbookEntry[],
  worldbookScope: 'chat' | 'code',
): string | null {
  if (triggers.length === 0) return null;
  const imageCount = triggers.filter((w) => w.content_type === 'image').length;
  const scopeMissCount = triggers.length - imageCount;
  const cause = imageCount === 0
    ? '⇒ 该 scope 在库里没有条目（配置缺口，不是故障）'
    : scopeMissCount === 0
      ? '⇒ 只有 image 条目匹配（检查 content_type 是否配错）'
      : '⇒ 两类原因并存';
  return `[PromptAssembler] worldbookScope=${worldbookScope} 且匹配到 ${triggers.length} 条，但注入 0 条` +
    `（image 型 ${imageCount} 条不注入、scope 不符 ${scopeMissCount} 条）${cause}`;
}


/**
 * ★ 2026-10-24（change: `align-dsh-memory-blocks-with-scope`）：把 `mode` 的一词三义拆开。
 *
 * 拆之前：`mode` 同时决定「世界书 scope」「提示块表」「token 预算」，而 dsh 场景下三者
 * 想要**不同值**（scope 要 code、块表要 chat、预算要更大）—— 选谁都错一半。
 */
export interface AssembleOptions {
  /** 用哪张块表。缺省 = `mode` */
  blocks?: 'chat' | 'code';
  /**
   * 世界书 scope。**显式给出 ⇒ 该 scope 的条目注入 prompt**（仅 `blocks === 'chat'` 生效）；
   * 缺省 ⇒ 只匹配不注入 —— 与 2026-10-24 之前**逐字相同**。
   */
  worldbookScope?: 'chat' | 'code';
}

/** 组装报告（★ 2026-10-24）：把"丢了几块""世界书真注入了几条"从隐式变显式 */
export interface AssembleReport {
  text: string;
  /** 因预算不足被丢掉的块 key（与 `[Prompt] 预算不足…` 日志同源） */
  dropped: string[];
  /** **真正进了 prompt** 的世界书条目数（≠ 匹配数；0 = 没注入） */
  worldbookInjected: number;
}

export class PromptAssembler {
  constructor(
    private profileStore: ProfileStore,
    private personaStore: PersonaStore,
    private conversationStore: ConversationStore,
    private knowledgeStore: KnowledgeStore,
    private worldbookStore: WorldbookStore,
    private codeContextStore: CodeContextStore,
  ) {}

  /**
   * 投放一块提示词（★ 2026-10-20，change: `tabular-prompt-blocks`）。
   *
   * `required` → 无条件先占预算（丢它说明有 bug）；
   * `optional` → `canFit` 通过才进，否则把 key 记进 `dropped`（末尾统一留痕）。
   *
   * ⚠️ 这个函数**不改变任何既有行为**：它只是把原来散在 11 处的
   * `if (budget.canFit(x)) { budget.reserve(x); blocks.push(x) }` 收成一处，
   * 并让"丢哪块"第一次变成可观测的事实。
   */
  private pushBlock(
    policy: 'required' | 'optional',
    key: string,
    block: string,
    budget: TokenBudget,
    blocks: string[],
    dropped: string[],
  ): void {
    if (policy === 'required') {
      budget.reserve(block);
      blocks.push(block);
      return;
    }
    if (budget.canFit(block)) {
      budget.reserve(block);
      blocks.push(block);
      return;
    }
    // ★ 2026-10-28：丢弃时记下该块的 token 估算，日志里带上尺寸。
    //   否则只知道“丢了 memories”，不知道它占多少 —— 调预算只能猜。
    const sizes = DROPPED_TOKENS.get(dropped) ?? new Map<string, number>();
    sizes.set(key, budget.estimateTokens(block));
    DROPPED_TOKENS.set(dropped, sizes);
    dropped.push(key);
  }

  private pushChatBlock(key: ChatBlockKey, block: string, budget: TokenBudget, blocks: string[], dropped: string[]): void {
    this.pushBlock(CHAT_BLOCK_POLICY[key], key, block, budget, blocks, dropped);
  }

  private pushCodeBlock(key: CodeBlockKey, block: string, budget: TokenBudget, blocks: string[], dropped: string[]): void {
    this.pushBlock(CODE_BLOCK_POLICY[key], key, block, budget, blocks, dropped);
  }

  async assemble(mode: 'chat' | 'code', extraRetrieved: SearchResult[] = [], worldbookTriggers: WorldbookEntry[] = [], lifeInjection: string = '', sessionId?: string, opts: AssembleOptions = {}): Promise<string> {
    return (await this.assembleWithReport(mode, extraRetrieved, worldbookTriggers, lifeInjection, sessionId, opts)).text;
  }

  /**
   * ★ 2026-10-24（change: `align-dsh-memory-blocks-with-scope`）：带报告版。
   *
   * 存在的理由是**观测口径**：以前 `[memory/read]` 只能打出"匹配到 N 条"，
   * 于是"匹配到了但一条都没注入"和"注入成功"在日志里**完全同形** ——
   * dsh 的世界书就那样一直没生效（读通道 2026-10-02 上线 → 2026-10-24 发现，22 天）。
   * 现在调用方能拿到 `worldbookInjected`。
   */
  async assembleWithReport(mode: 'chat' | 'code', extraRetrieved: SearchResult[] = [], worldbookTriggers: WorldbookEntry[] = [], lifeInjection: string = '', sessionId?: string, opts: AssembleOptions = {}): Promise<AssembleReport> {
    const blocks = opts.blocks ?? mode;
    return blocks === 'chat'
      ? this.assembleChat(extraRetrieved, worldbookTriggers, lifeInjection, sessionId, opts.worldbookScope)
      : this.assembleCode(extraRetrieved, worldbookTriggers, lifeInjection);
  }

  private async assembleChat(retrieved: SearchResult[], triggers: WorldbookEntry[], lifeInjection: string = '', sessionId?: string, worldbookScope?: 'chat' | 'code'): Promise<AssembleReport> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    // ★ 8-09 会话隔离：只取当前会话类型（private/同群）的摘要，防群聊摘要混入私聊
    const recentConvs = this.conversationStore.getRecent(3, sessionId);
    const budget = new TokenBudget(GENRES.chat.budgetTokens ?? 3200);

    const blocks: string[] = [];
    /** ★ tabular-prompt-blocks：本轮因预算不足被丢掉的块（末尾留痕） */
    const dropped: string[] = [];

    // ★ 2026-10-19（change: `watch-for-stuck-work`）：**她自己注意到的事**。
    //   放在最靠前：它决定"此刻该不该说点什么"，比背景知识更即时。
    //   没有就完全不出块（不要留一个空标题）。
    const selfNotices = getSelfNotices();
    const selfNoticeBlock = renderSelfNoticeBlock(selfNotices);
    if (selfNoticeBlock) {
      this.pushChatBlock('selfNotice', selfNoticeBlock, budget, blocks, dropped);
      // 可观测：她这一轮到底看没看到（否则"注入了"与"没注入"同形）
      // INFO 级：这一行是"她到底看没看到"的唯一证据（DEBUG 不进日志文件）
      logger.info(`[Prompt] 她这一轮看到了 ${selfNotices.length} 条自己注意到的事`);
    }

    // Persona block (always included — most essential)
    // ★ 8-09 防御：tone 空对象/缺失字段 → 默认参数（云端历史遗留 tone='{}' 导致 undefined）
    const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
    const speechStyle = safeParseJSON<Record<string, number>>(persona.speech_style, {});
    const emotionalRange = safeParseJSON<Record<string, number>>(persona.emotional_range, {});
    const t = (v: number | undefined, def: number) => (typeof v === 'number' && isFinite(v) ? v : def);
    const toneText = `语气: 形式度=${t(tone.formality, 0)}, 温暖度=${t(tone.warmth, 0.2)}, 幽默感=${t(tone.humor, 0.1)}, 直接程度=${t(tone.directness, 0)}`;
    const styleText = `说话风格: 句子长度=${t(speechStyle.sentence_length, 0)}, 表情使用=${t(speechStyle.emoji_usage, 0)}, 代码倾向=${t(speechStyle.code_heavy, 0)}`;
    const rangeText = `情感表达: 表现力=${t(emotionalRange.expressiveness, 0.1)}, 共情=${t(emotionalRange.empathy, 0.3)}, playful=${t(emotionalRange.playfulness, 0.1)}`;
    // ★ 8-29 Overlay 注入（persona-overlay-perspective）：证据门槛固化的稳定演化——
    //   已固化的稳定变化是"她现在的样子"，注入让对话/事件自然体现
    const overlayNotes = this.personaStore.getOverlayNotes();
    let overlayBlock = '';
    if (overlayNotes.length > 0) {
      overlayBlock = `【你的稳定变化】\n${overlayNotes.map(n => `- ${n.change}（${n.evidence}）`).join('\n')}`;
    }
    const personaBlock = `[角色设定]
你是${persona.name}。
${toneText}
${styleText}
${rangeText}`;
    this.pushChatBlock('persona', personaBlock, budget, blocks, dropped);
    if (overlayBlock) {
      this.pushChatBlock('overlay', overlayBlock, budget, blocks, dropped);
    }

    // User profile — handles both JSON (manual input) and plain text (LLM summary from Cron)
    if (profile.basics && profile.basics !== '{}') {
      const basicsText = this.parseOrPlain(profile.basics);
      if (basicsText) {
        // ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C3）：
        //   `basics` 是**派生结果**（一次 LLM 总结），事实被纠正/过期后它就**可能过时**。
        //   过时了还照原样注入，等于"你纠正掉的旧说法换个出口继续生效"（E2 的同一个病）。
        //
        //   三档处置（**顺序即优先级**）：
        //     ① 新鲜 → 正常注入 `[关于你]`
        //     ② 过时，但**当前还有事实** → **整块不注入**：事实块会以"当前认知"的身份
        //        说同一件事，而 stale 的旧总结只会和新事实打架（"他在长沙" vs "他在深圳"）
        //     ③ 过时，且**当前一条事实都没有** → 降级注入 `[关于你（较早的印象，可能已过时）]`：
        //        没有事实块兜底时仍要给一点底色，但必须标明它旧
        let stale = false;
        try {
          stale = this.profileStore.getBasicsMeta().stale;
        } catch {
          // 读谱系失败不该拖垮 prompt：按"可能过时"处理（宁可保守，不要假装新鲜）
          stale = true;
        }
        let currentFactCount = 0;
        try {
          currentFactCount = this.profileStore.getCurrentFacts().length;
        } catch {
          currentFactCount = 0;
        }

        if (!stale) {
          this.pushChatBlock('basics', `[关于你]\n${basicsText}`, budget, blocks, dropped);
        } else if (currentFactCount === 0) {
          this.pushChatBlock(
            'basics',
            `[关于你（较早的印象，可能已过时）]\n${basicsText}`,
            budget, blocks, dropped,
          );
        } else {
          logger.debug(
            `[PromptAssembler] basics 已过时且当前有 ${currentFactCount} 条事实 ⇒ 跳过该块（由事实块承载当前认知）`,
          );
        }
      }
    }
    if (profile.preferences && profile.preferences !== '{}') {
      const prefsText = this.parseOrPlain(profile.preferences);
      if (prefsText) {
        const prefsBlock = `[你的偏好]\n${prefsText}`;
        this.pushChatBlock('preferences', prefsBlock, budget, blocks, dropped);
      }
    }

    // Active profile facts (v2: 只显示活跃事实，标注来源)
    // ★ 8-09 去重增强：归一化（去停用字/主语/标点）+ 子串包含合并——历史重复数据
    //   （"用户在长沙" ×4）在组装层兜底消除，不显示即不烧 token
    const activeFacts = this.profileStore.getActiveFacts();
    if (activeFacts.length > 0) {
      const norm = (s: string) => s.replace(/[的得了吗呢是个了在于是和也呀啊哦吧]/g, '').replace(/^(用户|你)/, '').replace(/[\s，,。！？；;：:、()（）"“”']/g, '').toLowerCase();
      const normContains = (a: string, b: string) => {
        const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
        return longer.length >= 5 && shorter.length >= 2 && longer.includes(shorter);
      };
      const kept: typeof activeFacts = [];
      for (const f of activeFacts.sort((a, b) => b.confidence - a.confidence)) {
        const key = norm(f.fact);
        const dup = kept.find(k => norm(k.fact) === key || normContains(norm(k.fact), key));
        if (dup) continue; // 已有同义事实（保留置信度更高的第一条）
        kept.push(f);
      }
      // ★ 2026-10-28：限量，避免 facts 块自己把预算吃穿（全量 118 条会挤掉 memories/life）。
      //   排序已是 confidence 降序，取前 N 条；被截掉的仍在库，可被检索/后续重排。
      const inPrompt = kept.slice(0, FACTS_IN_PROMPT);
      if (kept.length > inPrompt.length) {
        logger.debug(
          `[PromptAssembler] facts ${kept.length} 条 → 注入前 ${inPrompt.length} 条（其余留库）`,
        );
      }
      const factsText = inPrompt
        .map(f => {
          const marker = f.source === 'inferred' ? '(待确认)' : '';
          const sourceNote = f.source === 'user' ? ' [你说过]' : '';
          // ★ 8-28 时间标注（profile-facts-timestamps）：事实时效对 AI 决策关键——
          //   "用户在长沙" 是 3 个月前还是今天的，含义完全不同
          const timeNote = this.formatFactTime(f.valid_from, f.updated_at);
          return `- ${f.fact}${marker}${sourceNote}${timeNote}`;
        })
        .join('\n');
      if (factsText) {
        const factsBlock = `[关于你的事实]\n${factsText}`;
        this.pushChatBlock('facts', factsBlock, budget, blocks, dropped);
      }
    }

    // ★ 8-29 独立人格：【关于我】——她的角色事实（character_facts）注入，她记得自己的事
    // ★ 10-15 fix-reflection-insight-misroute：**限量注入**。
    //   每日反思每天产一条「关于我」，线上实测 31 条 = 1058 字 ≈ 705 tokens，
    //   占满 3200 预算的 22%；而本块是**最后一个** canFit 检查的块（前面 persona/
    //   basics/prefs/关于你的事实 都已 reserve）→ 极易整块被丢，等于她一条都读不到。
    //   ★ 且实测**去重救不了它**：31 条措辞差异超出 normalizeKey 前 20 字与 normContains
    //     的判定范围，addCharacterFacts 去重结果为 supersede 0 条。
    //   故取**最近 N 条**——自省说的是"我此刻是谁"，近期的才代表当下的她。
    //   旧的仍在库里（只是不进 prompt）；长期方案是把陈旧自省归并成稳定的自我描述。
    try {
      const myFacts = this.profileStore
        .getActiveCharacterFacts() // 按插入顺序（旧→新）
        .slice(-CHARACTER_FACTS_IN_PROMPT);
      if (myFacts.length > 0) {
        const myText = myFacts
          .map(f => `- ${f.fact}${this.formatFactTime(f.valid_from, f.updated_at)}`)
          .join('\n');
        const myBlock = `[关于我]\n${myText}`;
        // ⚠️ 本块历史上**整块被丢过**（31 条自省吃满预算）——策略表里它是 optional，
        //    但丢弃现在一定会被末尾的日志记名；若线上频繁出现，说明该缩块而不是加预算。
        this.pushChatBlock('characterFacts', myBlock, budget, blocks, dropped);
      }
    } catch (err: any) {
      // ★ KI-5：这里原本是裸 catch。`getActiveCharacterFacts()` 读失败会被静默，
      //   表现为「[关于我] 块忽然没了」而没有任何原因可查。
      //   热路径（每轮组装）→ 限频。
      warnThrottled(
        'PromptAssembler.characterFacts',
        `[PromptAssembler] [关于我] 块构建失败（本轮不注入）: ${err?.message ?? err}`,
      );
    }

    // ★ 8-28 过期确认（profile-facts-classification-confirm）：过期 ≤3 天的画像事实 →
    //   【待确认的事实】块（≤2 条）——昔涟在合适时机自然询问，用户回答后调 confirm_profile_fact 记录
    try {
      const pending = this.profileStore.listPendingConfirmFacts();
      if (pending.length > 0) {
        const pendingLines = pending.slice(0, 2).map(f => {
          const d = new Date(f.validFrom);
          const dateNote = Number.isNaN(d.getTime()) ? '' : ` (${d.getMonth() + 1}月${d.getDate()}日记录的)`;
          return `- ${f.fact}${dateNote}`;
        }).join('\n');
        const pendingBlock = `[待确认的事实]\n这些关于轻月的事你可能记错了——想确认的话可以在合适的时机自然地问（一次最多问一条），\n问清后用 confirm_profile_fact 工具记录回答（确认 → 续期；否认 → 忘掉）：\n${pendingLines}`;
        this.pushChatBlock('pendingConfirm', pendingBlock, budget, blocks, dropped);
      }
    } catch (err: any) {
      // ★ KI-5 点名的那一处：`listPendingConfirmFacts()` 内部会先跑
      //   `expireStaleFacts()` → `writeFacts()` —— 所以这里吞掉的可能是一次**写**失败
      //   （过期事实永不清理），而日志上完全看不出来。热路径 → 限频。
      warnThrottled(
        'PromptAssembler.pendingConfirm',
        `[PromptAssembler] [待确认的事实] 块构建失败（本轮不注入；注意它内部含过期清理的**写**）: ${err?.message ?? err}`,
      );
    }

    // Recent conversations
    if (recentConvs.length > 0) {
      const recentBlock = `[最近对话]\n${recentConvs.map(c => `- ${c.summary}`).join('\n')}`;
      this.pushChatBlock('recentConversations', recentBlock, budget, blocks, dropped);
    }

    // ★ 2026-10-24（change: `align-dsh-memory-blocks-with-scope`）：世界书 **opt-in 注入**。
    //
    //   历史坑（这条注释就是为它而写）：本函数的 `triggers` 参数**曾经是死参数** ——
    //   匹配了、`recordTrigger()` 计数了、日志打着「worldbook N 条」，然后**整包扔掉**。
    //   于是 chat 侧的世界书从来没进过 prompt，而日志看起来完全正常。
    //   ★ 时长按 git 复算（别凭感觉写）：dsh 读通道 2026-10-02 上线 → 2026-10-24 发现，22 天。
    //
    //   现在语义写死两条：
    //     ① **给 `worldbookScope` 才注入**；不给 ⇒ 不注入（与改动前逐字相同，QQ/console 走工具）
    //     ② filter **按传入的 scope 决定**（不许硬编码 'code' —— 否则将来给 QQ 开注入会一条都进不来）
    let worldbookInjected = 0;
    if (worldbookScope) {
      const wanted = triggers.filter(
        w => w.content_type !== 'image' && (w.scope === worldbookScope || w.scope === 'both'),
      );
      if (wanted.length > 0) {
        const wbBlock = `[情境提示]\n${wanted.map(w => w.content).join('\n')}`;
        this.pushChatBlock('worldbook', wbBlock, budget, blocks, dropped);
        // 预算不足会被丢 —— 那时"注入了 0 条"才是实话
        worldbookInjected = dropped.includes('worldbook') ? 0 : wanted.length;
      } else if (triggers.length > 0) {
        // 守卫：给了 scope、也匹配到了条目，却一条都进不去。
        // 只可能是「全是 image」或「scope 不符」—— 两种都该被看见，否则又会退化成静默死参数。
        // ★ 2026-10-25（change: `pin-memory-read-seams`）：文案抽成纯函数（见下），
        //   一是因为两种原因混在一句里就诊断不了，二是**内联字符串没法测**（限频会吞掉重复断言）。
        const why = worldbookSkipDiagnosis(triggers, worldbookScope);
        if (why) warnThrottled('PromptAssembler.worldbookTrivial', why);
      }
    }

    // AI 近期生活（主动生活系统）— 由调用方通过 getLifeEventInjection() 预组装（今天事件 + 近 7 天摘要）
    if (lifeInjection) {
      this.pushChatBlock('life', lifeInjection, budget, blocks, dropped);
    }

    // Retrieved memories
    if (retrieved.length > 0) {
      const memBlock = `[相关记忆]\n${retrieved.map(r => `- ${r.text}`).join('\n')}`;
      this.pushChatBlock('memories', memBlock, budget, blocks, dropped);
    }

    // ⚠️ chat 侧**默认不注入**世界书（上面的 opt-in 分支除外）：QQ/console 走 Agent 工具
    //    `lookup_worldbook` 按需查。改成默认注入是一个**产品决定**，不是重构 ——
    //    见 change `align-dsh-memory-blocks-with-scope` 的「否决 B」。

    // ★ 2026-10-20（change: `make-her-brief`）：**说话的分寸**放**最后一个必选块**。
    //   为什么在最后：它是"输出约束"，离生成位置越近越有效（近因）；
    //   为什么 required：它被预算丢掉就等于她今晚话痨 —— 丢它比丢任何 optional 块都糟。
    this.pushChatBlock('brevity', CHAT_BREVITY_DIRECTIVE, budget, blocks, dropped);

    // ★ tabular-prompt-blocks：预算不足丢掉的块**必须留痕** ——
    //   否则"她今天没读到自己的自省"与"她读到了"在日志里同形（10-15 那次事故=22 天无人发现）。
    if (dropped.length > 0) {
      logger.info(`[Prompt] 预算不足，本轮丢弃 ${dropped.length} 块：${formatDropped(dropped)}`);
    }

    return { text: blocks.join('\n\n'), dropped, worldbookInjected };
  }

  private async assembleCode(retrieved: SearchResult[], triggers: WorldbookEntry[], lifeInjection: string = ''): Promise<AssembleReport> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    const codeCtx = this.codeContextStore.getActive();
    const budget = new TokenBudget(GENRES.code.budgetTokens ?? 2450);

    const blocks: string[] = [];
    /** ★ tabular-prompt-blocks：本轮因预算不足被丢掉的块（末尾留痕） */
    const dropped: string[] = [];

    // Compressed persona — only key tone dimensions for code mode (always included)
    const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
    const personaBlock = `[角色设定]
${persona.name} 编程助手模式。语气: ${tone.formality < 0 ? '随意' : '正式'}，直接程度: ${tone.directness > 0 ? '直接' : '委婉'}`;
    this.pushCodeBlock('persona', personaBlock, budget, blocks, dropped);

    // Filtered profile — technical fields only.
    // Handles both JSON (structured) and plain text (LLM summary from Cron deep rewrite).
    try {
      const basics = JSON.parse(profile.basics);
      const prefs = JSON.parse(profile.preferences);
      const techProfile: string[] = [];
      if (basics.occupation) techProfile.push(`角色: ${basics.occupation}`);
      if (basics.experience) techProfile.push(`经验: ${basics.experience}`);
      if (prefs.code_languages) techProfile.push(`技术栈: ${JSON.stringify(prefs.code_languages)}`);
      if (prefs.code_style) techProfile.push(`代码风格: ${prefs.code_style}`);
      if (prefs.comment_style) techProfile.push(`注释: ${prefs.comment_style}`);
      if (techProfile.length > 0) {
        const techBlock = `[编程用户画像]\n${techProfile.join('\n')}`;
        this.pushCodeBlock('techProfile', techBlock, budget, blocks, dropped);
      }
    } catch {
      // basics is not JSON (LLM summary) — include a short snippet as context
      if (profile.basics && profile.basics !== '{}') {
        const snippet = profile.basics.slice(0, 200);
        const techBlock = `[编程用户画像]\n${snippet}`;
        this.pushCodeBlock('techProfile', techBlock, budget, blocks, dropped);
      }
    }

    // Project context
    if (codeCtx) {
      const tech = safeParseJSON<Record<string, unknown>>(codeCtx.tech_stack, {});
      const ctxBlock = `[当前项目]
- 项目: ${codeCtx.project_name}
- 技术栈: ${JSON.stringify(tech)}
- 架构: ${codeCtx.architecture_notes}
- 最近: ${codeCtx.recent_changes}`;
      this.pushCodeBlock('projectContext', ctxBlock, budget, blocks, dropped);
    }

    // Worldbook triggers (code scope only) — 排除表情包条目（image 类型走 send_sticker 工具）
    const codeTriggers = triggers.filter(w => (w.scope === 'code' || w.scope === 'both') && w.content_type !== 'image');
    if (codeTriggers.length > 0) {
      const wbBlock = `[情境提示]\n${codeTriggers.map(w => w.content).join('\n')}`;
      this.pushCodeBlock('worldbook', wbBlock, budget, blocks, dropped);
    }

    // AI 近期生活（主动生活系统）— AI 把生活带进编程模式（今天事件 + 近 7 天摘要）
    if (lifeInjection) {
      this.pushCodeBlock('life', lifeInjection, budget, blocks, dropped);
    }

    // Retrieved knowledge
    if (retrieved.length > 0) {
      const knowBlock = `[相关知识]\n${retrieved.map(r => `- ${r.text}`).join('\n')}`;
      this.pushCodeBlock('memories', knowBlock, budget, blocks, dropped);
    }

    // ★ tabular-prompt-blocks：丢弃留痕（与 chat 同款）
    if (dropped.length > 0) {
      logger.info(`[Prompt] 预算不足（code），本轮丢弃 ${dropped.length} 块：${formatDropped(dropped)}`);
    }

    // ★ 2026-10-24：code 表**行为不变** —— 它一直注入 code/both scope 的世界书
    //   （`worldbookScope` 对它无效；code 的 scope 是隐式的）。
    //   报告里如实回填"真正进去几条"，供观测使用。
    return {
      text: blocks.join('\n\n'),
      dropped,
      worldbookInjected: dropped.includes('worldbook') ? 0 : codeTriggers.length,
    };
  }

  /** 隐私模式：仅注入角色设定，不含用户画像/Worldbook/记忆 */
  async assembleMinimal(mode: 'chat' | 'code'): Promise<string> {
    const persona = this.personaStore.get();
    if (mode === 'chat') {
      // ★ 8-09：与 assembleChat 同款空值兜底（tone='{}' 历史数据不再输出 undefined）
      const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
      const speechStyle = safeParseJSON<Record<string, number>>(persona.speech_style, {});
      const emotionalRange = safeParseJSON<Record<string, number>>(persona.emotional_range, {});
      const t = (v: number | undefined, def: number) => (typeof v === 'number' && isFinite(v) ? v : def);
      return `[角色设定]
你是${persona.name}。
语气: 形式度=${t(tone.formality, 0)}, 温暖度=${t(tone.warmth, 0.2)}, 幽默感=${t(tone.humor, 0.1)}, 直接程度=${t(tone.directness, 0)}
说话风格: 句子长度=${t(speechStyle.sentence_length, 0)}, 表情使用=${t(speechStyle.emoji_usage, 0)}, 代码倾向=${t(speechStyle.code_heavy, 0)}
情感表达: 表现力=${t(emotionalRange.expressiveness, 0.1)}, 共情=${t(emotionalRange.empathy, 0.3)}, playful=${t(emotionalRange.playfulness, 0.1)}

(隐私模式 — 未加载用户画像和记忆)`;
    } else {
      const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
      return `${persona.name} 编程助手模式(隐私)。`;
    }
  }

  /** Parse JSON if possible, else return the text as-is (LLM summary from Cron) */
  private parseOrPlain(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) {
        return JSON.stringify(parsed, null, 2);
      }
      return '';
    } catch {
      // Not JSON — use as plain text (LLM-generated natural language summary)
      return raw;
    }
  }

  /** ★ 8-28 画像事实时间标注（profile-facts-timestamps）：
   *  valid_from/updated_at 较新者 → 相对时间（今天/昨天/N天前）；超 30 天显示 M月d日。
   *  无时间字段返回空串（不标注）。token 成本 ~3-6/条。 */
  private formatFactTime(validFrom?: string, updatedAt?: string): string {
    const ref = Math.max(
      validFrom ? new Date(validFrom).getTime() : 0,
      updatedAt ? new Date(updatedAt).getTime() : 0,
    );
    if (!ref) return '';
    const days = Math.floor((Date.now() - ref) / 86_400_000);
    if (days < 1) return ' (今天)';
    if (days === 1) return ' (昨天)';
    if (days <= 30) return ` (${days}天前)`;
    const d = new Date(ref);
    return ` (${d.getMonth() + 1}月${d.getDate()}日)`;
  }
}

/** Safely parse JSON with a fallback value, logging on failure */
function safeParseJSON<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    logger.warn(`[PromptAssembler] Failed to parse JSON: ${raw.slice(0, 100)}`);
    return fallback;
  }
}
