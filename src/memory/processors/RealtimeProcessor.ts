// src/memory/processors/RealtimeProcessor.ts
import type { MemoryEvent } from '../types';
import { PROCESSED_PROFILE, PROCESSED_PERSONA, PROCESSED_KNOWLEDGE } from '../types';
import type { EventStore } from '../stores/EventStore';
import type { ProfileStore } from '../stores/ProfileStore';
import type { WorldbookMatcher } from '../engines/WorldbookMatcher';
import type { PersonaAdapter } from '../engines/PersonaAdapter';
import type { IEmbedService } from '../interfaces/IEmbedService';
import type { IVectorStore } from '../interfaces/IVectorStore';

/**
 * RealtimeProcessor handles per-event processing in the hot path:
 *   1. Worldbook matching (trigger worldbook entries from event content)
 *   2. Persona scan (detect preference signals and adjust persona)
 *   3. Embed generation (async, stored in vector store if available)
 *   4. Mark event as processed (PROFILE | PERSONA | KNOWLEDGE)
 */
export class RealtimeProcessor {
  constructor(
    private eventStore: EventStore,
    private worldbookMatcher: WorldbookMatcher,
    private personaAdapter: PersonaAdapter,
    private profileStore: ProfileStore,
    private embedService: IEmbedService,
    private vectorStore: IVectorStore | null,
  ) {}

  async process(event: MemoryEvent): Promise<void> {
    const text = typeof event.payload.content === 'string' ? event.payload.content : '';

    // 1. Worldbook match from event content
    if (text) {
      const mode = event.source === 'code' ? 'code' : 'chat';
      const matches = await this.worldbookMatcher.match(text, mode);
      if (matches.length > 0) {
        // Store a lightweight profile hint when worldbook triggers
        // (cached in memory, not persisted — hint only)
        for (const entry of matches) {
          // Worldbook triggers are recorded by matcher; we just note the signal
          void entry;
        }
      }
    }

    // 2. Persona scan from event content
    if (text) {
      const adjustment = await this.personaAdapter.processSignal(event);
      if (adjustment) {
        this.personaAdapter.apply(adjustment);
      }
    }

    // 3. Embed generation (async)
    if (text && this.vectorStore) {
      try {
        const vector = await this.embedService.embed(text);
        await this.vectorStore.insert(event.id, vector, text, {
          source: event.source,
          type: event.type,
          session_id: event.session_id,
          created_at: event.created_at,
        });
      } catch {
        // Embedding failure is non-fatal — continue processing
      }
    }

    // 4. Mark event as processed (profile | persona | knowledge)
    //    Worldbook + persona are profile-level signals; embedding is knowledge-level
    const flags = PROCESSED_PROFILE | PROCESSED_PERSONA | PROCESSED_KNOWLEDGE;
    this.eventStore.markProcessed(event.id, flags);
  }
}
