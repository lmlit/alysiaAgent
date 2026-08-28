// src/memory/MemoryManager.ts
// Unified facade that wires all stores, engines, processors, and PromptAssembler.
import type Database from 'better-sqlite3';
import { EventStore } from './stores/EventStore.js';
import { ProfileStore } from './stores/ProfileStore.js';
import { PersonaStore } from './stores/PersonaStore.js';
import { ConversationStore } from './stores/ConversationStore.js';
import { KnowledgeStore } from './stores/KnowledgeStore.js';
import { WorldbookStore } from './stores/WorldbookStore.js';
import { CodeContextStore } from './stores/CodeContextStore.js';
import { LifeStore } from './stores/LifeStore.js';
import type { LifeEvent } from './stores/LifeStore.js';
import { WorldbookMatcher } from './engines/WorldbookMatcher.js';
import { PersonaAdapter } from './engines/PersonaAdapter.js';
import { ProfileExtractor } from './engines/ProfileExtractor.js';
import { RealtimeProcessor } from './processors/RealtimeProcessor.js';
import { SessionEndProcessor } from './processors/SessionEndProcessor.js';
import { CronProcessor } from './processors/CronProcessor.js';
import { PromptAssembler } from './PromptAssembler.js';
import { filterPII } from './PIIFilter.js';
import { logger } from '../utils/logger.js';
import { formatLocalTime, localDateKey, localDateKeyFromISO } from '../utils/time.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import type { MemoryEvent, MemoryReadRequest, MemoryReadResult, MemoryConfig, KnowledgeDoc, SearchResult, WorldbookEntry } from './types.js';
import { DEFAULT_MEMORY_CONFIG, FACT_CONFIRM_WINDOW_MS } from './types.js';
import type { IVectorStore } from './interfaces/IVectorStore.js';
import type { IEmbedService } from './interfaces/IEmbedService.js';
import type { ILLMService } from './interfaces/ILLMService.js';
import type { SamplingConfig, SamplingSlot } from '../provider/sampling.js';

