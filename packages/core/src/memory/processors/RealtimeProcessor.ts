// src/memory/processors/RealtimeProcessor.ts
import type { MemoryEvent } from '../types.js';
import { logger } from '../../utils/logger.js';
// ★ add-memory-channel-field：hint 渠道派生
import { channelOfSession } from '../../utils/channel.js';
import { warnThrottled } from '../../utils/write-trace.js';
import type { EventStore } from '../stores/EventStore.js';
import type { ProfileStore } from '../stores/ProfileStore.js';
import type { WorldbookMatcher } from '../engines/WorldbookMatcher.js';
import type { PersonaAdapter } from '../engines/PersonaAdapter.js';
import type { ProfileExtractor } from '../engines/ProfileExtractor.js';
import type { IEmbedService } from '../interfaces/IEmbedService.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
// ★ 2026-10-21（change: `unify-memory-eligibility`，C1）：资格判据唯一出处
import { isEligible, isMachineOrigin, describeSkip } from '../eligibility.js';

/**
 * ★ KI-15：向量库缺失时**已跳过**的嵌入条数（模块级 = 进程内累计）。
 *
 * 用途只有一个：让「没有向量库」这件事**不再是静默的**，同时不刷屏 ——
 * 首次跳过必报，此后每 100 条补报一次累计。
 * 光靠启动时一行 warn 说不清「到底漏了多少条」（这正是 KI-15 的原话）。
 */
let skippedNoVectorStore = 0;

/**
 * RealtimeProcessor handles per-event processing in the hot path:
 *   1. Worldbook matching (trigger worldbook entries from event content)
 *   2. Persona scan (detect preference signals and adjust persona)
 *   3. Correction detection (快路径：用户纠正立即生效)
 *   4. Embed generation (async, stored in vector store if available)
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

    // 1. Worldbook match（**所有来源**都匹配：它是纯读取，不改写任何学习状态）
    if (text) {
      const mode = event.source === 'code' ? 'code' : 'chat';
      await this.worldbookMatcher.match(text, mode);
      // Trigger recording is handled internally by WorldbookMatcher.match()
    }

    // 2. ★ 2026-10-21（change: `unify-memory-eligibility`，C1/E4）：
    //    资格**一次问清、分开判**，不再自带 `if`。
    //
    //    这里改正的两件事：
    //    ① 原实现只看 `skip_profile`（= 群聊 NPC 的标记），**不看 `role`** ——
    //       于是她自己的回复（`role:'assistant'`）也会进人格扫描与纠正快路径：
    //       她说一句带"不要"的话，就调整了她自己的人格（E4）。人格该由"你怎么对她"驱动。
    //    ② 判据散在四个处理器里写法各异（proposal §1），合成注入在摘要两条路径上结局不同（E1）。
    const facts = isEligible(event, 'profile-facts');
    const persona = isEligible(event, 'persona-evidence');
    const correction = isEligible(event, 'correction');
    const embed = isEligible(event, 'embed');

    // 四种用途全不允许 ⇒ 只留流水账（事件本身仍在事件表里，见 KI-20 的 R4）
    if (!facts.ok && !persona.ok && !correction.ok && !embed.ok) {
      // ⚠️ 只对**机器来源**出声（合成注入 / 委托会话 / 执行回执）：
      //    群聊 NPC 的 skip_profile 量非常大，一起打会把真正要看的记录淹掉
      //    （本项目已因 96.6% QQ 噪声吃过一次亏）。
      if (isMachineOrigin(facts.origin)) {
        warnThrottled('realtime-synthetic', describeSkip(facts));
      }
      return;
    }

    // 3. Persona scan（**只有用户本人发言**算反馈 —— D1）
    if (text && persona.ok) {
      const adjustment = await this.personaAdapter.processSignal(event);
      if (adjustment) {
        // ★ add-memory-channel-field：把**事件所属渠道**传下去，让 hint 如实记来源
        this.personaAdapter.apply(adjustment, { channel: channelOfSession(event.session_id) });
      }
    }

    // 4. 纠正快路径 (v2)：检测用户纠正信号 → 立即更新 Profile
    //    ⚠️ 同样只认用户发言：她用一句"不对"不该去改写他事实（E4 的另一半）
    if (text && correction.ok) {
      try {
        // ★ 2026-10-21（C2/E3）：候选池只要**当前态** —— 喂全量会让模型去"纠正"
        //   一条早已 superseded 的旧说法（`getAllFacts` 是审计专用，见 ProfileStore 文档）。
        const currentFacts = this.profileStore.getCurrentFacts();
        const signal = await this.profileExtractor.detectCorrectionSignal(text, currentFacts);
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

    // 5. Embed generation (async) —— 她说过的话**可以**被检索（要能回忆"聊过什么"），
    //    但机器注入（synthetic / 委托会话）不行：那正是 2026-09-27 那次污染的形态。
    if (text && embed.ok) {
      if (this.vectorStore) {
        try {
          const vector = await this.embedService.embed(text);
          await this.vectorStore.insert(event.id, vector, text, {
            source: event.source,
            type: event.type,
            session_id: event.session_id,
            created_at: event.created_at,
            // ★ 9-25 wire-importance-signal：之前漏了这个字段 ——
            //   事件表里就算有 importance 也传不进向量 metadata，
            //   而 `applyKnobsToRetrieved` 读的正是 `r.metadata.importance`。
            importance: event.importance ?? 0,
            // ★ 2026-10-21（C3）：向量是**派生**，标出来源，将来才解释得清它凭什么被召回
            derived_from: 'event',
          });
        } catch (err: any) {
          // Embedding failure is non-fatal — continue processing
          logger.warn(`[Realtime] embed failed (${event.id.slice(0, 24)}): ${err.message}`);
        }
      } else {
        // ★ KI-15：向量库为 null 时**不再静默跳过**。
        //   逐事件 warn 会刷屏（每条消息都走这里），所以首次必报 + 每 100 条补报累计。
        skippedNoVectorStore++;
        if (skippedNoVectorStore === 1 || skippedNoVectorStore % 100 === 0) {
          logger.warn(
            `[Realtime] 没有向量库：已跳过 ${skippedNoVectorStore} 条事件的嵌入（这些事件只进文本检索）`,
          );
        }
      }
    }

    // ★ 2026-10-26（retire-processed-bitmask，KI-27）：不再写 `processed` 位。
    //   "做过什么"由 `facts_status` / `summary_status` / `archived` 表达；
    //   位掩码只写不读，已删除。
  }
}
