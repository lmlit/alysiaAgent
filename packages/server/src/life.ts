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
  /** ★ 8-28 意图兑现消息生成器（ai-life-intent-system）：delayed-reply/promise 到期时
   *  生成自然兑现消息（纯文本，昔涟语气）。缺失则直接推 intent.content 原文（降级）。 */
  generateIntentMessage?: (context: string) => Promise<string>;
  /** ★ 8-29 情绪侧端分析（mood-side-analysis）：mood_value 深度阈值后生成描述性氛围
   *  （纯文本，"这段日子…"）。缺失则跳过（降级，mood_note 保持空）。 */
  generateMoodNote?: (context: string) => Promise<string>;
  /** ★ 今天已主动联系的内容（ProactiveService.getTodayActivity），
   *  注入事件生成器避免重复打扰（如问候后生成"早上好"类事件）。 */
  todayProactive?: () => string;
  /** ★ 8-29 今天是什么日子（ProactiveService.todaySpecial）：节日/节气 → 事件生成自然带氛围 */
  todaySpecial?: () => string;
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
  /** ★ 8-29 情绪侧端分析：上次生成 mood_note 的时间（冷却 6h） */
  moodNoteAnalyzedAt: number;
}

export class LifeService {
  /** ★ 8-09 事件驱动调度：setInterval 每小时 → nextEventAt 精确到点（事件内容决定间隔） */
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private state: LifeState = { lastProactiveAt: 0, lastSummaryDate: null, nextEventAt: 0, chatPushesToday: 0, moodNoteAnalyzedAt: 0 };
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
        moodNoteAnalyzedAt: s.moodNoteAnalyzedAt ?? 0,
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

    // ★ 8-28 意图到期扫描（ai-life-intent-system）：处理到期的 delayed-reply/promise/proactive-contact
    await this.processDueIntents(now);

    // ★ 8-27 对话余波：聊完天 15min 后生成 internal 余波（不推送只记录）
    await this.maybeGenerateFollowUp(now);

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

    // ② 深夜感知（★ 8-28 深夜抑制已关闭——不再强制 internal，仅保留时间感知供生成上下文；
    //   深夜的生活由 LLM 自然判断：安静的独处或想说的话都可以，类型不再被压制）
    const [deepStart, deepEnd] = this.opts.deepNightHours ?? [0, 7];
    const hour = now.getHours();
    const deepNight = hour >= deepStart && hour < deepEnd;

    // ③ 生成事件（LLM 建议间隔 next_in_hours 由 evt 带回）
    // ★ 8-27 post-check：LLM 输出过 7 条校验，不过 → 带反馈重试 1 次 → 仍不过回落模板
    const todayKey = localDateKey();
    const todayEvents = this.memoryManager.listLifeEvents(2)
      .filter((e: any) => localDateKeyFromISO(e.createdAt) === todayKey);
    const presentNames = this.memoryManager.listPresentCharacters() as string[];

    let evt = await this.generateEvent(deepNight);
    if (evt && !evt.fromTemplate) {
      const check = this.postCheck(evt, todayEvents, presentNames);
      if (!check.ok) {
        logger.info(`[Life] post-check failed (${check.feedback}), retrying once`);
        const retry = await this.generateEvent(deepNight, check.feedback);
        if (retry && !retry.fromTemplate) {
          const check2 = this.postCheck(retry, todayEvents, presentNames);
          evt = check2.ok ? retry : null;
        } else if (retry) {
          evt = retry; // 重试也回落模板 → 接受模板（模板内容本身满足约束）
        } else {
          evt = null;
        }
      }
    }
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

    // ★ 8-28 意图落库（ai-life-intent-system）：事件想推送但 can_contact=false（正在忙/不适合）→
    //   存 intent，delay_hours 后 tick 重查 Agency Window 再推送——不丢弃"未来要做的事"
    // ★ 8-29 拆分：intent 存的是 message（对轻月说的话），不是生活叙述 content
    if (evt.can_contact === false && evt.intent) {
      this.memoryManager.saveIntent({
        type: 'proactive-contact',
        content: evt.message ?? evt.intent.content,
        triggerAt: now.getTime() + evt.intent.delayHours * 3_600_000,
        source: 'life-event',
      });
      logger.info(`[Intent] event deferred (can_contact=false): ${(evt.message ?? evt.intent.content).slice(0, 40)} +${evt.intent.delayHours}h`);
    }

    // ★ 8-27 在场推导 + 情绪累积（事件入库后）
    this.updatePresenceFromEvent(evt.content);
    this.updateMoodValue(evt.mood_shift, now);