// ── 知识库分块参数（参考 AstrBot：chunk 512 / overlap 50）──
const KB_CHUNK_SIZE = 500;
const KB_CHUNK_OVERLAP = 50;

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
    /** ★ 8-10 采样配置（sampling-config-unify）：按 engine 场景绑定槽位 */
    private sampling?: SamplingConfig,
  ) {
    this.eventStore = new EventStore(db, vectorStore);
    this.profileStore = new ProfileStore(db);
    this.personaStore = new PersonaStore(db);
    this.conversationStore = new ConversationStore(db, vectorStore);
    this.knowledgeStore = new KnowledgeStore(db, vectorStore);
    this.worldbookStore = new WorldbookStore(db);
    this.codeContextStore = new CodeContextStore(db);
    this.lifeStore = new LifeStore(db);

    // ★ 8-10 slotify：把同一定时任务/画像类调用绑定到对应采样槽位
    const slotify = (slot?: Partial<SamplingSlot>): ILLMService => ({
      complete: (sys, usr) => this.llmService.complete(sys, usr, slot),
    });
    const profileLlm = slotify(this.sampling?.profile?.extract);
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
      this.profileStore, this.profileExtractor, profileLlm, this.vectorStore,
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
    } catch { /* ignore load errors */ }
  }

  private saveTokenStats(): void {
    if (this.tokenStatsSaveTimer) return;
    this.tokenStatsSaveTimer = setTimeout(() => {
      this.tokenStatsSaveTimer = null;
      try {
        writeFileSync(TOKEN_STATS_FILE, JSON.stringify(Object.fromEntries(this.tokenStats)));
      } catch { /* ignore save errors */ }
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

  /** ★ 8-15 WebUI 会话删除（彻底）：清空该会话的事件流与摘要（用户主动删除,日志留痕） */
  deleteSession(sessionId: string): boolean {
    const origin = sessionId.startsWith('webui:private:') ? sessionId : `webui:private:${sessionId}`;
    const before = (this.db.prepare('SELECT COUNT(*) c FROM events WHERE session_id = ?').get(origin) as any)?.c ?? 0;
    this.eventStore.deleteBySession(origin);
    this.conversationStore.deleteBySession(origin);
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
        return `${time} ${r.role === 'user' ? '你' : '昔涟'}: ${r.content}`;
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
    } catch {
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
   *  ★ 8-27 扩展 origin（'regular' | 'followup' 对话余波） */
  recordLifeEvent(input: { type: 'chat' | 'internal'; content: string; moodDelta?: string; referenceEventId?: string; wbEntryId?: string; origin?: 'regular' | 'followup' }): string {
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
      this.embedService.embed(input.content)
        .then(vector => this.vectorStore!.insert(id, vector, input.content, {
          source: 'life_event',
          type: input.type,
          created_at: now,
        }))
        .catch(() => { /* embedding failure is non-fatal */ });
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
   *    ?? 截断正文 200 字（无 digest 兜底，如新导入条目） */
  getWorldbookSample(limit: number = 5): Array<{ id: string; content: string }> {
    const role = this.getActiveRoleId();
    // 分层：life_event 占 3/5，text 占 2/5（按 limit 等比，最小各 1）
    const lifeCount = Math.max(1, Math.round(limit * 3 / 5));
    const textCount = Math.max(1, limit - lifeCount);
    const lifeRows = this.db.prepare(
      "SELECT id, content FROM worldbook_entries WHERE role = ? AND scope IN ('chat', 'both') AND content_type = 'life_event' ORDER BY RANDOM() LIMIT ?"
    ).all(role, lifeCount) as Array<{ id: string; content: string }>;
    const textRows = this.db.prepare(
      "SELECT id, content, digest FROM worldbook_entries WHERE role = ? AND scope IN ('chat', 'both') AND content_type = 'text' ORDER BY RANDOM() LIMIT ?"
    ).all(role, textCount) as Array<{ id: string; content: string; digest: string | null }>;
    return [
      ...lifeRows.map(r => ({ id: r.id, content: r.content.slice(0, 200) })),
      ...textRows.map(r => {
        const digest = (r.digest ?? '').trim();
        return { id: r.id, content: digest ? digest.slice(0, 200) : r.content.slice(0, 200) };
      }),
    ];
  }

  /** ★ 世界书命中统计（spec §7 ②）：事件引用条目 → hit_count+1 + last_triggered（与对话触发共用冷却） */
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
    if (!this.vectorStore) {
      const retrieved = this.applyKnobsToRetrieved([
        ...this.conversationStore.searchByText(req.query, req.limit),
        ...this.knowledgeStore.searchChunksByText(req.query, Math.min(3, req.limit)),
      ], knobs).slice(0, req.limit);

      return {
        context: '',
        persona_hint: '',
        retrieved,
        worldbook_triggers: triggers,
      };
    }

    // Vector search
    let retrieved: SearchResult[] = [];
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
      retrieved = this.applyKnobsToRetrieved(
        [...convResults, ...knowledgeResults, ...eventResults, ...lifeResults],
        knobs,
      ).slice(0, req.limit);
    } catch {
      // Fallback: SQLite LIKE search when embed API fails
      // 知识库升级为搜 chunk 全文（之前只搜标题，几乎搜不到内容）
      retrieved = this.applyKnobsToRetrieved([
        ...this.conversationStore.searchByText(req.query, req.limit),
        ...this.knowledgeStore.searchChunksByText(req.query, Math.min(3, req.limit)),
      ], knobs).slice(0, req.limit);
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
   * 限制：服务端 ingest importance 恒 0——importance 加分待 importance 计算接入后自动生效。
   */
  private applyKnobsToRetrieved(retrieved: SearchResult[], knobs: MemoryConfig): SearchResult[] {
    const now = Date.now();
    const halfLifeHours = 24 / Math.max(knobs.decay_rate, 0.05);
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
      // importance 优先：metadata.importance > threshold → 加分（数据到位自动生效）
      const imp = r.metadata?.importance;
      if (typeof imp === 'number' && imp > knobs.importance_threshold) {
        score += 0.15;
      }
      return { ...r, score };
    });
    return scored.sort((a, b) => b.score - a.score);
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

  async onSessionEnd(sessionId: string): Promise<void> {
    logger.info(`[Memory] onSessionEnd: ${sessionId.slice(-30)} (summary + profile)`);
    const start = Date.now();
    try {
      await this.sessionEndProcessor.process(sessionId);
      logger.info(`[Memory] onSessionEnd done (${Date.now() - start}ms)`);
    } catch (err: any) {
      logger.error(`[Memory] onSessionEnd failed: ${err.message}`);
      throw err;
    }
    // 会话结束自动恢复隐私模式
    this.privacyMode = 'off';
  }

  /** ★ 8-09 定期归档（修"短对话永不归档"）：24h 内有消息的活跃 session → 摘要归档。
   *  since 锚点 = 该 session 最新摘要的 ended_at（无摘要 → 24h 前起点）——防重复摘要。
   *  cron 每 6h 调用。返回归档 session 数。 */
  async archiveStaleSessions(): Promise<number> {
    let archived = 0;
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const active = this.eventStore.getActiveSessions(since);
      for (const sid of active) {
        try {
          const last = this.conversationStore.getLatestBySession(sid);
          const anchor = last?.ended_at ? new Date(last.ended_at) : since;
          await this.sessionEndProcessor.process(sid, anchor);
          archived++;
        } catch (err: any) {
          logger.error(`[Memory] archive failed for ${sid.slice(-24)}: ${err.message}`);
        }
      }
      if (archived > 0) logger.info(`[Memory] archived ${archived}/${active.length} sessions`);
    } catch (err: any) {
      logger.error(`[Memory] archiveStaleSessions failed: ${err.message}`);
    }
    return archived;
  }

  /** ★ 8-28 情绪惯性漂移（memory-character-perspective）：生活事件累积 mood_value 驱动
   *  人格自然漂移（连续开心 → playfulness、连续低落 → empathy），走 apply 5 道护栏。
   *  由 LifeService.updateMoodValue 极性跨阈值时调用。 */
  adjustPersonaFromMood(moodValue: number): boolean {
    return this.personaAdapter.adjustFromMood(moodValue);
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

  /** ★ 手动触发画像提取（Web 端"提取画像"按钮）。
   *  对指定会话执行 SessionEnd 处理：对话摘要 + LLM 事实提取 + 合并入画像。
   *  返回本次提取到的 facts 数量。 */
  async extractProfile(sessionId: string): Promise<{ factsExtracted: number; summaryGenerated: boolean }> {
    const before = JSON.parse(this.profileStore.get().facts).length;
    const start = Date.now();
    await this.sessionEndProcessor.process(sessionId);
    const after = JSON.parse(this.profileStore.get().facts).length;
    const factsExtracted = Math.max(0, after - before);
    logger.info(`[Memory] extractProfile: ${factsExtracted} new facts (${Date.now() - start}ms)`);
    return {
      factsExtracted,
      summaryGenerated: true,
    };
  }

  /** ★ 获取会话列表（Web 端会话管理）。
   *  返回最近活跃的会话及其消息数。 */
  listSessions(limit: number = 20): Array<{ sessionId: string; messageCount: number; lastActive: string }> {
    const sessions = this.eventStore.listSessions(limit);
    return sessions.map(s => ({
      sessionId: s.session_id,
      messageCount: s.count,
      lastActive: s.last_active,
    }));
  }

  /** ★ 获取当前画像快照（Web 端画像展示）。 */
  getProfileSnapshot(): {
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
      .filter(f => f.status !== 'superseded')
      .map(toView);
    // ★ 8-28 角色事实（memory-character-perspective）：昔涟自己的事，Web 画像页并列展示
    const characterFacts = (JSON.parse(profile.character_facts || '[]') as Parameters<typeof toView>[0][])
      .filter(f => f.status !== 'superseded')
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
      return { docId: existing.id, chunks: existing.chunk_count, deduplicated: true };
    }

    // 2. 分块
    const chunks = chunkText(content);
    const now = new Date().toISOString();
    const docId = `kb-${hash.slice(0, 16)}`;

    // 3. 插入文档元数据
    const doc: KnowledgeDoc = {
      id: docId,
      title: input.title,
      source,
      file_path: null,
      content_hash: hash,
      chunk_count: chunks.length,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    await this.knowledgeStore.insert(doc);

    // 4. 插入 chunks（向量化待 LanceDB 部署后启用）
    for (let i = 0; i < chunks.length; i++) {
      this.knowledgeStore.insertChunk({
        id: `chunk_${docId}_${i}`,
        doc_id: docId,
        chunk_index: i,
        content: chunks[i],
      });
      if (this.vectorStore) {
        try {
          const vector = await this.embedService.embed(chunks[i]);
          await this.vectorStore.insert(`chunk_${docId}_${i}`, vector, chunks[i], {
            source: 'knowledge',
            doc_id: docId,
            chunk_index: i,
          });
        } catch { /* embedding failure non-fatal */ }
      }
    }

    return { docId, chunks: chunks.length, deduplicated: false };
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

  /** 彻底删除知识文档 + chunks */
  deleteKnowledgeDoc(docId: string): void {
    this.knowledgeStore.deleteDoc(docId);
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
    this.personaStore.upsertRole({
      role: pkg.role,
      name: pkg.name,
      tone: JSON.stringify(pkg.persona?.tone ?? {}),
      speech_style: JSON.stringify(pkg.persona?.speech_style ?? {}),
      emotional_range: JSON.stringify(pkg.persona?.emotional_range ?? {}),
      memory_config: JSON.stringify(pkg.persona?.memory_config ?? DEFAULT_MEMORY_CONFIG),
      system_prompt: pkg.system_prompt ?? '',
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
