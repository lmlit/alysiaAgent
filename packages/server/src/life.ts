/**
 * LifeService — AI 主动生活系统
 *
 * 每小时 tick：概率门 → 冷却门 → 聊天锁 → 深夜抑制
 * 通过 LLM（woke 模式）生成生活事件 → 存储 → 可推送事件窗口内推送 + 回写记忆
 * 顺带：亲密度更新、每日摘要生成
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { logger } from '@alysia/core';

// ── 本地时间工具 ─────────────────────────────────────
// core 的 utils/time.ts 未从 @alysia/core/memory 导出（exports map 只暴露
// ./utils/logger），这里内联最小实现，保证 server 包可独立编译运行。
const pad = (n: number) => String(n).padStart(2, '0');

/** 本地日期 key: 2026-08-06 */
function todayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO/UTC 时间字符串 → 本地日期 key（LifeEvent.createdAt 存的是 ISO） */
function dateKeyFromISO(iso: string): string {
  return todayKey(new Date(iso));
}

/** 2026年8月6日 14:30（本地时间，事件生成 prompt 用） */
function formatLocalTime(d: Date = new Date()): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
    const lockMinutes = this.opts.chatLockMinutes ?? 30;
    const recent = this.memoryManager.getRecentMessages(
      this.sessionId(),
      1,
      new Date(now.getTime() - lockMinutes * 60_000),
    );
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

    // 存储 + 更新状态
    this.memoryManager.recordLifeEvent({
      type: evt.type,
      content: evt.content,
      moodDelta: evt.mood_delta,
      referenceEventId: evt.reference_event_id,
    });

    // 推送（chat 类型 + 非深夜 + 48h 窗口由 sendProactive 内部决定）
    if (evt.type === 'chat' && !deepNight) {
      const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, evt.content);
      if (ok) {
        this.state.lastProactiveAt = Date.now();
        this.saveState();
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
  private async generateEvent(deepNight: boolean): Promise<{ content: string; type: 'chat' | 'internal'; mood_delta?: string; reference_event_id?: string } | null> {
    const snapshot = this.memoryManager.getLifeSnapshot();
    const context = [
      `【当前时间】${formatLocalTime()}`,
      `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
      `【亲密度】与轻月: ${snapshot.intimacy}/100`,
      `【今天的生活】${this.memoryManager.getLifeEventInjection() || '（还没有特别的事）'}`,
      `【你的人设背景】${this.memoryManager.getWorldbookSample(5).map((w: any) => `- ${w.content}`).join('\n')}`,
      `【轻月最近】${this.memoryManager.getUserActivitySummary() || '（暂无）'}`,
      deepNight ? '【注意】现在是深夜，只能生成安静的内部事件（发呆/看书/听雨），不要打扰轻月。' : '',
    ].filter(Boolean).join('\n');

    try {
      const text = await this.opts.generateEvent?.(context) ?? '';
      const parsed = JSON.parse(text);
      if (parsed.content) {
        return {
          content: String(parsed.content).trim(),
          type: deepNight ? 'internal' : (parsed.type === 'chat' ? 'chat' : 'internal'),
          mood_delta: parsed.mood_delta ? String(parsed.mood_delta) : undefined,
          reference_event_id: parsed.reference_event_id ? String(parsed.reference_event_id) : undefined,
        };
      }
    } catch (err: any) {
      logger.warn(`[Life] LLM event generation failed, fallback to template: ${err.message}`);
    }

    // 失败回落：通用模板随机（模板文件由 Task 7 提供，缺失时返回 null）
    const templates = this.loadTemplates();
    if (templates.length > 0) {
      const t = templates[Math.floor(Math.random() * templates.length)];
      return { content: t.activity, type: t.type, mood_delta: '平静' };
    }
    return null;
  }

  private loadTemplates(): Array<{ activity: string; type: 'chat' | 'internal'; weight: number }> {
    try {
      return JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'life-templates.json'), 'utf-8'));
    } catch {
      return [];
    }
  }

  // ── 每日摘要生成 ────────────────────────────────────

  private async maybeGenerateDailySummary(now: Date): Promise<void> {
    const today = todayKey(now);
    if (this.state.lastSummaryDate === today) return;
    this.state.lastSummaryDate = today;
    this.saveState();

    // 昨天的摘要（如果有昨天的事件）
    const yesterday = new Date(now.getTime() - 86_400_000);
    const yesterdayKey = todayKey(yesterday);
    const events = this.memoryManager.listLifeEvents(2).filter((e: any) => dateKeyFromISO(e.createdAt) === yesterdayKey);
    if (events.length === 0) return;

    try {
      const text = await this.opts.generateEvent?.(`【任务】把下面这些生活事件压缩成一句 30 字以内的昨天生活摘要，第一人称，温柔自然：\n${events.map((e: any) => `- ${e.content}`).join('\n')}`) ?? '';
      const summary = text.replace(/^["'`]+|["'`]+$/g, '').trim();
      if (summary && summary.length > 5) {
        this.memoryManager.upsertDailySummary(yesterdayKey, summary);
        logger.info(`[Life] daily summary ${yesterdayKey}: ${summary}`);
      }
    } catch (err: any) {
      logger.warn(`[Life] daily summary failed: ${err.message}`);
    }
  }

  // ── 亲密度 ──────────────────────────────────────────

  /** 互动数据推导 0-100：频率 + 时长 + 主动占比。
   *  数据来自 getRecentMessages（近 7 天最多 500 条，无时间戳，按消息数近似天数）。 */
  updateIntimacy(): void {
    try {
      const since7d = new Date(Date.now() - 7 * 86_400_000);
      const msgs = this.memoryManager.getRecentMessages(this.sessionId(), 500, since7d);

      // 频率：近 7 天活跃度（消息数近似，0 条 → 0，40 条 → 35 封顶）
      const freqScore = Math.min(35, msgs.length / 4 * 5);

      // 时长：>20 条视为有长会话
      const longScore = Math.min(21, (msgs.length > 20 ? 10 : msgs.length / 2) * 2);

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
