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
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import type { IVectorStore } from './interfaces/IVectorStore.js';
import type { IEmbedService } from './interfaces/IEmbedService.js';
import type { ILLMService } from './interfaces/ILLMService.js';

// ── 知识库分块参数（参考 AstrBot：chunk 512 / overlap 50）──
const KB_CHUNK_SIZE = 500;
const KB_CHUNK_OVERLAP = 50;

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
  ) {
    this.eventStore = new EventStore(db);
    this.profileStore = new ProfileStore(db);
    this.personaStore = new PersonaStore(db);
    this.conversationStore = new ConversationStore(db, vectorStore);
    this.knowledgeStore = new KnowledgeStore(db, vectorStore);
    this.worldbookStore = new WorldbookStore(db);
    this.codeContextStore = new CodeContextStore(db);
    this.lifeStore = new LifeStore(db);

    this.worldbookMatcher = new WorldbookMatcher(this.worldbookStore);
    this.personaAdapter = new PersonaAdapter(this.personaStore, llmService);
    this.profileExtractor = new ProfileExtractor(llmService);
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
      this.personaAdapter, this.llmService, this.embedService, this.vectorStore,
    );
    this.cronProcessor = new CronProcessor(
      this.eventStore, this.conversationStore, this.knowledgeStore,
      this.profileStore, this.profileExtractor, this.llmService, this.vectorStore,
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
    };

    return this.profileStore.supersede(signal.target, newFact);
  }

  /** 获取最近消息（短期记忆）。limit 上限；since 可选时间窗口（如最近 2 小时） */
  getRecentMessages(sessionId: string, limit: number = 10, since?: Date): Array<{ role: string; content: string }> {
    return this.eventStore.getRecentBySession(sessionId, limit, since);
  }

  // ===== AI 主动生活系统（v4）=====

  /** ★ 生活状态快照（Web 展示） */
  getLifeSnapshot(): { currentActivity: string; mood: string; intimacy: number } {
    const s = this.lifeStore.getState();
    return { currentActivity: s.currentActivity, mood: s.mood, intimacy: s.intimacy };
  }

  /** 更新 AI 实时状态（活动/心情/亲密度），亲密度由 LifeService 每小时推导后传入 */
  updateLifeState(partial: { currentActivity?: string; mood?: string; intimacy?: number }): void {
    this.lifeStore.updateState(partial);
  }

  /** ★ 事件流注入块（对话 prompt 用）：今天逐条 + 近 7 天摘要。无事件返回 '' */
  getLifeEventInjection(): string {
    const todayKey = localDateKey();
    // 本地今天 0 点对应的 ISO 时刻，作为时间窗口起点（避免 LifeStore 字符串比较的 UTC 边界错位）
    const sinceIso = new Date(`${todayKey}T00:00:00`).toISOString();
    const today = this.lifeStore.getEventsSince(sinceIso)
      .filter(e => localDateKeyFromISO(e.createdAt) === todayKey); // 边界兜底
    const summaries = this.lifeStore.getRecentSummaries(7).filter(s => s.date !== todayKey);
    if (today.length === 0 && summaries.length === 0) return '';

    const lines: string[] = [];
    for (const e of today) {
      // 本地时间显示 HH:MM
      const time = formatLocalTime(new Date(e.createdAt)).slice(-5);
      lines.push(`- 今天 ${time} ${e.content}`);
    }
    for (const s of summaries) {
      lines.push(`- ${s.date}: ${s.summary}`);
    }
    return `[我的近期日常]\n${lines.join('\n')}`;
  }

  /** ★ 记录 AI 生活事件 + 更新当前活动 */
  recordLifeEvent(input: { type: 'chat' | 'internal'; content: string; moodDelta?: string; referenceEventId?: string }): void {
    const now = new Date().toISOString();
    const id = `life-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.lifeStore.addEvent({
      id, createdAt: now, type: input.type, content: input.content,
      moodDelta: input.moodDelta, referenceEventId: input.referenceEventId,
    });
    this.lifeStore.updateState({ currentActivity: input.content, mood: input.moodDelta ?? undefined, lastEventId: id });
    logger.info(`[Life] event: [${input.type}] ${input.content.slice(0, 60)}`);
  }

  /** ★ 激活角色世界书采样（事件生成人设背景，priority 加权） */
  getWorldbookSample(limit: number = 5): Array<{ content: string }> {
    const role = this.getActiveRoleId();
    const rows = this.db.prepare(
      "SELECT content, priority FROM worldbook_entries WHERE role = ? AND scope IN ('chat', 'both') AND content_type = 'text' ORDER BY priority DESC LIMIT ?"
    ).all(role, limit) as Array<{ content: string; priority: number }>;
    return rows.map(r => ({ content: r.content.slice(0, 100) }));
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

    // 向量存储未启用时直接走文本检索（避免 embed 成功但 search 空结果不触发 fallback）
    if (!this.vectorStore) {
      const retrieved = [
        ...this.conversationStore.searchByText(req.query, req.limit),
        ...this.knowledgeStore.searchChunksByText(req.query, Math.min(3, req.limit)),
      ].sort((a, b) => b.score - a.score).slice(0, req.limit);

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
      const [convResults, knowledgeResults] = await Promise.all([
        this.conversationStore.searchByVector(vector, req.limit),
        this.knowledgeStore.searchByVector(vector, Math.min(3, req.limit)),
      ]);
      retrieved = [...convResults, ...knowledgeResults]
        .sort((a, b) => b.score - a.score)
        .slice(0, req.limit);
    } catch {
      // Fallback: SQLite LIKE search when embed API fails
      // 知识库升级为搜 chunk 全文（之前只搜标题，几乎搜不到内容）
      retrieved = [
        ...this.conversationStore.searchByText(req.query, req.limit),
        ...this.knowledgeStore.searchChunksByText(req.query, Math.min(3, req.limit)),
      ].sort((a, b) => b.score - a.score).slice(0, req.limit);
    }

    return {
      context: '',
      persona_hint: '',
      retrieved,
      worldbook_triggers: triggers,
    };
  }

  /** @deprecated 请使用 assembleWithWorldbook()，它包含了 Worldbook 和 search results 的完整组装 */
  async assemble(mode: 'chat' | 'code'): Promise<string> {
    return this.promptAssembler.assemble(mode);
  }

  /** 带 Worldbook 匹配的 assemble — 供 MemoryRetrievalStage 使用 */
  async assembleWithWorldbook(mode: 'chat' | 'code', triggers: WorldbookEntry[], retrieved: SearchResult[]): Promise<string> {
    // 隐私模式 readonly/full: 不注入 Profile/Worldbook/Life
    if (this.privacyMode !== 'off') {
      return this.promptAssembler.assembleMinimal(mode);
    }
    const lifeInjection = this.getLifeEventInjection();
    if (lifeInjection) {
      logger.debug(`[Memory] life injection: ${lifeInjection.length} chars into ${mode} prompt`);
    }
    return this.promptAssembler.assemble(mode, retrieved, triggers, lifeInjection);
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
    facts: Array<{ fact: string; confidence: number; source: string; status: string }>;
    basics: string;
    preferences: string;
  } {
    const profile = this.profileStore.get();
    const facts = JSON.parse(profile.facts) as Array<{ fact: string; confidence: number; source: string; status: string }>;
    return {
      facts: facts.filter(f => f.status !== 'superseded'),
      basics: profile.basics,
      preferences: profile.preferences,
    };
  }

  /** ★ 获取人格快照（Web 端人格状态展示）。 */
  getPersonaSnapshot(): { name: string; tone: Record<string, number>; speechStyle: Record<string, number>; emotionalRange: Record<string, number>; memoryConfig: MemoryConfig } {
    const persona = this.personaStore.get();
    const memoryConfig = this.personaStore.getMemoryConfig();
    return {
      name: persona.name,
      tone: JSON.parse(persona.tone),
      speechStyle: JSON.parse(persona.speech_style),
      emotionalRange: JSON.parse(persona.emotional_range),
      memoryConfig,
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

    // 2. Worldbook 条目（先删旧角色条目再插入，保证幂等）
    this.db.prepare('DELETE FROM worldbook_entries WHERE role = ?').run(pkg.role);
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
    content_type?: 'text' | 'image' | 'sticker';
  }>;
  /** 导入后是否立即激活 */
  activate?: boolean;
}
