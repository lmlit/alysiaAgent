// src/memory/engines/ProfileExtractor.ts
import type { MemoryEvent, ProfileFact } from '../types.js';
import { FACT_TTL_BY_CATEGORY } from '../types.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import { logger } from '../../utils/logger.js';
// ★ 2026-10-01：改用共用解析器（剥 markdown 围栏 + 空判 + 裸文本分类）——
//   与 SessionEndProcessor 同款。原来的裸 `JSON.parse` 遇到围栏直接抛，
//   抛了又被 catch 吞掉，是画像静默停摆的帮凶。
import { parseLLMJson } from '../../utils/llm-json.js';
// ★ add-memory-channel-field：事实条目的渠道派生（写入时落库）
import { channelOfSession } from '../../utils/channel.js';
// ★ 2026-10-20（change: collect-memory-prompts）：提示词资产已外置（逐字搬移，零改动）
import {
  PROFILE_EXTRACT_SYSTEM_PROMPT,
  buildCorrectionPrompt,
} from '../../prompts/memory.js';
// ★ 2026-10-21（change: `unify-memory-eligibility`，C1）：来源筛选的唯一判据
import { filterEligible } from '../eligibility.js';

/**
 * ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C4 / E5）：提取结果必须**可分三种**。
 *
 * 旧返回值只有两个数组 ⇒ 调用方**分不清**「看了，确实没有新事实」与「提取失败」：
 * 两者都是空数组，后者只留一行 error 日志，而摘要行是 `'ok'` ⇒ 锚点前进 ⇒
 * 那批事实**永久不可重提**。这就是 E5 的机制。
 */
export interface ExtractResult {
  facts: ProfileFact[];
  characterFacts: ProfileFact[];
  /** 有没有真的调用过 LLM（false = 本窗口没有可提取的用户发言，**不是失败**） */
  attempted: boolean;
  /** 失败原因（有值 ⇒ `facts_status='failed'`，可被 `retryFailedFactExtraction` 补） */
  error?: string;
}

export interface CorrectionSignal {
  isCorrection: boolean;
  /** 被纠正的旧事实关键词（用于 fuzzy match） */
  target?: string;
  /** 新事实内容 */
  newFact?: string;
  /** 原始用户消息 */
  rawText: string;
}

/** ★ 8-28 容错映射（profile-extractor-category-fix）：LLM 实测输出 location/interest/hobby
 *  等自由词不遵循枚举 → 全回落 general（分类功能形同虚设）。同义词表兜底映射。 */
const CATEGORY_SYNONYMS: Record<string, ProfileFact['category']> = {
  location: 'identity',
  city: 'identity',
  career: 'identity',
  job: 'identity',
  age: 'identity',
  identity: 'identity',
  interest: 'preference',
  hobby: 'preference',
  taste: 'preference',
  food: 'preference',
  preference: 'preference',
  current: 'status',
  recent: 'status',
  state: 'status',
  status: 'status',
  friend: 'relationship',
  relation: 'relationship',
  relationship: 'relationship',
  general: 'general',
  other: 'general',
};

/** ★ 9-25 wire-importance-signal：画像提取的重要性门槛（与 MemoryConfig.importance_threshold 默认一致） */
const IMPORTANCE_FLOOR = 0.4;
/** 过线事件少于此数时回退用全部（防止重要度稀疏饿死画像提取） */
const MIN_SIGNIFICANT = 3;

export class ProfileExtractor {
  constructor(private llm: ILLMService) {}

  // ===== Fact 提取 (慢路径，SessionEnd 使用) =====