    // ④ 推送判定（8-09：冷却 1h + 每日软上限 + ★ 8-27 Agency Window can_contact）
    // ★ 8-28 深夜抑制关闭：深夜 chat 事件同样按正常推送门（type=chat && can_contact）
    // ★ 8-29 拆分：推送 message（对轻月说的话），无 message 回落 content（生活叙述）
    const pushable = evt.type === 'chat' && evt.can_contact !== false;
    if (pushable) {
      const pushText = evt.message ?? evt.content;
      const cooldownMs = (this.opts.cooldownHours ?? 1) * 3_600_000;
      const inCooldown = now.getTime() - this.state.lastProactiveAt < cooldownMs;
      const overDaily = this.state.chatPushesToday >= (this.opts.maxChatPushesPerDay ?? 5);
      const ok = !inCooldown && !overDaily && await this.qqOff.sendProactive(this.opts.ownerOpenid, pushText);
      if (ok) {
        this.state.lastProactiveAt = Date.now();
        this.state.chatPushesToday += 1;
        this.saveState();
        // ★ delivered=1（spec §5）：推送成功标记，Web 端可区分已推送/未推送
        if (evtId) this.memoryManager.markLifeEventDelivered(evtId);
        logger.info(`[Life] pushed: ${pushText.slice(0, 50)}`);
      } else {
        logger.info(`[Life] chat event degraded to internal (${inCooldown ? 'cooldown' : overDaily ? 'daily cap' : 'push failed'}): ${pushText.slice(0, 50)}`);
      }
    } else {
      logger.debug(`[Life] internal event (${deepNight ? 'deep night' : evt.can_contact === false ? 'not contactable' : 'internal'}): ${evt.content.slice(0, 50)}`);
    }

    // ★ 8-09 C：所有事件回写记忆（chat 推送成功的 + internal）——bot 记得自己在做什么
    // ★ 8-29 拆分：回写用户看到的内容（message ?? content）——她记得自己对轻月说过的话
    await this.writebackToMemory(evt.message ?? evt.content);

