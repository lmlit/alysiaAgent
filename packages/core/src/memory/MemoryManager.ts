// src/memory/MemoryManager.ts
// Unified facade that wires all stores, engines, processors, and PromptAssembler.
import type Database from 'better-sqlite3';
import { EventStore } from './stores/EventStore.js';
import { ProfileStore } from './stores/ProfileStore.js';
import { PersonaStore } from './stores/PersonaStore.js';
import { ConversationStore } from './stores/ConversationStore.js';
import type { VectorWriteOutcome } from './stores/ConversationStore.js';
import { KnowledgeStore } from './stores/KnowledgeStore.js';
import { WorldbookStore } from './stores/WorldbookStore.js';
import { CodeContextStore } from './stores/CodeContextStore.js';
import { LifeStore } from './stores/LifeStore.js';
import type { LifeEvent } from './stores/LifeStore.js';
// ★ 2026-10-17（change: add-project-task-delegation）：委托任务表
import { ProjectTaskStore } from './stores/ProjectTaskStore.js';
import type {
  ProjectTask,
  ProjectTaskStatus,
  CreateOutcome,
  SubmitResultInput,
} from './stores/ProjectTaskStore.js';
// ★ 2026-10-19（change: wake-her-on-task-result）：结果事件 outbox（重启后仍能投递）
import {
  ProjectTaskEventStore,
  type ProjectTaskEvent,
  type EnqueueEventInput,
  type ProjectTaskEventStoreOptions,
} from './stores/ProjectTaskEventStore.js';
import { dialogueSpeaker } from './render-dialogue.js';
// ★ 2026-10-18（change: `make-author-iterate`）：「做一件东西」的显式状态机
import {
  advanceLoop,
  type LoopDecision,
  type LoopFacts,
} from './project-task-loop.js';
// ★ 2026-10-18（change: return-project-task-result）：结果 → 记忆事件的纯构造
import {
  buildProjectTaskResultEvent,
  buildNoticePrompts,
  finalizeNotice,
  MAX_NOTICE_CHARS,
} from './project-task-result.js';
import { lifeEventImportance, moodDeltaToPolarity } from './importance.js';
import { WorldbookMatcher } from './engines/WorldbookMatcher.js';
import { PersonaAdapter } from './engines/PersonaAdapter.js';
import { ProfileExtractor } from './engines/ProfileExtractor.js';
import { readWorldviewBlock } from '../persona/loader.js';
// ★ 2026-10-20（put-dropped-turns-back）：上下文压缩的提示词（与长期记忆的 prompts/memory 分开）
import { CONTEXT_COMPACT_SYSTEM_PROMPT, CONTEXT_COMPACT_MERGE_SYSTEM_PROMPT } from '../prompts/context.js';
import { RealtimeProcessor } from './processors/RealtimeProcessor.js';
import { SessionEndProcessor } from './processors/SessionEndProcessor.js';
import { CronProcessor } from './processors/CronProcessor.js';
import { PromptAssembler } from './PromptAssembler.js';
import { filterPII } from './PIIFilter.js';
import { logger } from '../utils/logger.js';
import { warnThrottled } from '../utils/write-trace.js';
import { formatLocalTime, localDateKey, localDateKeyFromISO } from '../utils/time.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import type { MemoryEvent, MemoryReadRequest, MemoryReadResult, MemoryConfig, KnowledgeDoc, SearchResult, WorldbookEntry, ProfileFact } from './types.js';
import { DEFAULT_MEMORY_CONFIG, FACT_CONFIRM_WINDOW_MS } from './types.js';
import type { IVectorStore } from './interfaces/IVectorStore.js';
import type { IEmbedService } from './interfaces/IEmbedService.js';
import type { ILLMService } from './interfaces/ILLMService.js';
import { DEFAULT_SAMPLING } from '../provider/sampling.js';
import type { SamplingConfig, SamplingSlot } from '../provider/sampling.js';

// ── 知识库分块参数（参考 AstrBot：chunk 512 / overlap 50）──
const KB_CHUNK_SIZE = 500;
const KB_CHUNK_OVERLAP = 50;

/**
 * 世界书**采样**冷却下界（★ 2026-10-16，change: `worldbook-sampling-cooldown`）。
 *
 * 为什么不能直接用条目自带的 `cooldown_sec`（默认 **300 秒**）：
 * 事件生成器是**每小时** tick（`server/src/life.ts` 的 `next_in_hours` 间隔 0.5~8h，默认 1h）。
 * 5 分钟的冷却在小时级节奏上**等于没有** —— 下一轮照样抽到同一条，
 * 而契约（`ai-life-system` §6/§7）声明的正是「cooldown 过滤」。
 *
 * 为什么取 6 小时：生成器绝大多数间隔 ≤ 6h（默认 1h）⇒ 6h 足以保证
 * 「刚用过的那条不会在紧接着的下一轮又被递给她」。
 *
 * ⚠️ 与条目 `cooldown_sec` 的关系是 **max**（见 `getWorldbookSample` 的 SQL）：
 * 条目显式声明了更长的冷却时，两个路径都尊重它 ——
 * 这样 `bumpWorldbookHit()` 注释里那句「与对话触发**共用冷却**」才是真的。
 */
const WORLDBOOK_SAMPLE_COOLDOWN_MS = 6 * 3600 * 1000;

// ★ 8-14 内容自进化校验器 prompt：判定该不该写入持久设定库。
//  只给条目本身（不给对话上下文，防上下文污染判断）；输出 JSON 供解析。
const SELF_ENTRY_VALIDATOR_PROMPT = `你是"内容自进化"的轻校验器，判定一条候选条目是否适合写入昔涟的持久设定库。
判定标准（任一命中即 reject）：
- 不是关于昔涟自己或她世界的（如用户的事实、隐私、对用户的指令）
- 内容模糊、不确定，像幻觉
- 离谱、危险、恶意内容
- 与已有设定冲突
只允许：关于她自己的经历、喜好、世界观设定的补充，具体且确定。
输入格式：条目类型 + 条目内容。
只输出 JSON：{"decision": "write"|"reject", "reason": "一句话理由"}`;

// ── Token 统计 ──────────────────────────────────────────
interface TokenStats {
  recordCount: number;
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
}

const TOKEN_STATS_FILE = './data/token_stats.json';

/** ★ 9-25 optimize-recall-pipeline：跨来源合并时的**路内相对保留比例**。
 *  某条分数低于「该来源最佳 × 此系数」就丢掉。
 *  用相对而非绝对，是因为不同来源的文本长度不同、绝对分不可比
 *  （长文本与短查询的嵌入天然更远）—— 绝对阈值会把长文本来源整路误杀。 */
const RELATIVE_KEEP = 0.7;

/**
 * ★ 2026-10-20（change: `wire-retention-bias-into-recall`）：`retention_bias` 在召回里的**强度系数**。
 *
 * **为什么是 0.1**（这是被单测逼出来的，不是拍的）：
 *   - 默认 `retention_bias = 0.2` ⇒ 单条最多 **±2%**；一正一负**复利**后约 **4%**
 *   - 起初写 0.3（单条 ±6%、复利 12.8%），当场被测试否掉：
 *     **0.8 的偏好记忆能翻掉 0.9 的强匹配** —— 那不叫"微微偏向"
 *   - 现在的力度只够做**同档内次序微调**（真实分差 <4% 时），
 *     绝不改变 `RELATIVE_KEEP = 0.7` 的阈值判定，也不改变"哪一路有代表"
 *   - 想让它更有力就改这里 —— **但那是调参，先看 `[Recall] 极性调整×N` 的分布**
 *
 * ⚠️ 只作用于**有 valence** 的记忆（新生活事件的 `metadata.polarity`）；
 * 存量向量没有该字段 ⇒ 完全不受影响（不追溯改排序）。
 * ⚠️ 这是**路内**调整，不是跨来源加权 —— 见 spec §7 的通用判据。
 */
const RETENTION_BIAS_IN_RECALL = 0.1;

function chunkText(text: string, size = KB_CHUNK_SIZE, overlap = KB_CHUNK_OVERLAP): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

export type PrivacyMode = 'off' | 'readonly' | 'full';

