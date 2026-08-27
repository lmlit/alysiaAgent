// src/memory/engines/ProfileExtractor.ts
import type { MemoryEvent, ProfileFact } from '../types.js';
import { FACT_TTL_BY_CATEGORY } from '../types.js';
import type { ILLMService } from '../interfaces/ILLMService.js';

export interface CorrectionSignal {
  isCorrection: boolean;
  /** 被纠正的旧事实关键词（用于 fuzzy match） */
  target?: string;
  /** 新事实内容 */
  newFact?: string;
  /** 原始用户消息 */
  rawText: string;
}

export class ProfileExtractor {
  constructor(private llm: ILLMService) {}

  // ===== Fact 提取 (慢路径，SessionEnd 使用) =====

  /** ★ 8-28 双输出（memory-character-perspective）：用户事实 + 角色事实（昔涟自己的事） */
  async extract(events: MemoryEvent[]): Promise<{ facts: ProfileFact[]; characterFacts: ProfileFact[] }> {
    // 服务端 ingest 不计算 importance（恒为 0），所以不过滤重要性。
    // 是否值得提取由 LLM 自行判断（prompt 中已要求"不确定则不提取"）。
    const significantEvents = events;
    const userMessages = significantEvents
      .filter(e => e.type === 'message')
      // 兼容两种 payload：新消息有 role 字段；旧消息凭 sender_id 判断
      .filter(e => (e.payload?.role === 'user' || !!e.payload?.sender_id))
      // 排除群聊 NPC 消息（非 owner 标记 skip_profile）
      .filter(e => e.payload?.skip_profile !== true)
      .map(e => `[user]: ${e.payload?.content}`)
      .join('\n');

    if (!userMessages.trim()) return { facts: [], characterFacts: [] };

    try {
      const response = await this.llm.complete(
        '你是一个用户画像提取器。提取关于用户的事实，每条附置信度(0-1)和原文证据。' +
        'directly_stated: 用户是否直接陈述了这个事实（true=用户亲口说的，如"我周末不上班"；' +
        'false=你从对话中推断的，如"用户可能从事技术工作"）。不确定则不提取。' +
        // ★ 8-12 时效性分类（profile-transient-expiry）：瞬时事件不固化进长期画像
        'transient: 该事实是否为时效性信息（true=仅在某个时间点/短期内成立：某天吃了什么、' +
        '当天状态、单次事件、梦境、近期近况；false=稳定属性：城市/职业/习惯/偏好/关系/身体状况/长期爱好）。' +
        // ★ 8-28 分类（profile-facts-classification-confirm）：按语义判类别——
        //   identity=身份属性（城市/职业/年龄/长期状态）；preference=偏好（口味/兴趣/习惯）；
        //   status=当前状态（最近在做什么/近况）；relationship=与昔涟的关系/互动模式；general=其他稳定事实。
        //   状态类（status）过期最快（14 天），身份类最慢（365 天）——判错倾向 identity/general 保守即可。
        'category: "identity"|"preference"|"status"|"relationship"|"general"。' +
        // ★ 8-28 角色视角（memory-character-perspective）：除用户事实外，同时提取对话中
        //   反映的**昔涟自己的事**（她的感受/态度/变化/习惯/看法）——结构与用户事实相同。
        //   示例："昔涟在对话中表现出对下雨的喜爱"、"昔涟最近在学做点心"。
        //   character_facts 留空数组也可以（不是每段对话都有角色事实）。
        '返回JSON: {"facts": [{"fact": "...", "confidence": 0.8, "evidence": "...", "directly_stated": true, "transient": false, "category": "preference"}], "character_facts": [{"fact": "...", "confidence": 0.6, "evidence": "...", "category": "preference"}]}',
        userMessages
      );
      const parsed = JSON.parse(response);
      // ★ 8-28 分类接线：按 category 设 valid_until（TTL：identity 365d/preference 90d/status 14d/
      //   relationship 90d/general 60d）；transient 兼容（无 category 时 transient=true → status 14 天）
      const ttlMs = (cat: string) => FACT_TTL_BY_CATEGORY[cat as keyof typeof FACT_TTL_BY_CATEGORY] ?? FACT_TTL_BY_CATEGORY.general;
      const toFact = (f: { fact: string; confidence: number; evidence: string; directly_stated?: boolean; transient?: boolean; category?: string }, index: number): ProfileFact => {
        const category = (['identity', 'preference', 'status', 'relationship', 'general'] as const).includes(f.category as never)
          ? (f.category as ProfileFact['category'])
          : (f.transient ? 'status' as const : 'general' as const);
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
        };
      };
      // ★ 8-28 双输出：用户事实 + 角色事实（角色事实 source 固定 inferred——对话中推断的角色信息）
      const userFacts = (parsed.facts || []).map((f: Parameters<typeof toFact>[0], i: number) => toFact(f, i));
      const characterFacts = (parsed.character_facts || []).map((f: Parameters<typeof toFact>[0], i: number) => ({
        ...toFact(f, i),
        source: 'inferred' as const,
        source_event: events[0]?.id || `unknown-c${i}`,
      }));
      return { facts: userFacts, characterFacts };
    } catch {
      return { facts: [], characterFacts: [] };
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
        `你是一个对话理解器。判断用户消息是否在纠正自己之前说过的事实。

当前已知的活跃事实:
${activeFacts}

如果用户在纠正，指出被纠正的事实关键词(必须能在上述列表中模糊匹配到)和新的事实内容。
如果不是纠正，返回 isCorrection: false。

返回JSON: {"isCorrection": true/false, "target": "被纠正的关键词", "newFact": "新的事实"}`,
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
