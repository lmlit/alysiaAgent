import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  adaptCompanions,
  adaptLife,
  adaptLifeEvent,
  adaptLifeEvents,
  adaptProfile,
  adaptSummaries,
  deriveStats,
  formatAgo,
  formatClock,
  formatRelativeDay,
  formatSummaryDate,
  memoryKnobs,
  personaDims,
  radarData,
  SESSION_LIST_LIMIT,
} from '../lib/adapt';
import type {
  MemoryConfig,
  PersonaResponse,
  ProfileResponse,
  RawLifeEvent,
  SessionSummary,
  StatsResponse,
} from '../lib/api/types';

// 基准时间：2026-09-24 21:00 +08:00
const NOW = new Date('2026-09-24T13:00:00Z');

function ev(partial: Partial<RawLifeEvent>): RawLifeEvent {
  return {
    id: 'e1',
    createdAt: '2026-09-24T01:00:00Z', // +08 → 09:00 当天
    type: 'chat',
    content: '今天的雨好大',
    delivered: 1,
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatRelativeDay', () => {
  it('识别今天/昨天/前天', () => {
    expect(formatRelativeDay('2026-09-24T01:00:00Z', NOW)).toBe('今天');
    expect(formatRelativeDay('2026-09-23T01:00:00Z', NOW)).toBe('昨天');
    expect(formatRelativeDay('2026-09-22T01:00:00Z', NOW)).toBe('前天');
  });

  it('更早的日期给 M月D日', () => {
    expect(formatRelativeDay('2026-09-17T01:00:00Z', NOW)).toBe('9月17日');
  });

  it('跨时区边界按东八区判定（UTC 16:00 = 次日 00:00）', () => {
    // 2026-09-23T16:00:00Z 在东八区是 09-24 00:00 → 今天
    expect(formatRelativeDay('2026-09-23T16:00:00Z', NOW)).toBe('今天');
  });

  it('非法时间返回空串，不抛异常', () => {
    expect(formatRelativeDay('not-a-date', NOW)).toBe('');
    expect(formatRelativeDay('', NOW)).toBe('');
  });

  it('未来时间不退化成"明天"，直接给日期', () => {
    expect(formatRelativeDay('2026-09-30T01:00:00Z', NOW)).toBe('9月30日');
  });
});

describe('formatClock', () => {
  it('本地时区 HH:mm', () => {
    expect(formatClock('2026-09-24T01:05:00Z')).toBe('09:05');
  });
  it('非法时间返回空串', () => {
    expect(formatClock('garbage')).toBe('');
  });
});

describe('adaptLifeEvent', () => {
  it("type='chat' → share（说给轻月的话）", () => {
    const v = adaptLifeEvent(ev({ type: 'chat' }), NOW);
    expect(v.type).toBe('share');
    expect(v.delivered).toBe(true);
  });

  it("type='internal' → alone（她自己的日子）", () => {
    const v = adaptLifeEvent(ev({ type: 'internal', delivered: 0 }), NOW);
    expect(v.type).toBe('alone');
    expect(v.delivered).toBe(false);
  });

  it("origin='followup' 标记为对话余波", () => {
    expect(adaptLifeEvent(ev({ origin: 'followup' }), NOW).followup).toBe(true);
    expect(adaptLifeEvent(ev({ origin: 'regular' }), NOW).followup).toBe(false);
    expect(adaptLifeEvent(ev({}), NOW).followup).toBe(false);
  });

  it('未知 type 落保守值 alone 并告警，不冒充推送', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = adaptLifeEvent(ev({ type: 'weird' as RawLifeEvent['type'] }), NOW);
    expect(v.type).toBe('alone');
    expect(warn).toHaveBeenCalled();
  });

  it('content 原样进 text，空串不崩', () => {
    expect(adaptLifeEvent(ev({ content: '' }), NOW).text).toBe('');
  });
});

