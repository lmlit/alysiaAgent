// src/memory/processors/RealtimeProcessor.ts
import type { MemoryEvent } from '../types.js';
import { PROCESSED_PROFILE, PROCESSED_PERSONA, PROCESSED_KNOWLEDGE } from '../types.js';
import type { EventStore } from '../stores/EventStore.js';
import type { ProfileStore } from '../stores/ProfileStore.js';
import type { WorldbookMatcher } from '../engines/WorldbookMatcher.js';
import type { PersonaAdapter } from '../engines/PersonaAdapter.js';
import type { ProfileExtractor } from '../engines/ProfileExtractor.js';
import type { IEmbedService } from '../interfaces/IEmbedService.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';

/**
 * RealtimeProcessor handles per-event processing in the hot path:
 *   1. Worldbook matching (trigger worldbook entries from event content)
 *   2. Persona scan (detect preference signals and adjust persona)
 *   3. Correction detection (快路径：用户纠正立即生效)
 *   4. Embed generation (async, stored in vector store if available)
 *   5. Mark event as processed (PROFILE | PERSONA | KNOWLEDGE)
 */
export class RealtimeProcessor {
  constructor(
    private eventStore: EventStore,
    private worldbookMatcher: WorldbookMatcher,
    private personaAdapter: PersonaAdapter,
    private profileStore: ProfileStore,
    private profileExtractor: ProfileExtractor,
    private embedService: IEmbedService,
    private vectorStore: IVectorStore | null,
  ) {}

  async process(event: MemoryEvent): Promise<void> {
    const text = typeof event.payload.content === 'string' ? event.payload.content : '';

    // 群聊 NPC 模式：非 owner 的消息跳过画像提取（Persona + Profile），
    // 仅保留流水账 (EventLog) 和 Worldbook 匹配。
    const skipProfile = event.payload.skip_profile === true;

    // 1. Worldbook match from event content (所有人消息都匹配)
    if (text) {
      const mode = event.source === 'code' ? 'code' : 'chat';
      await this.worldbookMatcher.match(text, mode);
      // Trigger recording is handled internally by WorldbookMatcher.match()
    }

    if (skipProfile) {
      // NPC 消息：只匹配 Worldbook，不提取画像、不做嵌入
      this.eventStore.markProcessed(event.id, PROCESSED_KNOWLEDGE);
      return;
    }

    // 2. Persona scan from event content
    if (text) {
      const adjustment = await this.personaAdapter.processSignal(event);
      if (adjustment) {
        this.personaAdapter.apply(adjustment);
      }
    }

    // 3. 纠正快路径 (v2): 检测用户纠正信号 → 立即更新 Profile
    if (text) {
      try {
        const allFacts = this.profileStore.getAllFacts();
        const signal = await this.profileExtractor.detectCorrectionSignal(text, allFacts);
        if (signal.isCorrection && signal.target) {
          this.profileStore.supersede(signal.target, {
            fact: signal.newFact || signal.target,
            confidence: 1.0,
            evidence: signal.rawText,
            source_event: event.id,
            updated_at: new Date().toISOString(),
            source: 'user',
            valid_from: new Date().toISOString(),
            valid_until: null,
            status: 'active',
            category: 'general', // ★ 8-28 纠正事实兜底分类
          });
        }
      } catch {
        // 纠正检测失败不阻塞主流程
      }
    }

    // 4. Embed generation (async)
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

    // 5. Mark event as processed (profile | persona | knowledge)
    const flags = PROCESSED_PROFILE | PROCESSED_PERSONA | PROCESSED_KNOWLEDGE;
    this.eventStore.markProcessed(event.id, flags);
  }
}
