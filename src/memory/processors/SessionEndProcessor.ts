// src/memory/processors/SessionEndProcessor.ts
import type { MemoryEvent, Conversation } from '../types';
import { PROCESSED_SUMMARY } from '../types';
import type { EventStore } from '../stores/EventStore';
import type { ConversationStore } from '../stores/ConversationStore';
import type { ProfileStore } from '../stores/ProfileStore';
import type { PersonaStore } from '../stores/PersonaStore';
import type { WorldbookStore } from '../stores/WorldbookStore';
import type { ProfileExtractor } from '../engines/ProfileExtractor';
import type { PersonaAdapter } from '../engines/PersonaAdapter';
import type { ILLMService } from '../interfaces/ILLMService';
import type { IEmbedService } from '../interfaces/IEmbedService';
import type { IVectorStore } from '../interfaces/IVectorStore';

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
    const userMessages = messageEvents
      .filter(e => e.payload?.role === 'user')
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

    // 4. Extract profile facts from session events
    if (messageEvents.length > 0) {
      const newFacts = await this.profileExtractor.extract(messageEvents);
      if (newFacts.length > 0) {
        const existingFacts = this.profileStore.getFacts();
        const mergedFacts = this.profileExtractor.mergeFacts(newFacts, existingFacts);
        this.profileStore.replaceFacts(mergedFacts);
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
    // Since EventStore doesn't expose getBySession, we fetch a large batch
    // of unprocessed events from the DB directly.
    // For integration we query all events with this session_id via raw DB.
    // But we only have access through the store. Let's use the database
    // through the event store's existing methods.
    // Actually EventStore only has getUnprocessed(limit). We'll create a helper
    // using the fact that we can get events. But we need all events for the session.
    // Let's use the db directly from the store — actually we can't access private db.
    //
    // Instead, we'll batch-fetch unprocessed events and filter by session.
    // For a complete solution, this could be optimized with a direct DB query,
    // but since EventStore doesn't expose it, we collect via batch.
    // In practice, the EventStore should have a getBySession method.
    // For now, we'll collect unprocessed events.
    const allEvents: MemoryEvent[] = [];
    let offset = 0;
    const batchSize = 100;
    let batch = this.eventStore.getUnprocessed(batchSize);
    while (batch.length > 0) {
      allEvents.push(...batch.filter(e => e.session_id === sessionId));
      if (batch.length < batchSize) break;
      offset += batchSize;
      batch = this.eventStore.getUnprocessed(batchSize);
    }
    return allEvents;
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

  private async confirmPersona(events: MemoryEvent[]): Promise<void> {
    // Check for persona-related events and apply any pending adjustments
    for (const event of events) {
      if (event.type === 'persona_change') {
        // Process persona adjustment signals that may have been missed during realtime
        const adjustment = await this.personaAdapter.processSignal(event);
        if (adjustment) {
          this.personaAdapter.apply(adjustment);
        }
      }
    }
  }
}