export class MemoryManager {
  private eventStore: EventStore;
  private profileStore: ProfileStore;
  private personaStore: PersonaStore;
  private conversationStore: ConversationStore;
  private knowledgeStore: KnowledgeStore;
  private worldbookStore: WorldbookStore;
  private codeContextStore: CodeContextStore;
  private lifeStore: LifeStore;
  /**
   * 委托任务表（★ 2026-10-17，change: `add-project-task-delegation`）。
   *
   * ★ 为什么放在 MemoryManager 上：它是**落库状态**且 Web 端要用 ——
   *   按本仓硬约束（CLAUDE.md「Web 端接口兼容」），必须经 MemoryManager/AlysiaCore
   *   暴露**纯数据**方法，不能在路由层自己开 DB 句柄。
   */
  private projectTaskStore: ProjectTaskStore;
  /** ★ 2026-10-19（change: wake-her-on-task-result）：结果事件 outbox */
  private projectTaskEventStore: ProjectTaskEventStore;
  /** 主 Agent 是否可自己验收（`subagentWake.autoAccept`；默认开） */
  private acceptEnabled = true;
  /** ★ 8-29 世界观底色缓存（worldview-base-field） */
  private _worldviewBlock: string = '';
  private worldbookMatcher: WorldbookMatcher;
  private personaAdapter: PersonaAdapter;
  private profileExtractor: ProfileExtractor;
  private promptAssembler: PromptAssembler;
  private realtimeProcessor: RealtimeProcessor;
  private sessionEndProcessor: SessionEndProcessor;
  private cronProcessor: CronProcessor;
  private privacyMode: PrivacyMode = 'off';
  private tokenStats: Map<string, TokenStats> = new Map();
  private tokenStatsSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private db: Database.Database,
    private vectorStore: IVectorStore | null,
    private embedService: IEmbedService,
    private llmService: ILLMService,
    /** ★ 8-10 采样配置（sampling-config-unify）：按 engine 场景绑定槽位。
     *  ★ 2026-10-01：缺省填 `DEFAULT_SAMPLING`（原先缺省 `undefined` →
     *    slotify 传 `undefined` 给 llmService → 落回它自己的默认槽 →
     *    **所有场景塌成同一个槽**，分槽机制形同虚设）。 */
    private sampling?: SamplingConfig,
  ) {
    this.sampling = sampling ?? DEFAULT_SAMPLING;
    this.eventStore = new EventStore(db, vectorStore);
    this.profileStore = new ProfileStore(db);
    this.personaStore = new PersonaStore(db);
    this.conversationStore = new ConversationStore(db, vectorStore);
    this.knowledgeStore = new KnowledgeStore(db, vectorStore);
    this.worldbookStore = new WorldbookStore(db);
    this.codeContextStore = new CodeContextStore(db);
    this.lifeStore = new LifeStore(db);
    this.projectTaskStore = new ProjectTaskStore(db);
    this.projectTaskEventStore = new ProjectTaskEventStore(db);

    // ★ 8-10 slotify：把同一定时任务/画像类调用绑定到对应采样槽位
    const slotify = (slot?: Partial<SamplingSlot>): ILLMService => ({
      complete: (sys, usr) => this.llmService.complete(sys, usr, slot),
    });
    // ★ 2026-10-01 fix-profile-extract-empty-response：`profile.extract` 槽是 **JSON 契约**
    //   （prompt 里含 "JSON"），消费者：PersonaAdapter（人格调整）/ ProfileExtractor（事实提取）。
    //   CronProcessor.deepProfile 要的是**自然语言画像描述**，共用该槽会被 json_object 模式
    //   直接拒（API 400：Prompt must contain the word 'json'）——故走独立槽。
    const profileLlm = slotify(this.sampling?.profile?.extract);
    const deepRewriteLlm = slotify(this.sampling?.profile?.deepRewrite);
    const summaryLlm = slotify(this.sampling?.session?.summary);

    this.worldbookMatcher = new WorldbookMatcher(this.worldbookStore);
    this.personaAdapter = new PersonaAdapter(this.personaStore, profileLlm);
    this.profileExtractor = new ProfileExtractor(profileLlm);
    this.promptAssembler = new PromptAssembler(
      this.profileStore, this.personaStore, this.conversationStore,
      this.knowledgeStore, this.worldbookStore, this.codeContextStore,
    );

    this.realtimeProcessor = new RealtimeProcessor(
      this.eventStore, this.worldbookMatcher, this.personaAdapter,
      this.profileStore, this.profileExtractor, this.embedService, this.vectorStore,
    );
    this.sessionEndProcessor = new SessionEndProcessor(
      this.eventStore, this.conversationStore, this.profileStore,
      this.personaStore, this.worldbookStore, this.profileExtractor,
      this.personaAdapter, summaryLlm, this.embedService, this.vectorStore,
    );
    this.cronProcessor = new CronProcessor(
      this.eventStore, this.conversationStore, this.knowledgeStore,
      this.profileStore, this.profileExtractor, deepRewriteLlm, this.vectorStore,
    );

    // Load persisted token stats on startup
    this.loadTokenStats();
  }

  // ===== 隐私模式 =====

  setPrivacyMode(mode: PrivacyMode): void {
    this.privacyMode = mode;
  }

  getPrivacyMode(): PrivacyMode {
    return this.privacyMode;
  }

  /** 会话结束时自动恢复隐私模式 */
  resetPrivacyMode(): void {
    this.privacyMode = 'off';
  }

  // ===== Token 统计（由 LLMAgentStage POST 调用）=====

  private loadTokenStats(): void {
    try {
      if (existsSync(TOKEN_STATS_FILE)) {
        const data = JSON.parse(readFileSync(TOKEN_STATS_FILE, 'utf-8'));
        for (const [k, v] of Object.entries(data)) {
          this.tokenStats.set(k, v as TokenStats);
        }
      }
    } catch (err: any) {
      // ★ KI-5：原先裸 catch。token 统计文件坏掉会让 `/api/stats` 从 0 开始，
      //   而"文件坏了"与"从来没有过统计"在接口上完全同形。
      logger.warn(`[Memory] token 统计**读取**失败（本次从 0 开始）: ${err?.message ?? err}`);
    }
  }

  private saveTokenStats(): void {
    if (this.tokenStatsSaveTimer) return;
    this.tokenStatsSaveTimer = setTimeout(() => {
      this.tokenStatsSaveTimer = null;
      try {
        writeFileSync(TOKEN_STATS_FILE, JSON.stringify(Object.fromEntries(this.tokenStats)));
      } catch (err: any) {
        // ★ KI-5：写入失败被吞 ⇒ token 统计**静默停摆**（喂 `/api/stats`）。
        logger.warn(`[Memory] token 统计**写入**失败（统计已停摆）: ${err?.message ?? err}`);
      }
    }, 5000);
  }

  /** ★ 记录一次 LLM token 用量（LLMAgentStage POST 阶段调用）。 */
  recordTokenUsage(sessionId: string, usage: { input: number; output: number; total: number }): void {
    const existing = this.tokenStats.get(sessionId) ?? {
      recordCount: 0, totalInput: 0, totalOutput: 0, totalTokens: 0,
    };
    existing.recordCount += 1;
    existing.totalInput += usage.input;
    existing.totalOutput += usage.output;
    existing.totalTokens += usage.total;
    this.tokenStats.set(sessionId, existing);
    this.saveTokenStats();
  }

  /** ★ 获取 token 统计（Web 端 /stats 路由使用）。
   *  不传 sessionId 返回全局汇总；传入则返回单会话。 */
  getTokenStats(sessionId?: string): TokenStats | { global: { input: number; output: number; tokens: number }; perSession: Record<string, TokenStats> } {
    if (sessionId) {
      return this.tokenStats.get(sessionId) ?? { recordCount: 0, totalInput: 0, totalOutput: 0, totalTokens: 0 };
    }
    // 返回全局 + 所有会话
    const perSession: Record<string, TokenStats> = {};
    let globalInput = 0, globalOutput = 0, globalTokens = 0;
    for (const [id, s] of this.tokenStats) {
      perSession[id] = s;
      globalInput += s.totalInput;
      globalOutput += s.totalOutput;
      globalTokens += s.totalTokens;
    }
    return { global: { input: globalInput, output: globalOutput, tokens: globalTokens }, perSession };
  }

  // ===== 纠正快路径 =====

  /**
   * 用户纠正事实时立即生效（快路径），不等待 SessionEnd。
   * 调用方：RealtimeProcessor 或 Pipeline 中检测到纠正信号。
   */
  async applyCorrectionFastPath(text: string): Promise<boolean> {
    const allFacts = this.profileStore.getAllFacts();
    const signal = await this.profileExtractor.detectCorrectionSignal(text, allFacts);

    if (!signal.isCorrection || !signal.target) return false;

    const newFact = {
      fact: signal.newFact || signal.target,
      confidence: 1.0,
      evidence: signal.rawText,
      source_event: 'correction-fast-path',
      updated_at: new Date().toISOString(),
      source: 'user' as const,
      valid_from: new Date().toISOString(),
      valid_until: null as string | null,
      status: 'active' as const,
      category: 'general' as const, // ★ 8-28 纠正事实：类别由后续提取器细分，兜底 general
    };

    return this.profileStore.supersede(signal.target, newFact);
  }

  /** 获取最近消息（短期记忆）。limit 上限；since 可选时间窗口（如最近 2 小时）。
   *  createdAt 为 ISO 时间（老库行/外部 mock 可能缺失，故可选）。 */
  getRecentMessages(sessionId: string, limit: number = 10, since?: Date): Array<{ role: string; content: string; createdAt?: string }> {
    return this.eventStore.getRecentBySession(sessionId, limit, since);
  }

  /** ★ 8-15 WebUI 会话历史分页（webui-chat-endpoints）：created_at 游标向下翻页，
   *   before 为 ISO 游标；省略取最新 limit 条。时间倒序（最新在前）。 */
  getSessionMessages(sessionId: string, limit: number = 50, before?: string): Array<{ role: string; content: string; senderName: string; createdAt?: string }> {
    return this.eventStore.getMessagesBySession(sessionId, limit, before);
  }

  /** ★ 8-15 WebUI 会话归档(软删除)：列表消失,数据保留(events archived=1) */
  archiveSession(sessionId: string): boolean {
    const origin = sessionId.startsWith('webui:private:') ? sessionId : `webui:private:${sessionId}`;
    this.eventStore.archiveBySession(origin);
    logger.info(`[Session] archived ${origin}`);
    return true;
  }

  /** ★ 8-15 WebUI 会话删除（彻底）：清空该会话的事件流与摘要（用户主动删除,日志留痕）
   *  ★ 8-29 cr-p0-delete-cleanup：同步清理向量——已删内容不再被 [相关记忆] 召回 */
  async deleteSession(sessionId: string): Promise<boolean> {
    const origin = sessionId.startsWith('webui:private:') ? sessionId : `webui:private:${sessionId}`;
    const before = (this.db.prepare('SELECT COUNT(*) c FROM events WHERE session_id = ?').get(origin) as any)?.c ?? 0;
    // 先取向量 id（SQLite 行删除后无法再查）
    const evtIds = (this.db.prepare('SELECT id FROM events WHERE session_id = ?').all(origin) as any[]).map(r => r.id as string);
    const convIds = (this.db.prepare('SELECT id FROM conversations WHERE session_id = ?').all(origin) as any[]).map(r => r.id as string);
    this.eventStore.deleteBySession(origin);
    this.conversationStore.deleteBySession(origin);
    if (this.vectorStore) {
      const results = await Promise.allSettled([...evtIds, ...convIds].map(id => this.vectorStore!.delete(id)));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) logger.warn(`[Session] vector cleanup ${failed}/${evtIds.length + convIds.length} failed for ${origin}`);
    }
    logger.info(`[Session] deleted ${origin} (${before} events)`);
    return true;
  }

  /** ★ 8-09：最近对话注入块（主动消息生成器用——问候/Life 事件也吃对话上下文）。
   *  格式与 memory-retrieval 的 [最近对话] 一致："[HH:MM] 你/昔涟: 内容"，24h 窗口 + limit 条。
   *  无消息返回 ''。 */
  getRecentDialogueBlock(sessionId: string, limit: number = 40): string {
    try {
      const recent = this.getRecentMessages(sessionId, limit, new Date(Date.now() - 24 * 3600 * 1000));
      if (recent.length === 0) return '';
      const p = (n: number) => String(n).padStart(2, '0');
      const lines = recent.map(r => {
        const d = r.createdAt ? new Date(r.createdAt) : null;
        const time = d && !isNaN(d.getTime())
          ? `[${p(d.getHours())}:${p(d.getMinutes())}]`
          : '';
        return `${time} ${dialogueSpeaker(r.role)}: ${r.content}`;
      });
      return `【最近对话】\n${lines.join('\n')}`;
    } catch (err: any) {
      logger.warn(`[Memory] getRecentDialogueBlock failed: ${err.message}`);
      return '';
    }
  }

  /** ★ 8-12 记忆旋钮调整（Web 端/LLM 适配用，转发 PersonaStore） */
  adjustMemoryConfig(config: Partial<MemoryConfig>): void {
    this.personaStore.updateMemoryConfig(config);
  }

  /** ★ 8-12 记忆旋钮读取（当前激活角色） */
  getMemoryConfig(): MemoryConfig {
    return this.personaStore.getMemoryConfig();
  }

  // ===== 提醒持久化（8-12，reminder-sqlite-persistence）=====

  /** ★ 保存提醒（set_reminder 工具持久化）——容器重启不丢失 */
  saveReminder(id: string, r: { text: string; triggerAt: Date; sessionId?: string; retryCount?: number }): void {
    try {
      this.db.prepare(
        'INSERT INTO reminders (id, text, trigger_at, session_id, retry_count) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET text=excluded.text, trigger_at=excluded.trigger_at, session_id=excluded.session_id, retry_count=excluded.retry_count'
      ).run(id, r.text, r.triggerAt.getTime(), r.sessionId ?? '', r.retryCount ?? 0);
    } catch (err: any) {
      logger.warn(`[Memory] saveReminder failed: ${err.message}`);
    }
  }

  /** ★ 删除提醒（cancel / 触发后消费） */
  removeReminder(id: string): void {
    try {
      this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    } catch (err: any) {
      logger.warn(`[Memory] removeReminder failed: ${err.message}`);
    }
  }

  /** ★ 全部待触发提醒（含已过期的——启动恢复时补发用） */
  listPendingReminders(): Array<{ id: string; text: string; triggerAt: Date; sessionId: string; retryCount: number }> {
    try {
      return this.db.prepare('SELECT * FROM reminders ORDER BY trigger_at').all().map((r: any) => ({
        id: r.id,
        text: r.text,
        triggerAt: new Date(r.trigger_at),
        sessionId: r.session_id,
        retryCount: r.retry_count,
      }));
    } catch (err: any) {
      logger.warn(`[Memory] listPendingReminders failed: ${err.message}`);
      return [];
    }
  }

  // ===== AI 主动生活系统（v4）=====

  /** ★ 生活状态快照（Web 展示）。★ 8-27 增量扩展 moodValue（情绪累积值）与 updatedAt（8h 回归基准） */
  getLifeSnapshot(): { currentActivity: string; mood: string; intimacy: number; moodValue: number; moodNote: string; updatedAt: string } {
    const s = this.lifeStore.getState();
    return { currentActivity: s.currentActivity, mood: s.mood, intimacy: s.intimacy, moodValue: s.moodValue, moodNote: s.moodNote, updatedAt: s.updatedAt };
  }

  /** 更新 AI 实时状态（活动/心情/亲密度/moodValue/moodNote），亲密度由 LifeService 每小时推导后传入 */
  updateLifeState(partial: { currentActivity?: string; mood?: string; intimacy?: number; moodValue?: number; moodNote?: string }): void {
    this.lifeStore.updateState(partial);
  }

  /** ★ 8-29 世界观底色（worldview-base-field）：统一底色字段（跨世界之窗/独立人格/生活中心）——
   *  聊天经 persona 文件注入,事件生成经此方法取同一数据源。缓存读取。 */
  /** ★ 8-29 世界观底色；★ 8-30 集中化（worldview-centralize）：按节提取——
   *  'all' 全文（life.ts 事件注入用）/ 'window' 跨世界之窗节 / 'life' 独立生活+生活中心节
   *  （llm-agent 聊天强化块用）。唯一数据源 persona/worldview.md,修改只改那里。 */
  getWorldviewBlock(section: 'all' | 'window' | 'life' = 'all'): string {
    if (!this._worldviewBlock) {
      try {
        this._worldviewBlock = readWorldviewBlock();
      } catch (err: any) {
        // ★ KI-5 点名的那一处：原实现 `catch { this._worldviewBlock = '' }` ——
        //   把失败**永久缓存成空**：此后每轮 prompt 都少一段，而原因再也拿不回来
        //   （下次调用因为已经"有值"了，直接返回空串，连重试都没有）。
        //   现在：喊（限频，因为这是每轮调用的热路径）+ **不缓存**，下次调用会重试。
        warnThrottled(
          'MemoryManager.worldview',
          `[MemoryManager] 读取世界观文件失败（本轮不注入；**不缓存失败**，下次重试）: ${err?.message ?? err}`,
        );
      }
    }
    if (!this._worldviewBlock) return '';
    if (section === 'all') return this._worldviewBlock;
    // 按 `## ` 分节提取（节内含使用引导行）
    const sectionOf = (title: string): string => {
      const re = new RegExp(`## ${title}[\\s\\S]*?(?=\\n## |$)`);
      const m = this._worldviewBlock.match(re);
      return m ? m[0].trim() : '';
    };
    if (section === 'window') return sectionOf('跨世界之窗');
    // 'life'：独立的生活 + 生活是中心
    return [sectionOf('独立的生活'), sectionOf('生活是中心')].filter(Boolean).join('\n\n');
  }

  /** ★ 8-29 聊天生活衔接（chat-life-continuity）：距上次生活事件 ≤30min →
   *  "你刚才在…"补写块（用户消息进来时,对话自然从生活里走出来接话）。
   *  无近期事件返回空串。 */
  getLifeContinuityBlock(): string {
    try {
      const events = this.lifeStore.getEventsSince(new Date(Date.now() - 30 * 60_000).toISOString())
        .filter(e => e.origin !== 'followup');
      if (events.length === 0) return '';
      const last = events[events.length - 1];
      return `你刚才在: ${last.content.slice(0, 60)}（${formatLocalTime(new Date(last.createdAt)).slice(-5)}）`;
    } catch (err: any) {
      // ★ KI-5：原先裸 catch + 返回空串 ⇒「生活衔接块没了」和「她最近确实没有生活事件」
      //   在 prompt 上完全同形。热路径（每条用户消息）→ 限频。
      warnThrottled(
        'MemoryManager.lifeContinuity',
        `[MemoryManager] 生活衔接块构建失败（本轮不注入）: ${err?.message ?? err}`,
      );
      return '';
    }
  }

  // ===== ★ 8-28 意图系统（ai-life-intent-system）=====
  // 角色自己的隐式意图：延迟回复 / 承诺兑现 / 主动联系候选（与 reminders 用户显式提醒并列）

  /** 存意图（LLM 隐式产生：对话 [intent:] 标记 POST 解析 / 事件生成 intent 字段）。
   *  ★ 8-28 evidence：原始承诺句（到期裁决时还原承诺语气） */
  saveIntent(input: { type: 'delayed-reply' | 'promise' | 'proactive-contact'; content: string; triggerAt: number; source: 'dialogue' | 'life-event'; sessionId?: string; evidence?: string }): string {
    const id = `intent-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.lifeStore.saveIntent({
      id, type: input.type, content: input.content, triggerAt: input.triggerAt,
      source: input.source, sessionId: input.sessionId, createdAt: new Date().toISOString(),
      evidence: input.evidence,
    });
    logger.info(`[Intent] + [${input.type}] ${input.content.slice(0, 40)} (trigger ${new Date(input.triggerAt).toLocaleString()})`);
    return id;
  }

  /** 到期未完成的意图（LifeService.tick 扫描处理） */
  listDueIntents(now: number = Date.now()): Array<{ id: string; type: string; content: string; triggerAt: number; status: string; source: string; sessionId: string; createdAt: string; evidence: string; deferCount: number }> {
    return this.lifeStore.listDueIntents(now);
  }

  /** ★ 8-28 延期（承诺闭环）：重排 trigger_at + defer_count+1（上限由 LifeService 判断） */
  deferIntent(id: string, newTriggerAt: number): boolean {
    const ok = this.lifeStore.deferIntent(id, newTriggerAt);
    if (ok) logger.info(`[Intent] ↻ deferred: ${id} → ${new Date(newTriggerAt).toLocaleString()}`);
    return ok;
  }

  /** 标记完成（处理成功后，防重复触发） */
  completeIntent(id: string): boolean {
    const ok = this.lifeStore.markIntentStatus(id, 'completed');
    if (ok) logger.info(`[Intent] ✓ completed: ${id}`);
    return ok;
  }

  /** 取消意图（对话中用户说"不用了"时） */
  cancelIntent(id: string): boolean {
    return this.lifeStore.markIntentStatus(id, 'cancelled');
  }

  // ===== ★ 8-27 配角在场（ScenePresence）=====

  /** 全部在场状态（含 off-scene，供管理展示） */
  listScenePresence(): Array<{ name: string; status: string; basis?: string; updatedAt: string }> {
    return this.lifeStore.listScenePresence();
  }

  /** 当前在场配角名（present + expected）——事件生成注入【在场角色】 */
  listPresentCharacters(): string[] {
    return this.lifeStore.listPresentNames();
  }

  /** 更新/新建在场状态（事件提到谁 → present，带依据；24h 无提及由 LifeService 巡检降级） */
  upsertScenePresence(name: string, status: 'present' | 'off-scene' | 'expected', basis?: string): void {
    this.lifeStore.upsertScenePresence(name, status, basis);
  }

  /** ★ 事件流注入块（对话 prompt 用）：今天逐条 + 近 7 天摘要。无事件返回 '' */
  getLifeEventInjection(): string {
    const todayKey = localDateKey();
    // 本地今天 0 点对应的 ISO 时刻，作为时间窗口起点（避免 LifeStore 字符串比较的 UTC 边界错位）
    const sinceIso = new Date(`${todayKey}T00:00:00`).toISOString();
    const today = this.lifeStore.getEventsSince(sinceIso)
      .filter(e => localDateKeyFromISO(e.createdAt) === todayKey); // 边界兜底
    const summaries = this.lifeStore.getRecentSummaries(7).filter(s => s.date !== todayKey);
    // ★ 8-12 窗口外补叙（life-offline-recap）：昨天 internal 事件（bot 独处、未推送）
    //   最近 2 条——用户跨天后对话时 bot 自然记得昨晚做了什么（查询须在早期 return 前）
    const yesterdayKey = localDateKey(new Date(Date.now() - 86_400_000));
    let recapLines: string[] = [];
    try {
      recapLines = this.lifeStore.getEventsSince(new Date(`${yesterdayKey}T00:00:00`).toISOString())
        .filter(e => e.type === 'internal' && localDateKeyFromISO(e.createdAt) === yesterdayKey)
        .slice(-2)
        .map(e => `- 昨天 ${formatLocalTime(new Date(e.createdAt)).slice(-5)} ${e.content}`);
    } catch { /* recap failure is non-fatal */ }
    if (today.length === 0 && summaries.length === 0 && recapLines.length === 0) return '';

    // ★ 8-12 主提示词瘦身（life-prompt-slim）：今天事件只注入最近 3 条（倒序）——
    //   bot 的"当下状态"（正在做的事 + 最近一两件事）够用，更多细节由事件向量
    //   检索（二期②）在相关时召回；预算 ≤ 500 字，超出优先保留事件、丢最旧摘要
    // ★ 8-28 微叙事适配（life-event-micro-narrative）：事件 2-4 句变长 → 今天只注入最近
    //   2 条、每条截断 100 字（完整细节走向量检索召回）
    const MAX_TODAY_EVENTS = 2;
    const MAX_INJECTION_CHARS = 500;
    const MAX_EVENT_CHARS = 100;
    const recentToday = [...today].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_TODAY_EVENTS);

    const eventLines = recentToday.map(e => {
      const time = formatLocalTime(new Date(e.createdAt)).slice(-5);
      const content = e.content.length > MAX_EVENT_CHARS ? e.content.slice(0, MAX_EVENT_CHARS) + '…' : e.content;
      return `- 今天 ${time} ${content}`;
    });
    const summaryLines = summaries.map(s => `- ${s.date}: ${s.summary}`);

    let lines = [...eventLines, ...recapLines, ...summaryLines];
    // 预算裁剪：从摘要尾部开始丢（事件 + 补叙优先保留）
    while (lines.join('\n').length > MAX_INJECTION_CHARS && summaryLines.length > 0) {
      summaryLines.pop();
      lines = [...eventLines, ...recapLines, ...summaryLines];
    }
    if (lines.length === 0) return '';
    return `[我的近期日常]\n${lines.join('\n')}`;
  }

  /** ★ 记录 AI 生活事件 + 更新当前活动。返回事件 id（LifeService 推送成功后标记 delivered 用）
   *  ★ 8-27 扩展 origin（'regular' | 'followup' 对话余波）
   *  ★ 2026-10-20（change: let-her-decline-a-day）：再扩展 'decline' ——
   *    **她这一轮选择不说话时写下的理由**（拒绝权的留痕，内部分析可召回） */
  recordLifeEvent(input: { type: 'chat' | 'internal'; content: string; moodDelta?: string; referenceEventId?: string; wbEntryId?: string; origin?: 'regular' | 'followup' | 'decline' }): string {
    const now = new Date().toISOString();
    const id = `life-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.lifeStore.addEvent({
      id, createdAt: now, type: input.type, content: input.content,
      moodDelta: input.moodDelta, referenceEventId: input.referenceEventId,
      wbEntryId: input.wbEntryId, origin: input.origin,
    });
    this.lifeStore.updateState({ currentActivity: input.content, mood: input.moodDelta ?? undefined, lastEventId: id });
    logger.info(`[Life] event: [${input.type}]${input.origin === 'followup' ? '[followup]' : ''} ${input.content.slice(0, 60)}`);
    // ★ 8-12 事件向量检索（life-event-vector-search）：fire-and-forget 嵌入——
    //   对话可召回"bot 自己做过的事"（与主提示词瘦身配对：瘦掉的细节检索兜底）。
    //   embed 失败不阻塞事件记录（沿用 RealtimeProcessor 模式）
    if (this.vectorStore) {
      // ★ 9-25 wire-importance-signal：按**情绪强度**算重要性写进向量 metadata ——
      //   `applyKnobsToRetrieved` 的 `importance > 阈值 → +0.15` 分支正是读这里，
      //   接线前它永远读不到值（该分支从未执行）。
      //   放 metadata 而非 `ai_life_events` 加列：召回读的就是 metadata，不需要改表。
      const importance = lifeEventImportance({
        moodDelta: input.moodDelta,
        origin: input.origin,
      });
      // ★ 2026-10-20（change: `wire-retention-bias-into-recall`）：**正负**（valence）单独一列。
      //   重要度取的是强度（arousal），**丢掉正负**；而 `retention_bias`
      //   （-1 只记坏的 / +1 只记好的）要的正是正负。没有它，旋钮只能空转。
      //   ⚠️ 只对**新事件**生效：存量向量没有 polarity ⇒ 不调整（不追溯改排序）。
      const polarity = moodDeltaToPolarity(input.moodDelta);
      this.embedService.embed(input.content)
        .then(vector => this.vectorStore!.insert(id, vector, input.content, {
          source: 'life_event',
          type: input.type,
          created_at: now,
          importance,
          polarity,
        }))
        .catch((err: any) => logger.warn(`[Life] event embed failed: ${err.message}`));
    }
    return id;
  }

  /** ★ 激活角色世界书采样（事件生成人设背景）。返回含 id，供生成器引用与命中统计。
   *  ★ 8-12 二期④：纳入 content_type='life_event' 角色专属事件种子（事件模板）。
   *  ★ 8-27 分层随机（life-worldbook-layered-sample）：life_event 随机取 3 + text 随机取 2
   *    （ORDER BY RANDOM()，不再按 priority 排序），每条截断 200 字（原 100）——
   *    角色生活化条目优先于设定条目；limit 参数兼容旧调用（按分层比例分配）。
   *  ★ 8-27 digest 简介优先（worldbook-digest-summary）：text 条目 content 字段 =
   *    digest（LLM 生成的 120-150 字角色简介，scripts/digest-worldbook.ts 批量生成）
   *    ?? 截断正文 200 字（无 digest 兜底，如新导入条目）
   *
   *  ★ 2026-10-16 冷却过滤（change: `worldbook-sampling-cooldown`）：契约
   *    （`ai-life-system` §6/§7）声明「priority 加权 + **cooldown 过滤**」，
   *    但**两条路径不一致** —— 对话触发（`WorldbookStore.match`）**有**冷却，
   *    而这里（事件生成器采样）此前**只有 `ORDER BY RANDOM()`，从不看 `last_triggered`**。
   *    而 `bumpWorldbookHit()` 的注释早已写着「与对话触发**共用冷却**」
   *    ⇒ 属**声明了没接**（写入侧记了 `last_triggered`，读取侧不看）。
   *
   *    现在的判据（**两条 SQL 都要**，别只改一条）：
   *      `last_triggered` 为空 → 可选；
   *      否则要求 `now − last_triggered > max(采样窗口, 条目 cooldown_sec)`。
   *
   *    ⚠️ 两个实现细节：
   *      ① 用 `NULLIF(last_triggered,'')` 兜空串 —— 否则 `julianday('')` 为 NULL，
   *         比较恒为假，那条会被**永久**排除（比"忘了冷却"更难查）；
   *      ② `julianday` 能正确解析 `recordTrigger` 写入的 `toISOString()`（带 Z）——
   *         本仓 SQLite 3.53.2 实测过。若将来换了存储格式，这里会静默 fail-closed
   *         （全部排除），**改动存储格式时必须回来看这一处**。
   */
  getWorldbookSample(limit: number = 5): Array<{ id: string; content: string }> {
    const role = this.getActiveRoleId();
    // 分层：life_event 占 3/5，text 占 2/5（按 limit 等比，最小各 1）
    const lifeCount = Math.max(1, Math.round(limit * 3 / 5));
    const textCount = Math.max(1, limit - lifeCount);

    // 冷却条件（两条 SQL 共用同一段，避免只有一条被改到）
    const cd = [
      "AND (last_triggered IS NULL OR NULLIF(last_triggered,'') = ''",
      '     OR (julianday(?) - julianday(last_triggered)) * 86400.0 > MAX(?, cooldown_sec))',
    ].join(' ');
    const nowIso = new Date().toISOString();
    const cdSec = WORLDBOOK_SAMPLE_COOLDOWN_MS / 1000;

    const lifeRows = this.db.prepare(
      `SELECT id, content FROM worldbook_entries
        WHERE role = ? AND scope IN ('chat', 'both') AND content_type = 'life_event' ${cd}
        ORDER BY RANDOM() LIMIT ?`
    ).all(role, nowIso, cdSec, lifeCount) as Array<{ id: string; content: string }>;
    const textRows = this.db.prepare(
      `SELECT id, content, digest FROM worldbook_entries
        WHERE role = ? AND scope IN ('chat', 'both') AND content_type = 'text' ${cd}
        ORDER BY RANDOM() LIMIT ?`
    ).all(role, nowIso, cdSec, textCount) as Array<{ id: string; content: string; digest: string | null }>;
    return [
      ...lifeRows.map(r => ({ id: r.id, content: r.content.slice(0, 200) })),
      ...textRows.map(r => {
        const digest = (r.digest ?? '').trim();
        return { id: r.id, content: digest ? digest.slice(0, 200) : r.content.slice(0, 200) };
      }),
    ];
  }

  /** ★ 世界书命中统计（spec §7 ②）：事件引用条目 → hit_count+1 + last_triggered（与对话触发共用冷却）
   *  ⚠️ 2026-10-16 起「共用冷却」才**真的**成立：此前这里记了 `last_triggered`，
   *     而 `getWorldbookSample` 不看它（change: `worldbook-sampling-cooldown`）。 */
  bumpWorldbookHit(id: string): void {
    this.worldbookStore.recordTrigger(id);
  }

  // ===== ★ 8-14 内容自进化（content-self-evolution）=====
  // 昔涟自写持久内容条目：worldbook（回忆/设定）+ life 模板（日常活动）。
  // 写入校验双段：机械预检（查重/长度/触发词）→ LLM 校验器；异常降级拒写（宁可漏记不误记）。
  // 安全靠事后：logger.info 硬审计 + source='self' 标记 + 用户对话内指令删除。

  /** 轻校验器：LLM 判定该不该写（判定 prompt 只给条目本身，不给对话上下文防污染）。
   *  异常/解析失败 → 拒写（模糊一律不写）。 */
  private async validateSelfEntry(kind: string, content: string): Promise<{ ok: boolean; reason: string }> {
    try {
      const text = (await this.llmService.complete(SELF_ENTRY_VALIDATOR_PROMPT, `${kind}\n${content}`))
        .replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const parsed = JSON.parse(text) as { decision?: string; reason?: string };
      if (parsed?.decision === 'write') return { ok: true, reason: '通过' };
      return { ok: false, reason: parsed?.reason ?? '校验未通过' };
    } catch (err: any) {
      logger.warn(`[SelfEvolve] validator failed (${kind}), reject-write: ${err.message}`);
      return { ok: false, reason: '校验失败' };
    }
  }

  /** 自写世界书条目：机械预检 → LLM 校验 → 写入（source='self'，role=alysia）。 */
  async addWorldbookEntry(input: { triggerKeys: string[]; content: string }): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const triggerKeys = (input.triggerKeys ?? []).map(k => String(k).trim()).filter(Boolean);
    const content = (input.content ?? '').trim();
    if (triggerKeys.length === 0) return { ok: false, reason: '触发词为空' };
    if (!content) return { ok: false, reason: '内容为空' };
    if (content.length > 250) return { ok: false, reason: '内容超过 250 字上限' };

    // 机械查重：content 完全重复 / trigger_keys 交集
    if (this.db.prepare('SELECT id FROM worldbook_entries WHERE content = ?').get(content)) {
      return { ok: false, reason: '已有完全相同的内容' };
    }
    const keySet = new Set(triggerKeys);
    const existingRows = this.db.prepare('SELECT trigger_keys FROM worldbook_entries').all() as Array<{ trigger_keys: string }>;
    for (const row of existingRows) {
      try {
        const rowKeys = new Set(JSON.parse(row.trigger_keys) as string[]);
        for (const k of keySet) if (rowKeys.has(k)) return { ok: false, reason: `触发词"${k}"已被其他条目占用` };
      } catch { /* 忽略坏行 */ }
    }

    const v = await this.validateSelfEntry('worldbook', `条目: ${content}\n触发词: ${triggerKeys.join('、')}`);
    if (!v.ok) return { ok: false, reason: v.reason };

    const now = new Date().toISOString();
    const id = `wb_self_${this.hashStr(triggerKeys.join('') + content)}`;
    this.worldbookStore.insert({
      id, trigger_keys: JSON.stringify(triggerKeys), trigger_mode: 'any', content,
      scope: 'chat', priority: 3, cooldown_sec: 300,
      last_triggered: null, hit_count: 0, created_at: now, updated_at: now,
      role: 'alysia', content_type: 'text', source: 'self',
    });
    // ★ 硬审计记录（可扫描 + 撤销找回）
    logger.info(`[SelfEvolve] worldbook+ ${id} 触发词[${triggerKeys.join(',')}] 内容: ${content.slice(0, 60)}`);
    return { ok: true, id };
  }

  /** 自写世界书条目列表（Web 审计面；source 区分 seed/self；contentType 供前端过滤表情包） */
  listWorldbookEntries(): Array<{ id: string; triggerKeys: string[]; content: string; source: string; createdAt: string; contentType: string }> {
    const rows = this.db.prepare(
      'SELECT id, trigger_keys, content, source, created_at, content_type FROM worldbook_entries ORDER BY created_at DESC'
    ).all() as Array<{ id: string; trigger_keys: string; content: string; source: string; created_at: string; content_type: string }>;
    return rows.map(r => ({
      id: r.id,
      triggerKeys: JSON.parse(r.trigger_keys) as string[],
      content: r.content,
      source: r.source ?? 'seed',
      createdAt: r.created_at,
      contentType: r.content_type ?? 'text',
    }));
  }

  /** 删除世界书条目（仅用户指令驱动；删除日志留完整内容供找回） */
  deleteWorldbookEntry(id: string): boolean {
    const row = this.db.prepare('SELECT content, source FROM worldbook_entries WHERE id = ?').get(id) as { content: string; source: string } | undefined;
    if (!row) return false;
    this.worldbookStore.deleteEntry(id);
    logger.info(`[SelfEvolve] worldbook- ${id} (source=${row.source}) 内容: ${row.content.slice(0, 60)}`);
    return true;
  }

  /** 自加生活模板：机械预检 → LLM 校验 → 写入（source='self'，weight 固定 2 防权重操纵）。
   *  ★ 8-27 自加分类（life-template-self-classify）：category/groupName 透传；
   *    未传时默认映射（chat→'分享'、internal→'独处'）——自写模板回落能匹配在场角色组 */
  async addLifeTemplate(input: { activity: string; type?: 'chat' | 'internal'; category?: string; groupName?: string }): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const activity = (input.activity ?? '').trim();
    const type = input.type === 'chat' ? 'chat' : 'internal';
    if (!activity) return { ok: false, reason: '活动描述为空' };
    if (activity.length > 250) return { ok: false, reason: '内容超过 250 字上限' };
    if (this.db.prepare('SELECT id FROM life_templates WHERE activity = ?').get(activity)) {
      return { ok: false, reason: '已有相同的活动模板' };
    }
    const v = await this.validateSelfEntry('life_template', `活动: ${activity}`);
    if (!v.ok) return { ok: false, reason: v.reason };

    // 分类兜底：未显式传 → type 默认映射；非法值回落 '独处'
    const category = ['独处', '互动', '分享'].includes(input.category ?? '')
      ? (input.category as string)
      : (type === 'chat' ? '分享' : '独处');
    const groupName = ['none', '迷迷', '风堇', '遐蝶', '白厄', '其他人'].includes(input.groupName ?? '')
      ? (input.groupName as string)
      : 'none';

    const now = new Date().toISOString();
    const id = `lt_self_${this.hashStr(activity)}`;
    this.lifeStore.addTemplate({ id, activity, type, weight: 2, source: 'self', createdAt: now, category, groupName });
    logger.info(`[SelfEvolve] life_template+ ${id} [${type}/${category}/${groupName}] ${activity.slice(0, 60)}`);
    return { ok: true, id };
  }

  /** 生活模板池列表（seed + self；LifeService.pickTemplate 实时读取） */
  listLifeTemplates(): Array<{ id: string; activity: string; type: 'chat' | 'internal'; weight: number; source: string }> {
    return this.lifeStore.listTemplates();
  }

  /** 删除生活模板（仅用户指令驱动；删除日志留底） */
  deleteLifeTemplate(id: string): boolean {
    const row = this.db.prepare('SELECT activity, source FROM life_templates WHERE id = ?').get(id) as { activity: string; source: string } | undefined;
    if (!row) return false;
    this.lifeStore.deleteTemplate(id);
    logger.info(`[SelfEvolve] life_template- ${id} (source=${row.source}) ${row.activity.slice(0, 60)}`);
    return true;
  }

  /** ★ 标记生活事件已推送（LifeService 推送成功后调用，spec §5 delivered=1） */
  markLifeEventDelivered(id: string): void {
    this.lifeStore.markDelivered(id);
  }

  /** ★ 近 N 天每日生活摘要（生成器回顾用；注入块见 getLifeEventInjection） */
  listLifeSummaries(days: number = 7): Array<{ date: string; summary: string }> {
    return this.lifeStore.getRecentSummaries(days);
  }

  /** ★ 用户近况摘要（事件生成器用）：活跃 facts 前 5 条 */
  getUserActivitySummary(): string {
    const facts = this.profileStore.getActiveFacts()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(f => f.fact);
    return facts.join('；');
  }

  /** ★ 生活事件列表（Web 展示） */
  listLifeEvents(days: number = 7): LifeEvent[] {
    const start = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.lifeStore.getEventsSince(start);
  }

  /** ★ 每日生活摘要写入（LifeService 每日 0 点调用） */
  upsertDailySummary(date: string, summary: string): void {
    this.lifeStore.upsertDailySummary(date, summary);
  }

  async ingest(event: MemoryEvent): Promise<void> {
    // 隐私模式 'full': 不写入 EventLog
    if (this.privacyMode === 'full') {
      logger.debug('[Memory] ingest skipped (privacy full)');
      return;
    }

    // PII filter before storing
    if (event.payload.content) {
      event.payload = { ...event.payload, content: filterPII(event.payload.content as string) };
    }
    // ★ 8-28 视角标记（memory-character-perspective）：LifeService 回写生活事件带 'self'
    event.perspective = event.perspective ?? 'interaction';

    // Write to event log (immutable)
    this.eventStore.insert(event);
    logger.debug(`[Memory] ingest saved: ${(event.payload.content as string ?? '').slice(0, 50)} (${event.session_id.slice(-20)})`);

    // Fire realtime processing (async, don't await)
    this.realtimeProcessor.process(event).catch(err => {
      logger.error('Realtime processing error:', err);
    });
  }

  async read(req: MemoryReadRequest): Promise<MemoryReadResult> {
    // Worldbook matching（按当前激活角色过滤）
    const activeRole = this.getActiveRoleId();
    const triggers = await this.worldbookMatcher.match(req.query, req.mode, activeRole);

    // ★ 8-12 记忆旋钮（memory-knobs-into-recall-pipeline）：召回排序前应用
    //   recency_weight（时间衰减）+ decay_rate（遗忘速度）+ importance_threshold（优先）
    const knobs = this.personaStore.getMemoryConfig();

    // 向量存储未启用时直接走文本检索（避免 embed 成功但 search 空结果不触发 fallback）
    //
    // ★ 2026-10-19（change: `fix-empty-embed-query`）：**空 query 也直接走文本检索**。
    //   真机证据：`[memory/read] query=""` 紧跟着
    //   `Embed API error 400: {"code":"1213","message":"未正常接收到prompt参数。"}`
    //   —— 只是"这次没有语义查询"（如 dsh 会话的系统组装），却每次都要先撞一次 400、
    //   再打一条 WARN，日志噪声掩盖真故障。空查询请求 embedding 本来就是错的：
    //   **没有查询文本就没有"语义相似"可言**。
    if (!this.vectorStore || req.query.trim() === '') {
      const retrieved = this.applyKnobsToRetrieved([
        ...this.conversationStore.searchByText(req.query, req.limit),
        ...this.knowledgeStore.searchChunksByText(req.query, Math.min(3, req.limit)),
      ], knobs).results.slice(0, req.limit);
      if (!this.vectorStore) {
        // 老路径：向量库没起来（真问题，值得 WARN，由调用方/启动日志说明）
      } else {
        logger.debug('[Memory] 空查询 ⇒ 跳过向量检索，直接文本检索（不是故障）');
      }

      return {
        context: '',
        persona_hint: '',
        retrieved,
        worldbook_triggers: triggers,
      };
    }

    // Vector search
    let retrieved: SearchResult[] = [];
    const recallStart = Date.now(); // ★ 9-25 观测：召回耗时（观测日志里报）
    try {
      const vector = await this.embedService.embed(req.query);
      // ★ 8-09 事件向量纳入检索：[相关记忆] 可捞回超 24h 的对话细节（含回写后的 AI 发言）
      // ★ 8-12 life 事件纳入检索（life-event-vector-search）：bot 自己的"生活"可被召回
      const [convResults, knowledgeResults, eventResults, lifeResults] = await Promise.all([
        this.conversationStore.searchByVector(vector, req.limit),
        this.knowledgeStore.searchByVector(vector, Math.min(3, req.limit)),
        this.eventStore.searchByVector(vector, Math.min(3, req.limit)),
        this.vectorStore.search(vector, Math.min(2, req.limit), { source: 'life_event' }),
      ]);
      // ★ 9-25 optimize-recall-pipeline：合并改为「保底配额 + 分数补位」，
      //   不再 `[...四路] → 全局 sort → slice`。
      //
      //   原因：**路内排名可信，跨路比绝对分不可信**。不同来源的文本长度分布不同
      //   （生活事件是 2-4 句长微叙事、聊天是短问句），长文本跟短查询的嵌入天然更远。
      //   全局 sort 等于让"文本短的来源"系统性获胜 —— 实测 46 条 life_event
      //   在 6 个话题里一条都进不了最终 5 条（全被 conversation 挤掉）。
      //
      //   现在：每路先保底 top-1（保证"她的生活""过往对话""知识"都有代表），
      //   剩余名额按分数从所有候选里补。某路无候选则名额让给其他路。
      const merged = this.mergeWithQuota(
        [
          // ★ 顺序有讲究：`type='chat'` 的生活事件在两个来源各存一份（见 mergeWithQuota 的注释）。
          //   去重时**先到先得**，所以把 life_event 排前面 —— 让语义更具体的标签胜出，
          //   否则同一段内容会被标成 'chat'，导致 perspective:'self' 视角过滤漏掉它。
          { source: 'life_event', items: lifeResults },
          { source: 'chat', items: eventResults },
          { source: 'conversation', items: convResults },
          { source: 'knowledge', items: knowledgeResults },
        ],
        knobs,
        req.limit,
      );
      retrieved = merged.picked;

      // ★ 9-25 tune-recall-with-runtime-data：**召回观测日志**（一召一行，info 级）。
      //   目的：这些系数全是启发式拍的，要按运行数据调 —— 但调之前得先有数据。
      //   这一行回答四个问题：各来源候选多少 / 被相对阈值丢了多少 /
      //   最终选中分布 / 重要度加分触发几次。
      //   ⚠️ 别改成 debug —— 生产跑 info，改了就等于没记（这正是本次补日志的原因）。
      logger.info(
        `[Recall] 候选 ${this.fmtCounts(merged.candidateCounts)}` +
        ` → 过阈值 ${this.fmtCounts(merged.keptCounts)}` +
        ` → 选中 ${this.fmtCounts(merged.pickedCounts)}` +
        ` | 重要度加分×${merged.boosted}` +
        ` | 极性调整×${merged.polarityAdjusted}` +
        ` | ${Date.now() - recallStart}ms`,
      );
    } catch (err: any) {
      // Fallback: SQLite LIKE search when embed API fails
      logger.warn(`[Memory] vector search failed, fallback to text search: ${err.message}`);
      // 知识库升级为搜 chunk 全文（之前只搜标题，几乎搜不到内容）
      retrieved = this.applyKnobsToRetrieved([
        ...this.conversationStore.searchByText(req.query, req.limit),
        ...this.knowledgeStore.searchChunksByText(req.query, Math.min(3, req.limit)),
      ], knobs).results.slice(0, req.limit);
    }

    // ★ 8-28 视角过滤（memory-character-perspective）：'self'=只留生活事件（昔涟自己的生活）；
    //   'interaction'=排除生活事件（互动为主）；缺省不过滤
    if (req.perspective === 'self') {
      retrieved = retrieved.filter(r => r.metadata?.source === 'life_event');
    } else if (req.perspective === 'interaction') {
      retrieved = retrieved.filter(r => r.metadata?.source !== 'life_event');
    }

    return {
      context: '',
      persona_hint: '',
      retrieved,
      worldbook_triggers: triggers,
    };
  }

  /**
   * ★ 8-12 记忆旋钮接线（memory-knobs-into-recall-pipeline）：
   * - decay_rate：遗忘速度——半衰期 = 24h / decay_rate（0.3 → ~80h 半衰；1 → 24h 秒忘；0 → 不忘）
   * - recency_weight：时间惩罚上限——score × (1 − recency_weight × ageFactor × 0.5)
   *   （ageFactor = 1 − e^(−age/半衰期)，0~1；=0 念旧不罚）
   * - importance_threshold：importance > threshold 的结果加分优先（metadata.importance）
   * 知识库（无时间字段）天然不衰减；metadata 缺时间按最新处理（不罚）。
   *
   * ★ 9-25 wire-importance-signal：importance 加分**已生效**（此前注入端恒 0、分支从未执行）。
   *   返回 `boosted` 供观测日志统计实际触发率 —— 这是判断"重要性有没有真起作用"的关键指标。
   */
  private applyKnobsToRetrieved(
    retrieved: SearchResult[],
    knobs: MemoryConfig,
  ): { results: SearchResult[]; boosted: number; polarityAdjusted: number } {
    const now = Date.now();
    const halfLifeHours = 24 / Math.max(knobs.decay_rate, 0.05);
    let boosted = 0;
    let polarityAdjusted = 0;
    const scored = retrieved.map(r => {
      let score = r.score;
      // recency 衰减：metadata.created_at/updated_at（事件/会话向量带；知识无 → 不衰减）
      const ts = (r.metadata?.created_at ?? r.metadata?.updated_at) as string | undefined;
      if (typeof ts === 'string') {
        const ageHours = (now - new Date(ts).getTime()) / 3_600_000;
        if (ageHours > 0) {
          const ageFactor = 1 - Math.exp(-ageHours / halfLifeHours);
          score = score * (1 - knobs.recency_weight * ageFactor * 0.5);
        }
      }
      // importance 优先：metadata.importance > threshold → 加分
      const imp = r.metadata?.importance;
      if (typeof imp === 'number' && imp > knobs.importance_threshold) {
        score += 0.15;
        boosted++;
      }
      // ★ 2026-10-20（change: `wire-retention-bias-into-recall`）：**retention_bias 接线**。
      //
      //   语义（spec §2.2）：`retention_bias` 正 = 更愿意想起**好的**，负 = 更愿意想起**坏的**。
      //   只在**有 valence** 的记忆上生效（`metadata.polarity`，仅新生活事件带）；
      //   判不出正负（0 / 缺失）⇒ **不动分**（不猜）。
      //
      //   系数 0.3 是**保守值**：默认 `retention_bias=0.2` ⇒ 正向记忆最多 +6%、
      //   负向 -6%，不足以翻掉 `RELATIVE_KEEP=0.7` 的阈值判定，只微调同档内次序。
      //   ⚠️ 这是**路内**调整：不允许拿它做跨来源加权（见 spec §7 的通用判据）。
      const pol = r.metadata?.polarity;
      if (typeof pol === 'number' && pol !== 0 && knobs.retention_bias !== 0) {
        score = score * (1 + knobs.retention_bias * pol * RETENTION_BIAS_IN_RECALL);
        polarityAdjusted++;
      }
      return { ...r, score };
    });
    return { results: scored.sort((a, b) => b.score - a.score), boosted, polarityAdjusted };
  }

  /**
   * ★ 9-25 optimize-recall-pipeline：多来源合并 —— 保底配额 + 分数补位。
   *
   * 为什么不能简单 `[...各路] → sort → slice`：
   *   **路内排名可信，跨路比绝对分不可信。** 不同来源的文本长度分布不同
   *   （生活事件是 2-4 句长微叙事、聊天是短问句），长文本与短查询的嵌入天然更远。
   *   全局 sort 等于让"文本短的来源"系统性获胜。实测：46 条 life_event 在 6 个话题里
   *   一条都进不了最终 5 条（全被 conversation 挤掉），尽管它们路内排名第一。
   *
   * 策略：
   *   1. 每路内部打分排序 + **相对阈值**（差于该路最佳 {@link RELATIVE_KEEP} 倍以上的丢掉）
   *      —— 相对而非绝对，才不受"长文本分数天然低"的影响
   *   2. **每路保底 top-1**（无候选则名额让给其他路）—— 保证"她的生活""过往对话"
   *      "知识"都有代表
   *   3. 剩余名额按分数从所有候选补
   *
   * 代价与取舍：limit=5 且四路都有候选时，会**固定注入 1 条生活事件**。
   * 这是有意的 —— "她有自己的生活"是这套系统的核心，她的近况理应常在上下文里。
   * 需要排除时走 `perspective: 'interaction'`（见 read() 的视角过滤）。
   */
  private mergeWithQuota(
    groups: Array<{ source: string; items: SearchResult[] }>,
    knobs: MemoryConfig,
    limit: number,
  ): {
    picked: SearchResult[];
    /** 各来源**原始候选**数（观测用） */
    candidateCounts: Record<string, number>;
    /** 各来源**过相对阈值后**保留数（观测用）—— 与候选的差 = 被阈值丢掉多少 */
    keptCounts: Record<string, number>;
    /** 各来源**最终选中**数（观测用） */
    pickedCounts: Record<string, number>;
    /** `importance > 阈值 → +0.15` 的命中次数（观测用；接线前该值恒为 0） */
    boosted: number;
    /** `retention_bias` 按 valence 调整过的条数（观测用；没 polarity 的老记忆不计） */
    polarityAdjusted: number;
  } {
    const candidateCounts: Record<string, number> = {};
    const keptCounts: Record<string, number> = {};
    const pickedCounts: Record<string, number> = {};
    let boosted = 0;
    let polarityAdjusted = 0;

    if (limit <= 0) {
      return { picked: [], candidateCounts, keptCounts, pickedCounts, boosted, polarityAdjusted };
    }

    const prepared = groups.map(g => {
      candidateCounts[g.source] = g.items.length;
      const { results: scored, boosted: b, polarityAdjusted: p } = this.applyKnobsToRetrieved(g.items, knobs);
      boosted += b;
      polarityAdjusted += p;
      if (scored.length === 0) {
        keptCounts[g.source] = 0;
        return { source: g.source, items: [] as SearchResult[] };
      }
      const floor = scored[0].score * RELATIVE_KEEP;
      const kept = scored.filter(r => r.score >= floor);
      keptCounts[g.source] = kept.length;
      return { source: g.source, items: kept };
    });

    const picked: SearchResult[] = [];
    const seenId = new Set<string>();
    // ★ 文本去重：同一段内容会以**两个来源**各存一份 —— `type='chat'` 的生活事件
    //   既被 recordLifeEvent 嵌成 life_event，又被推送后经 RealtimeProcessor 嵌成 chat。
    //   实测 47 条 life_event 里 23 条在 chat 里也有一份。
    //   **不去掉写入端的重复**：那两份语义不同（"她的生活" vs "她对你说的话"），
    //   perspective 视角过滤（'self' / 'interaction'）正依赖这个区分。
    //   只在最终选稿阶段按文本去重，避免同一句话占掉两个名额。
    const seenText = new Set<string>();
    const normalize = (t: string) => t.replace(/\s+/g, ' ').trim();

    const take = (r: SearchResult | undefined): void => {
      if (!r || seenId.has(r.id)) return;
      const key = normalize(r.text);
      if (key && seenText.has(key)) return;
      picked.push(r);
      seenId.add(r.id);
      if (key) seenText.add(key);
    };

    // ② 保底 top-1
    for (const g of prepared) take(g.items[0]);

    // ③ 补位：所有剩余按分数降序
    if (picked.length < limit) {
      const rest = prepared
        .flatMap(g => g.items)
        .filter(r => !seenId.has(r.id))
        .sort((a, b) => b.score - a.score);
      for (const r of rest) {
        if (picked.length >= limit) break;
        take(r);
      }
    }

    const final = picked.slice(0, limit);
    for (const r of final) {
      const src = String(r.metadata?.source ?? 'unknown');
      pickedCounts[src] = (pickedCounts[src] ?? 0) + 1;
    }
    return { picked: final, candidateCounts, keptCounts, pickedCounts, boosted, polarityAdjusted };
  }

  /** 观测日志用的紧凑计数格式：`conv=2 chat=3 life=1` */
  private fmtCounts(counts: Record<string, number>): string {
    const abbrev: Record<string, string> = {
      conversation: 'conv',
      knowledge: 'kn',
      chat: 'chat',
      life_event: 'life',
    };
    const parts = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${abbrev[k] ?? k}=${n}`);
    return parts.length ? parts.join(' ') : '—';
  }

  /** @deprecated 请使用 assembleWithWorldbook()，它包含了 Worldbook 和 search results 的完整组装 */
  async assemble(mode: 'chat' | 'code'): Promise<string> {
    return this.promptAssembler.assemble(mode);
  }

  /** 带 Worldbook 匹配的 assemble — 供 MemoryRetrievalStage 使用 */
  async assembleWithWorldbook(mode: 'chat' | 'code', triggers: WorldbookEntry[], retrieved: SearchResult[], sessionId?: string): Promise<string> {
    // 隐私模式 readonly/full: 不注入 Profile/Worldbook/Life
    if (this.privacyMode !== 'off') {
      return this.promptAssembler.assembleMinimal(mode);
    }
    const lifeInjection = this.getLifeEventInjection();
    if (lifeInjection) {
      logger.debug(`[Memory] life injection: ${lifeInjection.length} chars into ${mode} prompt`);
    }
    // ★ 8-09 会话隔离：sessionId 透传给会话摘要过滤（防群聊摘要混入私聊）
    return this.promptAssembler.assemble(mode, retrieved, triggers, lifeInjection, sessionId);
  }

  /**
   * 会话摘要的窗口锚点 = 该会话**最新一条摘要的 ended_at**；无历史摘要 → 见下。
   *
   * ★ 2026-10-11（fix-session-end-window）：`MemoryManager` 有三个 SessionEnd 入口
   *   （`onSessionEnd` / `extractProfile` / `archiveStaleSessions`），**锚点规则只能有
   *   这一处**。此前 cron 那份写对了、另外两个入口漏传 `since`，于是
   *   `process(sessionId)` 落到 `EventStore.getBySession` 的缺省行为
   *   「全历史 `ORDER BY created_at DESC LIMIT 1000`」：
   *   线上实测 76% 的摘要窗口跨度 > 24h，29 条恰好 1000 条消息、跨度 46~61 天，
   *   同一段历史被反复摘要（45 秒内连摘三次），摘要槽稳定失败（8 天 10 次空响应）。
   *
   * ★ 2026-10-16（change: `fix-summary-anchor-floor`，KI-26）：**无历史摘要**那条分支
   *   由「现在 − 24h」改为「**该会话最早的事件**（并以 7 天为上限）」：
   *
   *   - 旧兜底（`now − 24h`）会让**消息全部早于 24h 的会话一条都摘要不出来**，
   *     而且**永远够不着** —— 下一次的锚点是「上一份摘要的 `ended_at`」，
   *     可上一份根本不存在，于是每回都退回 `now − 24h`，而 now 还在往前跑。
   *     真实场景：会话开着超过 24h 才结束、或进程停过之后由 cron 归档。
   *   - ⚠️ 旧兜底是 `now − 24h`（2026-10-11 事故后加的），现已去掉 ——
   *     它的代价是**永久丢掉**更早那段，而事故的真机制（反复摘要同一段历史）
   *     已经被"锚点只此一处 + 摘完就前进"堵死。详见分支内的注释。
   *
   * ⚠️ 不要与 `archiveStaleSessions` 里 `getActiveSessions(since)` 的那个 `since` 混用：
   *   那个是「24h 内有过活跃」的**筛选门槛**，与本锚点是两个不同语义——
   *   合并成一个变量会漏掉「很久没说话的会话」。
   */
  private summaryAnchor(sessionId: string): Date {
    const last = this.conversationStore.getLatestBySession(sessionId);

    if (!last) {
      // ★ **从未摘要过** ⇒ 从头摘（**不设时间上限**，理由见"为什么无界是安全的"）。
      //
      //   ⚠️ **为什么"从头摘"不会造成二次摘要**：
      //       `getBySession` **不按 `processed` 过滤**，所以窗口锚点是唯一的闸；
      //       而这里的前提是「一条会话记录都没有」⇒ 这个会话**从来没被摘过** ⇒
      //       从头摘正是它该做的事。一旦摘过一次，下面就走 `ended_at` 分支。
      //
      //   ⚠️ **为什么"无界"是安全的**（2026-10-16 重新判断过，推翻了我自己前一刻的 7 天上限）：
      //       2026-10-11 那次事故的**真机制**是「三个 SessionEnd 入口都没传锚点 ⇒
      //       落到 `getBySession` 缺省的全历史 ⇒ **同一段历史被反复摘要**」
      //       （45 秒内连摘三次）—— 坏窗口（46~61 天 / 1000 条）是它的**症状**。
      //       那个机制已被"锚点只此一处 + 摘完就前进"堵死：从头摘只会发生**一次**。
      //       而当初为它加的 `now − 24h` 兜底代价是**永久丢掉**更早那段（KI-26），
      //       且**永远够不着**（下一次锚点 = 新摘要的 `ended_at`，那条再也进不来）。
      //       权衡：一次**可见且可重试**的大窗口（失败写成 `summary_status='failed'`，
      //       `retryFailedSummaries()` 会补）**优于**静默且不可恢复的丢失。
      //       ⚠️ 残留风险：单次窗口仍受 `getBySession` 的 `LIMIT 1000` 截断 ——
      //          从未摘过且超过 1000 条的会话，最老那批这次仍够不到。
      //          彻底做法是**分块回填**（Backlog「历史画像回填」），不在本 change 内。
      const earliest = this.eventStore.getEarliestCreatedAt(sessionId);
      if (!earliest) {
        // 连事件都没有：保持旧兜底（行为与以前一致）
        return new Date(Date.now() - 24 * 3600 * 1000);
      }

      // ⚠️ **减 1ms**：窗口下界是**排他**的（`getBySession` 用 `created_at > since`，
      //    见 `memory-system` §5.4.1 契约 4b）。若把下界设成"最早事件自己的时间戳"，
      //    那第一条会被 `>` **正好排除掉** —— "从头摘"反而漏掉开头（红测抓到过：
      //    新鲜会话因此一条摘要都不产）。
      const anchor = new Date(new Date(earliest).getTime() - 1);
      logger.debug(`[Memory] summary anchor（从未摘要→从头）for ${sessionId.slice(-24)}: ${anchor.toISOString()}`);
      return anchor;
    }

    // 有历史摘要 → 从它之后继续。`ended_at` 是**数据边界**（§5.4.1 契约 4）。
    // ⚠️ 有记录却 `ended_at` 为空 → **保守到底，就是旧的 24h**（**不要**跟着放宽）：
    //    那个分支**没有已知边界**（正常写入路径一定会填 `ended_at`），
    //    而 `getBySession` 不按 `processed` 过滤 ⇒ 窗口放宽多少就可能重摘多少。
    //    宁可漏（它至少还会被下一次的窗口重新考虑），也不要回头重摘已学过的历史。
    const anchor = last.ended_at
      ? new Date(last.ended_at)
      : new Date(Date.now() - 24 * 3600 * 1000);
    logger.debug(`[Memory] summary anchor for ${sessionId.slice(-24)}: ${anchor.toISOString()}`);
    return anchor;
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    logger.info(`[Memory] onSessionEnd: ${sessionId.slice(-30)} (summary + profile)`);
    const start = Date.now();
    try {
      await this.sessionEndProcessor.process(sessionId, this.summaryAnchor(sessionId));
      logger.info(`[Memory] onSessionEnd done (${Date.now() - start}ms)`);
    } catch (err: any) {
      logger.error(`[Memory] onSessionEnd failed: ${err.message}`);
      throw err;
    }
    // 会话结束自动恢复隐私模式
    this.privacyMode = 'off';
  }

  /**
   * ★ 2026-10-20（change: `put-dropped-turns-back`）：把**被上下文压缩丢弃的轮次**压成一段回忆。
   *
   * 与 `onSessionEnd` 的区别（**别混**）：
   *   - `onSessionEnd` 是**长期记忆**（会话结束/超阈值结算，进 conversations 表）
   *   - 本方法是**当前会话的上下文压缩**（结果插回 prompt 头部，不落库、不改状态）
   *
   * 输入输出都是纯数据（`turns` / `previousSummary` → 文本），调用方（`AgentHooks`）决定用途。
   *
   * ⚠️ **必须走 `profile.deepRewrite` 槽（纯文本）**：默认槽是 `profile.extract`
   * （`response_format: json_object`），而本 prompt 里没有 "json" 字样 ⇒ 直接 API 400。
   * 这是 2026-10-01 那次事故的同一个坑，别重犯。
   */
  async summarizeContextSlice(input: {
    turns: Array<{ role: string; content: string }>;
    previousSummary?: string;
  }): Promise<string> {
    const dialogue = input.turns
      .map(t => `${t.role === 'user' ? '用户' : t.role === 'assistant' ? '昔涟' : t.role}: ${t.content}`)
      .join('\n');
    const system = input.previousSummary
      ? CONTEXT_COMPACT_MERGE_SYSTEM_PROMPT
      : CONTEXT_COMPACT_SYSTEM_PROMPT;
    const user = input.previousSummary
      ? `【已有摘要】\n${input.previousSummary}\n\n【更晚一些的对话】\n${dialogue}`
      : `【较早的对话】\n${dialogue}`;
    return this.llmService.complete(system, user, this.sampling?.profile?.deepRewrite);
  }

  /** ★ 8-09 定期归档（修"短对话永不归档"）：24h 内有消息的活跃 session → 摘要归档。
   *  since 锚点 = 该 session 最新摘要的 ended_at（无摘要 → 24h 前起点）——防重复摘要。
   *  cron 每 6h 调用。返回归档 session 数。 */
  async archiveStaleSessions(): Promise<number> {
    let archived = 0;
    try {
      // ★ 9-25 fix-session-summary-silent-failure：**先补处理历史失败行**。
      //   失败行也带 ended_at，会推进 anchor —— 常规循环因此不会再覆盖那个窗口，
      //   必须显式还原窗口起点重跑，否则失败窗口的消息永久丢失摘要。
      const retried = await this.retryFailedSummaries();
      if (retried > 0) logger.info(`[Memory] 补处理成功 ${retried} 条失败摘要`);

      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const active = this.eventStore.getActiveSessions(since);
      // ★ 9-26 fix-session-event-window-truncation：按 process() 的**真实结果**计数。
      //   原实现无条件 `archived++`，于是"空转什么都没做"在日志里和"归档成功"一模一样
      //   （线上表现为 `archived 1/1` 而库里 0 条新摘要，持续 18 小时无人发现）。
      let skipped = 0;
      let failed = 0;
      // ★ KI-15：摘要与向量**分开计数**。旧日志 `archived N/M` 只数摘要，
      //   于是「摘要全成、向量一条没写」也报全绿 —— 2026-09-27 回填事故同形。
      const vectorCounts: Record<VectorWriteOutcome, number> = {
        stored: 0, 'no-store': 0, 'no-vector': 0, failed: 0,
      };
      for (const sid of active) {
        try {
          // ★ 2026-10-11 fix-session-end-window：锚点改走共用 helper
          //   （行为不变：无历史摘要仍回退 24h 前）。
          const anchor = this.summaryAnchor(sid);
          const r = await this.sessionEndProcessor.process(sid, anchor);
          if (r.summarized) {
            archived++;
            if (r.vectorOutcome) vectorCounts[r.vectorOutcome]++;
          } else if (r.reason === 'summary-failed') failed++;
          else {
            skipped++;
            logger.info(`[Memory] 跳过 ${sid.slice(-24)}（${r.reason}，无新内容可摘要）`);
          }
        } catch (err: any) {
          logger.error(`[Memory] archive failed for ${sid.slice(-24)}: ${err.message}`);
        }
      }
      if (archived > 0 || skipped > 0 || failed > 0) {
        // 只有「全部 stored」才不加尾巴 —— 任何降级都要在这行里看得见
        const allStored = vectorCounts.stored === archived;
        const vectorNote = allStored
          ? ''
          : `（向量：成功 ${vectorCounts.stored} / 无库 ${vectorCounts['no-store']} / 失败 ${vectorCounts.failed}）`;
        logger.info(
          `[Memory] archived ${archived}/${active.length} sessions` +
          (skipped > 0 ? `（跳过 ${skipped}：无新内容）` : '') +
          (failed > 0 ? `（失败 ${failed}）` : '') +
          vectorNote,
        );
      }
    } catch (err: any) {
      logger.error(`[Memory] archiveStaleSessions failed: ${err.message}`);
    }
    return archived;
  }

  /**
   * ★ 9-25 fix-session-summary-silent-failure：补处理 `summary_status='failed'` 的摘要。
   *
   * 窗口起点怎么来：失败行本身只有 `ended_at`（`started_at` 是**整个会话**的首个事件时间，
   * 不是本窗口起点）。所以取该会话中更早的最近一条摘要的 `ended_at` 作为起点；
   * 没有更早的（本会话第一条就失败了）则回退到 ended_at 前 24h。
   *
   * 成功后就地更新原行（`updateSummaryResult`），不会为同一窗口再插一条。
   *
   * @returns 补成功的条数（供调用方判断是否值得记日志）
   */
  async retryFailedSummaries(limit = 10): Promise<number> {
    const failed = this.conversationStore.getFailed(limit);
    if (failed.length === 0) return 0;

    let ok = 0;
    for (const f of failed) {
      try {
        const prevEnd = f.ended_at
          ? this.conversationStore.getPreviousEndedAt(f.session_id, f.ended_at)
          : null;
        const since = prevEnd
          ? new Date(prevEnd)
          : new Date((f.ended_at ? new Date(f.ended_at).getTime() : Date.now()) - 24 * 3600 * 1000);
        if (await this.sessionEndProcessor.retryFailedSummary(f, since)) ok++;
      } catch (err: any) {
        logger.warn(`[Memory] 补处理异常 ${f.id.slice(0, 30)}: ${err?.message ?? err}`);
      }
    }
    return ok;
  }

  /** ★ 8-28 情绪惯性漂移（memory-character-perspective）：生活事件累积 mood_value 驱动
   *  人格自然漂移（连续开心 → playfulness、连续低落 → empathy），走 apply 5 道护栏。
   *  由 LifeService.updateMoodValue 极性跨阈值时调用。 */
  adjustPersonaFromMood(moodValue: number): boolean {
    return this.personaAdapter.adjustFromMood(moodValue);
  }

  /**
   * ★ 2026-10-16（KI-16）：**显式**修复被冲空的人格列，返回被修复的列名。
   *
   * 读路径（`PersonaStore.get()`）**不再**自动把默认值写回库 ——
   * 否则「人格被冲成空」会被整形成一组合法出厂默认值，既骗过数据层也骗过巡检。
   * 因此需要有人**在启动时显式**做一次修复并把结果喊出来；由 `al:persona-seed` 调用。
   */
  repairPersonaDefaults(): string[] {
    return this.personaStore.repairEmptyColumns();
  }

  /** ★ 手动调整人格参数（Web 端滑条/按钮）。
   *  包装 PersonaAdapter.apply()，带护栏（|Δ|≤0.1 / 5min 冷却 / 24h 回归 / 显式 bypass）。
   *  param 格式: "tone.warmth" / "speech_style.emoji_usage" / "emotional_range.empathy" 等。
   *  返回 { applied, newValue } —— applied=false 表示被护栏拦截。 */
  adjustPersona(param: string, delta: number, reason: string = '手动调整'): { applied: boolean; newValue: number | null } {
    const applied = this.personaAdapter.apply({ param, delta, reason });
    // Read the new value after adjustment
    const snapshot = this.getPersonaSnapshot();
    const [category, key] = param.split('.');
    let newValue: number | null = null;
    if (category === 'tone' && key) newValue = (snapshot.tone as any)[key] ?? null;
    else if (category === 'speech_style' && key) newValue = (snapshot.speechStyle as any)[key] ?? null;
    else if (category === 'emotional_range' && key) newValue = (snapshot.emotionalRange as any)[key] ?? null;
    return { applied, newValue };
  }

  /** ★ 8-31 每日反思闭环（life-reflection-loop）——L3 自修改执行器：
   *   LLM 反思（今日事件流+情绪+当前人格）输出 adjustments/insight/reflection，
   *   回写：adjustments 走 5 道护栏调人格参数（delta 钳制 ±0.05，反思是慢变量）、
   *   insight 进**角色画像** character_facts、【关于我】块（见下方 ★ 10-15）、
   *   reflection 存 ai_life_state（WebUI 可读）。
   *   @returns 各回写结果统计 */
  recordReflection(input: { reflection: string; adjustments?: Array<{ param: string; delta: number; reason: string }>; insight?: string }): {
    appliedAdjustments: number; blockedAdjustments: number; insightAdded: boolean; reflectionSaved: boolean;
  } {
    let appliedAdjustments = 0, blockedAdjustments = 0, insightAdded = false, reflectionSaved = false;

    // ① 人格参数调整（护栏内，delta 钳制 ±0.05——反思比实时调整更保守）
    const adjustments = (input.adjustments ?? []).slice(0, 3);
    for (const adj of adjustments) {
      if (!adj?.param || typeof adj.delta !== 'number' || !adj.reason?.trim()) {
        blockedAdjustments++;
        continue;
      }
      const clamped = Math.max(-0.05, Math.min(0.05, adj.delta));
      const result = this.adjustPersona(adj.param, clamped, `反思: ${adj.reason.slice(0, 60)}`);
      if (result.applied) appliedAdjustments++;
      else blockedAdjustments++;
    }

    // ② 洞察进**角色画像**（★ 10-15 fix-reflection-insight-misroute）
    //   LIFE_REFLECTION_PROMPT 要的是「我悟到的一个关于**自己**的事实」（其示例原文
    //   「我其实很享受被需要的时刻」），所以它的家是 character_facts（PromptAssembler 的
    //   【关于我】块），**不是** user_profile.facts。
    //   此前误写用户画像 → 她两个月积累的自我认知既读不到（character_facts 长期 0 条），
    //   又把用户画像污染成"她的自述合集"。
    //   category 也不再硬编码 preference：那是**用户偏好**类目，且 90 天 TTL 对自省语义不对。
    //   取 general（60 天）——自省由每日反思持续重产，短 TTL 不易堆积陈旧自我描述。
    if (input.insight?.trim()) {
      const now = new Date().toISOString();
      insightAdded = this.profileStore.addCharacterFacts([{
        fact: input.insight.trim().slice(0, 100),
        confidence: 0.5,
        evidence: `每日反思 ${now.slice(0, 10)}`,
        source_event: `reflection-${now.slice(0, 10)}`,
        updated_at: now,
        source: 'inferred',
        valid_from: now,
        valid_until: null,
        status: 'active',
        category: 'general',
      }]).length > 0;
    }

    // ③ 反思文本存 ai_life_state（覆盖更新——只保留最新反思）
    if (input.reflection?.trim()) {
      this.lifeStore.updateState({ reflection: input.reflection.trim().slice(0, 300) });
      reflectionSaved = true;
    }

    logger.info(`[Reflection] saved: ${appliedAdjustments} adj applied, ${blockedAdjustments} blocked, insight ${insightAdded ? '+' : '-'}, reflection ${reflectionSaved ? '+' : '-'}`);
    return { appliedAdjustments, blockedAdjustments, insightAdded, reflectionSaved };
  }

  /** ★ 手动触发画像提取（Web 端"提取画像"按钮）。
   *  对指定会话执行 SessionEnd 处理：对话摘要 + LLM 事实提取 + 合并入画像。
   *  返回本次提取到的 facts 数量。 */
  async extractProfile(sessionId: string): Promise<{ factsExtracted: number; summaryGenerated: boolean }> {
    const before = JSON.parse(this.profileStore.get().facts).length;
    const start = Date.now();
    // ★ 2026-10-11 fix-session-end-window：这里原先也不传 `since`，与 onSessionEnd 同病——
    //   一次「提取画像」会把全历史最近 1000 条事件重摘一遍。
    await this.sessionEndProcessor.process(sessionId, this.summaryAnchor(sessionId));
    const after = JSON.parse(this.profileStore.get().facts).length;
    const factsExtracted = Math.max(0, after - before);
    // ★ 9-25 fix-session-summary-silent-failure：**不再恒返回 true**——
    //   摘要失败时该字段一直是 true，Web 端"提取画像"按钮无论成败都报成功。
    //   现在读回刚落库的那条，如实反映。
    const latest = this.conversationStore.getLatestBySession(sessionId);
    const summaryGenerated = !!latest && latest.summary_status !== 'failed' && latest.summary.length > 0;
    logger.info(`[Memory] extractProfile: ${factsExtracted} new facts, summary ${summaryGenerated ? 'ok' : 'FAILED'} (${Date.now() - start}ms)`);
    return {
      factsExtracted,
      summaryGenerated,
    };
  }

  /** ★ 获取会话列表（Web 端会话管理）。
   *  返回最近活跃的会话及其消息数。 */
  // ── 委托任务（project tasks）────────────────────────────────
  //  ★ 2026-10-17（change: `add-project-task-delegation`）。
  //  这几个方法是**纯数据**出入口：路由层与聊天工具都只经它们，
  //  不许自己去碰 DB 句柄（本仓「Web 端接口兼容」硬约束）。
  //  ⚠️ `now` 只为测试注入；生产路径别传。

  /** 建任务（`requestKey` 去重 / 同项目在途 ⇒ `busy`） */
  createProjectTask(input: {
    projectId: string;
    requestKey: string;
    goal: string;
    acceptanceCriteria?: string;
    originSessionId?: string;
    origin?: 'user' | 'delegated' | 'self';
    /** ★ 2026-10-19：`build`（做新东西，走六阶段） / `action`（做一件事，单轮） */
    kind?: 'build' | 'action';
  }): CreateOutcome {
    return this.projectTaskStore.create(input);
  }

  getProjectTask(taskId: string): ProjectTask | null {
    return this.projectTaskStore.get(taskId);
  }

  listProjectTasks(projectId: string, limit = 20): ProjectTask[] {
    return this.projectTaskStore.listByProject(projectId, limit);
  }

  /**
   * ★ 2026-10-19（change: `let-her-query-what-she-made`）：**跨项目**最近的活 + 各状态计数。
   * 给"她现在在忙什么 / 有没有堆着没人管"这类只读看板用。
   */
  listRecentProjectTasks(limit = 10, status?: string): ProjectTask[] {
    return this.projectTaskStore.listRecent(limit, status);
  }

  countProjectTasksByStatus(): Record<string, number> {
    return this.projectTaskStore.countByStatus();
  }

  /** **原子**认领（runner 用）；没有可执行任务时返回 `null`（空闲是常态） */
  claimNextProjectTask(projectId: string): ProjectTask | null {
    return this.projectTaskStore.claimNext(projectId);
  }

  /**
   * 还有活可干的、**最老**的那个项目 id（没有则 `null`）。   *
   * ★ 2026-10-18（真机撞出来的）：runner 原先按项目起服务（`--project alysia-blog`），
   *   新登记的项目**永远没人认领**，任务一路 `queued` 而且**静默**（我实测等了 580 秒）。
   *   改成"一个 runner 服务所有项目"：认领方不指定项目时，由这里决定先做谁的活。
   *   取最老而不是第一个项目，是为了**不饿死**后登记的项目。
   */
  nextQueuedProject(): string | null {
    return this.projectTaskStore.nextQueuedProject();
  }

  /**
   * 推进「做一件东西」的状态机（★ 2026-10-18，change: `make-author-iterate`）。
   *
   * 执行端跑完一个阶段后，服务端**按文件事实**判断能不能进下一阶段；
   * 不能就原地重试（并把原因写进 detail），超过轮次上限就收工成 `needs_review`。
   *
   * ⚠️ `facts` 必须由**文件系统**算出，不能采信模型自述。
   */
  advanceProjectTaskLoop(
    taskId: string,
    facts: LoopFacts,
    opts: { allowPublish: boolean; maxRounds?: number; claimToken?: number },
  ): { decision: LoopDecision; task: ProjectTask | null } | null {
    const task = this.projectTaskStore.get(taskId);
    if (!task) return null;
    const decision = advanceLoop({
      phase: task.phase,
      state: task.loopState,
      facts,
      allowPublish: opts.allowPublish,
      maxRounds: opts.maxRounds,
    });
    // ★ 2026-10-19：带 claimToken ⇒ 只允许**当前认领批次**推进阶段（旧实现无条件 UPDATE，
    //   重放/乱序的 advance 会把阶段推错）
    const updated = this.projectTaskStore.setLoop(
      taskId,
      decision.next,
      decision.state,
      new Date(),
      opts.claimToken,
    );
    if (!updated) return { decision, task: null };
    return { decision, task: updated };
  }

  // ─────────────────────────────────────────────────────────────
  // ★ 2026-10-18（change: `let-her-start-her-own-projects`）：
  //   **她自己发起**做点小东西（生活/闲置活动）。
  //   决策规则在 `self-activity.ts` 的纯函数里；这里只提供它需要的数据 + 一句"她想做什么"。
  // ─────────────────────────────────────────────────────────────

  /** 自发起判定需要的现状（一次查完，避免服务里散着查） */
  projectTaskStats(origin: 'user' | 'delegated' | 'self' = 'self'): {
    hasActive: boolean;
    latestAt: string | null;
  } {
    return {
      hasActive: this.projectTaskStore.hasActiveTask(),
      latestAt: this.projectTaskStore.latestCreatedAtByOrigin(origin),
    };
  }

  /** 某来源在 `since` 之后发起了几个（默认数 `self`） */
  countProjectTasksSince(origin: 'user' | 'delegated' | 'self', sinceIso: string): number {
    return this.projectTaskStore.countByOriginSince(origin, sinceIso);
  }

  /**
   * 让她自己说一句"我想做点什么"（闲置时发起任务前用）。
   *
   * ★ 为什么走人格而不是写死模板：这件事的本质是**她想做**，不是系统派活。
   *   但仍然只给**事实与边界**（能做/不能做的清单），不给"该做得多好多美"。
   *
   * ⚠️ 采样**必须带 `max_tokens`**（KI-1：本仓已因缺上限炸过三次）。
   *
   * @returns 一句她自己写的小目标；失败返回 `null`（调用方**放弃这次**，不要瞎凑）
   */
  async composeSelfActivityIdea(input: {
    projectId: string;
    /** 她最近在做的东西（可选，取材用） */
    recentContext?: string;
  }): Promise<string | null> {
    let personaName = '昔涟';
    try {
      personaName = this.personaStore.get()?.name || '昔涟';
    } catch {
      /* 人设读不到不该挡住 */
    }
    const system = [
      `你叫${personaName}。现在用户不在，你有点空闲，想给自己的工作区里添一个小东西。`,
      '',
      '要求：',
      '- 一两句话，说清**你想做什么**（主题你自己定，比如一个小玩具、一页小东西、一个小工具）。',
      '- **只做纯静态页面**：不许外链（CDN / 外链字体 / 外部图片 / 外部脚本都不行），图形用内联 SVG 或 CSS。',
      '- 规模小：一两个小时能做完，别规划一个大站。',
      '- 不要提"任务""委托""系统"这类词；这是你自己的小念头。',
      '- 不要写成需求文档；像在自言自语地说"我想做……"。',
    ].join('\n');
    const user = [
      `工作区项目：${input.projectId}`,
      input.recentContext ? `\n（最近你在忙的：${input.recentContext.slice(0, 400)}）` : '',
    ].join('\n');

    try {
      const raw = await this.llmService.complete(system, user, {
        // ★ 800 而不是 200：真机第一次用 200 时**返回空串** —— reasoning 把预算吃光、
        //   `content` 为空（就是 KI-1 那个形状：finish=length + 空内容）。
        //   一句"我想做个小东西"给它 800 才稳。
        max_tokens: 800,
        temperature: 0.9,
      } as Partial<SamplingSlot>);
      const text = (raw ?? '')
        .replace(/^```[a-zA-Z]*\s*/g, '')
        .replace(/```$/g, '')
        .replace(/^[「“"']([\s\S]*)[」”"']$/, '$1')
        .trim();
      if (!text) return null;
      return text.length > 300 ? `${text.slice(0, 300)}…` : text;
    } catch (err: any) {
      logger.warn(`[SelfActivity] 生成"想做什么"失败：${err?.message ?? err}`);
      return null;
    }
  }

  /** runner 回传结果；不在 `running` 的任务不接受（迟到的回传不许覆盖） */
  submitProjectTaskResult(taskId: string, input: SubmitResultInput): ProjectTask | null {
    return this.projectTaskStore.submitResult(taskId, input);
  }

  // ─────────────────────────────────────────────────────────────
  // ★ 2026-10-19（change: `wake-her-on-task-result`）：结果事件 outbox
  //   「她做完了一轮」与「她知道自己做完了」之间靠它连接：
  //   终态入队 → 调度器领取 → 跑一轮主 Agent → ack。全程落库，重启不丢。
  // ─────────────────────────────────────────────────────────────

  /** 入队一条结果事件（幂等：同 `eventId` 只入一次） */
  enqueueProjectTaskEvent(
    input: EnqueueEventInput,
  ): { created: boolean; event: ProjectTaskEvent | null } {
    return this.projectTaskEventStore.enqueue(input);
  }

  /** **原子**领一条待投递事件；没有则 `null`（空闲是常态） */
  claimNextProjectTaskEvent(): ProjectTaskEvent | null {
    return this.projectTaskEventStore.claimNext();
  }

  /** 投递成功 → ack */
  finishProjectTaskEvent(eventId: string): boolean {
    return this.projectTaskEventStore.finish(eventId);
  }

  /** 投递失败 → 退避重试（用尽 → dead，响亮地停） */
  failProjectTaskEvent(eventId: string, error: string): ProjectTaskEvent | null {
    return this.projectTaskEventStore.fail(eventId, error);
  }

  getProjectTaskEvent(eventId: string): ProjectTaskEvent | null {
    return this.projectTaskEventStore.get(eventId);
  }

  listProjectTaskEvents(taskId: string): ProjectTaskEvent[] {
    return this.projectTaskEventStore.listByTask(taskId);
  }

  countProjectTaskEventsByStatus(): Record<string, number> {
    return this.projectTaskEventStore.countByStatus();
  }

  /**
   * **验收**（她看过结果之后做的决定）。
   *
   * ⚠️ 与 `submitProjectTaskResult` 的分工：那个是**执行方**写「跑完了」，
   *   这个是**她**写「我认了」。`completed` 只表示后者，与发布无关。
   */
  acceptProjectTask(
    taskId: string,
    input: { revision: number; by: string; note?: string },
  ): { task: ProjectTask | null; accepted: boolean; reason?: string } {
    // ★ 2026-10-19：`subagentWake.autoAccept=false` ⇒ 验收留给人（她只能汇报/返工/问）
    if (!this.acceptEnabled) {
      return {
        task: this.projectTaskStore.get(taskId),
        accepted: false,
        reason: '自动验收现在关着（配置 subagentWake.autoAccept=false）—— 让他自己看过再说',
      };
    }
    return this.projectTaskStore.acceptResult(taskId, input);
  }

  /** 开关：是否允许主 Agent 自己验收（默认开） */
  setAcceptEnabled(enabled: boolean): void {
    this.acceptEnabled = enabled;
  }

  /** 标记结果已发出（QQ 回复成功之后调；去重闸） */
  markProjectTaskNotified(taskId: string): void {
    this.projectTaskStore.markNotified(taskId);
  }

  /** 该任务已经返工过几轮（自动返工上限按它算） */
  projectTaskReworkCount(taskId: string): number {
    return this.projectTaskStore.reworkCount(taskId);
  }

  /** 追加修改意见 ⇒ 新 revision、回 `queued`、**沿用同一个工程会话** */
  addProjectTaskRevision(taskId: string, feedback: string, fromEventId?: string): ProjectTask | null {
    return this.projectTaskStore.addRevision(taskId, feedback, new Date(), { fromEventId });
  }

  /**
   * 把委托任务的**结果**记回发起它的那个聊天会话（★ 2026-10-18，change: `return-project-task-result`）。
   *
   * ★ 为什么要有这一步（这是"最后两米"里更重要的那一米）：
   *   委托会话的事件被**整段排除**在记忆外（见 `dsh-adapter` §2.5.2），
   *   于是「她做过」不会变成「她记得做过」——每次委托都像一次失忆的打工。
   *   本方法写的是一条**类型化的结果记录**（不是原始对话），补上这个缺口。
   *
   * 落成什么样：原会话里一条 `role: 'assistant'` 的事件，带 `skip_profile` + `synthetic`：
   *   - **进** `getRecentMessages`（她下一轮就能在「最近对话」里看到"我做过这件事"）
   *   - **不进**画像 / 人格 / 嵌入（`skip_profile`）——不让它污染对她的认知
   *   - **不进**摘要（`synthetic`）——v1 只保证近期可回忆；要长期记住得另立 change
   *
   * ⚠️ **幂等**：事件 id = `project-task:<taskId>:r<revision>`，
   *   同一条结果重复回传只会命中既有 id（`EventStore.insert` 同 id 同内容 = 空转）。
   *
   * @returns 是否写入（`originSessionId` 为空/非法时返回 false —— **不猜**目标会话）
   */
  /**
   * 让**她自己**说这句话：把机械的结果状态，用她的人格与口吻重说一遍。
   *
   * ★ 2026-10-18（change: `return-project-task-result`），用户原话：
   *   「返回的东西要过一遍提示词不，感觉好干啊，而且没有昔涟的味道」。
   *
   * ★ 为什么必须走人格：那条回执是 `role: 'assistant'` —— 它以**她说过的话**的身份
   *   进她的对话史。模板腔放进去，等于让她的记忆里留着一句她绝不会说的话。
   *
   * ⚠️ **采样必须带 `max_tokens`**（KI-1 的教训：无上限的槽已经炸过三次 ——
   *   会话摘要 22 天 / 每日反思 11 次 / 画像提取 6 个月）。
   *
   * @returns 一句话；模型失败时返回 **`null`**（调用方回落模板 —— 干，但诚实）
   */
  async composeProjectTaskNotice(input: {
    projectId: string;
    revision: number;
    status: string;
    summary?: string;
    artifacts?: unknown[] | null;
    publicUrl?: string;
    /** ★ 2026-10-18（补）：通知也要有"她跟这个人怎么说话"的上下文 */
    originSessionId?: string;
    /** ★ 2026-10-18（补）：她自己写的「哪里像我」 */
    selfStatement?: string;
  }): Promise<string | null> {
    let personaName: string | undefined;
    try {
      personaName = this.personaStore.get()?.name;
    } catch {
      personaName = undefined; // 人设读不到不该挡住通知
    }

    // ★ 与聊天回复同样的上下文：最近对话（24h 窗口，取 10 条足够找回语气）
    let recentDialogue: string | undefined;
    if (input.originSessionId) {
      try {
        recentDialogue = this.getRecentDialogueBlock(input.originSessionId, 10) || undefined;
      } catch {
        recentDialogue = undefined; // 读不到就当没有，别挡住通知
      }
    }

    const { system, user } = buildNoticePrompts({ ...input, personaName, recentDialogue });
    try {
      const raw = await this.llmService.complete(system, user, {
        max_tokens: MAX_NOTICE_CHARS * 2,
        temperature: 0.85,
      } as Partial<SamplingSlot>);
      const text = finalizeNotice(raw, input.publicUrl ?? '');
      if (!text) return null;
      return text;
    } catch (err: any) {
      logger.warn(`[ProjectTask] 通知措辞生成失败（回落模板）：${err?.message ?? err}`);
      return null;
    }
  }

  
  /**
   * ⚠️ 2026-10-19 删除：`composeWatchdogNotice()`。
   *
   * 第一版让看门狗**生成一段话推给用户**，用户当场否掉了：
   * 「这个不是推送给我的，是告诉昔涟让她自行决策或者来找我商量的吧，
   * 不要太多专业名词和上面数字，很奇怪啊」。
   *
   * 现在的形态：看门狗只把**一句人话**放进 `self-notice` 清单，
   * 由 `PromptAssembler` 在她下一次说话时注入 `[你刚注意到的事]` ——
   * **她**决定要不要处理、要不要开口、用什么话说。所以这里不再需要"代她写话"。
   */

  async recordProjectTaskResult(input: {
    taskId: string;
    projectId: string;
    revision: number;
    status: string;
    /** 发起任务的聊天会话；空/非法 ⇒ 不写（宁可不记，也不往错误的会话里写） */
    originSessionId: string;
    dshSessionId?: string | null;
    /** 执行端最后一段话（已截断） */
    summary?: string;
    /** 产物（工作区相对路径） */
    artifacts?: unknown[] | null;
    /** 该项目的对外地址（随回执给她 —— 她会用它回答"给我链接"） */
    publicUrl?: string;
    /**
     * ~~她自己的措辞~~ —— **已废弃**（2026-10-18，change: `attribute-engine-receipts`）。
     *
     * 保留字段只为不破坏既有调用；**不再写进正文**。
     * 理由：那条事件不再是"她说的话"（`role: 'engine'`），借她的口吻就是伪造归属。
     * 她的口吻现在只用于 **QQ 推送**（那时真的是她在对用户说话）。
     */
    notice?: string;
  }): Promise<boolean> {
    // 事件形状（幂等 id / 三个标记位 / 正文措辞）在纯函数里，测试直接钉它
    const event = buildProjectTaskResultEvent(input);
    if (!event) {
      logger.warn(`[ProjectTask] ${input.taskId} 没有 originSessionId —— 结果无处可记（不猜会话）`);
      return false;
    }

    try {
      await this.ingest(event);
      logger.info(
        `[ProjectTask] 结果已记回原会话 ${event.session_id}（${input.taskId} r${input.revision} → ${input.status}）`,
      );
      return true;
    } catch (err: any) {
      // 记不进去不能反过来把任务判失败 —— 结果本身是好的
      logger.warn(`[ProjectTask] 结果记回失败（${input.taskId}）：${err?.message ?? err}`);
      return false;
    }
  }

  /** ★ 2026-10-20（change: guard-session-extract-endpoint；KI-18）：某会话的**事件条数**。
   *  只读、纯数据（「Web 端接口兼容」硬约束）。
   *
   *  **为什么要暴露它**：`POST /api/sessions/:id/extract` 此前对 id 不设防，且会话不存在时
   *  `extractProfile` 返回 `{factsExtracted:0, summaryGenerated:false}` —— 一个**成功形状的空转**，
   *  Web 端分不清「这个会话很干净」和「这个会话根本不存在」。
   *  判据刻意取「有没有事件」而不是「有没有产出新事实」：后者是结算的**结果**，不能当入口判据
   *  （否则「干净但真实」的会话会被判成不存在）。 */
  /** ★ 2026-10-20（change: tie-intimacy-to-speech）：**最后一条真人消息**的时间（ISO）。
   *  只读、纯数据。亲密度档位用它算 idle（⚠️ 已排除 `skip_profile`/`synthetic` 机器注入，
   *  详见 `EventStore.getLastUserMessageAt` 的三条排除）。
   *  **禁止**改用 `ai_life_state.updated_at` / 任何 assistant 侧写入当判据 ——
   *  那些每次推送都会刷新，算出来永远是"刚联系过"。 */
  getLastUserMessageAt(): string | null {
    return this.eventStore.getLastUserMessageAt();
  }

  countSessionEvents(sessionId: string): number {
    return this.eventStore.countBySession(sessionId);
  }

  listSessions(limit: number = 20): Array<{ sessionId: string; messageCount: number; lastActive: string }> {
    const sessions = this.eventStore.listSessions(limit);
    return sessions.map(s => ({
      sessionId: s.session_id,
      messageCount: s.count,
      lastActive: s.last_active,
    }));
  }

  /** ★ 获取当前画像快照（Web 端画像展示）。 */
  getProfileSnapshot(opts: { includeSuperseded?: boolean } = {}): {
    facts: Array<{ fact: string; confidence: number; source: string; status: string; updatedAt: string; validFrom: string; category: string }>;
    characterFacts: Array<{ fact: string; confidence: number; source: string; status: string; updatedAt: string; validFrom: string; category: string }>;
    basics: string;
    preferences: string;
  } {
    const profile = this.profileStore.get();
    // ★ 8-28 时间 + 分类透出（profile-facts-timestamps / classification）：Web 画像页展示时间列与分类
    const toView = (f: { fact: string; confidence: number; source: string; status: string; updated_at?: string; valid_from?: string; category?: string }) => ({
      fact: f.fact,
      confidence: f.confidence,
      source: f.source,
      status: f.status,
      updatedAt: f.updated_at ?? '',
      validFrom: f.valid_from ?? '',
      category: f.category ?? 'general',
    });
    const facts = (JSON.parse(profile.facts) as Parameters<typeof toView>[0][])
      // ★ 2026-10-16：默认仍过滤 superseded（画像展示只要"她现在相信的"）；
      //   但**记忆纠正页需要看到"被作废的"** —— 否则用户没法确认"旧事实真的失效了"。
      .filter(f => opts.includeSuperseded || f.status !== 'superseded')
      .map(toView);
    // ★ 8-28 角色事实（memory-character-perspective）：昔涟自己的事，Web 画像页并列展示
    const characterFacts = (JSON.parse(profile.character_facts || '[]') as Parameters<typeof toView>[0][])
      .filter(f => opts.includeSuperseded || f.status !== 'superseded')
      .map(toView);
    return {
      facts,
      characterFacts,
      basics: profile.basics,
      preferences: profile.preferences,
    };
  }

  // ===== ★ 8-28 过期确认（profile-facts-classification-confirm）=====

  /** 待确认事实：过期 ≤3 天的 active 事实（先清理超窗事实）。昔涟对话中可自然询问。 */
  listPendingConfirmFacts(): Array<{ factId: string; fact: string; validFrom: string; category: string }> {
    try {
      return this.profileStore.listPendingConfirmFacts();
    } catch (err: any) {
      logger.warn(`[Profile] pending confirm list failed: ${err.message}`);
      return [];
    }
  }

  /** 确认事实：stillValid=true → 按分类续期；false → superseded（不删除，留审计链）。
   *  factId 为事实完整文本（工具/LLM 传原文），内部归一化匹配 */
  confirmProfileFact(factId: string, stillValid: boolean): boolean {
    try {
      const key = this.profileStore.factKeyOf(factId);
      const ok = this.profileStore.confirmFact(key, stillValid);
      if (ok) logger.info(`[Profile] fact confirmed: still_valid=${stillValid} (${factId.slice(0, 30)})`);
      return ok;
    } catch (err: any) {
      logger.warn(`[Profile] fact confirm failed: ${err.message}`);
      return false;
    }
  }

  /**
   * ★ 手动纠正一条**用户事实**：让旧的失效，并写入新的（`source: 'user'`）。
   *
   * ★ 为什么不能只 `addFacts([新])`：冲突检测是按 `normalizeKey` 的**文本相似**做的，
   *   而「用户在长沙」→「用户在上海」两条**并不相似** ⇒ 不会相互 supersede
   *   ⇒ **两条同时 active** ⇒ 召回会同时拿到，用户看到的是**自相矛盾的她**。
   *   所以「纠正」必须显式做两步，且**先失效旧、再写新**。
   *
   * `source: 'user'` 是关键：`ProfileStore` 的既有规则是
   * 「用户主动声明不可被 inferred 覆盖」，所以手动纠正**不会被后续 LLM 提取顶掉**。
   *
   * ⚠️ 首版**只支持用户事实**（`facts`）。角色事实（`character_facts`）当前只读 ——
   *   `ProfileStore` 没有按 key supersede 角色事实的方法，那需要单独加（见 change 记录）。
   *
   * @returns `superseded`：旧事实是否真的被找到了并失效（false = 没找到，但新事实仍会写入）
   */
  correctProfileFact(oldFact: string, newFact: string): { superseded: boolean; added: boolean } {
    const text = newFact.trim();
    if (!text) throw new Error('新事实不能为空');
    const now = new Date().toISOString();

    const superseded = this.profileStore.confirmFact(this.profileStore.factKeyOf(oldFact), false);
    const added = this.profileStore.addFacts([{
      fact: text,
      confidence: 1.0,
      evidence: `用户手动纠正「${oldFact}」`,
      source_event: 'manual-correction',
      updated_at: now,
      source: 'user',
      valid_from: now,
      valid_until: null,
      status: 'active',
      category: 'general',
    } as ProfileFact]).length > 0;

    logger.info(
      `[Profile] 手动纠正：superseded=${superseded} added=${added}（${text.slice(0, 30)}）`,
    );
    return { superseded, added };
  }

  /** ★ 获取人格快照（Web 端人格状态展示）。 */
  getPersonaSnapshot(): { name: string; tone: Record<string, number>; speechStyle: Record<string, number>; emotionalRange: Record<string, number>; memoryConfig: MemoryConfig; overlayNotes: Array<{ dimension: string; change: string; evidence: string; appliedAt: string }> } {
    const persona = this.personaStore.get();
    const memoryConfig = this.personaStore.getMemoryConfig();
    return {
      name: persona.name,
      tone: JSON.parse(persona.tone),
      speechStyle: JSON.parse(persona.speech_style),
      emotionalRange: JSON.parse(persona.emotional_range),
      memoryConfig,
      // ★ 8-29 Overlay（persona-overlay-perspective）：证据门槛固化的稳定演化
      overlayNotes: this.personaStore.getOverlayNotes(),
    };
  }

  async cron(): Promise<void> {
    logger.info('[Memory] cron: deep profile rewrite + cleanup start');
    const start = Date.now();
    try {
      await this.cronProcessor.process();
      logger.info(`[Memory] cron done (${Date.now() - start}ms)`);
    } catch (err: any) {
      logger.error(`[Memory] cron failed: ${err.message}`);
      throw err;
    }
  }

  // ===== ★ 知识库（Web 端接口预留）=====

  /** 导入知识文档（文本）。hash 去重，分块存储。 */
  async importKnowledge(input: {
    title: string;
    content: string;
    source?: 'imported' | 'url' | 'note' | 'generated';
  }): Promise<{ docId: string; chunks: number; deduplicated: boolean }> {
    const source = input.source ?? 'imported';
    const content = input.content.trim();
    if (!content) throw new Error('Knowledge content is empty');

    // 1. Hash 去重
    const hash = createHash('sha256').update(input.title + content).digest('hex');
    const existing = this.knowledgeStore.getByHash(hash);
    if (existing) {
      // ★ 2026-10-16（KI-13）：**hash 命中不等于完整**。
      //   旧实现直接 `return { chunks: existing.chunk_count, deduplicated: true }`，
      //   把一颗"上次半途失败"的残行当成了事实 —— 返回**从未兑现的块数**并宣布已导入。
      //   现在必须核对：① 状态仍是 active（归档的不算已导入）；
      //   ② 实际块数与声明块数一致。
      const actual = this.knowledgeStore.getChunksByDoc(existing.id).length;
      const complete = existing.status === 'active' && actual > 0 && actual === existing.chunk_count;
      if (complete) {
        return { docId: existing.id, chunks: existing.chunk_count, deduplicated: true };
      }
      logger.warn(
        `[Knowledge] hash 命中但文档**不完整**（status=${existing.status}，` +
        `chunk_count=${existing.chunk_count}，实存=${actual}）→ 清掉残壳并重新导入 ${existing.id}`,
      );
      // 残壳彻底清掉再重建（docId 由 hash 决定 → 向量 id 不变，重建时会被覆盖）
      this.knowledgeStore.deleteDoc(existing.id);
    }

    // 2. 分块
    const chunks = chunkText(content);
    const now = new Date().toISOString();
    const docId = `kb-${hash.slice(0, 16)}`;

    // 3. 事务内落 doc + 全部 chunk（★ KI-13：中途失败不留残壳）
    const doc: KnowledgeDoc = {
      id: docId,
      title: input.title,
      source,
      file_path: null,
      content_hash: hash,
      // 占位：真实值由 `insertDocWithChunks` 在事务内用**实到块数**回填 ——
      // KI-13 的要点就是**不许先声明一个尚未兑现的块数**。
      chunk_count: 0,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    const storedChunks = this.knowledgeStore.insertDocWithChunks(doc, chunks);

    // 4. 向量化（**不在**事务内：另一条链路，失败不阻塞文本检索；KI-15 逐 chunk 留痕）
    // ★ KI-15：没有向量库时**不再静默** —— 逐 chunk 报会刷屏，故末尾报总账
    let vectorsSkipped = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (this.vectorStore) {
        try {
          const vector = await this.embedService.embed(chunks[i]);
          await this.vectorStore.insert(`chunk_${docId}_${i}`, vector, chunks[i], {
            source: 'knowledge',
            doc_id: docId,
            chunk_index: i,
          });
        } catch (err: any) {
          logger.warn(`[Knowledge] chunk embed failed (${docId} #${i}): ${err.message}`);
        }
      } else {
        vectorsSkipped++;
      }
    }
    if (vectorsSkipped > 0) {
      logger.warn(
        `[Knowledge] 没有向量库：${vectorsSkipped}/${chunks.length} 个 chunk **只进了文本检索**` +
        `（向量检索取不到它们，导入返回的 chunks 数不代表已被向量化）`,
      );
    }

    return { docId, chunks: storedChunks, deduplicated: false };
  }

  /** 知识文档列表（Web 展示） */
  listKnowledgeDocs(): Array<{ id: string; title: string; source: string; chunkCount: number; createdAt: string; status: string }> {
    return this.knowledgeStore.listActive().map(d => ({
      id: d.id,
      title: d.title,
      source: d.source,
      chunkCount: d.chunk_count,
      createdAt: d.created_at,
      status: d.status,
    }));
  }

  /** 归档知识文档（软删除） */
  archiveKnowledgeDoc(docId: string): void {
    this.knowledgeStore.archive(docId);
  }

  /** 彻底删除知识文档 + chunks（★ 8-29 cr-p0-delete-cleanup：同步清理向量） */
  async deleteKnowledgeDoc(docId: string): Promise<void> {
    // 先取 chunk ids（deleteDoc 后 chunks 表已清）
    const chunkIds = (this.db.prepare('SELECT id FROM knowledge_chunks WHERE doc_id = ?').all(docId) as any[]).map(r => r.id as string);
    this.knowledgeStore.deleteDoc(docId);
    if (this.vectorStore) {
      const results = await Promise.allSettled(chunkIds.map(id => this.vectorStore!.delete(id)));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) logger.warn(`[Knowledge] vector cleanup ${failed}/${chunkIds.length} failed for doc ${docId}`);
    }
  }

  // ===== ★ 角色系统（v3）=====

  /** 当前激活角色 ID */
  getActiveRoleId(): string {
    return this.personaStore.get().role ?? 'alysia';
  }

  /** ★ 获取激活角色摘要（Web 端角色切换展示）。
   *  返回 { role, name, systemPromptPreview }。 */
  getActiveRole(): { role: string; name: string; systemPromptPreview: string } {
    const p = this.personaStore.get();
    const prompt = p.system_prompt || '';
    return {
      role: p.role ?? 'alysia',
      name: p.name,
      systemPromptPreview: prompt.slice(0, 100) + (prompt.length > 100 ? '…' : ''),
    };
  }

  /** ★ 表情包列表：当前激活角色的 image 类型世界书条目（send_sticker 工具用） */
  listStickers(): Array<{ name: string; path: string }> {
    const role = this.getActiveRoleId();
    const rows = this.db.prepare(
      "SELECT trigger_keys, content FROM worldbook_entries WHERE role = ? AND content_type = 'image' ORDER BY priority DESC"
    ).all(role) as Array<{ trigger_keys: string; content: string }>;
    return rows.map(r => {
      let keys: string[] = [];
      try { keys = JSON.parse(r.trigger_keys); } catch { /* ignore */ }
      return { name: keys[0] || 'sticker', path: r.content };
    });
  }

  /** ★ 按名称查找表情包（触发词匹配） */
  findSticker(name: string): { content: string } | null {
    const role = this.getActiveRoleId();
    const row = this.db.prepare(
      "SELECT content FROM worldbook_entries WHERE role = ? AND content_type = 'image' AND trigger_keys LIKE ? LIMIT 1"
    ).get(role, `%${name}%`) as { content: string } | undefined;
    return row ?? null;
  }

  /** 角色列表（Web 展示） */
  listRoles(): Array<{ role: string; name: string; isActive: boolean; worldbookCount: number }> {
    const roles = this.personaStore.listAll();
    return roles.map(r => {
      const count = this.db.prepare('SELECT COUNT(*) as c FROM worldbook_entries WHERE role = ?').get(r.role) as { c: number };
      return { ...r, worldbookCount: count.c };
    });
  }

  /** 切换激活角色 */
  switchRole(roleId: string): { ok: boolean; reason?: string } {
    const ok = this.personaStore.setActive(roleId);
    if (!ok) return { ok: false, reason: `角色 ${roleId} 不存在` };
    return { ok: true };
  }

  /** 导入角色包（JSON）→ persona 行 + worldbook 条目 */
  importRole(pkg: RolePackage): { role: string; worldbookCount: number } {
    if (!pkg.role || !pkg.name) throw new Error('角色包缺少 role 或 name');
    const now = new Date().toISOString();

    // 1. Persona 行（upsert）
    //
    // ★★ 2026-10-01 fix-role-import-wipes-persona：**按字段合并，不用空默认值覆盖**。
    //
    //   `upsertRole` 是整行 UPDATE，而旧代码对包没提供的字段一律填空默认
    //   （`pkg.system_prompt ?? ''` / `pkg.persona?.tone ?? {}`）。
    //   后果：表情包角色包（`data/roles/stickers*.json`，role 同为 `'alysia'`，
    //   只有 worldbook 没有 persona）在**每次启动**把昔涟的整行 persona 冲掉——
    //   包括人格核心 `system_prompt`。
    //
    //   `tone` 等列之所以看着正常，是 `PersonaStore.get()` 检测到空值会自动填回
    //   结构默认值（那是默认参数，不是她的真实调校）；`system_prompt` 没有兜底，
    //   所以只有它表现出「空」。**整行都在被冲，只是只有它露馅。**
    //
    //   与 `docs/dsh-migration-guide.md` 坑 #7 同族（那次修的是世界书那半）。
    const existing = this.personaStore.getByRole(pkg.role);
    /** 包提供了就用包的；否则保留已有；都没有才落默认 */
    const merge = <T>(fromPkg: T | undefined, current: string | undefined, fallback: string): string =>
      fromPkg !== undefined ? JSON.stringify(fromPkg) : (current ?? fallback);

    this.personaStore.upsertRole({
      role: pkg.role,
      name: pkg.name,
      tone: merge(pkg.persona?.tone, existing?.tone, '{}'),
      speech_style: merge(pkg.persona?.speech_style, existing?.speech_style, '{}'),
      emotional_range: merge(pkg.persona?.emotional_range, existing?.emotional_range, '{}'),
      memory_config: merge(pkg.persona?.memory_config, existing?.memory_config, JSON.stringify(DEFAULT_MEMORY_CONFIG)),
      // system_prompt 是普通字符串（不是 JSON），单独处理
      system_prompt: pkg.system_prompt ?? existing?.system_prompt ?? '',
      is_active: pkg.activate ?? false,
    });

    // 2. Worldbook 条目（幂等替换：只删"本次包生成的 id"，不动同 role 的其他来源——
    //   seed 世界书(66 条)与自写条目(sourse=self)都挂 role='alysia'，
    //   原 DELETE WHERE role=? 会把它们误删，表情包角色包曾把全部文本设定清空）
    const newIds = (pkg.worldbook ?? []).map((entry) => {
      const keys = Array.isArray(entry.trigger_keys) ? JSON.stringify(entry.trigger_keys) : entry.trigger_keys;
      return `wb_${pkg.role}_${this.hashStr(keys + entry.content)}`;
    });
    // ★ 8-27 digest 保留（worldbook-digest-summary）：seed 幂等重建 delete+insert 会清空
    //   已生成的简介（digest-worldbook.ts 多轮 digest 被 seed 重置的根因）。
    //   必须在 delete **之前**缓存旧 digest——delete 后再 SELECT 恒为 NULL
    const oldDigests = new Map<string, string | null>();
    for (const id of newIds) {
      const row = this.db.prepare('SELECT digest FROM worldbook_entries WHERE id = ?').get(id) as { digest: string | null } | undefined;
      oldDigests.set(id, row?.digest ?? null);
    }
    for (const id of newIds) {
      this.worldbookStore.deleteEntry(id);
    }
    let count = 0;
    for (const entry of pkg.worldbook ?? []) {
      const keys = Array.isArray(entry.trigger_keys) ? JSON.stringify(entry.trigger_keys) : entry.trigger_keys;
      const id = `wb_${pkg.role}_${this.hashStr(keys + entry.content)}`;
      this.worldbookStore.insert({
        id,
        trigger_keys: keys,
        trigger_mode: entry.trigger_mode ?? 'any',
        content: entry.content,
        scope: entry.scope ?? 'chat',
        priority: entry.priority ?? 5,
        cooldown_sec: entry.cooldown_sec ?? 300,
        last_triggered: null,
        hit_count: 0,
        created_at: now,
        updated_at: now,
        role: pkg.role,
        content_type: entry.content_type ?? 'text',
        digest: oldDigests.get(id) ?? null,
      });
      count++;
    }

    // 3. 激活首个导入角色（如果指定 activate 或当前无激活角色）
    if (pkg.activate) this.personaStore.setActive(pkg.role);

    return { role: pkg.role, worldbookCount: count };
  }

  /** 导出角色包（Web 下载） */
  exportRole(roleId: string): RolePackage | null {
    const persona = this.personaStore.getByRole(roleId);
    if (!persona) return null;
    const wbRows = this.db.prepare('SELECT * FROM worldbook_entries WHERE role = ?').all(roleId) as Array<{ trigger_keys: string; trigger_mode: string; content: string; scope: string; priority: number; cooldown_sec: number; content_type: string }>;
    return {
      role: roleId,
      name: persona.name,
      version: 1,
      system_prompt: persona.system_prompt,
      persona: {
        tone: JSON.parse(persona.tone),
        speech_style: JSON.parse(persona.speech_style),
        emotional_range: JSON.parse(persona.emotional_range),
        memory_config: JSON.parse(persona.memory_config),
      },
      worldbook: wbRows.map(w => ({
        trigger_keys: JSON.parse(w.trigger_keys) as string[],
        trigger_mode: w.trigger_mode as 'any' | 'all' | 'regex',
        content: w.content,
        scope: w.scope as 'chat' | 'code' | 'both',
        priority: w.priority,
        cooldown_sec: w.cooldown_sec,
        content_type: w.content_type as 'text' | 'image' | 'sticker',
      })),
    };
  }

  /** 获取激活角色的 system_prompt（LLMAgentStage 使用，替代读 md 文件） */
  getActiveSystemPrompt(): string {
    return this.personaStore.get().system_prompt || '';
  }

  /**
   * 人设的**紧凑形式**：只取前 N 节，丢掉 worldbook 类的大段设定。
   *
   * ★ 2026-10-01（change: connect-dsh-alysia-bridge）：从 `LLMAgentStage` 里
   *   的一句内联表达式提出来。提出来的理由不是「好看」，是**只能有一处定义**——
   *   dsh 侧的动态人设（`GET /api/persona/prompt`）必须和聊天管线取到同一份文本，
   *   否则她在 dsh 里和 QQ 里会是两个人。
   *
   *   原注释：worldbook 66 条约 15k 字符，全量注入会吃光 context。
   *
   * @param sections 保留前几节（默认 4，与管线历史行为一致）
   */
  getCompactPersonaPrompt(sections: number = 4): string {
    return this.getActiveSystemPrompt().split('\n---\n').slice(0, sections).join('\n---\n');
  }

  private hashStr(s: string): string {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }
}

// ── 角色包类型 ──────────────────────────────────────────

export interface RolePackage {
  role: string;
  name: string;
  version?: number;
  system_prompt?: string;
  persona?: {
    tone: Record<string, number>;
    speech_style: Record<string, number>;
    emotional_range: Record<string, number>;
    memory_config?: MemoryConfig;
  };
  worldbook?: Array<{
    trigger_keys: string[];
    trigger_mode?: 'any' | 'all' | 'regex';
    content: string;
    scope?: 'chat' | 'code' | 'both';
    priority?: number;
    cooldown_sec?: number;
    /** ★ 8-12/8-27：'text'(设定) | 'life_event'(生活化种子) | 'image' | 'sticker'（表情包素材） */
    content_type?: 'text' | 'life_event' | 'image' | 'sticker';
  }>;
  /** 导入后是否立即激活 */
  activate?: boolean;
}
