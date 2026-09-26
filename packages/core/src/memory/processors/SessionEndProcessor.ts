// src/memory/processors/SessionEndProcessor.ts
import type { MemoryEvent, Conversation } from '../types.js';
import { PROCESSED_SUMMARY } from '../types.js';
import { logger } from '../../utils/logger.js';
import { parseLLMJson } from '../../utils/llm-json.js';
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
 * ★ 9-26 fix-session-event-window-truncation：`process()` 的处理结果。
 *
 * 存在的意义是**让空转可区分**：此前 `process()` 返回 void，调用方无条件计数，
 * 于是"提前 return、什么都没做"和"归档成功"在日志里长得一样
 * （线上表现为 `archived 1/1` 而库里 0 条新摘要，持续 18 小时无人发现）。
 */
export interface SessionEndResult {
  /** 是否产生了可用的摘要（写入了 status='ok' 的行） */
  summarized: boolean;
  /** 未产生摘要的原因 */
  reason?: 'no-events' | 'no-messages' | 'no-dialogue' | 'summary-failed';
}

/** LLM 摘要的结构化输出（成功路径） */
interface SummaryData {
  summary: string;
  participants: string[];
  topics: string[];
  key_decisions: string[];
  character_perspective: string;
  important_moments: Array<{ quote: string; importance: number }>;
}

/** ★ 8-28 角色视角（memory-character-perspective）：摘要同时总结昔涟的感受/变化
 *  ★ 9-25 importance：**复用这一次调用**顺带打分——不额外增加 LLM 成本。
 *    要求返回原文摘句而不是编号：LLM 拿不到事件 id，只能靠文本匹配回填。 */
const SUMMARY_SYSTEM_PROMPT =
  '你是一个会话总结器。请总结以下对话（[用户]/[昔涟] 标记发言者），提取关键主题和决定。' +
  '同时用一句话总结**昔涟**在这段对话中的感受或变化（角色视角，如"昔涟聊到雨时语气变得柔软"、"昔涟对游戏话题显得兴致勃勃"；没有明显情绪变化就留空字符串）。' +
  '另外挑出这段对话里**最值得长期记住的 1-3 处**（关系里程碑、承诺、重要偏好、情绪强烈的时刻），' +
  '每处给一个**原文摘句**（10-40 字的连续原文片段，用于回定位）和 importance（0.7-0.95 的小数，越重要越高）。' +
  '没有值得记的就返回空数组，不要硬凑。' +
  '返回JSON格式: {"summary": "...", "participants": ["user", "assistant"], "topics": [...], "key_decisions": [...], "character_perspective": "...", ' +
  '"important_moments": [{"quote": "原文摘句", "importance": 0.85}]}';

