/**
 * ★ 2026-10-21（change: `add-letters`）
 *
 * **信**：不按日，她想写才写。
 *
 * 这些测试守的是"允许不写"这件事 —— 它比"能写信"重要得多：
 * 如果 NONE 被当成失败，每个 tick 都会重问一遍，最后变成逼她每周产出，
 * 信就退化成另一种打卡。
 */
import { describe, it, expect, vi } from 'vitest';
import { LifeService, isoWeekKey } from '../src/life.js';

function makeMocks(overrides: Record<string, any> = {}) {
  const memoryManager = {
    getLifeSnapshot: vi.fn().mockReturnValue({ mood: '平静', moodValue: 0.1, moodNote: '安静', currentActivity: '窗边', intimacy: 60, updatedAt: '' }),
    getPersonaSnapshot: vi.fn().mockReturnValue({
      name: '昔涟', tone: {}, speechStyle: {}, emotionalRange: {},
      memoryConfig: { retention_bias: 0.2, decay_rate: 0.3, importance_threshold: 0.4, recency_weight: 0.3, confirmation_bias: 0.3 },
    }),
    recordLifeEvent: vi.fn().mockReturnValue('id'),
    getLastUserMessageAt: vi.fn().mockReturnValue(null),
    getLifeEventInjection: vi.fn().mockReturnValue(''),
    getWorldbookSample: vi.fn().mockReturnValue([]),
    getUserActivitySummary: vi.fn().mockReturnValue(''),
    getRecentMessages: vi.fn().mockReturnValue([]),
    updateLifeState: vi.fn(),
    listLifeEvents: vi.fn().mockReturnValue([{ id: 'e1', content: '他今天很晚才回' }]),
    listLifeSummaries: vi.fn().mockReturnValue([{ date: '2026-10-19', summary: '安静的一周' }]),
    listLifeTemplates: vi.fn().mockReturnValue([]),
    listSessions: vi.fn().mockReturnValue([]),
    listDueIntents: vi.fn().mockReturnValue([]),
    upsertDailySummary: vi.fn(),
    markLifeEventDelivered: vi.fn(),
    bumpWorldbookHit: vi.fn(),
    saveIntent: vi.fn(),
    ingest: vi.fn().mockResolvedValue(undefined),
    listPresentCharacters: vi.fn().mockReturnValue([]),
    listScenePresence: vi.fn().mockReturnValue([]),
    upsertScenePresence: vi.fn(),
    saveLetter: vi.fn(),
    hasLetterForWeek: vi.fn().mockReturnValue(false),
    ...overrides,
  };
  return { memoryManager, push: { sendProactive: vi.fn().mockResolvedValue(true) } };
}

function makeService(overrides: Record<string, any> = {}, mmOverrides: Record<string, any> = {}) {
  const { memoryManager, push } = makeMocks(mmOverrides);
  const generateLetter = vi.fn().mockResolvedValue('这段时间你回来得越来越晚。我不问，但我在等。');
  const svc = new LifeService(memoryManager as any, push as any, {
    ownerOpenid: 'openid-1',
    generateLetter,
    generateEvent: async () => '{"content":"x","type":"internal"}',
    ...overrides,
  });
  return { svc, memoryManager, generateLetter };
}

const AT = new Date('2026-10-21T02:00:00+08:00');

describe('信：想写才写', () => {
  it('★ 有话要说 → 写一封，带周 key', async () => {
    const { svc, memoryManager } = makeService();
    await (svc as any).maybeWeeklyLetter(AT);

    expect(memoryManager.saveLetter).toHaveBeenCalledTimes(1);
    const arg = memoryManager.saveLetter.mock.calls[0][0];
    expect(arg.week).toBe(isoWeekKey(AT));
    expect(arg.date).toBe('2026-10-21');
    expect(arg.content.length).toBeGreaterThan(5);
  });

  it('★★ 回答 NONE ⇒ **不写**，但仍然置位（不重复追问）', async () => {
    const generateLetter = vi.fn().mockResolvedValue('NONE');
    const { svc, memoryManager } = makeService({ generateLetter });
    await (svc as any).maybeWeeklyLetter(AT);

    expect(memoryManager.saveLetter).not.toHaveBeenCalled();
    expect((svc as any).state.letterWeek).toBe(isoWeekKey(AT));

    // 同一周再跑一次：连 LLM 都不该再调
    await (svc as any).maybeWeeklyLetter(new Date('2026-10-23T02:00:00+08:00'));
    expect(generateLetter).toHaveBeenCalledTimes(1);
  });

  it('★ 同一周只问一次（letterWeek 去重）', async () => {
    const { svc, generateLetter } = makeService();
    await (svc as any).maybeWeeklyLetter(AT);
    await (svc as any).maybeWeeklyLetter(new Date('2026-10-22T02:00:00+08:00'));
    expect(generateLetter).toHaveBeenCalledTimes(1);
  });

  it('库里已有本周的信 ⇒ 不再问', async () => {
    const { svc, generateLetter } = makeService({}, { hasLetterForWeek: vi.fn().mockReturnValue(true) });
    await (svc as any).maybeWeeklyLetter(AT);
    expect(generateLetter).not.toHaveBeenCalled();
  });

  it('LLM 失败 ⇒ 不置位，下次还能重试', async () => {
    const generateLetter = vi.fn().mockRejectedValue(new Error('timeout'));
    const { svc, memoryManager } = makeService({ generateLetter });
    await (svc as any).maybeWeeklyLetter(AT);
    expect(memoryManager.saveLetter).not.toHaveBeenCalled();
    expect((svc as any).state.letterWeek).toBeFalsy();
  });

  it('isoWeekKey 稳定且格式正确', () => {
    expect(isoWeekKey(new Date('2026-10-21T00:00:00Z'))).toMatch(/^2026-W\d{2}$/);
    expect(isoWeekKey(new Date('2026-10-21T00:00:00Z'))).toBe(isoWeekKey(new Date('2026-10-24T00:00:00Z')));
  });
});
