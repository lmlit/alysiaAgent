/**
 * 数据适配层 — 服务端字段 → 视图字段的**唯一**翻译处。
 *
 * 规范见 spec: alysia-console §4。原则：
 *   - 纯函数，无副作用（除 console.warn 记录异常数据）
 *   - 不臆造字段：视图只展示服务端真有的东西
 *   - 未知输入不静默吞掉，打日志 + 落到保守值
 */
import type {
  LifeSnapshot,
  MemoryConfig,
  PersonaResponse,
  ProfileResponse,
  RawLifeEvent,
  SessionSummary,
  StatsResponse,
} from './api/types';

// ── 生活事件 ───────────────────────────────────────────

export type LifeEventView = {
  id: string;
  /** 今天 / 昨天 / 前天 / M月D日 */
  day: string;
  /** HH:mm */
  time: string;
  /** share = 说给轻月的话（type='chat'）；alone = 她自己的日子（type='internal'） */
  type: 'share' | 'alone';
  text: string;
  /** 1 = 已推送出去；0 = 只入库 */
  delivered: boolean;
  /** 对话余波：不推送只记录（origin='followup'） */
  followup: boolean;
};

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 相对日期：今天 / 昨天 / 前天 / M月D日。非法时间返回空串（由调用方决定怎么显示） */
export function formatRelativeDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff < 0) return `${d.getMonth() + 1}月${d.getDate()}日`; // 未来时间：不退化成"明天"，直接给日期
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** HH:mm（本地时区） */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function adaptLifeEvent(raw: RawLifeEvent, now?: Date): LifeEventView {
  let type: 'share' | 'alone';
  if (raw.type === 'chat') type = 'share';
  else if (raw.type === 'internal') type = 'alone';
  else {
    // 未知 type：不假装它是推送（share 意味着"说给轻月听了"），落保守值并留痕
    console.warn('[adapt] 未知的生活事件 type，按 alone 处理', raw.id, raw.type);
    type = 'alone';
  }

  return {
    id: raw.id,
    day: formatRelativeDay(raw.createdAt, now),
    time: formatClock(raw.createdAt),
    type,
    text: raw.content,
    delivered: raw.delivered === 1,
    followup: raw.origin === 'followup',
  };
}

export function adaptLifeEvents(raw: RawLifeEvent[], now?: Date): LifeEventView[] {
  return (raw ?? []).map((e) => adaptLifeEvent(e, now));
}

// ── 人格参数 ───────────────────────────────────────────
// ★ 中文标签沿用 packages/webui/src/views/PersonaView.vue 的 PARAM_NAMES，
//   两个前端叫法必须一致（见 spec §7 共享约定）

const PERSONA_PARAM_LABELS: Record<string, string> = {
  formality: '正式度',
  warmth: '温暖度',
  humor: '幽默感',
  directness: '直接度',
  sentence_length: '句子长度',
  emoji_usage: '表情使用',
  code_heavy: '代码倾向',
  expressiveness: '表达力',
  empathy: '共情力',
  playfulness: '俏皮度',
};

/** 雷达图取的 6 个轴（真实存在的键，不含 mock 臆造的「口语化 / 稳定性」） */
export const RADAR_AXES: Array<{ key: string; group: keyof PersonaResponse }> = [
  { key: 'warmth', group: 'tone' },
  { key: 'humor', group: 'tone' },
  { key: 'directness', group: 'tone' },
  { key: 'expressiveness', group: 'emotionalRange' },
  { key: 'empathy', group: 'emotionalRange' },
  { key: 'playfulness', group: 'emotionalRange' },
];

export type PersonaDimView = {
  group: string;
  params: Array<{ key: string; label: string; value: number }>;
};

