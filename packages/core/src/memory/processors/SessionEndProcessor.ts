// src/memory/processors/SessionEndProcessor.ts
import type { MemoryEvent, Conversation } from '../types.js';
import { PROCESSED_SUMMARY } from '../types.js';
import { logger } from '../../utils/logger.js';
import type { EventStore } from '../stores/EventStore.js';
import type { ConversationStore } from '../stores/ConversationStore.js';
import type { ProfileStore } from '../stores/ProfileStore.js';
import type { PersonaStore } from '../stores/PersonaStore.js';
import type { WorldbookStore } from '../stores/WorldbookStore.js';
import type { ProfileExtractor } from '../engines/ProfileExtractor.js';
import type { PersonaAdapter } from '../engines/PersonaAdapter.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import type { IEmbedService } from '../interfaces/IEmbedService.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';

/**
 * SessionEndProcessor handles end-of-session aggregation:
 *   1. Fetch all unprocessed events for the session
 *   2. Generate a conversation summary via LLM
 *   3. Insert Conversation record + embed vector
 *   4. Extract profile facts from session events and merge into ProfileStore
 *   5. Confirm persona adjustments (apply any pending hints)
 *   6. Mark all session events as PROCESSED_SUMMARY
 */
export class SessionEndProcessor {
  constructor(
    private eventStore: EventStore,
    private conversationStore: ConversationStore,
    private profileStore: ProfileStore,
    private personaStore: PersonaStore,
    private worldbookStore: WorldbookStore,
    private profileExtractor: ProfileExtractor,
    private personaAdapter: PersonaAdapter,
    private llmService: ILLMService,
    private embedService: IEmbedService,
    private vectorStore: IVectorStore | null,
  ) {}

  /** ★ 8-09：since 可选——定时归档只摘要 since 之后的消息（防对同一批消息重复摘要） */
  async process(sessionId: string, since?: Date): Promise<void> {
    // 1. Get all events for session
    // We use countBySession logic: we need all events, so we fetch from the DB.
    // Since EventStore doesn't have getBySession, we'll retrieve a large batch
    // of unprocessed events and filter. For simplicity, we iterate.
    const events = this.getSessionEvents(sessionId);
    if (events.length === 0) return;

    const messageEvents = events.filter(e => e.type === 'message' && (!since || new Date(e.created_at) >= since));
    if (messageEvents.length === 0) return;

    // ★ 8-09 摘要含 assistant：带角色标记的完整对话（回写后 AI 发言也进摘要）
    const dialogue = messageEvents
      .map(e => {
        const p = e.payload;
        if (!p?.content) return '';
        // 兼容两种 payload：新消息有 role 字段；旧消息可凭 sender_id 判断用户消息
        const isUser = p.role === 'user' || !!p.sender_id;
        return `[${isUser ? '用户' : '昔涟'}] ${p.content}`;
      })
      .filter(Boolean) as string[];

    // 2. Generate conversation summary via LLM
    const conversationSummary = await this.generateSummary(dialogue, sessionId);

    // 2.5 ★ 9-25 wire-importance-signal：把 LLM 挑出的「重要时刻」回填到具体事件。
    //     放在这里而不是最后：它只依赖 messageEvents 与 summary，越早回填，
    //     后续步骤（画像提取）就能用上 importance。
    await this.applyImportantMoments(conversationSummary.important_moments, messageEvents);

    // 3. Insert Conversation + embed vector
    const now = new Date().toISOString();
    const conv: Conversation = {
      id: `conv-${sessionId}-${Date.now()}`,
      session_id: sessionId,
      summary: conversationSummary.summary,
      participants: JSON.stringify(conversationSummary.participants),
      topics: JSON.stringify(conversationSummary.topics),
      key_decisions: JSON.stringify(conversationSummary.key_decisions),
      message_count: messageEvents.length,
      started_at: events[0]?.created_at || now,
      ended_at: now,
      embedding_id: null,
      // ★ 8-28 角色视角（memory-character-perspective）
      character_perspective: conversationSummary.character_perspective,
    };

    let embedVector: number[] | undefined;
    if (this.vectorStore) {
      try {
        embedVector = await this.embedService.embed(conversationSummary.summary);
      } catch {
        // Embedding failure is non-fatal
      }
    }

    await this.conversationStore.insert(conv, embedVector);

    // 4. Extract profile facts from session events (v2: 使用 addFacts 自动处理冲突)
    //    ★ 8-28 角色视角（memory-character-perspective）：同一次提取双输出——用户事实 +
    //    角色事实（昔涟自己的事）分库写入
    if (messageEvents.length > 0) {
      const extracted = await this.profileExtractor.extract(messageEvents);
      if (extracted.facts.length > 0) {
        this.profileStore.addFacts(extracted.facts);
      }
      if (extracted.characterFacts.length > 0) {
        this.profileStore.addCharacterFacts(extracted.characterFacts);
      }
    }

    // 5. Confirm persona adjustments (check for pending adaptations)
    await this.confirmPersona(events);

    // 6. Mark all events as PROCESSED_SUMMARY
    for (const event of events) {
      this.eventStore.markProcessed(event.id, PROCESSED_SUMMARY);
    }
  }

  private getSessionEvents(sessionId: string): MemoryEvent[] {
    return this.eventStore.getBySession(sessionId);
  }

