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
  /** 每小时触发概率 0-1，默认 0.3 */
  probability?: number;
  /** 主动推送冷却（小时），默认 2 */
  cooldownHours?: number;
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
  /** 去重状态持久化文件 */
  stateFile?: string;
}

interface LifeState {
  lastProactiveAt: number;
  lastSummaryDate: string | null;
}

export class LifeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: LifeState = { lastProactiveAt: 0, lastSummaryDate: null };

  constructor(
    private memoryManager: any,
    private qqOff: any,
    private opts: LifeOpts,
  ) {
    this.loadState();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(err => logger.error('[Life] tick:', err));
    }, 60 * 60_000); // 每小时
    logger.info('[Life] service started (hourly life events)');
    this.tick().catch(err => logger.error('[Life] tick:', err));
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.saveState();
  }

  // ── 状态持久化（冷却/摘要去重）────────────────────────

  private loadState(): void {
    if (!this.opts.stateFile) return;
    try {
      const s = JSON.parse(readFileSync(this.opts.stateFile, 'utf-8'));
      this.state = { lastProactiveAt: s.lastProactiveAt ?? 0, lastSummaryDate: s.lastSummaryDate ?? null };
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

    // 每日摘要生成（跨天检测）
    await this.maybeGenerateDailySummary(now);

    // 亲密度更新
    this.updateIntimacy();

    // ① 概率门
    if (Math.random() > (this.opts.probability ?? 0.3)) return;

    // ② 冷却门
    const cooldownMs = (this.opts.cooldownHours ?? 2) * 3_600_000;
    if (now.getTime() - this.state.lastProactiveAt < cooldownMs) return;

    // ③ 聊天锁：最近 chatLockMinutes 有用户互动则跳过
    //    只认 user 角色——AI 主动消息回写的 assistant 消息不算"互动"，否则 cooldownHours < 1 时自锁
    const lockMinutes = this.opts.chatLockMinutes ?? 30;
    const recent = this.memoryManager.getRecentMessages(
      this.sessionId(),
      100,
      new Date(now.getTime() - lockMinutes * 60_000),
    ).filter((m: any) => m.role === 'user');
    if (recent.length > 0) {
      logger.debug(`[Life] skipped — user active within ${lockMinutes}min`);
      return;
    }

    // ④ 深夜抑制
    const [deepStart, deepEnd] = this.opts.deepNightHours ?? [0, 7];
    const hour = now.getHours();
    const deepNight = hour >= deepStart && hour < deepEnd;

    // 生成事件
    const evt = await this.generateEvent(deepNight);
    if (!evt) return;

    // 存储 + 更新状态（recordLifeEvent 返回事件 id，供推送成功后标记 delivered）
    const evtId = this.memoryManager.recordLifeEvent({
      type: evt.type,
      content: evt.content,
      moodDelta: evt.mood_delta,
      referenceEventId: evt.reference_event_id,
      wbEntryId: evt.wb_entry_id,
    });

    // ★ 世界书命中统计（spec §7 ②）：事件引用了世界书条目 → hit_count+1
    if (evt.wb_entry_id) this.memoryManager.bumpWorldbookHit(evt.wb_entry_id);

    // 推送（chat 类型 + 非深夜 + 48h 窗口由 sendProactive 内部决定）
    if (evt.type === 'chat' && !deepNight) {
      const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, evt.content);
      if (ok) {
        this.state.lastProactiveAt = Date.now();
        this.saveState();
        // ★ delivered=1（spec §5）：推送成功标记，Web 端可区分已推送/未推送
        if (evtId) this.memoryManager.markLifeEventDelivered(evtId);
        // 回写记忆（assistant 角色）——用户回复时 AI 记得自己说过
        await this.writebackToMemory(evt.content);
        logger.info(`[Life] pushed: ${evt.content.slice(0, 50)}`);
      } else {
        logger.info(`[Life] push failed (window closed?): ${evt.content.slice(0, 50)}`);
      }
    } else {
      logger.debug(`[Life] internal event (${deepNight ? 'deep night' : 'internal'}): ${evt.content.slice(0, 50)}`);
    }
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
  private async generateEvent(deepNight: boolean): Promise<{ content: string; type: 'chat' | 'internal'; mood_delta?: string; reference_event_id?: string; wb_entry_id?: string } | null> {
    const snapshot = this.memoryManager.getLifeSnapshot();

    // ★ 剧情链（spec §8）：今天的事件逐条带 [id: life-xxx] 注入（LLM 只能引用今天的事件），
    //   近 7 天摘要不带 ID（summary 行仅作回顾，不可被引用）
    const todayKey = localDateKey();
    const todayEvents = this.memoryManager.listLifeEvents(2)
      .filter((e: any) => localDateKeyFromISO(e.createdAt) === todayKey);
    const todayIds = new Set(todayEvents.map((e: any) => e.id));
    const todayLines = todayEvents.map((e: any) =>
      `[id: ${e.id}] ${formatLocalTime(new Date(e.createdAt)).slice(-5)} ${e.content}`);
    const summaries = this.memoryManager.listLifeSummaries(7)
      .filter((s: any) => s.date !== todayKey)
      .map((s: any) => `- ${s.date}: ${s.summary}`);
    const todayBlock = [...todayLines, ...summaries].join('\n');

    // ★ 世界书背景（spec §7 ①）：行格式带 [wb: wb_xxx]，LLM 引用时返回 wb_entry_id
    const wbSample = this.memoryManager.getWorldbookSample(5);
    const wbIds = new Set(wbSample.map((w: any) => w.id));
    const wbBlock = wbSample.map((w: any) => `- [wb: ${w.id}] ${w.content}`).join('\n');

    const context = [
      `【当前时间】${formatLocalTime()}`,
      `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
      `【亲密度】与轻月: ${snapshot.intimacy}/100`,
      `【今天的生活】${todayBlock || '（还没有特别的事）'}`,
      `【你的人设背景】${wbBlock || '（暂无）'}`,
      `【轻月最近】${this.memoryManager.getUserActivitySummary() || '（暂无）'}`,
      deepNight ? '【注意】现在是深夜，只能生成安静的内部事件（发呆/看书/听雨），不要打扰轻月。' : '',
    ].filter(Boolean).join('\n');

    try {
      const text = ((await this.opts.generateEvent?.(context)) ?? '')
        .replace(/^```(?:json)?\s*|\s*```$/g, '').trim(); // 剥离 markdown fence（LLM 常包 ```json）
      const parsed = JSON.parse(text);
      if (parsed.content) {
        // ★ 防幻觉（终审修复）：reference_event_id 必须命中今天事件 ID 集合，wb_entry_id 必须命中采样世界书 ID
        const refId = parsed.reference_event_id ? String(parsed.reference_event_id) : undefined;
        const wbId = parsed.wb_entry_id ? String(parsed.wb_entry_id) : undefined;
        return {
          content: String(parsed.content).trim(),
          type: deepNight ? 'internal' : (parsed.type === 'chat' ? 'chat' : 'internal'),
          mood_delta: parsed.mood_delta ? String(parsed.mood_delta) : undefined,
          reference_event_id: refId && todayIds.has(refId) ? refId : undefined,
          wb_entry_id: wbId && wbIds.has(wbId) ? wbId : undefined,
        };
      }
    } catch (err: any) {
      logger.warn(`[Life] LLM event generation failed, fallback to template: ${err.message}`);
    }

    // 失败回落：通用模板加权随机（无角色特色；角色特色事件由 LLM 结合世界书自创）
    const t = this.pickTemplate();
    if (t) return { content: t.activity, type: t.type, mood_delta: '平静' };
    return null;
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
   *  ★ spec §11 衰减：近 3 天无互动每天 -2（作用于频率分），下限 10。 */
  updateIntimacy(): void {
    try {
      const since7d = new Date(Date.now() - 7 * 86_400_000);
      const msgs = this.memoryManager.getRecentMessages(this.sessionId(), 500, since7d);

      // 频率：近 7 天活跃度（消息数近似，0 条 → 0，40 条 → 35 封顶）
      let freqScore = Math.min(35, msgs.length / 4 * 5);

      // ★ 无互动衰减（spec §11）：取最后一条 user 消息时间；无 user 消息按窗口上限 7 天计
      const lastUserMsg = [...msgs].reverse().find((m: any) => m.role === 'user');
      const lastUserAt = lastUserMsg?.createdAt ? new Date(lastUserMsg.createdAt).getTime() : 0;
      const idleDays = lastUserAt ? Math.floor((Date.now() - lastUserAt) / 86_400_000) : 7;
      if (idleDays >= 3) {
        freqScore = Math.max(0, freqScore - 2 * idleDays);
        logger.debug(`[Life] intimacy decay: ${idleDays}d idle, freqScore ${Math.min(35, msgs.length / 4 * 5)} → ${freqScore}`);
      }

      // 时长：>20 条视为有长会话（封顶 21；旧实现 (n>20?10:n/2)*2 最大只到 20，达不到上限）
      const longScore = Math.min(21, msgs.length > 20 ? 21 : msgs.length * 1.05);

      // 主动占比：用户消息首条占比（连续 user 消息只计一条）
      const userFirst = msgs.filter((m: any, i: number) => m.role === 'user' && (i === 0 || msgs[i - 1]?.role !== 'user')).length;
      const activeScore = Math.min(14, userFirst * 3);

      const base = 30;
      const intimacy = Math.max(10, Math.min(100, base + freqScore + longScore + activeScore));
      this.memoryManager.updateLifeState({ intimacy });
      logger.debug(`[Life] intimacy = ${intimacy}`);
    } catch (err: any) {
      logger.warn(`[Life] intimacy update failed: ${err.message}`);
    }
  }
}
