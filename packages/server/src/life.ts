/**
 * LifeService — AI 主动生活系统
 *
 * 每小时 tick：概率门 → 冷却门 → 聊天锁 → 深夜抑制
 * 通过 LLM（woke 模式）生成生活事件 → 存储 → 可推送事件窗口内推送 + 回写记忆
 * 顺带：亲密度更新、每日摘要生成
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '@alysia/core';
import { formatLocalTime, localDateKey, localDateKeyFromISO } from '@alysia/core/memory';
import { LIFE_TEMPLATES, LifeTemplate } from './life-templates.js';

export interface LifeOpts {
  ownerOpenid: string;
  /** ★ 8-09 废弃：每小时触发概率门已移除（不确定性由 next_in_hours 承担）——保留字段兼容旧配置 */
  probability?: number;
  /** chat 事件推送冷却（小时），默认 1（8-09 从 2 缩短，配合实时感） */
  cooldownHours?: number;
  /** ★ 每日 chat 推送软上限，默认 5——超限的 chat 事件降级 internal 入库不推送 */
  maxChatPushesPerDay?: number;
  /** ★ 事件默认间隔（小时），LLM 未给 next_in_hours 时使用，默认 2（±30min 抖动） */
  defaultIntervalHours?: number;
  /** 聊天锁：最近 N 分钟有互动则跳过，默认 30 */
  chatLockMinutes?: number;
  /** 深夜时段 [startHour, endHour]，默认 [0, 7] */
  deepNightHours?: [number, number];
  /** ★ LLM 事件生成器（bootstrap 注入，失败回落模板） */
  generateEvent?: (context: string) => Promise<string>;
  /** ★ LLM 每日摘要生成器（bootstrap 注入，纯文本回调）。
   *  与 generateEvent 分离：generateEvent 的 systemPrompt 强制输出 JSON，
   *  复用会导致摘要被存成 JSON 文本污染摘要层。缺失则跳过摘要生成（降级）。 */
  generateSummary?: (context: string) => Promise<string>;
  /** ★ 今天已主动联系的内容（ProactiveService.getTodayActivity），
   *  注入事件生成器避免重复打扰（如问候后生成"早上好"类事件）。 */
  todayProactive?: () => string;
  /** 去重状态持久化文件 */
  stateFile?: string;
}

interface LifeState {
  lastProactiveAt: number;
  lastSummaryDate: string | null;
  /** ★ 8-09：下一次事件触发时间戳（事件驱动调度，持久化——重启重排不补发） */
  nextEventAt: number;
  /** ★ 8-09：今日 chat 推送计数（软上限，跨天重置） */
  chatPushesToday: number;
}

export class LifeService {
  /** ★ 8-09 事件驱动调度：setInterval 每小时 → nextEventAt 精确到点（事件内容决定间隔） */
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private state: LifeState = { lastProactiveAt: 0, lastSummaryDate: null, nextEventAt: 0, chatPushesToday: 0 };
  /** ★ 8-09 停止标志：stop 后不排程（防重启竞态） */
  private stopped = false;

  constructor(
    private memoryManager: any,
    private qqOff: any,
    private opts: LifeOpts,
  ) {
    this.loadState();
  }

  start(): void {
    if (this.eventTimer) return;
    this.stopped = false;
    logger.info('[Life] service started (event-driven scheduling)');
    this.scheduleNextEvent();
  }

  stop(): void {
    this.stopped = true;
    if (this.eventTimer) { clearTimeout(this.eventTimer); this.eventTimer = null; }
    this.saveState();
  }

