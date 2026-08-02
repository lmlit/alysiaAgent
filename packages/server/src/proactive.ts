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

  /** 启动定时检查（每 30 分钟一次） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(err => logger.error('Proactive tick:', err));
    }, 30 * 60_000);
    logger.info('Proactive service started (festival greetings + care messages)');
    // 启动后立即跑一次（若恰逢节日）
    this.tick().catch(err => logger.error('Proactive tick:', err));
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.flushState();
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // 0. 时段问候（每天各时段一次，发给 owner）— 文案优先 LLM 个性化
    for (const g of DAILY_GREETINGS) {
      const key = `${today}-${g.hour}`;
      if (this.sentGreetings.has(key)) continue;
      if (now.getHours() === g.hour && now.getMinutes() >= g.minute) {
        this.sentGreetings.add(key);
        this.scheduleSave();
        const text = await this.personalize(g.text, `现在是${g.hour < 12 ? '早上' : g.hour < 18 ? '中午' : '晚上'}，给用户发一条${g.hour < 12 ? '早安' : g.hour < 18 ? '午安' : '晚安'}问候`);
        const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, text);
        logger.info(`Proactive greeting ${g.hour}:${g.minute}: ${ok ? 'sent' : 'failed'}`);
      }
    }

    // 1. 节日祝福（当天只发一次，发给 owner）— 含 24 节气，文案优先 LLM 个性化
    const festival = this.todayFestival();
    if (festival && !this.sentFestivals.has(today)) {
      this.sentFestivals.add(today);
      this.scheduleSave();
      const text = await this.personalize(festival.greeting, `今天是${festival.name}，给用户发一条节日祝福`);
      const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, text);
      logger.info(`Proactive festival "${festival.name}": ${ok ? 'sent' : 'failed'}`);
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

      const lastDate = s.lastActive.slice(0, 10);
      if (lastDate === today) continue; // 今天聊过
      if (this.lastCareByUser.get(openid) === today) continue; // 今天关怀过

      const hoursSince = (Date.now() - new Date(s.lastActive).getTime()) / 3_600_000;
      if (hoursSince < (this.opts.careIntervalHours ?? 24)) continue;

      const msg = CARE_MESSAGES[Math.floor(Math.random() * CARE_MESSAGES.length)];
      this.lastCareByUser.set(openid, today);
      this.scheduleSave();
      const ok = await this.qqOff.sendProactive(openid, msg);
      logger.info(`Proactive care → ${openid.slice(0, 8)}...: ${ok ? 'sent' : 'failed'}`);
    }
  }

  /** ★ LLM 个性化文案：有 generateText 时生成，失败/为空回落写死文案 */
  private async personalize(fallback: string, context: string): Promise<string> {
    if (!this.opts.generateText) return fallback;
    try {
      const text = await this.opts.generateText(context);
      if (text && text.trim()) return text.trim();
    } catch (err: any) {
      logger.warn(`Proactive LLM generate failed, using fallback: ${err.message}`);
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
}
