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
// ★ 2026-10-20（change: collect-memory-prompts）：提示词资产已外置
import { CRON_DEEP_PROFILE_SYSTEM_PROMPT } from '../../prompts/memory.js';

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

  /**
   * 把**超过 COMPACTION_DAYS 仍未处理**的事件标记为「全部已处理」。
   *
   * ★ 2026-10-20（change: `log-cron-compaction`）：补上日志，并把**真实语义**写清楚。
   *
   * ## 它到底在做什么（查过之后，和文件名给人的印象不同）
   *
   * `processed` 是**位掩码**（1=画像 / 2=摘要 / 4=人格 / 8=知识），写入点很多，
   * 但**读取侧只有 `getUnprocessed`**（`WHERE processed = 0`）——而 `getUnprocessed`
   * 的**唯一调用者就是本方法**。
   *
   * 具体地：
   * - **摘要不受影响**：`SessionEndProcessor` 走 `getBySession`，而它**不按 `processed` 过滤**
   *   （`MemoryManager.summaryAnchor` 的注释里写明：「窗口锚点是唯一的闸」）。
   * - **画像提取不受影响**：同样在会话结算时由 `getBySession` 驱动。
   * - **RealtimeProcessor** 只**写**位，从不读。
   *
   * ⇒ 所以这一步的**实际效果**是：**清空 `getUnprocessed` 的积压**，
   *   让"未处理"这个概念回到 0。它**不是**"放弃学习"（我一度这么以为，是错的）。
   *
   * ## 那它还有意义吗
   *
   * 有，但很窄：`getUnprocessed` 的语义是「还没处理过的」。不清理的话，
   * 任何将来基于它做**补处理/回填**的功能都会捞到一堆两年前的陈货。
   * 所以它是**语义卫生**，不是学习路径。
   *
   * ⚠️ 由此登记一条技术债（`docs/KNOWN-ISSUES.md` KI-27）：`processed` 位**只写不读**，
   *    要么赋予语义（按位判断该不该处理），要么删掉 —— 别让它继续假装在工作。
   */
  private async compactOldEvents(): Promise<number> {
    const cutoffMs = Date.now() - this.COMPACTION_DAYS * 86_400_000;
    const cutoff = new Date(cutoffMs).toISOString();

    let marked = 0;
    let oldestAt = '';
    let batch = this.eventStore.getUnprocessed(100);
    while (batch.length > 0) {
      let markedAny = false;
      for (const event of batch) {
        if (event.created_at < cutoff) {
          if (!oldestAt || event.created_at < oldestAt) oldestAt = event.created_at;
          this.eventStore.markProcessed(event.id, this.ALL_FLAGS);
          marked++;
          markedAny = true;
        }
      }
      // Stop if no events were old enough to mark (remaining events are recent/still unprocessed)
      if (!markedAny) break;
      batch = this.eventStore.getUnprocessed(100);
    }

    // ★ 以前这里**一行日志都没有** —— "清了 300 条"与"一条都没有"在日志上完全同形。
    if (marked > 0) {
      const oldestDays = oldestAt
        ? Math.floor((Date.now() - new Date(oldestAt).getTime()) / 86_400_000)
        : 0;
      logger.info(
        `[Cron] compaction: 标记 ${marked} 条 >${this.COMPACTION_DAYS} 天未处理事件为 processed=ALL` +
        `（最老 ${oldestDays} 天前）— 注意：这只清 getUnprocessed 的积压，` +
        `不影响摘要/画像（它们走 getBySession，不筛 processed）`,
      );
      // 积压异常大 ⇒ 大概率是停机/挂起过，值得人看一眼
      if (marked > 500) {
        logger.warn(
          `[Cron] compaction 清理了 ${marked} 条积压（>500）— 通常意味着有一段时间没有跑结算，` +
          `建议查那段的 [SessionEnd]/[Cron] 日志`,
        );
      }
    } else {
      logger.debug('[Cron] compaction: 没有超过阈值仍未处理的事件');
    }
    return marked;
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