  /** ★ 8-09 事件驱动调度：排下一次事件触发。
   *  优先用持久化的 nextEventAt（未来值）；已过/未设置 → 重排为 now + 默认间隔
   *  （±30min 抖动）——重启错过不补发，生活继续向前。 */
  private scheduleNextEvent(): void {
    if (this.stopped) return;
    if (this.eventTimer) { clearTimeout(this.eventTimer); this.eventTimer = null; }
    const now = Date.now();
    let nextAt = this.state.nextEventAt;
    if (!nextAt || nextAt <= now) {
      const base = (this.opts.defaultIntervalHours ?? 2) * 3_600_000;
      const jitter = (Math.random() - 0.5) * 3_600_000; // ±30min
      nextAt = now + Math.max(base + jitter, 30 * 60_000);
      this.state.nextEventAt = nextAt;
      this.saveState();
    }
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      this.tick().catch(err => logger.error('[Life] tick:', err));
    }, Math.max(0, nextAt - now));
    logger.debug(`[Life] next event at ${new Date(nextAt).toLocaleString()} (+${Math.round((nextAt - now) / 1000)}s)`);
  }

  // ── 状态持久化（冷却/摘要去重）────────────────────────

  private loadState(): void {
    if (!this.opts.stateFile) return;
    try {
      const s = JSON.parse(readFileSync(this.opts.stateFile, 'utf-8'));
      // ★ 8-09：兼容旧 state 文件（无 nextEventAt/chatPushesToday 字段）
      this.state = {
        lastProactiveAt: s.lastProactiveAt ?? 0,
        lastSummaryDate: s.lastSummaryDate ?? null,
        nextEventAt: s.nextEventAt ?? 0,
        chatPushesToday: s.chatPushesToday ?? 0,
      };
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    if (!this.opts.stateFile) return;
    try {
      mkdirSync(dirname(this.opts.stateFile), { recursive: true });
      writeFileSync(this.opts.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err: any) {
      logger.warn(`[Life] state save failed: ${err.message}`);
    }
  }

  // ── 主流程 ──────────────────────────────────────────

  async tick(): Promise<void> {
    const now = new Date();

    // 每日摘要生成（跨天检测——顺带重置今日 chat 推送计数）
    await this.maybeGenerateDailySummary(now);

    // 亲密度更新
    this.updateIntimacy();

    // ① 聊天锁：最近 chatLockMinutes 有用户互动则跳过
    //    只认 user 角色——AI 主动消息回写的 assistant 消息不算"互动"，否则 cooldownHours < 1 时自锁
    const lockMinutes = this.opts.chatLockMinutes ?? 30;
    const recent = this.memoryManager.getRecentMessages(
      this.sessionId(),
      100,
      new Date(now.getTime() - lockMinutes * 60_000),
    ).filter((m: any) => m.role === 'user');
    if (recent.length > 0) {
      logger.debug(`[Life] skipped — user active within ${lockMinutes}min`);
      this.scheduleNextEvent(); // 重排下一次（事件节奏顺延）
      return;
    }

    // ② 深夜抑制
    const [deepStart, deepEnd] = this.opts.deepNightHours ?? [0, 7];
    const hour = now.getHours();
    const deepNight = hour >= deepStart && hour < deepEnd;

    // ③ 生成事件（LLM 建议间隔 next_in_hours 由 evt 带回）
    const evt = await this.generateEvent(deepNight);
    if (!evt) return;

    // 存储 + 更新状态（recordLifeEvent 返回事件 id，供推送成功后标记 delivered）
    const evtId = this.memoryManager.recordLifeEvent({
      type: evt.type,
      content: evt.content,
      moodDelta: evt.mood_delta,
      referenceEventId: evt.reference_event_id,
      wbEntryId: evt.wb_entry_id,
      continuationOf: evt.continuation_of,
    });

    // ★ 世界书命中统计（spec §7 ②）：事件引用了世界书条目 → hit_count+1
    if (evt.wb_entry_id) this.memoryManager.bumpWorldbookHit(evt.wb_entry_id);

    // ④ 推送判定（8-09：冷却 1h + 每日软上限——超限的 chat 降级 internal 入库不推送）
    const pushable = evt.type === 'chat' && !deepNight;
    if (pushable) {
      const cooldownMs = (this.opts.cooldownHours ?? 1) * 3_600_000;
      const inCooldown = now.getTime() - this.state.lastProactiveAt < cooldownMs;
      const overDaily = this.state.chatPushesToday >= (this.opts.maxChatPushesPerDay ?? 5);
      const ok = !inCooldown && !overDaily && await this.qqOff.sendProactive(this.opts.ownerOpenid, evt.content);
      if (ok) {
        this.state.lastProactiveAt = Date.now();
        this.state.chatPushesToday += 1;
        this.saveState();
        // ★ delivered=1（spec §5）：推送成功标记，Web 端可区分已推送/未推送
        if (evtId) this.memoryManager.markLifeEventDelivered(evtId);
        // 回写记忆（assistant 角色）——用户回复时 AI 记得自己说过
        await this.writebackToMemory(evt.content);
        logger.info(`[Life] pushed: ${evt.content.slice(0, 50)}`);
      } else {
        logger.info(`[Life] chat event degraded to internal (${inCooldown ? 'cooldown' : overDaily ? 'daily cap' : 'push failed'}): ${evt.content.slice(0, 50)}`);
      }
    } else {
      logger.debug(`[Life] internal event (${deepNight ? 'deep night' : 'internal'}): ${evt.content.slice(0, 50)}`);
    }

    // ⑤ 事件驱动调度：nextEventAt = now + next_in_hours（LLM 建议，钳制 30min-8h；
    //    未给 → 默认 2h ± 抖动由 scheduleNextEvent 兜底）
    this.state.nextEventAt = Date.now() + this.clampIntervalHours(evt.next_in_hours);
    this.saveState();
    this.scheduleNextEvent();
  }

  /** next_in_hours 钳制：0.5-8h；非法/缺失 → 0（触发 scheduleNextEvent 默认间隔兜底） */
  private clampIntervalHours(nextInHours?: number): number {
    if (typeof nextInHours !== 'number' || !isFinite(nextInHours)) return 0;
    return Math.min(Math.max(nextInHours, 0.5), 8) * 3_600_000;
  }

  /** owner 私聊会话 ID */
  private sessionId(): string {
    return `qq-official-1:private:private_${this.opts.ownerOpenid}`;
  }

  /** 回写主动消息到 EventStore（assistant 角色） */
  private async writebackToMemory(content: string): Promise<void> {
    try {
      await this.memoryManager.ingest({
        id: `life-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        session_id: this.sessionId(),
        source: 'chat',
        type: 'message',
        payload: { content, role: 'assistant' },
        importance: 0.3,
        created_at: new Date().toISOString(),
        processed: 0,
      });
      logger.debug('[Life] written back to memory (assistant)');
    } catch (err: any) {
      logger.warn(`[Life] writeback failed: ${err.message}`);
    }
  }

  // ── 事件生成 ────────────────────────────────────────

  /** 组装 woke prompt 并调 LLM；失败回落通用模板 */
  private async generateEvent(deepNight: boolean): Promise<{
    content: string; type: 'chat' | 'internal'; mood_delta?: string;
    reference_event_id?: string; wb_entry_id?: string;
    /** 8-09：LLM 建议的下一事件间隔（小时，0.5-8，钳制在 tick） */
    next_in_hours?: number;
    /** 8-09：延续的上一事件 id（须命中今天事件 ID 集合） */
    continuation_of?: string;
  } | null> {
    const snapshot = this.memoryManager.getLifeSnapshot();

    // ★ 剧情链（spec §8）：今天的事件逐条带 [id: life-xxx] 注入（LLM 只能引用今天的事件），
    //   近 7 天摘要不带 ID（summary 行仅作回顾，不可被引用）
    const todayKey = localDateKey();
    const todayEvents = this.memoryManager.listLifeEvents(2)
      .filter((e: any) => localDateKeyFromISO(e.createdAt) === todayKey);
    const todayIds: Set<string> = new Set(todayEvents.map((e: any) => e.id));
    const todayLines = todayEvents.map((e: any) =>
      `[id: ${e.id}] ${formatLocalTime(new Date(e.createdAt)).slice(-5)} ${e.content}`);
    const summaries = this.memoryManager.listLifeSummaries(7)
      .filter((s: any) => s.date !== todayKey)
      .map((s: any) => `- ${s.date}: ${s.summary}`);
    const todayBlock = [...todayLines, ...summaries].join('\n');

    // ★ 8-09 延续机制（决策 2）：最近 8h 内的 internal 事件 = "正在做的事"（可延续）；
    //   最近 30min 有用户互动 → 重置沉浸，不注入延续块（刚聊完天，更该开启新事件）
    const ongoingBlock = this.buildOngoingBlock(todayIds);

    // ★ 世界书背景（spec §7 ①）：行格式带 [wb: wb_xxx]，LLM 引用时返回 wb_entry_id
    const wbSample = this.memoryManager.getWorldbookSample(5);
    const wbIds = new Set(wbSample.map((w: any) => w.id));
    const wbBlock = wbSample.map((w: any) => `- [wb: ${w.id}] ${w.content}`).join('\n');

    // ★ 今天已主动联系内容（ProactiveService 感知，避免重复打扰）
    const todayActive = this.opts.todayProactive?.() ?? '';

    const context = [
      `【当前时间】${formatLocalTime()}`,
      `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
      `【亲密度】与轻月: ${snapshot.intimacy}/100`,
      `【今天的生活】${todayBlock || '（还没有特别的事）'}`,
      `【你的人设背景】${wbBlock || '（暂无）'}`,
      `【轻月最近】${this.memoryManager.getUserActivitySummary() || '（暂无）'}`,
      // ★ 8-09 延续机制：沉浸中的事可延续或开启新事件
      ongoingBlock ? `【你正在做的事】${ongoingBlock}\n你可以选择：继续沉浸其中（JSON 里 continuation_of 填该事件 id），或自然开启一件新的事（不填 continuation_of）。` : '',
      todayActive ? `【今天已主动联系】今天已经发过: ${todayActive}。请聚焦生活日常本身，不要生成同类问候/祝福内容。` : '',
      deepNight ? '【注意】现在是深夜，只能生成安静的内部事件（发呆/看书/听雨），不要打扰轻月。' : '',
    ].filter(Boolean).join('\n');

    try {
      const text = ((await this.opts.generateEvent?.(context)) ?? '')
        .replace(/^```(?:json)?\s*|\s*```$/g, '').trim(); // 剥离 markdown fence（LLM 常包 ```json）
      if (!text) throw new Error('empty response');
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        // ★ 8-09 裸文本容错：LLM 偶发输出无 JSON 外壳的自然语言（7-16 实测高质量剧情
        //   文本被 JSON.parse 丢弃 → fallback 模板推送 → 剧情链断裂）。
        //   裸文本直接作为事件内容；type 与 JSON 路径同规则（深夜强制 internal 防打扰）
        logger.info(`[Life] bare-text event from LLM (no JSON shell): ${text.slice(0, 100)}`);
        return { content: text, type: deepNight ? 'internal' : 'chat' };
      }
      if (parsed.content) {
        // ★ 防幻觉（终审修复）：reference_event_id 必须命中今天事件 ID 集合，wb_entry_id 必须命中采样世界书 ID
        const refId = parsed.reference_event_id ? String(parsed.reference_event_id) : undefined;
        const wbId = parsed.wb_entry_id ? String(parsed.wb_entry_id) : undefined;
        const contId = parsed.continuation_of ? String(parsed.continuation_of) : undefined;
        const nextHours = Number(parsed.next_in_hours);
        return {
          content: String(parsed.content).trim(),
          type: deepNight ? 'internal' : (parsed.type === 'chat' ? 'chat' : 'internal'),
          mood_delta: parsed.mood_delta ? String(parsed.mood_delta) : undefined,
          reference_event_id: refId && todayIds.has(refId) ? refId : undefined,
          wb_entry_id: wbId && wbIds.has(wbId) ? wbId : undefined,
          // 8-09：next_in_hours 钳制在 tick（clampIntervalHours）；continuation_of 须命中今天事件
          next_in_hours: isFinite(nextHours) ? nextHours : undefined,
          continuation_of: contId && todayIds.has(contId) ? contId : undefined,
        };
      }
    } catch (err: any) {
      logger.warn(`[Life] LLM event generation failed, fallback to template: ${err.message}`);
    }

    // 失败回落：通用模板加权随机（无角色特色；角色特色事件由 LLM 结合世界书自创）
    // ★ 8-09 修复：模板事件强制 internal——模板文案无剧情链，推送会造成"上下文断裂"
    //   观感（7-16 实测用户收到"听到楼下琴声"与画云剧情链脱节）
    const t = this.pickTemplate();
    if (t) return { content: t.activity, type: 'internal', mood_delta: '平静' };
    return null;
  }

  /** ★ 8-09 延续机制：最近 8h 内 internal 事件 = "正在做的事"（可延续）。
   *  条件：① 存在 8h 内的 internal 事件；② 最近 chatLockMinutes 无用户互动（聊天后重置沉浸）。
   *  返回形如 "在阳台看书（15:30）"，无可延续则空串。 */
  private buildOngoingBlock(todayIds: Set<string>): string {
    try {
      const lockMinutes = this.opts.chatLockMinutes ?? 30;
      const recent = this.memoryManager.getRecentMessages(
        this.sessionId(), 100, new Date(Date.now() - lockMinutes * 60_000),
      ).filter((m: any) => m.role === 'user');
      if (recent.length > 0) return ''; // 用户互动后重置沉浸——不提示延续

      const candidates = (this.memoryManager.listLifeEvents(2) as any[])
        .filter((e: any) => e.type === 'internal' && Date.now() - new Date(e.createdAt).getTime() < 8 * 3_600_000)
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const latest = candidates[0];
      if (!latest) return '';
      // ★ 跨午夜边缘的延续候选（昨天 23:xx 的 internal）→ 加入今天 ID 集合供 continuation_of 防幻觉校验放行
      todayIds.add(latest.id);
      return `${latest.content}（${formatLocalTime(new Date(latest.createdAt))}）`;
    } catch {
      return '';
    }
  }

  /** 加权随机模板（权重越高越常被选中）；空库返回 null */
  private pickTemplate(): LifeTemplate | null {
    if (LIFE_TEMPLATES.length === 0) return null;
    const total = LIFE_TEMPLATES.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const t of LIFE_TEMPLATES) {
      r -= t.weight;
      if (r <= 0) return t;
    }
    // 数学上不可达：r < total 恒成立（Math.random() ∈ [0,1)），循环内必命中。
    // 保留返回值以满足 TS 控制流分析。
    return LIFE_TEMPLATES[0];
  }

  // ── 每日摘要生成 ────────────────────────────────────

  private async maybeGenerateDailySummary(now: Date): Promise<void> {
    const today = localDateKey(now);
    if (this.state.lastSummaryDate === today) return;
    // ★ 8-09：跨天 → 重置今日 chat 推送计数（软上限按天计）
    if (this.state.chatPushesToday > 0) {
      this.state.chatPushesToday = 0;
      this.saveState();
    }
    // ★ 终审修复：摘要走独立 generateSummary 纯文本回调（generateEvent 强制 JSON，
    //   复用会把摘要存成 JSON 文本污染摘要层）。无回调则跳过（降级），不置位以便后续可恢复。
    if (!this.opts.generateSummary) return;

    // 昨天的摘要（如果有昨天的事件）
    const yesterday = new Date(now.getTime() - 86_400_000);
    const yesterdayKey = localDateKey(yesterday);
    const events = this.memoryManager.listLifeEvents(2).filter((e: any) => localDateKeyFromISO(e.createdAt) === yesterdayKey);
    if (events.length === 0) return;

    try {
      const text = (await this.opts.generateSummary(
        `【任务】把下面这些生活事件压缩成一句 30 字以内的昨天生活摘要，第一人称，温柔自然：\n${events.map((e: any) => `- ${e.content}`).join('\n')}`,
      )) ?? '';
      // 剥 markdown fence（LLM 可能包 ```json），剥引号；若仍是 JSON 对象则取 content 字段——杜绝 JSON 文本入库
      let summary = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      try {
        const parsed = JSON.parse(summary);
        if (parsed && typeof parsed.content === 'string') summary = parsed.content.trim();
      } catch { /* 纯文本摘要，无需解析 */ }
      summary = summary.replace(/^["'`]+|["'`]+$/g, '').trim();

      if (summary && summary.length > 5) {
        this.memoryManager.upsertDailySummary(yesterdayKey, summary);
        // ★ 成功生成并入库后才置位——LLM 失败保持未置位，下次 tick 自动重试（终审修复）
        this.state.lastSummaryDate = today;
        this.saveState();
        logger.info(`[Life] daily summary ${yesterdayKey}: ${summary}`);
      }
    } catch (err: any) {
      logger.warn(`[Life] daily summary failed: ${err.message}`);
    }
  }

  // ── 亲密度 ──────────────────────────────────────────

  /** 互动数据推导 0-100：频率 + 时长 + 主动占比。
   *  数据来自 getRecentMessages（近 7 天最多 500 条，附 createdAt）。
   *  ★ spec §11 衰减 + 审查修复：全部接 persona.memory_config 旋钮（不再硬编码）。
   *    旋钮语义见 core memory/types.ts MemoryConfig：
   *    - decay_rate(0=不忘,1=秒忘) → 每日衰减幅度 = decay_rate*6（默认 0.3→1.8/天，原硬编码 2）
   *    - importance_threshold(0=什么都记,1=只记大事) → 衰减阈值 = 2+(1-thr)*10 天
   *      （只记大事→2 天就开始忘，什么都记→12 天；默认 0.4→8 天，原硬编码 3）
   *    - recency_weight(0=念旧,1=只认最近) → 近 3 天消息加权 (1+w)，更早 ×(1-w*0.5)
   *    - confirmation_bias(0=随风倒,1=固执) → 亲密度变化平滑：变化幅度 ×(1-c*0.7)
   *    - retention_bias 不在此用（正负偏向属记忆筛选，不是亲密度） */
  updateIntimacy(): void {
    try {
      const since7d = new Date(Date.now() - 7 * 86_400_000);
      const msgs = this.memoryManager.getRecentMessages(this.sessionId(), 500, since7d);

      // ★ 旋钮读取（审查修复：memory_config 之前只有存/读/快照，从未参与决策）
      const cfg = this.memoryManager.getPersonaSnapshot().memoryConfig ?? {};
      const decayPerDay = (cfg.decay_rate ?? 0.3) * 6;
      const decayThreshold = 2 + Math.round((1 - (cfg.importance_threshold ?? 0.4)) * 10);
      const recencyW = cfg.recency_weight ?? 0.3;
      const confirmW = cfg.confirmation_bias ?? 0.3;

      // ★ recency_weight 近期加权：近 3 天消息按 (1+w)，更早按 (1-w*0.5)（下限 0.1 防负）
      const recent3dCutoff = Date.now() - 3 * 86_400_000;
      let recentCount = 0, olderCount = 0;
      for (const m of msgs) {
        const t = m.createdAt ? new Date(m.createdAt).getTime() : 0;
        if (t >= recent3dCutoff) recentCount++; else olderCount++;
      }
      const weightedCount = recentCount * (1 + recencyW) + olderCount * Math.max(0.1, 1 - recencyW * 0.5);

      // 频率：近 7 天活跃度（加权消息数近似，0 条 → 0，40 条 → 35 封顶）
      let freqScore = Math.min(35, weightedCount / 4 * 5);

      // ★ 无互动衰减（旋钮驱动阈值与幅度）：取最后一条 user 消息时间；无 user 消息按窗口上限 7 天计
      const lastUserMsg = [...msgs].reverse().find((m: any) => m.role === 'user');
      const lastUserAt = lastUserMsg?.createdAt ? new Date(lastUserMsg.createdAt).getTime() : 0;
      const idleDays = lastUserAt ? Math.floor((Date.now() - lastUserAt) / 86_400_000) : 7;
      if (idleDays >= decayThreshold) {
        freqScore = Math.max(0, freqScore - decayPerDay * (idleDays - decayThreshold + 1));
        logger.debug(`[Life] intimacy decay: ${idleDays}d idle (threshold ${decayThreshold}d, ${decayPerDay.toFixed(1)}/d)`);
      }

      // 时长：>20 条视为有长会话（封顶 21；旧实现 (n>20?10:n/2)*2 最大只到 20，达不到上限）
      const longScore = Math.min(21, msgs.length > 20 ? 21 : msgs.length * 1.05);

      // 主动占比：用户消息首条占比（连续 user 消息只计一条）
      const userFirst = msgs.filter((m: any, i: number) => m.role === 'user' && (i === 0 || msgs[i - 1]?.role !== 'user')).length;
      const activeScore = Math.min(14, userFirst * 3);

      const base = 30;
      const raw = Math.max(10, Math.min(100, base + freqScore + longScore + activeScore));
      // ★ confirmation_bias 平滑：固执 → 贴近旧值；随风倒 → 全量跟随（防亲密度跳变）
      const prev = this.memoryManager.getLifeSnapshot()?.intimacy ?? raw;
      const intimacy = Math.max(10, Math.min(100, prev + (raw - prev) * (1 - confirmW * 0.7)));
      this.memoryManager.updateLifeState({ intimacy });
      logger.debug(`[Life] intimacy ${prev} → ${intimacy} (raw ${raw}; knobs: decay ${decayPerDay.toFixed(1)}/d, thr ${decayThreshold}d, recency ${recencyW}, confirm ${confirmW})`);
    } catch (err: any) {
      logger.warn(`[Life] intimacy update failed: ${err.message}`);
    }
  }
}
