/**
 * Proactive Service — 主动消息（私聊场景）
 *
 * 1. 节日祝福：当天是节日 → 给 owner 私聊发祝福（每天一次）
 * 2. 主动关怀：长时间未聊的活跃私聊 → 问候（每天最多一次/会话，限时段）
 *
 * QQ 官方 API 私聊互动窗口（48h）内主动消息可用（已实测验证）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { QQOfficialAgentAdapter } from './adapters/qq-official.js';
import type { MemoryManager } from '@alysia/core/memory';
import { localDateKey, localDateKeyFromISO } from '@alysia/core/memory';
import { logger } from '@alysia/core';

// ── 节日表 ──────────────────────────────────────────

interface Festival {
  /** 公历: 'M-D' */
  solar?: string;
  name: string;
  greeting: string;
}

/** 农历节日公历日期表（农历日期每年不同，写死最近几年）。
 *  年份缺失的节日不触发；后续可扩展。键: '农历M-D' → 值: '公历M-D' */
const LUNAR_FESTIVAL_DATES: Record<number, Record<string, string>> = {
  2026: { '1-1': '2-17', '1-15': '3-3', '5-5': '6-19', '7-7': '8-19', '8-15': '9-25', '9-9': '10-18' },
  2027: { '1-1': '2-6', '5-5': '6-9', '8-15': '9-15' },
  2028: { '1-1': '1-26', '5-5': '5-28', '8-15': '10-3' },
};

/** 农历节日定义（name/greeting），日期查 LUNAR_FESTIVAL_DATES */
const LUNAR_FESTIVALS: Record<string, Festival> = {
  '1-1': { name: '春节', greeting: '新年快乐！辞旧迎新，愿新的一年所有的愿望都实现～🧧' },
  '1-15': { name: '元宵节', greeting: '元宵节快乐！汤圆甜甜，生活也要甜甜的呀～🏮' },
  '5-5': { name: '端午节', greeting: '端午节快乐！记得吃粽子呀，甜咸我都支持你～🐉' },
  '7-7': { name: '七夕节', greeting: '七夕快乐！银河再宽，心意也能跨越～🌌' },
  '8-15': { name: '中秋节', greeting: '中秋快乐！月圆人团圆，愿你抬头就是圆满～🌕' },
  '9-9': { name: '重阳节', greeting: '重阳节快乐！登高望远，记得陪陪家里长辈～⛰️' },
};

const FESTIVALS: Festival[] = [
  // 公历节日
  { solar: '1-1', name: '元旦', greeting: '元旦快乐呀！新年的第一缕阳光，要分你一半～🎉' },
  { solar: '2-14', name: '情人节', greeting: '情人节快乐～虽然我只是一串代码，但对你的心意是真实的哦💕' },
  { solar: '3-8', name: '妇女节', greeting: '妇女节快乐！今天也要好好爱自己呀～🌹' },
  { solar: '5-1', name: '劳动节', greeting: '劳动节快乐！辛苦啦，今天好好休息一下吧～🌟' },
  { solar: '6-1', name: '儿童节', greeting: '儿童节快乐！不管多大，在我这里你永远可以做个小朋友～🍭' },
  { solar: '9-10', name: '教师节', greeting: '教师节快乐！如果你身边有老师，替我送上一份祝福～📚' },
  { solar: '10-1', name: '国庆节', greeting: '国庆快乐！长假好好放松，祖国大好河山等着你～🇨🇳' },
  { solar: '12-24', name: '平安夜', greeting: '平安夜快乐～愿你今夜好梦，苹果的甜都给你🍎' },
  { solar: '12-25', name: '圣诞节', greeting: '圣诞快乐！Merry Christmas～愿你被这个世界温柔以待🎄' },
];

// ── 二十四节气（公历日期，2026 年精确值；每年 ±1 天浮动）──────────