describe('adaptLifeEvents', () => {
  it('空数组 → 空数组', () => {
    expect(adaptLifeEvents([], NOW)).toEqual([]);
  });

  it('null/undefined → 空数组（服务端字段缺失不崩）', () => {
    expect(adaptLifeEvents(undefined as unknown as RawLifeEvent[], NOW)).toEqual([]);
    expect(adaptLifeEvents(null as unknown as RawLifeEvent[], NOW)).toEqual([]);
  });

  it('批量保序', () => {
    const out = adaptLifeEvents([ev({ id: 'a' }), ev({ id: 'b' }), ev({ id: 'c' })], NOW);
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('personaDims', () => {
  const persona = {
    name: '昔涟',
    tone: { formality: 0, warmth: 0.2, humor: 0.1, directness: 0 },
    speechStyle: { sentence_length: 0, emoji_usage: 0, code_heavy: 0 },
    emotionalRange: { expressiveness: 0.1, empathy: 0.3, playfulness: 0.1 },
    memoryConfig: {} as MemoryConfig,
    overlayNotes: [],
  } as PersonaResponse;

  it('三维度展开，参数个数与服务端一致（4/3/3，不含 mock 臆造的键）', () => {
    const dims = personaDims(persona);
    expect(dims.map((d) => d.group)).toEqual(['语气', '说话风格', '情感范围']);
    expect(dims.map((d) => d.params.length)).toEqual([4, 3, 3]);
  });

  it('已知键给中文标签', () => {
    const dims = personaDims(persona);
    expect(dims[0].params.map((p) => p.label)).toEqual(['正式度', '温暖度', '幽默感', '直接度']);
    expect(dims[1].params.map((p) => p.label)).toEqual(['句子长度', '表情使用', '代码倾向']);
  });

  it('未知键原样显示，不隐藏也不崩', () => {
    const withUnknown = { ...persona, tone: { ...persona.tone, mystery: 0.5 } };
    const warm = personaDims(withUnknown)[0].params.find((p) => p.key === 'mystery');
    expect(warm?.label).toBe('mystery');
    expect(warm?.value).toBe(0.5);
  });
});

describe('radarData', () => {
  it('取 6 个真实存在的轴', () => {
    const data = radarData({
      tone: { warmth: 0.8, humor: 0.6, directness: 0.5 },
      emotionalRange: { expressiveness: 0.9, empathy: 0.9, playfulness: 0.7 },
    } as unknown as PersonaResponse);
    expect(data.map((d) => d.label)).toEqual(['温暖度', '幽默感', '直接度', '表达力', '共情力', '俏皮度']);
    expect(data.map((d) => d.value)).toEqual([0.8, 0.6, 0.5, 0.9, 0.9, 0.7]);
  });

  it('缺键补 0 并告警，不崩', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = radarData({ tone: {}, emotionalRange: {} } as unknown as PersonaResponse);
    expect(data.every((d) => d.value === 0)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe('memoryKnobs', () => {
  const cfg: MemoryConfig = {
    retention_bias: 0.2,
    decay_rate: 0.3,
    importance_threshold: 0.4,
    recency_weight: 0.3,
    confirmation_bias: 0.3,
  };

  it('输出真实的 5 个旋钮，不含 mock 臆造的「情绪记忆/主动唤起」', () => {
    const knobs = memoryKnobs(cfg);
    expect(knobs.map((k) => k.key)).toEqual([
      'decay_rate',
      'importance_threshold',
      'recency_weight',
      'confirmation_bias',
      'retention_bias',
    ]);
    expect(knobs.map((k) => k.label)).toEqual(['遗忘速度', '重要阈值', '近期权重', '固执度', '正负偏向']);
  });

  it('retention_bias 标记为有符号（值域 -1..1）', () => {
    const knobs = memoryKnobs(cfg);
    expect(knobs.find((k) => k.key === 'retention_bias')?.signed).toBe(true);
    expect(knobs.find((k) => k.key === 'decay_rate')?.signed).toBe(false);
  });

  it('缺键补 0 并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const knobs = memoryKnobs({} as MemoryConfig);
    expect(knobs.every((k) => k.value === 0)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe('adaptProfile', () => {
  it('basics 优先作为 summary，缺失退回 preferences', () => {
    const base = { facts: [], characterFacts: [] } as unknown as ProfileResponse;
    expect(adaptProfile({ ...base, basics: '喜欢深夜聊天', preferences: 'X' }).summary).toBe('喜欢深夜聊天');
    expect(adaptProfile({ ...base, basics: '  ', preferences: '偏好技术话题' }).summary).toBe('偏好技术话题');
    expect(adaptProfile({ ...base, basics: '', preferences: '' }).summary).toBe('');
  });

  it('facts 与 characterFacts 分开透出', () => {
    const p = {
      basics: '',
      preferences: '',
      facts: [{ fact: '养了只橘猫', category: 'life', confidence: 0.8 }],
      characterFacts: [{ fact: '喜欢旧书店', category: 'preference', confidence: 0.6 }],
    } as unknown as ProfileResponse;
    const v = adaptProfile(p);
    expect(v.facts).toHaveLength(1);
    expect(v.characterFacts).toHaveLength(1);
    expect(v.characterFacts[0].fact).toBe('喜欢旧书店');
  });

  it('facts 缺失当空数组，不崩', () => {
    const v = adaptProfile({ basics: '', preferences: '' } as unknown as ProfileResponse);
    expect(v.facts).toEqual([]);
    expect(v.characterFacts).toEqual([]);
  });
});

describe('deriveStats', () => {
  const sessions = (n: number): SessionSummary[] =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `s${i}`,
      messageCount: 10,
      lastActive: '2026-09-24T01:00:00Z',
    }));
  const stats = { global: { input: 1, output: 2, tokens: 1234 }, perSession: {} } as StatsResponse;

  it('正常统计', () => {
    const out = deriveStats(sessions(3), 7, stats);
    expect(out.find((s) => s.key === 'sessions')?.value).toBe(3);
    expect(out.find((s) => s.key === 'messages')?.value).toBe(30);
    expect(out.find((s) => s.key === 'lifeEvents')?.value).toBe(7);
    expect(out.find((s) => s.key === 'tokens')?.value).toBe(1234);
  });

  it('会话列表拿满 50 条时标记 capped，不假装是全部', () => {
    const out = deriveStats(sessions(SESSION_LIST_LIMIT), 0, stats);
    expect(out.find((s) => s.key === 'sessions')?.capped).toBe(true);
    expect(out.find((s) => s.key === 'messages')?.capped).toBe(true);
    expect(out.find((s) => s.key === 'sessions')?.hint).toBeTruthy();
  });

  it('未达上限不标记 capped', () => {
    const out = deriveStats(sessions(SESSION_LIST_LIMIT - 1), 0, stats);
    expect(out.find((s) => s.key === 'sessions')?.capped).toBe(false);
  });

  it('stats 为 null 时 token 记 0，不崩', () => {
    expect(deriveStats(sessions(1), 0, null).find((s) => s.key === 'tokens')?.value).toBe(0);
  });

  it('空列表 → 全 0', () => {
    const out = deriveStats([], 0, null);
    expect(out.every((s) => s.value === 0)).toBe(true);
  });
});

describe('formatAgo', () => {
  it('刚刚 / 分钟 / 小时 / 天', () => {
    expect(formatAgo('2026-09-24T12:59:30Z', NOW)).toBe('刚刚');
    expect(formatAgo('2026-09-24T12:30:00Z', NOW)).toBe('30 分钟前');
    expect(formatAgo('2026-09-24T09:00:00Z', NOW)).toBe('4 小时前');
    expect(formatAgo('2026-09-22T13:00:00Z', NOW)).toBe('2 天前');
  });
  it('未来时间按"刚刚"，不出现负数', () => {
    expect(formatAgo('2026-09-24T14:00:00Z', NOW)).toBe('刚刚');
  });
  it('非法时间返回空串', () => {
    expect(formatAgo('nope', NOW)).toBe('');
  });
});

describe('adaptLife', () => {
  it('null 快照 → null（页面据此显示空态）', () => {
    expect(adaptLife(null)).toBeNull();
    expect(adaptLife(undefined)).toBeNull();
  });

  it('字段透传 + 相对时间', () => {
    const v = adaptLife(
      {
        currentActivity: '在窗边看雨',
        mood: '温柔',
        moodValue: 0.7,
        moodNote: '',
        intimacy: 72,
        updatedAt: '2026-09-24T09:00:00Z',
      },
      NOW,
    );
    expect(v?.currentActivity).toBe('在窗边看雨');
    expect(v?.intimacy).toBe(72);
    expect(v?.updatedAgo).toBe('4 小时前');
  });

  it('★ 浮点亲密度取整（服务端实测给 44.699999999999996）', () => {
    const base = {
      currentActivity: 'x',
      mood: 'y',
      moodValue: 0,
      moodNote: '',
      updatedAt: '2026-09-24T09:00:00Z',
    };
    expect(adaptLife({ ...base, intimacy: 44.699999999999996 }, NOW)?.intimacy).toBe(45);
    expect(adaptLife({ ...base, intimacy: 0.4 }, NOW)?.intimacy).toBe(0);
    expect(adaptLife({ ...base, intimacy: 99.5 }, NOW)?.intimacy).toBe(100);
  });

  it('亲密度的非有限值落 0，不渲染 NaN', () => {
    const base = {
      currentActivity: 'x',
      mood: 'y',
      moodValue: 0,
      moodNote: '',
      updatedAt: '2026-09-24T09:00:00Z',
    };
    expect(adaptLife({ ...base, intimacy: NaN }, NOW)?.intimacy).toBe(0);
    expect(adaptLife({ ...base, intimacy: Infinity }, NOW)?.intimacy).toBe(0);
  });
});

// ── 每日摘要 / 配角在场（9-25 add-life-readonly-endpoints）────────

describe('formatSummaryDate', () => {
  it('今天/昨天/更早', () => {
    expect(formatSummaryDate('2026-09-24', NOW)).toBe('今天');
    expect(formatSummaryDate('2026-09-23', NOW)).toBe('昨天');
    expect(formatSummaryDate('2026-08-27', NOW)).toBe('8月27日');
  });

  it('★ 日期-only 按本地日历解析，不因 UTC 偏移挪一天', () => {
    // 若用 new Date('2026-09-24') 解析（UTC 午夜），在负时区会退回 09-23 → 标签变「昨天」。
    // 这里断言的是本地构造的稳定性：同一个日期串在任何时区都该判为「今天」。
    expect(formatSummaryDate('2026-09-24', NOW)).toBe('今天');
    // 且不依赖 NOW 的具体时刻（NOW 是当天 21:00，换到当天 00:30 也应是「今天」）
    expect(formatSummaryDate('2026-09-24', new Date('2026-09-23T16:30:00Z'))).toBe('今天');
  });

  it('非法格式原样返回并告警，不崩不隐藏', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(formatSummaryDate('not-a-date', NOW)).toBe('not-a-date');
    expect(formatSummaryDate('2026/09/24', NOW)).toBe('2026/09/24');
    expect(warn).toHaveBeenCalled();
  });
});

describe('adaptSummaries', () => {
  it('空/null 安全', () => {
    expect(adaptSummaries([], NOW)).toEqual([]);
    expect(adaptSummaries(null, NOW)).toEqual([]);
    expect(adaptSummaries(undefined, NOW)).toEqual([]);
  });

  it('透传并生成标签，保序', () => {
    const out = adaptSummaries(
      [
        { date: '2026-09-23', summary: '昨天的事' },
        { date: '2026-09-24', summary: '今天的事' },
      ],
      NOW,
    );
    expect(out.map((s) => s.label)).toEqual(['昨天', '今天']);
    expect(out[0].text).toBe('昨天的事');
  });
});

describe('adaptCompanions', () => {
  const base = (status: string, extra: Record<string, unknown> = {}) => ({
    name: '迷迷',
    status,
    updatedAt: '2026-09-24T09:00:00Z',
    ...extra,
  });

  it('三种状态的中文标签 + 在场判定（present/expected 都算在场）', () => {
    const out = adaptCompanions(
      [base('present'), base('expected'), base('off-scene')],
      NOW,
    );
    expect(out.map((c) => c.statusLabel)).toEqual(['在场', '期待中', '离场']);
    expect(out.map((c) => c.present)).toEqual([true, true, false]);
  });

  it('未知状态原样显示 + 告警，不静默丢', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = adaptCompanions([base('weird-status')], NOW);
    expect(out[0].statusLabel).toBe('weird-status');
    expect(out[0].present).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('basis 缺失落空串，相对时间正常', () => {
    const out = adaptCompanions([base('present')], NOW);
    expect(out[0].basis).toBe('');
    expect(out[0].updatedAgo).toBe('4 小时前');
  });

  it('空/null 安全', () => {
    expect(adaptCompanions([], NOW)).toEqual([]);
    expect(adaptCompanions(null, NOW)).toEqual([]);
  });
});
