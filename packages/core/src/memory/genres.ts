/**
 * ★ 2026-10-28（change: `extract-prompt-genres`；P8 第 4 步）
 *
 * **体裁表**：8 条生成链路的「预算 / 采样 / persona 注入方式 / 禁止块」的唯一声明处。
 *
 * ## 为什么是表，不是布尔
 *
 * `includePersona / includeBrevity / includeFacts ...` 4 个布尔会造出 16 种组合，
 * 其中 12 种非法（例如“摘要体裁带 persona”）。用 genre 枚举 + `forbids` 白名单后，
 * 非法组合**根本表达不出来**。
 *
 * ## 它不是什么
 *
 * - 不是运行时 feature flag：调用方读它，但不会因为改表就在运行时换行为；
 * - 不是 prompt 文本本身：文本仍在 `prompts/` 资产里；这里只声明**怎么组装**。
 *
 * ## 覆盖范围
 *
 * `chat / code / life-event / life-daily / proactive / session-summary /
 * profile-extract / profile-rewrite`。
 *
 * `life-event` 与 `life-daily` 是两类：前者是“她这一天发生了什么”（高温度、要具体），
 * 后者是摘要/反思/日记/信/拒绝理由/意图/心情侧写（低温、要忠）。它们共享
 * `life.generateSummary` 槽，但**不共享 persona 与 forbids**。
 */
import { DEFAULT_SAMPLING, type SamplingSlot } from '../provider/sampling.js';

export type GenreId =
  | 'chat'
  | 'code'
  | 'life-event'
  | 'life-daily'
  | 'proactive'
  | 'session-summary'
  | 'profile-extract'
  | 'profile-rewrite';

/** persona 注入方式（不是布尔组合；每种体裁只能选一种）。 */
export type PersonaInjection =
  | { kind: 'compact'; sections: number }
  | { kind: 'worldview'; section: 'all' | 'window' | 'life' }
  | { kind: 'name-tone' }
  | { kind: 'inline-one-line' }
  | { kind: 'none' };

export interface GenreSpec {
  id: GenreId;
  /** prompt 预算（token）；undefined = 该链路不设组装预算 */
  budgetTokens?: number;
  /** 该体裁的**默认**采样槽（config.sampling 仍可覆盖；这里只给 floor） */
  sampling: SamplingSlot;
  /** persona 怎么进 prompt */
  persona: PersonaInjection;
  /** 该体裁**结构上不应出现**的 prompt 块 key（拼错会在测试里红） */
  forbids: readonly string[];
  note?: string;
}

export const GENRES: Readonly<Record<GenreId, GenreSpec>> = {
  chat: {
    id: 'chat',
    budgetTokens: 3200,
    sampling: DEFAULT_SAMPLING.chat,
    persona: { kind: 'compact', sections: 4 },
    forbids: [],
    note: 'QQ/console 主对话：13 块，brevity required；facts 已 required（2026-10-28）',
  },
  code: {
    id: 'code',
    budgetTokens: 2450,
    sampling: DEFAULT_SAMPLING.chat,
    persona: { kind: 'inline-one-line' },
    forbids: [
      'basics', 'preferences', 'facts', 'characterFacts', 'pendingConfirm',
      'recentConversations', 'brevity',
    ],
    note: '编程模式：人味块全部不出现；生产链路无写者（P9 标死），仅 API/测试可达',
  },
  'life-event': {
    id: 'life-event',
    sampling: DEFAULT_SAMPLING.life.generateEvent,
    persona: { kind: 'worldview', section: 'all' },
    forbids: ['basics', 'preferences', 'facts', 'characterFacts', 'recentConversations', 'memories'],
    note: '她的一天：高温度、要具体；刻意不含用户画像（P5）',
  },
  'life-daily': {
    id: 'life-daily',
    sampling: DEFAULT_SAMPLING.life.generateSummary,
    persona: { kind: 'none' },
    forbids: ['basics', 'preferences', 'facts', 'characterFacts', 'recentConversations', 'memories'],
    note: '摘要/反思/日记/信/拒绝理由/意图/心情侧写：低温、要忠，不注入 persona',
  },
  proactive: {
    id: 'proactive',
    sampling: DEFAULT_SAMPLING.proactive.personalize,
    persona: { kind: 'name-tone' },
    forbids: ['basics', 'preferences', 'facts', 'recentConversations', 'memories'],
    note: '问候/节日/关怀：只要名字+语气维度；整份 compact persona 会把它带成对话',
  },
  'session-summary': {
    id: 'session-summary',
    sampling: DEFAULT_SAMPLING.session.summary,
    persona: { kind: 'none' },
    forbids: ['persona', 'basics', 'preferences', 'facts', 'recentConversations', 'memories'],
    note: '要原始对话，不要人格/画像（PLAN §2.6 坑 3）',
  },
  'profile-extract': {
    id: 'profile-extract',
    sampling: DEFAULT_SAMPLING.profile.extract,
    persona: { kind: 'none' },
    forbids: ['persona', 'basics', 'preferences', 'facts', 'recentConversations', 'memories'],
    note: 'JSON 事实提取；不共享事实层，避免“看她想看的”',
  },
  'profile-rewrite': {
    id: 'profile-rewrite',
    sampling: DEFAULT_SAMPLING.profile.deepRewrite,
    persona: { kind: 'none' },
    forbids: ['persona', 'basics', 'preferences', 'facts', 'recentConversations', 'memories'],
    note: 'Cron 深度画像重写；纯文本，绝不加 response_format',
  },
};

export const GENRE_IDS: readonly GenreId[] = Object.keys(GENRES) as GenreId[];

/** 取一个体裁；未知 id 直接抛（不要静默回落到 chat）。 */
export function getGenre(id: GenreId): GenreSpec {
  const genre = GENRES[id];
  if (!genre) throw new Error(`unknown genre: ${String(id)}`);
  return genre;
}