  /** ★ 8-28 双输出（memory-character-perspective）：用户事实 + 角色事实（昔涟自己的事） */
  async extract(events: MemoryEvent[]): Promise<ExtractResult> {
    // ★ 9-25 wire-importance-signal：importance 接线后，启用原注释所写的过滤意图。
    //   原来是 `const significantEvents = events;` —— 当时 importance 恒 0，过滤等于全杀。
    //
    //   安全下限：过滤后剩不足 MIN_SIGNIFICANT 条就**回退用全部**。
    //   宁可多提一点噪音，也不能因重要度稀疏就让画像停止生长。
    //
    // ★ 2026-10-21（change: `unify-memory-eligibility`，C1）：**来源筛选改走唯一判据**。
    //   原来这里自带三段手写 filter（`type==='message'` + `role==='user'||sender_id`
    //   + `skip_profile!==true`），而它**不看 `synthetic`** —— 与
    //   `SessionEndProcessor`、`RealtimeProcessor`、`EventStore` 三处的写法互不相同（E1/E4 同族）。
    //   现在只有一句：谁能进画像事实，由 `eligibility.ts` 的矩阵说了算。
    const factsEligible = filterEligible(events, 'profile-facts');
    const byImportance = factsEligible.filter(e => (e.importance ?? 0) >= IMPORTANCE_FLOOR);
    const significantEvents = byImportance.length >= MIN_SIGNIFICANT ? byImportance : factsEligible;
    const userMessages = significantEvents
      .map(e => `[user]: ${e.payload?.content}`)
      .join('\n');

    // ★ C4：**没调过 LLM** 与**调了但失败**必须分开（旧实现两者都返回空数组）
    if (!userMessages.trim()) return { facts: [], characterFacts: [], attempted: false };

    try {
      const response = await this.llm.complete(
        // 提示词见 `prompts/memory.ts`（逐字搬移，注释与约束都在那边）
        PROFILE_EXTRACT_SYSTEM_PROMPT,
        userMessages
      );
      // parseLLMJson 在 kind === 'json' 时 value 为 any——沿用原实现对该值的宽松处理
      const r = parseLLMJson(response);
      if (r.kind === 'empty') {
        throw new Error('LLM 返回空响应（推理预算可能被耗尽——见 sampling.ts 的 profile.extract）');
      }
      if (r.kind === 'bare') {
        // 裸文本对画像提取**没有用**：拿不到 fact/confidence/category 结构。
        throw new Error(`LLM 未返回合法 JSON（truncated=${r.truncated}）: ${r.text.slice(0, 80)}`);
      }
      const parsed = r.value;
      // ★ 8-28 分类接线：按 category 设 valid_until（TTL：identity 365d/preference 90d/status 14d/
      //   relationship 90d/general 60d）；transient 兼容（无 category 时 transient=true → status 14 天）
      const ttlMs = (cat: string) => FACT_TTL_BY_CATEGORY[cat as keyof typeof FACT_TTL_BY_CATEGORY] ?? FACT_TTL_BY_CATEGORY.general;
      const toFact = (f: { fact: string; confidence: number; evidence: string; directly_stated?: boolean; transient?: boolean; category?: string }, index: number): ProfileFact => {
        // ★ 8-28 修复：枚举校验 + 同义词容错映射（LLM 自由词 → 标准枚举）；transient 兼容兜底
        const raw = String(f.category ?? '').trim().toLowerCase();
        const category = (['identity', 'preference', 'status', 'relationship', 'general'] as const).includes(raw as never)
          ? (raw as ProfileFact['category'])
          : (CATEGORY_SYNONYMS[raw] ?? (f.transient ? 'status' as const : 'general' as const));
        return {
          fact: f.fact,
          confidence: f.confidence,
          evidence: f.evidence,
          source_event: events[0]?.id || `unknown-${index}`,
          updated_at: new Date().toISOString(),
          // ★ 用户直接陈述的事实标 source='user'（PromptAssembler 显示"[你说过]"且不可被推断覆盖）。
          //   之前硬编码 'inferred'，导致所有事实显示"（待确认）"，被 LLM 打折对待。
          source: f.directly_stated ? 'user' as const : 'inferred' as const,
          valid_from: new Date().toISOString(),
          // ★ 8-28 分类过期：按类别 TTL（显式 TTL 语义覆盖旧 transient 48h 二元制）
          valid_until: new Date(Date.now() + ttlMs(category)).toISOString(),
          status: 'active' as const,
          category,
          // ★ 2026-10-16（add-memory-channel-field）：渠道**写入时**就记下来。
          //   起源事件这里拿得到（`events[0]`），所以能如实派生 qq/dsh/webui；
          //   拿不到事件时记 'unknown'（**不许猜**）。
          //   ⚠️ 不要拿上面的 `source` 当渠道 —— 它是提取方式（user/inferred）。
          channel: channelOfSession(events[0]?.session_id),
        };
      };
      // ★ 8-28 双输出：用户事实 + 角色事实（角色事实 source 固定 inferred——对话中推断的角色信息）
      const userFacts = (parsed.facts || []).map((f: Parameters<typeof toFact>[0], i: number) => toFact(f, i));
      const characterFacts = (parsed.character_facts || []).map((f: Parameters<typeof toFact>[0], i: number) => ({
        ...toFact(f, i),
        source: 'inferred' as const,
        source_event: events[0]?.id || `unknown-c${i}`,
      }));
      return { facts: userFacts, characterFacts, attempted: true };
    } catch (err: any) {
      // ★ 2026-10-01 fix-profile-extract-empty-response：
      //   原来是**裸 `catch {}`**（这个文件此前连 logger 都没 import）——
      //   失败与「正常但没提取到」长得一模一样，画像因此静默停摆且无人察觉。
      //   同一模式在本项目已酿成 3 次事故（HANDOFF：成功日志掩盖了没做的事）。
      //
      // ★ 2026-10-21（C4/E5）：光有日志**不够** —— 日志没人聚合，而窗口会随锚点前进消失。
      //   现在把失败**返回给调用方**，由它落 `facts_status='failed'`（库里的一行状态），
      //   这样这批事实还有机会被补处理。日志保留（它是"当下就看得见"的那一层）。
      logger.error(
        `[ProfileExtractor] 提取失败，本批 ${events.length} 条事件的事实未入库（窗口已标 failed，可补）: ${err?.message ?? err}`,
      );
      return { facts: [], characterFacts: [], attempted: true, error: String(err?.message ?? err) };
    }
  }

