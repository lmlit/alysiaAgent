/**
 * ★ 2026-10-21（change: `add-daily-diary`）
 *
 * **她每天写一篇日记**（半公开，进博客独立栏目）。
 *
 * 这条测试守的四个边界（都比"能写日记"重要）：
 *
 * 1. **写的是"昨天"**：跨天时写刚过去的那一天。若写成 today，博客上会出现
 *    "今天的日记讲的是昨天的事"这种时间错位，而且和摘要/反思的日期口径打架。
 * 2. **跨天只写一次**：`diaryDate` 是闸。没有它，每个 tick 都会重写一遍，机器烧钱、内容还互相覆盖。
 * 3. **失败不置位**：LLM 超时别把一整天吃掉 —— 下一次 tick 必须还能重试。
 * 4. **一天什么都没有就不写**：硬写就是编，日记最不能编。
 */
import { describe, it, expect, vi } from 'vitest';
import { LifeService } from '../src/life.js';

function makeMocks(overrides: Record<string, any> = {}) {
  const memoryManager = {
    getLifeSnapshot: vi.fn().mockReturnValue({
      currentActivity: '在窗边', mood: '平静', intimacy: 60, moodValue: 0.2, moodNote: '安静的下午', updatedAt: '',
    }),
    getPersonaSnapshot: vi.fn().mockReturnValue({
      name: '昔涟', tone: {}, speechStyle: {}, emotionalRange: {},
      memoryConfig: { retention_bias: 0.2, decay_rate: 0.3, importance_threshold: 0.4, recency_weight: 0.3, confirmation_bias: 0.3 },
    }),
    recordLifeEvent: vi.fn().mockReturnValue('life-id'),
    getLastUserMessageAt: vi.fn().mockReturnValue(null),
    getLifeEventInjection: vi.fn().mockReturnValue(''),
    getWorldbookSample: vi.fn().mockReturnValue([{ id: 'wb', content: '设定' }]),
    getUserActivitySummary: vi.fn().mockReturnValue(''),
    getRecentMessages: vi.fn().mockReturnValue([]),
    updateLifeState: vi.fn(),
    listLifeEvents: vi.fn().mockReturnValue([{ id: 'e1', content: '在窗台上给绿萝浇水' }]),
    listLifeSummaries: vi.fn().mockReturnValue([{ date: '2026-10-19', summary: '安静的一天' }]),
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
    saveDiary: vi.fn(),
    getLastDiaryTail: vi.fn().mockReturnValue('灯关掉以后，房间安静得能听见自己。'),
    ...overrides,
  };
  return { memoryManager, push: { sendProactive: vi.fn().mockResolvedValue(true) } };
}

function makeService(overrides: Record<string, any> = {}, mmOverrides: Record<string, any> = {}) {
  const { memoryManager, push } = makeMocks(mmOverrides);
  const generateDiary = vi.fn().mockResolvedValue('今天给窗台那盆绿浇了水，土是干的，浇完以后有股泥土味。');
  // ⚠️ 构造签名是 (memoryManager, push, opts) —— 三个位置参数，不是一个对象
  const svc = new LifeService(memoryManager as any, push as any, {
    ownerOpenid: 'openid-1',
    generateDiary,
    generateEvent: async () => '{"content":"窗台上的绿萝长新叶了","type":"internal"}',
    ...overrides,
  });
  // 关掉 tick 里其它环节的副作用（我们只测日记）
  (svc as any).state.nextEventAt = Date.now() + 3_600_000;
  return { svc, memoryManager, generateDiary };
}

const AT = new Date('2026-10-21T00:05:00+08:00'); // 刚跨天

describe('日记：跨天触发', () => {
  it('★ 写的是**昨天**的日记（date = 昨天），不是今天', async () => {
    const { svc, memoryManager } = makeService();
    await (svc as any).maybeDailyDiary(AT);

    expect(memoryManager.saveDiary).toHaveBeenCalledTimes(1);
    const arg = memoryManager.saveDiary.mock.calls[0][0];
    expect(arg.date).toBe('2026-10-20');
    expect(arg.content.length).toBeGreaterThan(10);
    // 心情一并落库（博客按它选封面）
    expect(arg.mood).toBe('平静');
    expect(arg.moodValue).toBe(0.2);
  });

  it('★ 同一天只写一次（diaryDate 是闸）', async () => {
    const { svc, memoryManager } = makeService();
    await (svc as any).maybeDailyDiary(AT);
    await (svc as any).maybeDailyDiary(new Date('2026-10-21T09:00:00+08:00'));
    expect(memoryManager.saveDiary).toHaveBeenCalledTimes(1);
  });

  it('没配 generateDiary ⇒ 整个功能降级关闭（不报错）', async () => {
    const { svc, memoryManager } = makeService({ generateDiary: undefined });
    await expect((svc as any).maybeDailyDiary(AT)).resolves.toBeUndefined();
    expect(memoryManager.saveDiary).not.toHaveBeenCalled();
  });

  it('★ 一天什么都没有 ⇒ 不写（硬写就是编）', async () => {
    const { svc, memoryManager } = makeService({}, {
      listLifeEvents: vi.fn().mockReturnValue([]),
      listLifeSummaries: vi.fn().mockReturnValue([]),
    });
    await (svc as any).maybeDailyDiary(AT);
    expect(memoryManager.saveDiary).not.toHaveBeenCalled();
  });

  it('★ LLM 失败 ⇒ 不置位，下次还能重试', async () => {
    const generateDiary = vi.fn().mockRejectedValue(new Error('LLM 超时'));
    const { svc, memoryManager } = makeService({ generateDiary });
    await (svc as any).maybeDailyDiary(AT);
    expect(memoryManager.saveDiary).not.toHaveBeenCalled();
    expect((svc as any).state.diaryDate).toBeFalsy();

    // 下一次 tick 重试成功
    generateDiary.mockResolvedValue('补上了昨天那一篇。');
    await (svc as any).maybeDailyDiary(new Date('2026-10-21T00:10:00+08:00'));
    expect(memoryManager.saveDiary).toHaveBeenCalledTimes(1);
  });

  it('LLM 返回空串 ⇒ 不写、不置位（空日记等于没写）', async () => {
    const generateDiary = vi.fn().mockResolvedValue('   ');
    const { svc, memoryManager } = makeService({ generateDiary });
    await (svc as any).maybeDailyDiary(AT);
    expect(memoryManager.saveDiary).not.toHaveBeenCalled();
  });

  it('★ 把"上一篇的最后一句"喂给生成器（连续性）', async () => {
    const { svc, generateDiary } = makeService();
    await (svc as any).maybeDailyDiary(AT);
    const ctx = generateDiary.mock.calls[0][0] as string;
    expect(ctx).toContain('上一篇的最后一句');
    expect(ctx).toContain('灯关掉以后');
    // 也应当带上今天的事与心情
    expect(ctx).toContain('绿萝');
    expect(ctx).toContain('平静');
  });
});