/** 三维度展开。顺序固定，键序不影响展示 */
export function personaDims(persona: PersonaResponse): PersonaDimView[] {
  const groups: Array<{ group: string; src: Record<string, number> }> = [
    { group: '语气', src: persona.tone },
    { group: '说话风格', src: persona.speechStyle },
    { group: '情感范围', src: persona.emotionalRange },
  ];
  return groups.map(({ group, src }) => ({
    group,
    params: Object.entries(src ?? {}).map(([key, value]) => ({
      key,
      label: PERSONA_PARAM_LABELS[key] ?? key, // 未知键原样显示，不隐藏
      value,
    })),
  }));
}

/** 雷达图数据：按 RADAR_AXES 取值，缺键补 0 并警告 */
export function radarData(persona: PersonaResponse): Array<{ label: string; value: number }> {
  return RADAR_AXES.map(({ key, group }) => {
    const src = persona[group] as Record<string, number> | undefined;
    const value = src?.[key];
    if (typeof value !== 'number') {
      console.warn('[adapt] 人格参数缺失', group, key);
      return { label: PERSONA_PARAM_LABELS[key] ?? key, value: 0 };
    }
    return { label: PERSONA_PARAM_LABELS[key] ?? key, value };
  });
}

// ── 记忆旋钮 ───────────────────────────────────────────
// ★ 中文标签与描述沿用 webui PersonaView.vue 的 knobMeta（真实 5 个键）

const KNOB_META: Array<{ key: keyof MemoryConfig; label: string; hint: string }> = [
  { key: 'decay_rate', label: '遗忘速度', hint: '0 = 不忘，1 = 秒忘' },
  { key: 'importance_threshold', label: '重要阈值', hint: '0 = 什么都记，1 = 只记大事' },
  { key: 'recency_weight', label: '近期权重', hint: '0 = 念旧，1 = 只认最近' },
  { key: 'confirmation_bias', label: '固执度', hint: '0 = 随风倒，1 = 从不改变看法' },
  { key: 'retention_bias', label: '正负偏向', hint: '−1 = 只记坏，+1 = 只记好' },
];

export type KnobView = { key: string; label: string; hint: string; value: number; signed: boolean };

export function memoryKnobs(cfg: MemoryConfig): KnobView[] {
  return KNOB_META.map(({ key, label, hint }) => {
    const value = cfg?.[key];
    if (typeof value !== 'number') console.warn('[adapt] 记忆旋钮缺失', key);
    return {
      key,
      label,
      hint,
      value: typeof value === 'number' ? value : 0,
      // retention_bias 值域是 [-1, 1]，滑块展示要区别对待
      signed: key === 'retention_bias',
    };
  });
}

// ── 每日摘要 / 配角在场（9-25 add-life-readonly-endpoints）────

/**
 * `YYYY-MM-DD` → 本地 Date。
 * ★ 不要用 `new Date('2026-08-27')`——那按 UTC 解析，东八区会得到 08:00 同天尚可，
 *   但在负时区会**退回前一天**。日期-only 字符串必须按本地日历构造。
 */