    // ⑤ 事件驱动调度：nextEventAt = now + next_in_hours（LLM 建议，钳制 30min-8h；
    //    未给 → 默认 2h ± 抖动由 scheduleNextEvent 兜底）
    this.state.nextEventAt = Date.now() + this.clampIntervalHours(evt.next_in_hours);
    this.saveState();
    this.scheduleNextEvent();
  }

  // ── ★ 8-28 意图到期处理（ai-life-intent-system）─────────────────

  /** 扫描到期意图并处理：
   *  - proactive-contact：直接推送（事件生成时已表达"想对轻月说的话"）
   *  - delayed-reply / promise：★ 8-28 三选一裁决（promise-obligation-loop）——
   *    fulfill 兑现推送 / defer 延期重排（上限 2 次，超限强制兑现）/ cancel 取消并推送歉意说明
   *  成功 → completed（不重复触发）；失败 → 保留 pending 下次 tick 再查 */
  private async processDueIntents(now: Date): Promise<void> {
    try {
      const due = this.memoryManager.listDueIntents(now.getTime()) as Array<{ id: string; type: string; content: string; triggerAt: number; source: string; sessionId: string; evidence: string; deferCount: number }>;
      if (due.length === 0) return;
      for (const intent of due) {
        try {
          if (intent.type === 'proactive-contact') {
            // 主动联系候选：直接推送（事件生成时已表达的内容）
            const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, intent.content);
            if (ok) {
              this.memoryManager.completeIntent(intent.id);
              logger.info(`[Intent] due proactive-contact fulfilled → completed: ${intent.content.slice(0, 40)}`);
            } else {
              logger.info(`[Intent] due proactive-contact push failed, keep pending`);
            }
            continue;
          }

          // delayed-reply / promise：三选一裁决
          const decision = await this.decideIntent(intent);
          if (decision.action === 'defer' && intent.deferCount < 2) {
            // 延期：推送延期说明 + 重排 trigger_at
            const delayMs = (decision.delayHours ?? 6) * 3_600_000;
            const nextAt = Date.now() + Math.max(1, Math.min(72, delayMs / 3_600_000)) * 3_600_000;
            this.memoryManager.deferIntent(intent.id, nextAt);
            await this.qqOff.sendProactive(this.opts.ownerOpenid, decision.content || `那件事我还没准备好，再给我一点时间…`);
            logger.info(`[Intent] due ${intent.type} deferred (+${Math.round(delayMs / 3_600_000)}h): ${intent.content.slice(0, 30)}`);
            continue;
          }
          if (decision.action === 'cancel') {
            // 取消：推送歉意说明（不静默消失）
            await this.qqOff.sendProactive(this.opts.ownerOpenid, decision.content || `之前说的那件事，我可能做不到了，抱歉…`);
            this.memoryManager.completeIntent(intent.id);
            logger.info(`[Intent] due ${intent.type} cancelled with notice: ${intent.content.slice(0, 30)}`);
            continue;
          }
          // fulfill（或延期超限强制兑现）
          const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, decision.content || intent.content);
          if (ok) {
            this.memoryManager.completeIntent(intent.id);
            logger.info(`[Intent] due ${intent.type} fulfilled → completed: ${intent.content.slice(0, 40)}`);
          } else {
            logger.info(`[Intent] due ${intent.type} push failed, keep pending: ${intent.content.slice(0, 40)}`);
          }
        } catch (err: any) {
          logger.warn(`[Intent] due ${intent.type} processing failed, keep pending: ${err.message}`);
        }
      }
    } catch (err: any) {
      logger.warn(`[Intent] due scan failed: ${err.message}`);
    }
  }

  /** ★ 8-28 承诺裁决（promise-obligation-loop）：调 generateIntentMessage 裁决回调，
   *  输入承诺原文/内容/当前状态/延期次数 → 返回 {action: fulfill|defer|cancel, content, delay_hours?}。
   *  解析失败 → 兜底 fulfill（推原文，不丢承诺）。 */
  private async decideIntent(intent: { id: string; type: string; content: string; evidence: string; deferCount: number }): Promise<{ action: 'fulfill' | 'defer' | 'cancel'; content?: string; delayHours?: number }> {
    const fallback = { action: 'fulfill' as const, content: intent.content };
    try {
      if (!this.opts.generateIntentMessage) return fallback;
      const snapshot = this.memoryManager.getLifeSnapshot();
      const ctx = [
        `【你当初的承诺】${intent.evidence || intent.content}`,
        `【承诺内容】${intent.content}`,
        `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
        intent.deferCount > 0 ? `【已延期次数】${intent.deferCount} 次（最多 2 次，第 3 次到期必须兑现或取消）` : '',
        intent.type === 'delayed-reply' ? '这是你答应过"想想再答复"的事——此刻该给轻月一个答复了。' : '这是你答应过轻月的承诺——此刻该兑现了。',
      ].join('\n');
      const raw = ((await this.opts.generateIntentMessage(ctx)) ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return fallback;
      const action = ['fulfill', 'defer', 'cancel'].includes(String(parsed.action)) ? parsed.action as 'fulfill' | 'defer' | 'cancel' : 'fulfill';
      return {
        action,
        content: typeof parsed.content === 'string' && parsed.content.trim() ? parsed.content.trim().slice(0, 200) : undefined,
        delayHours: Number(parsed.delay_hours) > 0 ? Math.max(1, Math.min(72, Number(parsed.delay_hours))) : undefined,
      };
    } catch (err: any) {
      logger.warn(`[Intent] decide failed, fallback fulfill: ${err.message}`);
      return fallback;
    }
  }

  // ── ★ 8-27 对话余波（conversation-follow-up 简化）──────────────

  /** 聊完天 15min 后（窗口 15min-3h）且最近 3h 无余波 → 生成 internal 余波（origin='followup'，不推送）。
   *  余波回写记忆、参与 mood_value 与在场推导，让角色的生活与对话自然衔接。 */
  private async maybeGenerateFollowUp(now: Date): Promise<void> {
    try {
      const since24h = new Date(now.getTime() - 24 * 3_600_000);
      const msgs = this.memoryManager.getRecentMessages(this.sessionId(), 200, since24h)
        .filter((m: any) => m.role === 'user') as Array<{ createdAt: string; content: string }>;
      if (msgs.length === 0) return;
      // 最近一条 user 消息（无 createdAt 的 mock/异常行 → 跳过，不误触）
      let last = msgs[0];
      for (const m of msgs) if (new Date(m.createdAt) > new Date(last.createdAt)) last = m;
      const lastTime = new Date(last.createdAt).getTime();
      if (!Number.isFinite(lastTime)) return;
      const minutesSince = (now.getTime() - lastTime) / 60_000;
      if (minutesSince < 15 || minutesSince > 180) return; // 15min 后才生成，超 3h 窗口关闭

      // 最近 3h 已有余波 → 跳过（去重）
      const since3h = new Date(now.getTime() - 3 * 3_600_000).toISOString();
      const recentFollowUps = (this.memoryManager.listLifeEvents(1) as any[])
        .filter((e: any) => e.origin === 'followup' && e.createdAt >= since3h);
      if (recentFollowUps.length > 0) return;

      const evt = await this.generateEvent(false, undefined, true);
      if (!evt) return;
      this.memoryManager.recordLifeEvent({
        type: 'internal',
        content: evt.content,
        moodDelta: evt.mood_delta,
        referenceEventId: evt.reference_event_id,
        wbEntryId: evt.wb_entry_id,
        origin: 'followup',
      });
      this.updatePresenceFromEvent(evt.content);
      this.updateMoodValue(evt.mood_shift, now);
      await this.writebackToMemory(evt.content);
      logger.info(`[Life] follow-up event: ${evt.content.slice(0, 50)}`);
    } catch (err: any) {
      logger.warn(`[Life] follow-up generation failed: ${err.message}`);
    }
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

  /** 回写主动消息到 EventStore（assistant 角色）。
   *  ★ 8-28 视角标记（memory-character-perspective）：生活事件标 perspective='self'——
   *  向量检索可区分"昔涟自己的生活"与"和用户的互动" */
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
        perspective: 'self',
      });
      logger.debug('[Life] written back to memory (assistant, perspective=self)');
    } catch (err: any) {
      logger.warn(`[Life] writeback failed: ${err.message}`);
    }
  }

  // ── 事件生成 ────────────────────────────────────────

  /** ★ 8-27 叙事化重构：生成事件 = 组装 context（在场/心情/约束）→ LLM → post-check 7 条 →
   *  不过则带反馈重试 1 次 → 仍不过回落模板。LLM 失败同样回落模板。
   *  @param followUp - 对话余波模式（origin='followup'，只记录不推送） */
  private async generateEvent(deepNight: boolean, retryFeedback?: string, followUp = false): Promise<{
    content: string; type: 'chat' | 'internal'; mood_delta?: string;
    /** ★ 8-27 情绪净变化 -5..+5（mood_value 累积用，非法按 0） */
    mood_shift?: number;
    reference_event_id?: string; wb_entry_id?: string;
    /** 8-09：LLM 建议的下一事件间隔（小时，0.5-8，钳制在 tick） */
    next_in_hours?: number;
    /** 8-09：延续的上一事件 id（须命中今天事件 ID 集合） */
    continuation_of?: string;
    /** ★ 8-27 Agency Window：此刻是否方便联系轻月（false → 降级 internal 不推送） */
    can_contact?: boolean;
    /** ★ 8-29 事件/对话拆分（life-event-message-split）：type=chat 时对轻月说的话
     *  （第二人称/口语/互动感）——推送 message,content 只是生活叙述入库 */
    message?: string;
    /** ★ 8-28 意图（ai-life-intent-system）：can_contact=false 时存 intent，delay 后重查推送 */
    intent?: { type: 'proactive-contact'; delayHours: number; content: string };
    /** ★ 8-27 模板回落标记：模板事件不参与 post-check（非 LLM 输出） */
    fromTemplate?: boolean;
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

    // ★ 8-28 间隔叙事（life-interval-narrative）：最近事件 = 生活起点——事件覆盖
    //   "从上次事件到现在"的时间（不再只写此刻瞬间）；8h 内 internal 同时承担延续候选
    const lastEventBlock = this.buildLastEventBlock(todayIds);

    // ★ 8-29 独立人格:她惦记的事(未完成的 promise/proactive intent)——愿望驱动生活
    let pendingIntentBlock = '';
    try {
      pendingIntentBlock = (this.memoryManager.listDueIntents(Date.now() + 24 * 3_600_000) as any[])
        .filter((i: any) => i.type === 'proactive-contact' || i.type === 'promise')
        .slice(0, 2)
        .map((i: any) => `- ${i.content.slice(0, 50)}`)
        .join('\n');
    } catch { /* non-fatal */ }

    // ★ 世界书背景（spec §7 ①）：行格式带 [wb: wb_xxx]，LLM 引用时返回 wb_entry_id
    //   ★ 8-27 分层随机已下沉到 getWorldbookSample（life_event 3 + text 2，截断 200）
    const wbSample = this.memoryManager.getWorldbookSample(5);
    const wbIds = new Set(wbSample.map((w: any) => w.id));
    const wbBlock = wbSample.map((w: any) => `- [wb: ${w.id}] ${w.content}`).join('\n');

    // ★ 8-27 在场角色（ScenePresence）：只有在场者可与 LLM 生活交集
    const presentNames = this.memoryManager.listPresentCharacters() as string[];
    const presenceBlock = presentNames.length === 0
      ? '此刻只有你一个人，安安静静的——不要凭空召唤其他角色'
      : `这些配角此刻在你身边/可互动（只与他们交集，列表外的一律不出现）：\n${presentNames.map(n => `- ${n}`).join('\n')}`;

    // ★ 8-27 心情块（情绪惯性）：mood_value 极性 + 8-29 mood_note 氛围描述影响事件风格
    const moodBlock = this.buildMoodBlock(snapshot.moodValue ?? 0, snapshot.moodNote ?? '');

    // ★ 今天已主动联系内容（ProactiveService 感知，避免重复打扰）
    const todayActive = this.opts.todayProactive?.() ?? '';

    const context = [
      `【当前时间】${formatLocalTime()}`,
      // ★ 8-29 特定时间/节日:事件生成自然带节日氛围或对轻月的节日心意(不再是独立打卡)
      this.opts.todaySpecial?.() ? `【今天是什么日子】今天是${this.opts.todaySpecial()}——事件可以自然带上节日的气息,如果想到轻月,节日的分享可以是事件的一部分。` : '',
      // ★ 8-29 触发时间联动(日常状态决定下次事件何时来——实测 LLM 全给默认值,明确映射修正)
      '【间隔建议】next_in_hours 由你此刻的状态决定,不要给固定值:正沉浸在一件事里(书没看完/活没干完)→ 3-8h;刚做完事、有点无聊、或想找轻月聊天 → 0.5-2h;忙手头的事但想到了轻月 → 2-4h。',
      `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
      `【心情】${moodBlock}`,
      `【亲密度】与轻月: ${snapshot.intimacy}/100`,
      `【今天的生活】${todayBlock || '（还没有特别的事）'}`,
      `【你的人设背景】${wbBlock || '（暂无）'}`,
      `【在场角色】${presenceBlock}`,
      // ★ 8-29 独立人格:移除【轻月最近】(她的生活不围绕轻月)——轻月只在 chat 分享/偶发想念中出现
      // 【你惦记的事】(未完成的 intent):她的愿望驱动生活,不是随机开新
      pendingIntentBlock ? `【你惦记的事】${pendingIntentBlock}——这些是你自己惦记的事,可以自然地推进它们。` : '',
      // ★ 8-28 间隔叙事：上次事件 → 现在的生活补写（HDSI advance 式）
      lastEventBlock ? `【上次事件】${lastEventBlock}` : '',
      todayActive ? `【今天已主动联系】今天已经发过: ${todayActive}。请聚焦生活日常本身，不要生成同类问候/祝福内容。` : '',
      // ★ 8-28 深夜抑制关闭：深夜不再强制 internal——只提示时辰节奏，类型交 LLM 自然判断
      deepNight ? '【注意】现在是深夜，夜已深了——生活节奏安静下来（可能还在忙手头的事，也可能准备睡了）。' : '',
      // ★ 8-27 对话余波任务（followUp 模式）
      followUp ? '【任务】这是你刚和轻月聊完天后的片刻余波——此刻你的内心在想什么（1-2 句，第一人称内心独白）。不推送、不问候、不需要说给轻月听；安静地记录这一刻（如"想到刚才说的话，有点不好意思"）。' : '',
      // ★ 8-28 生活切片示范（life-event-micro-narrative）：平实具体的生活味参考——平凡物件、
      //   具体时辰、伴随小动作、小意外转折；拒绝纯文学意象堆砌
      '【生活切片示范】（参考这种"活人感"平实风格，不要照抄内容）\n"下午起风了，窗台的多肉被吹得晃。我起身去关窗，顺手把晾了三天没收的袜子收了——指尖碰到布料的潮意，才想起昨天忘收衣服。叠好放进柜子，又坐回沙发，茶几上那个苹果放了几天，皮有点皱了，我拿起来又放回去。"',
      // ★ 8-27 post-check 反馈重试
      retryFeedback ? `【修正提示】上次生成未通过校验：${retryFeedback}。请按提示重新生成。` : '',
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
        //   裸文本直接作为事件内容；type 默认 chat（★ 8-28 深夜不再强制 internal）
        logger.info(`[Life] bare-text event from LLM (no JSON shell): ${text.slice(0, 100)}`);
        return { content: text, type: 'chat' };
      }
      if (parsed.content) {
        // ★ 防幻觉（终审修复）：reference_event_id 必须命中今天事件 ID 集合，wb_entry_id 必须命中采样世界书 ID
        const refId = parsed.reference_event_id ? String(parsed.reference_event_id) : undefined;
        const wbId = parsed.wb_entry_id ? String(parsed.wb_entry_id) : undefined;
        const contId = parsed.continuation_of ? String(parsed.continuation_of) : undefined;
        const nextHours = Number(parsed.next_in_hours);
        // ★ 8-27 mood_shift 钳制 -5..+5（非法忽略）；can_contact 默认 true
        const shift = Number(parsed.mood_shift);
        // ★ 8-28 意图解析（ai-life-intent-system）：事件 JSON intent 字段 → 存 intent 重查
        //   ★ 8-29 拆分：intent.content 缺失时用 message（对轻月说的话）兜底
        const intent = parsed.intent;
        const parsedIntent = intent && typeof intent === 'object' && intent.type === 'proactive-contact'
          ? {
              type: 'proactive-contact' as const,
              delayHours: Math.max(0.5, Math.min(72, Number(intent.delay_hours) || 1)),
              content: String(intent.content ?? parsed.message ?? '').trim(),
            }
          : undefined;
        return {
          content: String(parsed.content).trim(),
          // ★ 8-28 深夜抑制关闭：type 完全交 LLM（深夜也可以是想分享的话，can_contact 兜底）
          type: parsed.type === 'chat' ? 'chat' : 'internal',
          mood_delta: parsed.mood_delta ? String(parsed.mood_delta) : undefined,
          mood_shift: isFinite(shift) ? Math.max(-5, Math.min(5, Math.round(shift))) : undefined,
          reference_event_id: refId && todayIds.has(refId) ? refId : undefined,
          wb_entry_id: wbId && wbIds.has(wbId) ? wbId : undefined,
          // 8-09：next_in_hours 钳制在 tick（clampIntervalHours）；continuation_of 须命中今天事件
          next_in_hours: isFinite(nextHours) ? nextHours : undefined,
          continuation_of: contId && todayIds.has(contId) ? contId : undefined,
          can_contact: parsed.agency?.can_contact === false ? false : true,
          // ★ 8-29 事件/对话拆分：message = 对轻月说的话(仅 chat 时有效,截断 200)
          message: parsed.type === 'chat' && parsed.message ? String(parsed.message).trim().slice(0, 200) : undefined,
          intent: parsedIntent,
        };
      }
    } catch (err: any) {
      logger.warn(`[Life] LLM event generation failed, fallback to template: ${err.message}`);
    }

    // 失败回落：通用模板加权随机（无角色特色；角色特色事件由 LLM 结合世界书自创）
    // ★ 8-09 修复：模板事件强制 internal——模板文案无剧情链，推送会造成"上下文断裂"
    //   观感（7-16 实测用户收到"听到楼下琴声"与画云剧情链脱节）
    // ★ 8-27 在场角色组优先（在场无迷迷 → 不回落"迷迷"组模板）
    const t = this.pickTemplate(presentNames);
    if (t) return { content: t.activity, type: 'internal', mood_delta: '平静', can_contact: false, fromTemplate: true };
    return null;
  }

  // ── ★ 8-27 情绪惯性（mood_value）───────────────────

  /** 【心情】块：mood_value 极性 + ★ 8-29 侧端分析 mood_note（深度阈值后的描述性氛围） */
  private buildMoodBlock(mv: number, moodNote: string = ''): string {
    const note = moodNote ? `；${moodNote}` : '';
    if (mv >= 15) return `情绪累积: +${mv}（最近心情偏开心——事件可以明亮、有暖意）${note}`;
    if (mv <= -15) return `情绪累积: ${mv}（最近心情偏低沉——事件可以安静、柔软一些）${note}`;
    return `情绪累积: ${mv}（心情平稳）${note}`;
  }

  /** mood_value 累积：同方向加成 / 反方向衰减 / 8h 回归 0（按事件间隔线性回归）。
   *  shift -5..+5（来自事件 JSON mood_shift，非法按 0）。联动 mood 文本极性。 */
  private updateMoodValue(shift?: number, now: Date = new Date()): void {
    try {
      const snapshot = this.memoryManager.getLifeSnapshot();
      const prevVal = snapshot.moodValue ?? 0;
      const prevPolar = prevVal >= 15 ? 'pos' : prevVal <= -15 ? 'neg' : 'flat';
      let mv = prevVal;
      const lastAt = snapshot.updatedAt ? new Date(snapshot.updatedAt).getTime() : 0;
      // 8h 回归：距上次 mood 更新 elapsed → 向 0 线性回归（满 8h 归 0）
      if (lastAt > 0) {
        const elapsed = Math.min(1, (now.getTime() - lastAt) / (8 * 3_600_000));
        if (elapsed > 0) mv = Math.round(mv - mv * elapsed);
      }
      const s = Math.max(-5, Math.min(5, Math.round(shift ?? 0)));
      if (s !== 0) {
        if (mv > 0 && s < 0) mv = Math.round(mv * 0.5) + s;   // 反方向：先衰减再反向
        else if (mv < 0 && s > 0) mv = Math.round(mv * 0.5) + s;
        else mv = mv + Math.round(s * 1.5);                    // 同方向加成
      }
      mv = Math.max(-100, Math.min(100, mv));
      // mood 文本联动极性（与 LifeView 心情映射兼容：平静/开心/低落）
      const moodText = mv >= 15 ? '开心' : mv <= -15 ? '低落' : '平静';
      // ★ 8-29 侧端分析（mood-side-analysis）：深度阈值 |mv|≥30 且 6h 冷却 → fire-and-forget
      //   生成描述性氛围 mood_note；回落到 |mv|<30 → 清空
      let moodNote = snapshot.moodNote ?? '';
      if (Math.abs(mv) >= 30 && !moodNote && now.getTime() - this.state.moodNoteAnalyzedAt > 6 * 3_600_000) {
        this.state.moodNoteAnalyzedAt = now.getTime();
        this.saveState();
        this.analyzeMoodNote(mv, now); // fire-and-forget
      } else if (Math.abs(mv) < 30 && moodNote) {
        moodNote = '';
        logger.info('[Life] mood_note cleared (|mood_value| < 30)');
      }
      this.memoryManager.updateLifeState({ moodValue: mv, mood: moodText, moodNote });
      // ★ 8-28 情绪惯性漂移（memory-character-perspective）：极性跨 ±15 阈值变化 →
      //   触发人格自然漂移（连续开心 → playfulness、连续低落 → empathy，走 5 道护栏）
      const newPolar = mv >= 15 ? 'pos' : mv <= -15 ? 'neg' : 'flat';
      if (prevPolar !== newPolar && newPolar !== 'flat') {
        const applied = this.memoryManager.adjustPersonaFromMood?.(mv) ?? false;
        logger.info(`[Life] mood polarity ${prevPolar} → ${newPolar} (mood_value ${snapshot.moodValue} → ${mv}): persona drift ${applied ? 'applied' : 'blocked by guards'}`);
      }
      logger.debug(`[Life] mood_value ${snapshot.moodValue} → ${mv} (shift ${s})`);
    } catch (err: any) {
      logger.warn(`[Life] mood_value update failed: ${err.message}`);
    }
  }

  /** ★ 8-29 情绪侧端分析（mood-side-analysis）：mood_value 深度阈值后,LLM 根据最近生活
   *  生成一句描述性氛围（"这段日子…"），注入【心情】块影响事件风格与对话。失败不阻塞（冷却后重试）。 */
  private async analyzeMoodNote(mv: number, now: Date): Promise<void> {
    try {
      if (!this.opts.generateMoodNote) return;
      const recentEvents = (this.memoryManager.listLifeEvents(2) as any[])
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5)
        .map((e: any) => `- ${e.content.slice(0, 50)}`)
        .join('\n');
      const note = ((await this.opts.generateMoodNote(
        `【当前情绪累积】${mv}（正=开心，负=低落）\n【最近的生活】\n${recentEvents || '（暂无）'}\n请用一句 30 字以内的话描述这段日子你的情绪氛围（第一人称，自然，如"这段日子心里像落了雨，做什么都提不起劲"；也可以写暖的）。`,
      )) ?? '').trim().slice(0, 60);
      if (note) {
        this.memoryManager.updateLifeState({ moodNote: note });
        logger.info(`[Life] mood_note: ${note}`);
      } else {
        logger.info('[Life] mood_note analysis returned empty, will retry after cooldown');
      }
    } catch (err: any) {
      logger.warn(`[Life] mood_note analysis failed: ${err.message}`);
    }
  }

  // ── ★ 8-27 配角在场（ScenePresence）─────────────────

  /** 世界书配角名单：事件内容提到谁 → 在场推导；post-check ⑦ 校验不在场角色不出现 */
  private static KNOWN_CHARS = [
    '迷迷', '风堇', '遐蝶', '白厄', '那刻夏', '万敌',
    '三月七', '丹恒', '开拓者', '荒笛', '来古士', '德谬歌',
  ] as const;

  /** 事件入库后：内容提到谁 → present（带依据）；随后巡检 present 超 24h 无更新 → off-scene */
  private updatePresenceFromEvent(content: string): void {
    try {
      for (const name of LifeService.KNOWN_CHARS) {
        if (content.includes(name)) {
          this.memoryManager.upsertScenePresence(name, 'present', content.slice(0, 50));
        }
      }
      // 巡检：在场角色 24h 无提及 → 降级离场（生活自然推移）
      const now = Date.now();
      const presence = this.memoryManager.listScenePresence() as Array<{ name: string; status: string; updatedAt: string }>;
      for (const p of presence) {
        if (p.status === 'present' && now - new Date(p.updatedAt).getTime() > 24 * 3_600_000) {
          this.memoryManager.upsertScenePresence(p.name, 'off-scene');
          logger.debug(`[Life] ${p.name} left scene (24h no mention)`);
        }
      }
    } catch (err: any) {
      logger.warn(`[Life] presence update failed: ${err.message}`);
    }
  }

  // ── ★ 8-27 post-check 7 条校验 ─────────────────────

  /** 生成后规则校验；返回 { ok, feedback }。不过 → 带反馈重试 1 次 → 回落模板 */
  private postCheck(
    evt: { content: string; type: string; message?: string },
    todayEvents: Array<{ content: string; type: string }>,
    presentNames: string[],
  ): { ok: boolean; feedback: string } {
    const c = evt.content.trim();
    // ① 长度 ≤ 150 字（★ 8-28 微叙事放宽：2-4 句生活切片，原 80 字只够一句快照）
    if (c.length > 150) return { ok: false, feedback: '内容超过 150 字，收成一个生活小片段（2-4 句）' };
    // ② 不硬设定：设定词条黑名单（生活事件里出现即生硬罗列）
    const HARD_SETTING_WORDS = ['黄金裔', '火种', '泰坦', '铁幕', '轮回', '因子', '神权', '负世', '岁月'];
    for (const w of HARD_SETTING_WORDS) {
      if (c.includes(w)) return { ok: false, feedback: `不要生硬罗列设定词"${w}"，把背景融入生活细节` };
    }
    // ③ 对话感：chat 是分享不是报备
    if (evt.type === 'chat') {
      const REPORT_WORDS = ['汇报', '通知', '特此', '以下是', '综上所述'];
      for (const w of REPORT_WORDS) {
        if (c.includes(w)) return { ok: false, feedback: '这是对轻月的分享不是报备，去掉公文腔' };
      }
    }
    // ④ 不重复：与今天已有事件（完全相同/前 20 字相同——★ 8-28 微叙事变长，前 12 字误判率高）
    for (const e of todayEvents) {
      const a = e.content.slice(0, 20), b = c.slice(0, 20);
      if (e.content === c || (a && b && a === b)) {
        return { ok: false, feedback: '与今天已有事件重复，换一件不一样的事' };
      }
    }
    // ⑤ 不连续独处：已有连续 ≥3 internal 且本事件仍 internal → 提示互动
    if (evt.type === 'internal' && todayEvents.length >= 3) {
      let streak = 0;
      for (let i = todayEvents.length - 1; i >= 0 && todayEvents[i].type === 'internal'; i--) streak++;
      if (streak >= 3) return { ok: false, feedback: '最近一直在独处，试着写一件和在场角色或轻月的互动' };
    }
    // ⑥ 不引用对话：引号包裹的直接引用 / "你说…""你刚才…"
    if (/[「」""''【】]/.test(c) || /你说|你刚才|你上次/.test(c)) {
      return { ok: false, feedback: '不要引用与轻月的对话内容，过自己的生活' };
    }
    // ⑦ 不在场角色不出现：内容提到的配角必须在场列表内
    const present = new Set(presentNames);
    for (const name of LifeService.KNOWN_CHARS) {
      if (c.includes(name) && !present.has(name)) {
        return { ok: false, feedback: `"${name}"此刻不在场，不要让他/她出现` };
      }
    }
    // ⑧ ★ 8-29 独立人格：internal 事件的动机围绕自己（我想/我需要/我好奇）——
    //   等/为/怕/担心"轻月"是围绕用户,想念只是偶发底色不是事件动机
    if (evt.type === 'internal' && /等(轻月|你)回来|为(轻月|你)|怕(轻月|你)|担心(轻月|你)/.test(c)) {
      return { ok: false, feedback: '这件事的动机应该是你自己（我想/我需要/我好奇），不是围绕轻月——想念只是偶发的底色，不要让它成为每件事的理由' };
    }
    // ⑨ ★ 8-29 拆分：chat 的 message 是对轻月说话——第二人称、口语互动，不是叙述
    if (evt.type === 'chat' && evt.message) {
      const m = evt.message.trim();
      if (m.length > 150) return { ok: false, feedback: 'message（对轻月说的话）超过 150 字，收成一句自然的分享' };
      if (m === c) return { ok: false, feedback: 'message 不能是 content 的复述——message 是对轻月说话（第二人称口语），content 是生活叙述' };
      if (m.includes('她') && !m.includes('他')) {
        return { ok: false, feedback: 'message 是对轻月说话，要用"你"（第二人称），不要用"她"叙述' };
      }
    }
    return { ok: true, feedback: '' };
  }

  /** ★ 8-28 间隔叙事（life-interval-narrative，替代 8-09 延续块）：
   *  最近事件 = 生活起点。事件覆盖"从上次事件到现在"的时间——
   *  - 8h 内 internal 且 30min 无互动 → 同时是延续候选（continuation_of 引导，todayIds 放行）
   *  - 其他 → 间隔补写引导（进展/变化/被打断，停在哪里）
   *  返回形如 "10:00 你在: 泡茶…\n现在距上次事件已过 4 小时——覆盖这中间的时间…" 的引导块；无事件返回空。 */
  private buildLastEventBlock(todayIds: Set<string>): string {
    try {
      const events = (this.memoryManager.listLifeEvents(2) as any[])
        .filter((e: any) => e.origin !== 'followup')
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const latest = events[0];
      if (!latest) return '';
      const lastAt = new Date(latest.createdAt);
      const hoursGap = Math.max(0, Math.round((Date.now() - lastAt.getTime()) / 3_600_000 * 10) / 10);

      // 延续候选：8h 内 internal 且 30min 无用户互动（聊天后重置沉浸）
      const lockMinutes = this.opts.chatLockMinutes ?? 30;
      const recent = this.memoryManager.getRecentMessages(
        this.sessionId(), 100, new Date(Date.now() - lockMinutes * 60_000),
      ).filter((m: any) => m.role === 'user');
      const canContinue = latest.type === 'internal' && Date.now() - lastAt.getTime() < 8 * 3_600_000 && recent.length === 0;
      if (canContinue) {
        // ★ 跨午夜边缘的延续候选 → 加入今天 ID 集合供 continuation_of 防幻觉校验放行
        todayIds.add(latest.id);
        const time = formatLocalTime(lastAt);
        return `${time} 你正在: ${latest.content.slice(0, 60)}\n优先续写推进这件事——它有什么进展、波折或变化（快做完了/卡住了/被别的事打断）；只有当它自然做完了，才开启新的事。续写时 JSON 里 continuation_of 填该事件 id（${latest.id}），开新事则不填。`;
      }
      const time = formatLocalTime(lastAt);
      const gapNote = hoursGap >= 1 ? `（已过 ${hoursGap} 小时）` : '';
      return `${time} 你上次在做: ${latest.content.slice(0, 60)}${gapNote}\n事件要覆盖从上次事件到现在的时间——这中间你经历了什么（进展/变化/被打断/小波折）？现在正停在哪里？不要只写此刻的一瞬间。`;
    } catch {
      return '';
    }
  }

  /** ★ 8-14 加权随机模板（权重越高越常被选中）；空池返回 null。
   *  模板池迁 SQLite（content-self-evolution）：listLifeTemplates 实时读取（seed + self）。
   *  ★ 8-27 在场角色组优先：在场者对应的 group_name 模板优先；无 → 独处/通用池。 */
  private pickTemplate(presentNames: string[] = []): { activity: string; type: 'chat' | 'internal'; category: string } | null {
    const templates = this.memoryManager.listLifeTemplates() ?? [];
    if (templates.length === 0) return null;
    const present = new Set(presentNames);
    const groupPool = templates.filter((t: any) => t.groupName !== 'none' && present.has(t.groupName));
    const pool = groupPool.length > 0
      ? groupPool
      : templates.filter((t: any) => t.category === '独处' || t.groupName === 'none');
    const total = pool.reduce((s: number, t: any) => s + (t.weight ?? 2), 0);
    let r = Math.random() * total;
    for (const t of pool) {
      r -= (t.weight ?? 2);
      if (r <= 0) return t;
    }
    // 数学上不可达：r < total 恒成立（Math.random() ∈ [0,1)），循环内必命中。
    // 保留返回值以满足 TS 控制流分析。
    return pool[0];
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
      // ★ 8-29 独立人格：亲密度加"她主动"维度——她主动推送成功的事件数（delivered=1）
      //   她也有想找你的时刻，关系不单由"你找她的频率"决定
      let selfInitiated = 0;
      try {
        selfInitiated = (this.memoryManager.listLifeEvents(7) as any[])
          .filter((e: any) => e.delivered === 1).length;
      } catch { /* non-fatal */ }
      const activeScore = Math.min(14, userFirst * 3 + selfInitiated * 2);

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