/**
 * SessionEndProcessor handles end-of-session aggregation:
 *   1. Fetch all unprocessed events for the session
 *   2. Generate a conversation summary via LLM
 *   3. Insert Conversation record + embed vector
 *   4. Extract profile facts from session events and merge into ProfileStore
 *   5. Confirm persona adjustments (apply any pending hints)
 *   6. Mark all session events as PROCESSED_SUMMARY
 *
 * ★ 9-25 fix-session-summary-silent-failure：第 2 步失败时**不再写占位符**——
 *   改为落一条 `summary_status='failed'` 的行（summary 空、无向量），失败因此**可见且可补**。
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

  /**
   * ★ 8-09：since 可选——定时归档只摘要 since 之后的消息（防对同一批消息重复摘要）
   *
   * ★ 9-26 fix-session-event-window-truncation：
   *   1. `since` **下推到 SQL**（原实现是"取 1000 条再内存 filter"，窗口外有多老
   *      会决定窗口内取不取得到——主会话超 1000 条后管道就空转了）。
   *   2. **返回处理结果**而不是 `void`——空转绝不能伪装成成功：
   *      调用方（archiveStaleSessions）原先无条件 `archived++`，
   *      于是"什么都没做"在日志里长得和"归档成功"一模一样。
   */
  async process(sessionId: string, since?: Date): Promise<SessionEndResult> {
    // 1. 取该会话的（窗口内）最近事件
    const events = this.getSessionEvents(sessionId, since);
    if (events.length === 0) return { summarized: false, reason: 'no-events' };

    const messageEvents = events.filter(e => e.type === 'message');
    if (messageEvents.length === 0) return { summarized: false, reason: 'no-messages' };

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

    // 没有任何可摘要的文本（消息无 content）→ 跳过。这**不是**失败，
    // 不该落一条 failed 行（否则会制造噪声，掩盖真正的失败）。
    if (dialogue.length === 0) {
      logger.info(`[SessionEnd] 无可用对话文本，跳过: ${sessionId.slice(-24)}`);
      return { summarized: false, reason: 'no-dialogue' };
    }

    // 2. Generate conversation summary via LLM
    //    ★ 9-25 fix-session-summary-silent-failure：**失败不再伪装成成功**。
    //      原实现 catch 后 `return defaultSummary`（`"Session <id> summary"`）——
    //      失败被存成一个看起来像内容的字符串，线上因此 22 天无人发现。
    //      现在失败会留下可见的 `summary_status='failed'`。
    let summaryData: SummaryData | null = null;
    try {
      summaryData = await this.generateSummary(dialogue);
    } catch (err: any) {
      logger.warn(`[SessionEnd] 摘要生成失败，记为 failed（不写占位符）: ${err?.message ?? err}`);
    }
    const ok = summaryData !== null;

    // 2.5 ★ 9-25 wire-importance-signal：把 LLM 挑出的「重要时刻」回填到具体事件。
    //     放在这里而不是最后：它只依赖 messageEvents 与 summary，越早回填，
    //     后续步骤（画像提取）就能用上 importance。
    //     摘要失败 → 没有 moments 可回填，跳过。
    if (summaryData) {
      await this.applyImportantMoments(summaryData.important_moments, messageEvents);
    }

    // 3. Insert Conversation + embed vector
    //    摘要失败时**仍然插行**：保留 message_count / 时间 / 事件关联，
    //    这样失败窗口不会随 PROCESSED_SUMMARY 标记一起消失，后续可回填。
    const now = new Date().toISOString();
    const conv: Conversation = {
      id: `conv-${sessionId}-${Date.now()}`,
      session_id: sessionId,
      summary: ok ? summaryData!.summary : '',
      participants: JSON.stringify(ok ? summaryData!.participants : []),
      topics: JSON.stringify(ok ? summaryData!.topics : []),
      key_decisions: JSON.stringify(ok ? summaryData!.key_decisions : []),
      message_count: messageEvents.length,
      started_at: events[0]?.created_at || now,
      ended_at: now,
      embedding_id: null,
      // ★ 8-28 角色视角（memory-character-perspective）
      character_perspective: ok ? summaryData!.character_perspective : '',
      summary_status: ok ? 'ok' : 'failed',
    };

    let embedVector: number[] | undefined;
    // ★ 只在成功时 embed。失败时 summary 为空，嵌入它等于往 LanceDB 里塞垃圾向量——
    //   而垃圾向量**会被召回出来当真内容用**，比"缺一条向量"危险得多
    //   （还会污染相似度分布，干扰召回系数调参）。
    if (ok && this.vectorStore) {
      try {
        embedVector = await this.embedService.embed(conv.summary);
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

    return ok ? { summarized: true } : { summarized: false, reason: 'summary-failed' };
  }

  /** ★ 9-26：`since` 透传到 SQL（窗口过滤下推，不受"最旧 1000 条"截断影响） */
  private getSessionEvents(sessionId: string, since?: Date): MemoryEvent[] {
    return this.eventStore.getBySession(sessionId, { since });
  }

  /**
   * 生成会话摘要。
   *
   * ★ 9-25 fix-session-summary-silent-failure：
   *   - 改用**共用解析器** `parseLLMJson`（剥围栏 + 空判 + 裸文本分类）——
   *     原实现是裸 `JSON.parse(response)`，模型包一层 ```json 就炸（线上真实报错）。
   *   - 失败时**抛异常**而不是返回占位符。调用方据此落 `summary_status='failed'`。
   *     绝不再返回 `"Session <id> summary"` 这种"看起来像内容"的字符串。
   */
  private async generateSummary(dialogue: string[]): Promise<SummaryData> {
    if (dialogue.length === 0) throw new Error('无对话内容可摘要');

    // ★ 9-25 真实 API 实测：即使开了 json_object，模型仍**偶发返回空响应**
    //   （0 字、HTTP 200；脚本 scripts/verify-session-summary-fix.ts 里 3 次出现 1 次）。
    //   空响应是瞬时的、与内容无关 —— 线上每日反思那 11 次 "empty response" 大概率同源。
    //   重试一次就能过，代价远低于"整段会话记忆丢失"。
    const MAX_ATTEMPTS = 2;
    let lastErr: unknown = new Error('未尝试');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.generateSummaryOnce(dialogue);
      } catch (err: any) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(`[SessionEnd] 摘要第 ${attempt} 次失败，重试: ${err?.message ?? err}`);
        }
      }
    }
    throw lastErr;
  }

  /** 单次摘要调用（重试逻辑在 generateSummary 里） */
  private async generateSummaryOnce(dialogue: string[]): Promise<SummaryData> {
    const response = await this.llmService.complete(SUMMARY_SYSTEM_PROMPT, dialogue.join('\n'));
    const r = parseLLMJson(response);

    if (r.kind === 'empty') {
      throw new Error('LLM 返回空响应');
    }
    if (r.kind === 'bare') {
      // 裸文本对摘要**没有用**——拿不到 topics/key_decisions 等结构化字段。
      // （对比：生活事件可以把裸文本直接当正文，摘要不行。）
      throw new Error(`LLM 未返回合法 JSON（truncated=${r.truncated}）: ${r.text.slice(0, 80)}`);
    }

    const parsed = r.value;
    const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
    if (!summary) throw new Error('LLM 返回的 JSON 缺少 summary 字段');

    return {
      summary,
      participants: Array.isArray(parsed.participants) ? parsed.participants : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      key_decisions: Array.isArray(parsed.key_decisions) ? parsed.key_decisions : [],
      character_perspective: typeof parsed.character_perspective === 'string' ? parsed.character_perspective.slice(0, 200) : '',
      important_moments: this.parseImportantMoments(parsed.important_moments),
    };
  }

  /**
   * ★ 9-25 fix-session-summary-silent-failure：补处理一条失败的摘要。
   *
   * 只重跑摘要本身（**不重跑画像提取**——那会在同一批消息上重复提取）。
   * 成功后**就地更新**失败行并补上向量。
   *
   * @param since 该失败窗口的起点（= 该会话中更早一条摘要的 ended_at）
   * @returns 是否补成功
   */
  async retryFailedSummary(conv: Conversation, since: Date): Promise<boolean> {
    // ★ 9-26：同样把窗口下推到 SQL（否则长会话同样取不到该窗口）
    const events = this.getSessionEvents(conv.session_id, since);
    const messageEvents = events.filter(e => e.type === 'message');
    const dialogue = messageEvents
      .map(e => {
        const p = e.payload;
        if (!p?.content) return '';
        const isUser = p.role === 'user' || !!p.sender_id;
        return `[${isUser ? '用户' : '昔涟'}] ${p.content}`;
      })
      .filter(Boolean) as string[];
    if (dialogue.length === 0) return false;

    let data: SummaryData;
    try {
      data = await this.generateSummary(dialogue);
    } catch (err: any) {
      logger.warn(`[SessionEnd] 补处理仍失败 (${conv.id.slice(0, 30)}): ${err?.message ?? err}`);
      return false;
    }

    let vector: number[] | undefined;
    if (this.vectorStore) {
      try {
        vector = await this.embedService.embed(data.summary);
      } catch {
        // 向量失败不阻塞行更新（与成功路径一致的降级）
      }
    }

    await this.conversationStore.updateSummaryResult(
      conv.id,
      {
        summary: data.summary,
        participants: JSON.stringify(data.participants),
        topics: JSON.stringify(data.topics),
        key_decisions: JSON.stringify(data.key_decisions),
        character_perspective: data.character_perspective,
      },
      vector,
    );
    logger.info(`[SessionEnd] 补处理成功: ${conv.id.slice(0, 30)}`);
    return true;
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