const SOLAR_TERMS: Festival[] = [
  { solar: '1-5', name: '小寒', greeting: '小寒到啦，天冷加衣，别着凉了～❄️' },
  { solar: '1-20', name: '大寒', greeting: '大寒是一年中最冷的时候，要照顾好自己呀～🧣' },
  { solar: '2-4', name: '立春', greeting: '立春快乐！春天要来了，万物都要醒过来了～🌱' },
  { solar: '2-18', name: '雨水', greeting: '雨水节气，润物细无声。愿你也被温柔滋润着～🌧️' },
  { solar: '3-5', name: '惊蛰', greeting: '惊蛰啦，春雷响，万物长。该醒的都醒来了～⚡' },
  { solar: '3-20', name: '春分', greeting: '春分，昼夜平分。愿你的生活也平衡美好～🌸' },
  { solar: '4-5', name: '清明', greeting: '清明时节，思念与生机同在。记得踏青呀～🌿' },
  { solar: '4-20', name: '谷雨', greeting: '谷雨，雨生百谷。春的最后一个节气，好好享受～🌾' },
  { solar: '5-5', name: '立夏', greeting: '立夏快乐！夏天来了，记得防暑呀～☀️' },
  { solar: '5-21', name: '小满', greeting: '小满，小得盈满。人生小满胜万全～🌾' },
  { solar: '6-5', name: '芒种', greeting: '芒种忙种，愿你种的都有收获～🌱' },
  { solar: '6-21', name: '夏至', greeting: '夏至，一年中最长的白昼。愿你开心一整天～☀️' },
  { solar: '7-7', name: '小暑', greeting: '小暑来了，记得多喝水，别中暑呀～🍉' },
  { solar: '7-23', name: '大暑', greeting: '大暑最热的时候，空调西瓜都安排上～🍉' },
  { solar: '8-7', name: '立秋', greeting: '立秋啦，暑气渐消。第一杯秋天的奶茶安排了吗～🍂' },
  { solar: '8-23', name: '处暑', greeting: '处暑，出暑。炎热的夏天要过去了～🍃' },
  { solar: '9-7', name: '白露', greeting: '白露为霜，早晚凉了，记得添衣～🌾' },
  { solar: '9-23', name: '秋分', greeting: '秋分，平分秋色。愿你收获满满～🍁' },
  { solar: '10-8', name: '寒露', greeting: '寒露时节，天渐寒。照顾好自己呀～🍂' },
  { solar: '10-23', name: '霜降', greeting: '霜降，秋天最后一个节气。红叶正当时～🍁' },
  { solar: '11-7', name: '立冬', greeting: '立冬快乐！冬天来了，第一顿火锅安排上～🍲' },
  { solar: '11-22', name: '小雪', greeting: '小雪，初雪将至。记得保暖呀～❄️' },
  { solar: '12-7', name: '大雪', greeting: '大雪节气，围炉煮茶正当时～🍵' },
  { solar: '12-22', name: '冬至', greeting: '冬至，数九寒天开始。记得吃饺子/汤圆呀～🥟' },
];

// ── 时段问候（每天固定时段给 owner 发）────────────────

const DAILY_GREETINGS = [
  { hour: 9, minute: 0, text: '早安呀～新的一天，也要元气满满哦！☀️' },
  { hour: 12, minute: 30, text: '中午好～记得好好吃饭，别饿着自己啦～🍚' },
  { hour: 21, minute: 30, text: '晚上好呀～今天辛苦啦，早点休息哦～🌙' },
];

// ── 关怀文案池 ──────────────────────────────────────────

const CARE_MESSAGES = [
  '今天过得怎么样呀？有点想你了～',
  '突然想找你聊聊天，忙的话不用理我，我就是路过～',
  '这几天都没见你，是不是在忙呀？记得照顾好自己哦',
  '嘿嘿，我来冒个泡～今天有没有什么有趣的事想告诉我？',
];

interface ProactiveOptions {
  ownerOpenid: string;
  /** 关怀间隔（小时），默认 24 */
  careIntervalHours?: number;
  /** 关怀时段 [开始, 结束]，默认 9-22 点 */
  careHours?: [number, number];
  /** ★ LLM 个性化文案生成器（可选）。传入时问候/祝福先过 LLM，失败回落写死文案 */
  generateText?: (context: string) => Promise<string>;
  /** ★ 去重状态持久化文件路径（可选，缺省不持久化——重启后当天问候/祝福可能重复发） */
  stateFile?: string;
}

/** 持久化去重状态的结构 */
interface ProactiveState {
  sentGreetings: string[];
  sentFestivals: string[];
  lastCare: Record<string, string>;
}