  private async generateSummary(
    dialogue: string[],
    sessionId: string,
  ): Promise<{
    summary: string;
    participants: string[];
    topics: string[];
    key_decisions: string[];
    character_perspective: string;
    /** ★ 9-25 wire-importance-signal：LLM 顺带指出这段对话里最重要的几处 */
    important_moments: Array<{ quote: string; importance: number }>;
  }> {
    const defaultSummary = {
      summary: `Session ${sessionId} summary`,
      participants: ['user', 'assistant'],
      topics: [] as string[],
      key_decisions: [] as string[],
      character_perspective: '',
      important_moments: [] as Array<{ quote: string; importance: number }>,
    };

    if (dialogue.length === 0) return defaultSummary;

    try {
      const conversationText = dialogue.join('\n');
      // ★ 8-28 角色视角（memory-character-perspective）：摘要同时总结昔涟的感受/变化
      // ★ 9-25 importance：**复用这一次调用**顺带打分——不额外增加 LLM 成本。
      //   要求返回原文摘句而不是编号：LLM 拿不到事件 id，只能靠文本匹配回填。
      const response = await this.llmService.complete(
        '你是一个会话总结器。请总结以下对话（[用户]/[昔涟] 标记发言者），提取关键主题和决定。' +
        '同时用一句话总结**昔涟**在这段对话中的感受或变化（角色视角，如"昔涟聊到雨时语气变得柔软"、"昔涟对游戏话题显得兴致勃勃"；没有明显情绪变化就留空字符串）。' +
        '另外挑出这段对话里**最值得长期记住的 1-3 处**（关系里程碑、承诺、重要偏好、情绪强烈的时刻），' +
        '每处给一个**原文摘句**（10-40 字的连续原文片段，用于回定位）和 importance（0.7-0.95 的小数，越重要越高）。' +
        '没有值得记的就返回空数组，不要硬凑。' +
        '返回JSON格式: {"summary": "...", "participants": ["user", "assistant"], "topics": [...], "key_decisions": [...], "character_perspective": "...", ' +
        '"important_moments": [{"quote": "原文摘句", "importance": 0.85}]}',
        conversationText,
      );

      const parsed = JSON.parse(response);
      return {
        summary: parsed.summary || defaultSummary.summary,
        participants: parsed.participants || defaultSummary.participants,
        topics: parsed.topics || [],
        key_decisions: parsed.key_decisions || [],
        character_perspective: typeof parsed.character_perspective === 'string' ? parsed.character_perspective.slice(0, 200) : '',
        important_moments: this.parseImportantMoments(parsed.important_moments),
      };
    } catch (err: any) {
      logger.warn(`[SessionEnd] summary LLM failed, using default: ${err.message}`);
      return defaultSummary;
    }
  }

  /** 解析并夹取 LLM 返回的 important_moments（形状不可信，逐项校验） */
  private parseImportantMoments(
    raw: unknown,
  ): Array<{ quote: string; importance: number }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ quote: string; importance: number }> = [];
    // ★ 先逐项校验、**最后**才截 3 条 —— 若先截再校验，
    //   LLM 多返回几条非法项时会把后面的合法项误伤掉（单测抓到过）。
    for (const item of raw) {
      const quote = typeof (item as any)?.quote === 'string' ? (item as any).quote.trim() : '';
      const imp = Number((item as any)?.importance);
      if (!quote || !Number.isFinite(imp)) continue;
      out.push({ quote, importance: Math.min(1, Math.max(0, imp)) });
    }
    return out.slice(0, 3);
  }

  /**
   * ★ 9-25 wire-importance-signal：把 LLM 挑出的「重要时刻」回填到具体事件上。
   *
   * 匹配方式：**原文摘句的子串包含**（双向：摘句含于消息，或消息含于摘句），
   * 只在本次摘要覆盖的时间窗内的消息里找。LLM 拿不到事件 id，这是唯一可行路径。
   *
   * 匹配不上的**记日志不静默丢** —— LLM 可能改写了标点或加了省略号，
   * 日志留着才能发现匹配率问题。
   *
   * 匹配上之后要**刷新向量 metadata**：召回读的是 `metadata.importance`，
   * 而事件是实时嵌好的、那时 importance 还是 0。重新嵌入一次（每条一次，通常 1-3 条）。
   */
  private async applyImportantMoments(
    moments: Array<{ quote: string; importance: number }>,
    candidates: MemoryEvent[],
  ): Promise<number> {
    if (moments.length === 0) return 0;
    let applied = 0;
    for (const { quote, importance } of moments) {
      const norm = (s: string) => s.replace(/\s+/g, '');
      const q = norm(quote);
      if (!q) continue;
      const hit = candidates.find(e => {
        const c = norm(String(e.payload?.content ?? ''));
        return c && (c.includes(q) || q.includes(c));
      });
      if (!hit) {
        logger.warn(`[SessionEnd] important_moment 未匹配到消息: "${quote.slice(0, 30)}"`);
        continue;
      }
      this.eventStore.updateImportance(hit.id, importance);
      // 刷新向量 metadata（召回读的是这里）
      if (this.vectorStore) {
        try {
          const text = String(hit.payload?.content ?? '');
          const vector = await this.embedService.embed(text);
          await this.vectorStore.insert(hit.id, vector, text, {
            source: hit.source,
            type: hit.type,
            session_id: hit.session_id,
            created_at: hit.created_at,
            importance,
          });
        } catch (err: any) {
          logger.warn(`[SessionEnd] importance 回填向量失败 (${hit.id.slice(0, 20)}): ${err.message}`);
        }
      }
      applied++;
    }
    if (applied > 0) {
      logger.info(`[SessionEnd] important_moments 回填 ${applied}/${moments.length} 条`);
    }
    return applied;
  }

  /** @deprecated 所有事件 type 均为 'message'，不存在 'persona_change' 事件。
   *  人格调整已由 RealtimeProcessor 实时处理。此方法保留以备未来事件类型扩展。 */
  private async confirmPersona(events: MemoryEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === 'persona_change') {
        const adjustment = await this.personaAdapter.processSignal(event);
        if (adjustment) {
          this.personaAdapter.apply(adjustment);
        }
      }
    }
  }
}
