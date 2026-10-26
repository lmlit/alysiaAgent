// src/memory/processors/CronProcessor.ts
import type { ConversationStore } from '../stores/ConversationStore.js';
import type { KnowledgeStore } from '../stores/KnowledgeStore.js';
import type { ProfileStore } from '../stores/ProfileStore.js';
import type { ProfileExtractor } from '../engines/ProfileExtractor.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import { logger } from '../../utils/logger.js';
// ★ 2026-10-20（change: collect-memory-prompts）：提示词资产已外置
import { CRON_DEEP_PROFILE_SYSTEM_PROMPT } from '../../prompts/memory.js';

/**
 * CronProcessor handles periodic maintenance tasks:
 *   1. Deep profile: aggregate all profile facts via LLM and update basics
 *   2. Knowledge cleanup: archive docs with updated_at older than 90 days
 *
 * ★ 2026-10-26（retire-processed-bitmask，KI-27）：compaction 已删。
 *   它唯一的作用是清 `getUnprocessed` 的积压，而位掩码只写不读 —— 那一步是空转。
 */
export class CronProcessor {
  private readonly KNOWLEDGE_ARCHIVE_DAYS = 90;

  constructor(
    private conversationStore: ConversationStore,
    private knowledgeStore: KnowledgeStore,
    private profileStore: ProfileStore,
    private profileExtractor: ProfileExtractor,
    private llmService: ILLMService,
    private vectorStore: IVectorStore | null,
  ) {}

  async process(): Promise<void> {
    // 1. Deep profile: use all facts → LLM summary → update basics
    await this.deepProfile();

    // 2. Knowledge cleanup: archive docs with updated_at > 90 days
    await this.cleanupKnowledge();
  }

  private async deepProfile(): Promise<void> {
    await this.rebuildBasics();
  }

  /**
   * ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C3 / E2）：**`basics` 的唯一重建入口**。
   *
   * 调用方：cron 每轮（本类的 `process()`）、`MemoryManager.rebuildBasics()`（Web 端按钮）、
   * 以及将来"stale 时按需重建"的任何地方 —— **不要再各写一段总结逻辑**。
   *
   * 三条纪律：
   *   ① 原料只取**当前态事实**（`getCurrentFacts`）—— 老实现读原始 JSON，
   *      于是被纠正的旧说法会以 `[关于你]` 的形式回来（E2）
   *   ② 当前态为空 ⇒ **不重写**（拿空输入重写会把已知印象洗成空白），但**标 stale**：
   *      此刻 `basics` 确实可能过时，prompt 侧据此降级标注，而不是假装新鲜
   *   ③ 写 `basics` 时**同时写谱系**（用了哪些事实键）——否则回答不了"这条旧说法从哪来"（E7）
   */
  async rebuildBasics(): Promise<{ ok: boolean; usedFacts: number; stale: boolean }> {
    const current = this.profileStore.getCurrentFacts();
    if (current.length === 0) {
      this.profileStore.markBasicsStale();
      logger.warn(
        '[Cron] 当前事实为 0（全部 expired/superseded）⇒ **跳过**深度画像重写：' +
        'basics 保持原样并标记 stale（避免把已知印象洗成空白）',
      );
      return { ok: false, usedFacts: 0, stale: true };
    }

    try {
      const factText = current
        .map(f => `- ${f.fact} (置信度: ${f.confidence}, 证据: "${f.evidence}")`)
        .join('\n');
      const summary = await this.llmService.complete(
        CRON_DEEP_PROFILE_SYSTEM_PROMPT,
        factText,
      );

      // ★ C3：谱系用**当次真正喂进去的**事实键（不是全量、也不是重读一次当前态）
      this.profileStore.updateBasicsWithSource(
        summary,
        current.map(f => this.profileStore.factKeyOf(f.fact)),
      );
      logger.info(`[Cron] basics 已重写（依据 ${current.length} 条当前事实）`);
      return { ok: true, usedFacts: current.length, stale: false };
    } catch (err: any) {
      // ★ 2026-10-01 fix-profile-extract-empty-response：原来是**裸 `catch {}`**。
      //   失败与「没事实可总结」长得一样，`basics` 长期为 `{}` 无人察觉
      //   （同 ProfileExtractor，本项目的第 4 次「静默吞错」）。
      //   `basics` 是 PromptAssembler 的 `[关于你]` 段来源，空 = 她对用户一无所知。
      this.profileStore.markBasicsStale();
      logger.error(`[CronProcessor] 深度画像重写失败，basics 未更新（已标 stale）: ${err?.message ?? err}`);
      return { ok: false, usedFacts: 0, stale: true };
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
    } catch (err: any) {
      // ★ KI-5：原来是裸 catch。后果是「90 天该归档的文档一个没归档」，
      //   而日志表现为「没有需要归档的文档」—— 两种完全不同的世界长得一样。
      logger.warn(`[Cron] 知识库归档失败（本轮一个都没归档）: ${err?.message ?? err}`);
    }
  }
}