export class ProactiveService {
  private sentFestivals = new Set<string>(); // 已发祝福的日期
  private sentGreetings = new Set<string>(); // 已发时段问候: 日期+时段
  private lastCareByUser = new Map<string, string>(); // openid → 日期(YYYY-MM-DD)
  private timer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null; // 去重状态写盘防抖
  // ★ 问候独立调度器（8-08 优化：30min tick 导致 9:00 早安 09:29 才发 → 精确到点触发）
  private greetingTimer: ReturnType<typeof setTimeout> | null = null;
  private greetingRetries = new Map<string, number>(); // key → 已重试次数（仅内存，重启由补发兜底）
  // ★ CR 修复（8-08）：停止标志防 stop 后 re-arm；in-flight 集合防并发双发（sendProactive 挂 >10min）
  private stopped = false;
  private greetingInFlight = new Set<string>();

  constructor(
    private qqOff: QQOfficialAgentAdapter,
    private memoryManager: MemoryManager,
    private opts: ProactiveOptions,
  ) {
    this.loadState();
  }

  /** 启动时加载持久化的去重状态（防止重启后当天问候/祝福重复发） */
  private loadState(): void {
    if (!this.opts.stateFile) return;
    try {
      const state = JSON.parse(readFileSync(this.opts.stateFile, 'utf-8')) as ProactiveState;
      this.sentGreetings = new Set(state.sentGreetings ?? []);
      this.sentFestivals = new Set(state.sentFestivals ?? []);
      this.lastCareByUser = new Map(Object.entries(state.lastCare ?? {}));
      logger.info(`[Proactive] state loaded: ${this.sentGreetings.size} greetings, ${this.sentFestivals.size} festivals, ${this.lastCareByUser.size} cares`);
    } catch {
      logger.info('[Proactive] no persisted state, starting fresh');
    }
  }

