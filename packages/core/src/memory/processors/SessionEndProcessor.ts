// src/memory/processors/SessionEndProcessor.ts
import type { MemoryEvent, Conversation } from '../types.js';
import { PROCESSED_SUMMARY } from '../types.js';
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

  async process(sessionId: string): Promise<void> {
    // 1. Get all events for session
    // We use countBySession logic: we need all events, so we fetch from the DB.
    // Since EventStore doesn't have getBySession, we'll retrieve a large batch
    // of unprocessed events and filter. For simplicity, we iterate.
    const events = this.getSessionEvents(sessionId);
    if (events.length === 0) return;

    const messageEvents = events.filter(e => e.type === 'message');
    // 兼容两种 payload：新消息有 role 字段；旧消息可凭 sender_id 判断用户消息
    const userMessages = messageEvents
      .filter(e => e.payload?.role === 'user' || !!e.payload?.sender_id)
      .map(e => e.payload?.content)
      .filter(Boolean) as string[];

    // 2. Generate conversation summary via LLM
    const conversationSummary = await this.generateSummary(userMessages, sessionId);

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
    if (messageEvents.length > 0) {
      const newFacts = await this.profileExtractor.extract(messageEvents);
      if (newFacts.length > 0) {
        this.profileStore.addFacts(newFacts);
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
    userMessages: string[],
    sessionId: string,
  ): Promise<{ summary: string; participants: string[]; topics: string[]; key_decisions: string[] }> {
    const defaultSummary = {
      summary: `Session ${sessionId} summary`,
      participants: ['user', 'assistant'],
      topics: [] as string[],
      key_decisions: [] as string[],
    };

    if (userMessages.length === 0) return defaultSummary;

    try {
      const conversationText = userMessages.join('\n');
      const response = await this.llmService.complete(
        '你是一个会话总结器。请总结以下用户消息，提取关键主题和决定。返回JSON格式: {"summary": "...", "participants": ["user", "assistant"], "topics": [...], "key_decisions": [...]}',
        conversationText,
      );

      const parsed = JSON.parse(response);
      return {
        summary: parsed.summary || defaultSummary.summary,
        participants: parsed.participants || defaultSummary.participants,
        topics: parsed.topics || [],
        key_decisions: parsed.key_decisions || [],
      };
    } catch {
      return defaultSummary;
    }
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