  // ===== v2: 状态感知的 mergeFacts =====

  /**
   * 合并新旧 facts，冲突时旧条 superseded（不删除），返回完整列表。
   * 由 ProfileStore.addFacts() 负责实际的冲突检测和写入，
   * 此方法保留用于向前兼容和独立测试。
   */
  mergeFacts(newFacts: ProfileFact[], existing: ProfileFact[]): ProfileFact[] {
    const now = new Date().toISOString();
    const result = existing.map(f => ({ ...f })); // shallow copy
    const normalizedExisting = new Map<string, number>();

    // Index existing active facts by normalized key
    for (let i = 0; i < result.length; i++) {
      if (result[i].status === 'active') {
        const key = this.normalizeKey(result[i].fact);
        normalizedExisting.set(key, i);
      }
    }

    for (const newFact of newFacts) {
      const key = this.normalizeKey(newFact.fact);
      const existingIdx = normalizedExisting.get(key);

      if (existingIdx !== undefined) {
        const existing = result[existingIdx];
        // user 来源不可被 inferred 覆盖
        if (existing.source === 'user' && (newFact.source || 'inferred') === 'inferred') {
          continue;
        }
        // supersede 旧条
        result[existingIdx] = {
          ...existing,
          status: 'superseded' as const,
          valid_until: now,
          updated_at: now,
        };
      }

      // 插入新条
      result.push({
        ...newFact,
        source: newFact.source || 'inferred',
        confidence: newFact.confidence ?? 0.4,
        status: 'active',
        valid_from: newFact.valid_from || now,
        valid_until: newFact.valid_until ?? null,
        updated_at: now,
      });
    }

    return result;
  }

  // ===== v2: 纠正信号检测 (快路径) =====

  /**
   * 检测用户消息中是否包含对已有事实的纠正信号。
   * 先用关键词快速筛选，再用 LLM 确认。
   */
  async detectCorrectionSignal(
    text: string,
    existingFacts: ProfileFact[],
  ): Promise<CorrectionSignal> {
    const baseResult: CorrectionSignal = { isCorrection: false, rawText: text };

    // Step 1: 关键词快速筛选
    const correctionKeywords = /不是|记错了|改了|不对|纠正一下|说错了|不对不对|没有啦/i;
    if (!correctionKeywords.test(text)) {
      return baseResult;
    }

    // Step 2: LLM 确认 + 定位被纠正的 fact + 提取新事实
    const activeFacts = existingFacts
      .filter(f => f.status === 'active')
      .map(f => `- ${f.fact} (来源: ${f.source}, 置信度: ${f.confidence})`)
      .join('\n');

    if (!activeFacts) return baseResult;

    try {
      const response = await this.llm.complete(
        // 提示词见 `prompts/memory.ts`（带一处插值，故是函数）
        buildCorrectionPrompt(activeFacts),
        text
      );

      const parsed = JSON.parse(response);
      if (parsed.isCorrection && parsed.target) {
        return {
          isCorrection: true,
          target: parsed.target,
          newFact: parsed.newFact || undefined,
          rawText: text,
        };
      }
    } catch {
      // LLM failed — fall back to returning no correction signal.
      // Previously this would treat the entire message as a correction target,
      // which could cause unintended profile data supersession on API errors.
      return baseResult;
    }

    return baseResult;
  }

  /** 暴露 normalizeKey 供 ProfileStore 使用 */
  normalizeKey(fact: string): string {
    return fact
      .replace(/[的得了吗呢是个了]/g, '')
      .replace(/[职业开发工程师前端后端架构设计运营产品]/g, '')
      .replace(/[\s，,。！？]/g, '')
      .slice(0, 20)
      .toLowerCase();
  }
}