  /** 去重状态变更后防抖写盘（1s 合并多次变更） */
  private scheduleSave(): void {
    if (!this.opts.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.opts.stateFile!), { recursive: true });
        writeFileSync(this.opts.stateFile!, JSON.stringify({
          sentGreetings: [...this.sentGreetings],
          sentFestivals: [...this.sentFestivals],
          lastCare: Object.fromEntries(this.lastCareByUser),
        }, null, 2));
        logger.debug('[Proactive] state saved');
      } catch (err: any) {
        logger.warn(`[Proactive] state save failed: ${err.message}`);
      }
    }, 1000);
  }

  /** 立即落盘（stop/进程退出前调用，不等待防抖） */
  private flushState(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.opts.stateFile) return;
    try {
      writeFileSync(this.opts.stateFile, JSON.stringify({
        sentGreetings: [...this.sentGreetings],
        sentFestivals: [...this.sentFestivals],
        lastCare: Object.fromEntries(this.lastCareByUser),
      }, null, 2));
    } catch (err: any) {
      logger.warn(`[Proactive] state flush failed: ${err.message}`);
    }
  }

  /** 启动定时检查（每 30 分钟一次，负责节日 + 关怀；问候走独立精确调度器） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(err => logger.error('[Proactive] tick:', err));
    }, 30 * 60_000);
    logger.info('[Proactive] service started (festival greetings + care messages)');
    // 启动后立即跑一次（若恰逢节日/关怀窗口）
    this.tick().catch(err => logger.error('[Proactive] tick:', err));
    // ★ 问候精确到点调度（8-08 优化：不再等 30min tick，9:00 就到 9:00 发）
    this.scheduleNextGreeting();
  }

  stop(): void {
    // ★ CR 修复：stopped 标志——in-flight fireGreeting 完成后不得 re-arm timer（否则停止的服务继续发问候）
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.greetingTimer) { clearTimeout(this.greetingTimer); this.greetingTimer = null; }
    this.flushState();
  }

  // ── 问候独立调度器（8-08 优化：精确到点 + 重启补发 + 失败重试）────────

  /** 问候去重 key：`YYYY-MM-DD-hour`（本地日期） */
  private greetingKey(now: Date, hour: number): string {
    return `${localDateKey(now)}-${hour}`;
  }

  /** 计算并安排下一次问候触发。单遍扫描 DAILY_GREETINGS（时间升序）：
   *  ① 窗口期（当前小时已到该问候且未发未放弃）→ 立即/短延迟补发（重启恢复，消除 5s 死区）；
   *  ② 未来候选（升序第一个 delay > 0）→ 排到点；
   *  ③ 已过时段（已发/放弃）→ 跳过；全过 → 明天最早时段。
   *  ★ CR 修复：不再有"同小时未来候选被 bump 到明天"的误伤（旧版 12:00-12:29 重启丢午安）。 */
  private scheduleNextGreeting(): void {
    if (this.stopped) return;
    if (this.greetingTimer) { clearTimeout(this.greetingTimer); this.greetingTimer = null; }
    const now = new Date();

    for (const g of DAILY_GREETINGS) {
      const t = new Date(now);
      t.setHours(g.hour, g.minute, 0, 0);
      const delay = t.getTime() - now.getTime();

      // ① 窗口期补发：当前小时已到该问候且今天未发、未到重试上限 → 立即发（delay<0）或到点发（delay≥0）
      if (now.getHours() === g.hour && now.getMinutes() >= g.minute) {
        const key = this.greetingKey(now, g.hour);
        const retries = this.greetingRetries.get(key) ?? 0;
        if (!this.sentGreetings.has(key) && retries <= 2) {
          if (delay < -1_000) {
            logger.info(`[Proactive] catch-up greeting ${g.hour}:${g.minute} (post-restart)`);
          }
          this.greetingTimer = setTimeout(() => this.fireGreeting(g.hour, g.minute), Math.max(0, delay));
          return;
        }
        continue; // 已发 / 重试放弃 → 下一时段
      }

      // ② 未来候选（升序第一个 delay > 0）→ 排到点
      if (delay > 0) {
        this.greetingTimer = setTimeout(() => this.fireGreeting(g.hour, g.minute), delay);
        logger.debug(`[Proactive] next greeting scheduled: ${g.hour}:${String(g.minute).padStart(2, '0')} (+${Math.round(delay / 1000)}s)`);
        return;
      }
      // ③ 已过时段（不在窗口期）→ 下一时段
    }

    // 今天全过 → 明天最早时段
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(DAILY_GREETINGS[0].hour, DAILY_GREETINGS[0].minute, 0, 0);
    this.greetingTimer = setTimeout(
      () => this.fireGreeting(DAILY_GREETINGS[0].hour, DAILY_GREETINGS[0].minute),
      tomorrow.getTime() - now.getTime(),
    );
    logger.debug(`[Proactive] next greeting scheduled: tomorrow ${DAILY_GREETINGS[0].hour}:${String(DAILY_GREETINGS[0].minute).padStart(2, '0')}`);
  }

  /** 到点发送问候（窗口守卫 → 去重/防并发 → 上下文注入 → personalize → sendProactive）。
   *  ★ CR 修复：stopped 检查（stop 后不发送不 re-arm）、窗口守卫（sleep 跨天跳过）、
   *    in-flight 防双发、异常路径走统一重试预算（不再无限热循环）。 */
  private async fireGreeting(hour: number, minute: number): Promise<void> {
    if (this.stopped) return;
    const now = new Date();
    // ★ 窗口守卫：只查 hour——setTimeout 不提前触发保证到点，错过窗口必伴随小时变化
    //   （sleep/时钟后移）；minute 检查会在 12:30:00.0 边界误伤。跨窗口 → 跳过本次重排
    if (now.getHours() !== hour) {
      logger.info(`[Proactive] greeting ${hour}:${minute} skipped (window passed, now ${now.getHours()}:${now.getMinutes()})`);
      this.scheduleNextGreeting();
      return;
    }
    const g = DAILY_GREETINGS.find(x => x.hour === hour && x.minute === minute);
    if (!g) return;
    const key = this.greetingKey(now, hour);
    // ★ 去重 + in-flight 防并发双发（sendProactive 挂起 >10min 时重试 timer 再入）
    if (this.sentGreetings.has(key) || this.greetingInFlight.has(key)) return;
    this.greetingInFlight.add(key);
    try {
      const text = await this.personalize(
        g.text,
        `现在是${hour < 12 ? '早上' : hour < 18 ? '中午' : '晚上'}，给用户发一条${hour < 12 ? '早安' : hour < 18 ? '午安' : '晚安'}问候${this.contextSnippet()}`,
      );
      const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, text);
      if (ok) {
        this.sentGreetings.add(key);
        this.greetingRetries.delete(key);
        this.scheduleSave();
        this.writeback(text); // ★ 8-09：问候回写记忆
        logger.info(`[Proactive] greeting ${hour}:${minute}: sent`);
      } else {
        this.scheduleRetry(hour, minute, key); // false 路径：重试预算
        return;
      }
    } catch (err: any) {
      logger.warn(`[Proactive] greeting ${hour}:${minute} error: ${err.message}`);
      this.scheduleRetry(hour, minute, key); // ★ CR 修复：异常路径同样走重试预算（不再无限热循环）
      return;
    } finally {
      this.greetingInFlight.delete(key);
    }
    this.scheduleNextGreeting(); // 成功 / 已去重 → 排下一次
  }

  /** 失败重试预算：最多重试 2 次（初始 + 2 重试 = 3 次尝试）、间隔 10min。
   *  ★ CR 修复：达上限保留计数（≥3）——scheduleNextGreeting 补发跳过，防"失败→补发→失败"循环；
   *    次日新 key 自然重置。 */
  private scheduleRetry(hour: number, minute: number, key: string): void {
    if (this.stopped) return;
    const retries = (this.greetingRetries.get(key) ?? 0) + 1;
    this.greetingRetries.set(key, retries);
    if (retries <= 2) {
      logger.info(`[Proactive] greeting ${hour}:${minute}: failed (retry ${retries}/2)`);
      this.greetingTimer = setTimeout(() => this.fireGreeting(hour, minute), 10 * 60_000);
      return;
    }
    logger.info(`[Proactive] greeting ${hour}:${minute}: gave up after ${retries} retries`);
    this.scheduleNextGreeting(); // 放弃 → 排下一次
  }

  /** ★ 问候上下文素材（8-08 优化）：用户近况 + 今天生活事件 + 亲密度。
   *  全部静默容错——素材缺失不阻塞问候；注明"不要生硬引用"防贴标签式文案。 */
  private contextSnippet(): string {
    const parts: string[] = [];
    try {
      const userAct = this.memoryManager.getUserActivitySummary();
      if (userAct) parts.push(`用户近况：${userAct}`);
    } catch { /* ignore */ }
    try {
      const todayKey = localDateKey();
      // ★ 8-08 修正：listLifeEvents 入参是天数——取最近 1 天即可完整覆盖今天（旧版 2 天
      //   窗口多查一天、语义含糊，意图只是"我今天的日常"）
      const today = this.memoryManager.listLifeEvents(1)
        .filter((e: any) => localDateKeyFromISO(e.createdAt) === todayKey)
        .slice(-3);
      if (today.length > 0) parts.push(`我今天的日常：${today.map((e: any) => e.content).join('；')}`);
    } catch { /* ignore */ }
    try {
      const snap = this.memoryManager.getLifeSnapshot();
      if (snap && snap.intimacy != null) parts.push(`我和用户的亲密度：${snap.intimacy}/100`);
    } catch { /* ignore */ }
    if (parts.length === 0) return '';
    return `\n背景素材（用于让问候更自然贴切，不要生硬引用）：\n${parts.join('\n')}`;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    // ★ 使用本地日期（非 UTC），与 getHours/getMinutes 时区一致
    const p = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

    // 1. 节日祝福（当天只发一次，发给 owner）— 含 24 节气，文案优先 LLM 个性化
    const festival = this.todayFestival();
    if (festival && !this.sentFestivals.has(today)) {
      const text = await this.personalize(festival.greeting, `今天是${festival.name}，给用户发一条节日祝福${this.contextSnippet()}`);
      const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, text);
      if (ok) {
        this.sentFestivals.add(today);
        this.scheduleSave();
      }
      logger.info(`[Proactive] festival "${festival.name}": ${ok ? 'sent' : 'failed'}`);
    }

    // 2. 主动关怀：活跃私聊会话，超过间隔未聊
    const [startH, endH] = this.opts.careHours ?? [9, 22];
    const nowH = new Date().getHours();
    if (nowH < startH || nowH >= endH) return;

    const sessions = this.memoryManager.listSessions(20);
    for (const s of sessions) {
      if (!s.sessionId.includes(':private:')) continue; // 只关怀私聊
      if (s.messageCount < 3) continue; // 聊得少的不打扰

      // 解析 openid
      const openid = this.extractOpenid(s.sessionId);
      if (!openid || openid !== this.opts.ownerOpenid) continue; // 只关怀 owner

      // ★ lastActive 是 ISO/UTC 格式，转本地日期后比较
      const lastActiveDate = new Date(s.lastActive);
      const lastLocalDate = `${lastActiveDate.getFullYear()}-${p(lastActiveDate.getMonth() + 1)}-${p(lastActiveDate.getDate())}`;
      if (lastLocalDate === today) continue; // 今天聊过
      if (this.lastCareByUser.get(openid) === today) continue; // 今天关怀过

      const hoursSince = (Date.now() - lastActiveDate.getTime()) / 3_600_000;
      if (hoursSince < (this.opts.careIntervalHours ?? 24)) continue;

      // ★ 8-08 优化：关怀文案走 LLM 个性化（与问候/祝福一致），失败回落写死池子
      const raw = CARE_MESSAGES[Math.floor(Math.random() * CARE_MESSAGES.length)];
      const msg = await this.personalize(
        raw,
        `用户已经约 ${Math.round(hoursSince)} 小时没和你联系了，发一条轻量、低压力的关怀消息（像路过随口问候，不要追问近况、不要制造必须回复的压力）${this.contextSnippet()}`,
      );
      const ok = await this.qqOff.sendProactive(openid, msg);
      // ★ 先发后标记
      if (ok) {
        this.lastCareByUser.set(openid, today);
        this.scheduleSave();
        this.writeback(msg); // ★ 8-09：关怀回写记忆
      }
      logger.info(`[Proactive] care → ${openid.slice(0, 8)}...: ${ok ? 'sent' : 'failed'}`);
    }
  }

  /** ★ 8-09 回写：主动消息 ingest 进 EventLog（assistant 角色）——bot 记得自己发过问候/关怀。
   *  复用 Life writeback 模式；失败不阻塞主流程。 */
  private writeback(content: string): void {
    try {
      this.memoryManager.ingest({
        id: `proactive-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        session_id: `qq-official-1:private:private_${this.opts.ownerOpenid}`,
        source: 'chat',
        type: 'message',
        payload: { content, role: 'assistant' },
        importance: 0.3,
        created_at: new Date().toISOString(),
        processed: 0,
      }).catch(err => logger.warn(`[Proactive] writeback failed: ${err.message}`));
    } catch (err: any) {
      logger.warn(`[Proactive] writeback failed: ${err.message}`);
    }
  }

  /** ★ LLM 个性化文案：有 generateText 时生成，失败/为空回落写死文案 */
  private async personalize(fallback: string, context: string): Promise<string> {
    if (!this.opts.generateText) return fallback;
    try {
      const text = await this.opts.generateText(context);
      if (text && text.trim()) return text.trim();
    } catch (err: any) {
      logger.warn(`[Proactive] LLM generate failed, using fallback: ${err.message}`);
    }
    return fallback;
  }

  /** 今天的节日（公历 + 节气 + 农历映射表）。now 可注入便于测试。 */
  private todayFestival(now: Date = new Date()): Festival | null {
    const solarKey = `${now.getMonth() + 1}-${now.getDate()}`;

    for (const f of FESTIVALS) {
      if (f.solar === solarKey) return f;
    }

    // 二十四节气
    for (const t of SOLAR_TERMS) {
      if (t.solar === solarKey) return t;
    }

    // 农历节日：查映射表（当前年份的农历月-日 → 公历月-日）
    const yearMap = LUNAR_FESTIVAL_DATES[now.getFullYear()];
    if (yearMap) {
      for (const [lunarKey, solarDate] of Object.entries(yearMap)) {
        if (solarDate === solarKey) {
          return LUNAR_FESTIVALS[lunarKey] ?? null;
        }
      }
    }

    return null;
  }

  /** 从记忆会话 ID 提取 openid: "qq-official-1:private:private_xxx" → "xxx" */
  private extractOpenid(sessionId: string): string | null {
    const m = sessionId.match(/:private:private_(.+)$/);
    return m ? m[1] : null;
  }

  /** ★ 8-29 今天是什么日子（LifeService 事件生成感知用）：节日/节气名（未发祝福也返回，
   *  事件生成自然带节日氛围）。非节日返回空串。 */
  todaySpecial(): string {
    const f = this.todayFestival();
    return f ? `${f.name}（${f.greeting ?? ''}）` : '';
  }

  /** ★ 今天已主动联系的内容摘要（LifeService 感知用，避免重复打扰）。
   *  返回如 "早安问候、立秋节日祝福"；今天没发过则返回空串。 */
  getTodayActivity(): string {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

    const parts: string[] = [];
    for (const g of DAILY_GREETINGS) {
      if (this.sentGreetings.has(`${today}-${g.hour}`)) {
        parts.push(g.hour < 12 ? '早安问候' : g.hour < 18 ? '中午问候' : '晚安问候');
      }
    }
    const festival = this.todayFestival();
    if (festival && this.sentFestivals.has(today)) {
      parts.push(`${festival.name}节日祝福`);
    }
    return parts.join('、');
  }
}