function parseDateOnly(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export type SummaryView = { date: string; label: string; text: string };

/** 摘要日期标签：今天 / 昨天 / M月D日 */
export function formatSummaryDate(dateStr: string, now: Date = new Date()): string {
  const d = parseDateOnly(dateStr);
  if (!d) {
    console.warn('[adapt] 摘要日期格式异常', dateStr);
    return dateStr; // 原样显示，不隐藏
  }
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function adaptSummaries(
  raw: Array<{ date: string; summary: string }> | null | undefined,
  now?: Date,
): SummaryView[] {
  return (raw ?? []).map((s) => ({
    date: s.date,
    label: formatSummaryDate(s.date, now),
    text: s.summary,
  }));
}

const COMPANION_STATUS_LABELS: Record<string, string> = {
  present: '在场',
  expected: '期待中',
  'off-scene': '离场',
};

export type CompanionView = {
  name: string;
  /** 是否在场（present / expected 都算「在」，与 core 的 listPresentNames 语义一致） */
  present: boolean;
  statusLabel: string;
  basis: string;
  updatedAgo: string;
};

export function adaptCompanions(
  raw: Array<{ name: string; status: string; basis?: string; updatedAt: string }> | null | undefined,
  now?: Date,
): CompanionView[] {
  return (raw ?? []).map((c) => {
    const label = COMPANION_STATUS_LABELS[c.status];
    if (!label) console.warn('[adapt] 未知的配角在场状态', c.name, c.status);
    return {
      name: c.name,
      // 与 MemoryManager.listPresentNames() 语义对齐：present + expected 都算在场
      present: c.status === 'present' || c.status === 'expected',
      statusLabel: label ?? c.status,
      basis: c.basis?.trim() ?? '',
      updatedAgo: formatAgo(c.updatedAt, now),
    };
  });
}

// ── 画像 ───────────────────────────────────────────────

export type ProfileView = {
  summary: string;
  /** 关于轻月的事实 */
  facts: Array<{ fact: string; category: string; confidence: number }>;
  /** 她自己的事实 */
  characterFacts: Array<{ fact: string; category: string; confidence: number }>;
};

export function adaptProfile(p: ProfileResponse): ProfileView {
  const toView = (f: ProfileResponse['facts'][number]) => ({
    fact: f.fact,
    category: f.category,
    confidence: f.confidence,
  });
  return {
    // 优先用自然语言概要；没有再退回逐条
    summary: p.basics?.trim() || p.preferences?.trim() || '',
    facts: (p.facts ?? []).map(toView),
    characterFacts: (p.characterFacts ?? []).map(toView),
  };
}

// ── 统计 ───────────────────────────────────────────────

export type StatView = {
  key: string;
  label: string;
  value: number;
  /** 数值被服务端 limit 截断了（显示成 "50+" 而不是假装是全部） */
  capped?: boolean;
  hint?: string;
};

/**
 * 服务端硬限制：`GET /api/sessions` 是 `listSessions(50)`。
 * 拿满 50 条时说明可能还有更多——显示上必须体现，不能假装是全部。
 */
export const SESSION_LIST_LIMIT = 50;

export function deriveStats(
  sessions: SessionSummary[],
  lifeEventCount: number,
  stats: StatsResponse | null,
): StatView[] {
  const list = sessions ?? [];
  const capped = list.length >= SESSION_LIST_LIMIT;
  const messages = list.reduce((sum, s) => sum + (s.messageCount ?? 0), 0);
  const tokens = stats?.global?.tokens ?? 0;

  return [
    { key: 'sessions', label: '会话', value: list.length, capped, hint: capped ? '服务端只返回最近 50 个' : undefined },
    { key: 'messages', label: '消息', value: messages, capped: capped || undefined, hint: capped ? '仅统计最近 50 个会话' : undefined },
    { key: 'lifeEvents', label: '近 7 天生活', value: lifeEventCount },
    { key: 'tokens', label: '累计 Token', value: tokens },
  ];
}

// ── 生活快照 ───────────────────────────────────────────

export type LifeView = {
  currentActivity: string;
  mood: string;
  moodNote: string;
  intimacy: number;
  /** 快照最后更新时间，用于提示"她多久没动了" */
  updatedAt: string;
  updatedAgo: string;
};

/** 人类可读的相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ms = now.getTime() - d.getTime();
  if (ms < 0) return '刚刚';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function adaptLife(snapshot: LifeSnapshot | null | undefined, now?: Date): LifeView | null {
  if (!snapshot) return null;
  return {
    currentActivity: snapshot.currentActivity,
    mood: snapshot.mood,
    moodNote: snapshot.moodNote,
    // ★ 服务端亲密度是浮点（实测 44.699999999999996），直接渲染会出现一长串小数。
    //   展示层要整数——在此收口，别指望每个调用点都记得 round。
    intimacy: Number.isFinite(snapshot.intimacy) ? Math.round(snapshot.intimacy) : 0,
    updatedAt: snapshot.updatedAt,
    updatedAgo: formatAgo(snapshot.updatedAt, now),
  };
}
