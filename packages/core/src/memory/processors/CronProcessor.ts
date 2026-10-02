// src/memory/processors/CronProcessor.ts
import { PROCESSED_PROFILE, PROCESSED_SUMMARY, PROCESSED_PERSONA, PROCESSED_KNOWLEDGE } from '../types.js';
import type { EventStore } from '../stores/EventStore.js';
import type { ConversationStore } from '../stores/ConversationStore.js';
import type { KnowledgeStore } from '../stores/KnowledgeStore.js';
import type { ProfileStore } from '../stores/ProfileStore.js';
import type { ProfileExtractor } from '../engines/ProfileExtractor.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import { logger } from '../../utils/logger.js';

/**
 * CronProcessor handles periodic maintenance tasks:
 *   1. Compaction: mark events older than 7 days as fully processed
 *   2. Vector dedup: not yet implemented (LanceDB doesn't expose full scan easily)
 *   3. Deep profile: aggregate all profile facts via LLM and update basics
 *   4. Knowledge cleanup: archive docs with updated_at older than 90 days
 */
export class CronProcessor {
  private readonly COMPACTION_DAYS = 7;
  private readonly KNOWLEDGE_ARCHIVE_DAYS = 90;
  private readonly ALL_FLAGS = PROCESSED_PROFILE | PROCESSED_SUMMARY | PROCESSED_PERSONA | PROCESSED_KNOWLEDGE;

  constructor(
    private eventStore: EventStore,
    private conversationStore: ConversationStore,
    private knowledgeStore: KnowledgeStore,
    private profileStore: ProfileStore,
    private profileExtractor: ProfileExtractor,
    private llmService: ILLMService,
    private vectorStore: IVectorStore | null,
  ) {}

  async process(): Promise<void> {
    // 1. Compaction: mark old events (>7 days) as fully processed
    await this.compactOldEvents();

    // 2. Vector dedup: not implemented yet (LanceDB doesn't expose full scan easily)
    //    Skipped — placeholder for future implementation.

    // 3. Deep profile: use all facts → LLM summary → update basics
    await this.deepProfile();

    // 4. Knowledge cleanup: archive docs with updated_at > 90 days
    await this.cleanupKnowledge();
  }

  private async compactOldEvents(): Promise<void> {
    const cutoff = new Date(Date.now() - this.COMPACTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Fetch unprocessed events in batches
    let batch = this.eventStore.getUnprocessed(100);
    while (batch.length > 0) {
      let markedAny = false;
      for (const event of batch) {
        if (event.created_at < cutoff) {
          this.eventStore.markProcessed(event.id, this.ALL_FLAGS);
          markedAny = true;
        }
      }
      // Stop if no events were old enough to mark (remaining events are recent/still unprocessed)
      if (!markedAny) break;
      batch = this.eventStore.getUnprocessed(100);
    }
  }

  private async deepProfile(): Promise<void> {
    const profile = this.profileStore.get();
    const facts = JSON.parse(profile.facts) as Array<{ fact: string; confidence: number; evidence: string }>;
    if (facts.length === 0) return;

    try {
      const factText = facts.map(f => `- ${f.fact} (置信度: ${f.confidence}, 证据: "${f.evidence}")`).join('\n');
      const summary = await this.llmService.complete(
        '你是一个深度画像总结器。根据用户的所有已知事实生成一段综合画像描述。返回纯文本总结。',
        factText,
      );

      this.profileStore.updateBasics(summary);
    } catch (err: any) {
      // ★ 2026-10-01 fix-profile-extract-empty-response：原来是**裸 `catch {}`**。
      //   失败与「没事实可总结」长得一样，`basics` 长期为 `{}` 无人察觉
      //   （同 ProfileExtractor，本项目的第 4 次「静默吞错」）。
      //   `basics` 是 PromptAssembler 的 `[关于你]` 段来源，空 = 她对用户一无所知。
      logger.error(`[CronProcessor] 深度画像重写失败，basics 未更新: ${err?.message ?? err}`);
    }
  }

  private async cleanupKnowledge(): Promise<void> {
    const cutoff = new Date(Date.now() - this.KNOWLEDGE_ARCHIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    try {
      const activeDocs = this.knowledgeStore.listActive();
      for (const doc of activeDocs) {
        if (doc.updated_at < cutoff) {
          this.knowledgeStore.archive(doc.id);
        }
      }
    } catch {
      // Cleanup failure is non-fatal
    }
  }
}
