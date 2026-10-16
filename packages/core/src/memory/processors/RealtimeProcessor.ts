// src/memory/processors/RealtimeProcessor.ts
import type { MemoryEvent } from '../types.js';
import { PROCESSED_PROFILE, PROCESSED_PERSONA, PROCESSED_KNOWLEDGE } from '../types.js';
import { logger } from '../../utils/logger.js';
import { warnThrottled } from '../../utils/write-trace.js';
import type { EventStore } from '../stores/EventStore.js';
import type { ProfileStore } from '../stores/ProfileStore.js';
import type { WorldbookMatcher } from '../engines/WorldbookMatcher.js';
import type { PersonaAdapter } from '../engines/PersonaAdapter.js';
import type { ProfileExtractor } from '../engines/ProfileExtractor.js';
import type { IEmbedService } from '../interfaces/IEmbedService.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';

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
      //
      // ★ 2026-10-16（change: `filter-synthetic-context-inflow`，KI-20）：**合成注入
      //   （dsh 的 runtime context 快照）走的是同一个闸**，但**必须留痕** ——
      //   否则「滤掉了」与「本来就没采到」长得一样，而那正是这条回流闭环
      //   能悄悄跑很久的原因。
      //   ⚠️ 只对 `synthetic` 打日志：群聊 NPC 的 skip_profile 量很大，
      //      一起打会把日志淹掉（本项目已因 96.6% QQ 噪声吃过一次亏）。
      if (event.payload.synthetic) {
        warnThrottled(
          'realtime-synthetic',
          `跳过学习：合成注入（${String(event.payload.synthetic)}）` +
            ` —— 不算用户发言，不进画像/人格/嵌入`,
        );
      }
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
          // ★ 9-25 wire-importance-signal：之前漏了这个字段 ——
          //   事件表里就算有 importance 也传不进向量 metadata，
          //   而 `applyKnobsToRetrieved` 读的正是 `r.metadata.importance`。
          //   （原先 `events.importance` 恒 0，所以没人发现这条链路是断的。）
          importance: event.importance ?? 0,
        });
      } catch (err: any) {
        // Embedding failure is non-fatal — continue processing
        logger.warn(`[Realtime] embed failed (${event.id.slice(0, 24)}): ${err.message}`);
      }
    } else if (text) {
      // ★ KI-15：向量库为 null 时**不再静默跳过**。
      //   逐事件 warn 会刷屏（每条消息都走这里），所以首次必报 + 每 100 条补报累计 ——
      //   「启动那一行 warn 不够」指的就是这种「跳过了多少条」说不清的状态。
      skippedNoVectorStore++;
      if (skippedNoVectorStore === 1 || skippedNoVectorStore % 100 === 0) {
        logger.warn(
          `[Realtime] 没有向量库：已跳过 ${skippedNoVectorStore} 条事件的嵌入（这些事件只进文本检索）`,
        );
      }
    }

    // 5. Mark event as processed (profile | persona | knowledge)
    const flags = PROCESSED_PROFILE | PROCESSED_PERSONA | PROCESSED_KNOWLEDGE;
    this.eventStore.markProcessed(event.id, flags);
  }
}
