/**
 * ★ 2026-10-20（change: `let-her-decline-a-day`）
 *
 * **她可以拒绝**：这一轮不想说话就不说 —— 但必须留下理由（入库 internal，可召回）。
 *
 * 这条测试真正守的是**两条边界**（而不是"能拒绝"这个功能本身）：
 *
 * 1. **拒绝 ≠ 停摆**：拒绝路径必须**续期锁**、必须**留痕**。
 *    原先 spec §2 的 `P1-6「永不静默停摆」`把"不主动"当故障，正是因为它担心
 *    "系统不知道自己该不该醒"。拒绝权不能把那个故障放回来。
 * 2. **拒绝失败必须 fail-open**：理由拿不到 / 太短 ⇒ **按正常流程生成**，
 *    绝不允许"拒绝机制坏了"表现为"她从此不说话"（那是最糟的静默故障）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LifeService, MAX_CONSECUTIVE_DECLINES, DECLINE_MIN_REASON_CHARS } from '../src/life.js';

function makeMocks(overrides: Record<string, any> = {}) {
  const memoryManager = {
    getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '在窗边', mood: '平静', intimacy: 60, moodValue: 0, updatedAt: '' }),
    getPersonaSnapshot: vi.fn().mockReturnValue({
      name: '昔涟', tone: {}, speechStyle: {}, emotionalRange: {},
      memoryConfig: { retention_bias: 0.2, decay_rate: 0.3, importance_threshold: 0.4, recency_weight: 0.3, confirmation_bias: 0.3 },
    }),
    recordLifeEvent: vi.fn().mockReturnValue('life-mock-id'),
    getLastUserMessageAt: vi.fn().mockReturnValue(null),
    getLifeEventInjection: vi.fn().mockReturnValue(''),
    getWorldbookSample: vi.fn().mockReturnValue([{ id: 'wb-mock', content: '设定' }]),
    getUserActivitySummary: vi.fn().mockReturnValue(''),
    getRecentMessages: vi.fn().mockReturnValue([]),
    updateLifeState: vi.fn(),
    listLifeEvents: vi.fn().mockReturnValue([]),
    listLifeSummaries: vi.fn().mockReturnValue([]),
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
    ...overrides,
  };
  const qqOff = { sendProactive: vi.fn().mockResolvedValue(true) };
  return { memoryManager, qqOff };
}

const CHAT_JSON = '{"content":"窗外的雨停了","message":"雨停了，你那边呢","type":"chat"}';

describe('拒绝权：她可以这一轮不说话', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(declineReason: string | (() => Promise<string>) = '脑子还挂着昨天没写完的东西，不想开口。') {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T14:00:00'));
    vi.spyOn(Math, 'random').mockReturnValue(0.01); // 骰子必中（chance 0.15）
    const { memoryManager, qqOff } = makeMocks();
    const generateDecline = vi.fn(
      typeof declineReason === 'function' ? declineReason : async () => declineReason,
    );
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      declineChance: 0.15,
      generateDecline,
      generateEvent: async () => CHAT_JSON,
    });
    return { svc, memoryManager, qqOff, generateDecline };
  }

  it('★ 骰子命中 → 不生成生活事件、不推送，只写一条带理由的 internal', async () => {
    const { svc, memoryManager, qqOff } = setup();
    await svc.tick();

    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    const calls = memoryManager.recordLifeEvent.mock.calls.map(c => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('internal');
    expect(calls[0].origin).toBe('decline');
    expect(calls[0].content).toContain('没写完的东西');
  });

  it('★ 拒绝 ≠ 停摆：锁必须续期（P1-6 的原始担忧不许回归）', async () => {
    const { svc } = setup();
    const before = (svc as any).state.nextEventAt;
    await svc.tick();
    const after = (svc as any).state.nextEventAt;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(Date.now());
  });

  it('★ 连续拒绝到上限 ⇒ 必须说话（防"她从此不开口"）', async () => {
    const { svc, memoryManager, qqOff } = setup();
    // 同一时刻连跑 MAX+1 轮（每轮骰子都中）
    for (let i = 0; i < MAX_CONSECUTIVE_DECLINES; i++) {
      await svc.tick();
      expect(qqOff.sendProactive, `第 ${i + 1} 轮仍应拒绝`).not.toHaveBeenCalled();
    }
    // 第 N+1 轮：护栏生效 → 走正常生成
    await svc.tick();
    const calls = memoryManager.recordLifeEvent.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.type === 'chat'), '到顶后必须产出正常事件').toBe(true);
    expect(qqOff.sendProactive).toHaveBeenCalled();
  });

  it('正常产出后，连续拒绝计数归零', async () => {
    const { svc } = setup();
    await svc.tick(); // 拒绝一次
    expect((svc as any).state.consecutiveDeclines).toBe(1);
    (svc as any).state.consecutiveDeclines = MAX_CONSECUTIVE_DECLINES; // 直接顶到上限
    await svc.tick(); // 护栏放行 → 正常生成
    expect((svc as any).state.consecutiveDeclines).toBe(0);
  });

  it('★ 理由太短 ⇒ fail-open：不认这次拒绝，按正常流程生成（绝不静默）', async () => {
    const { svc, memoryManager, qqOff } = setup('算了');
    await svc.tick();
    const calls = memoryManager.recordLifeEvent.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.origin === 'decline'), '短理由不该被当成拒绝').toBe(false);
    expect(calls.some(c => c.type === 'chat'), '必须退回正常生成').toBe(true);
    expect(qqOff.sendProactive).toHaveBeenCalled();
  });

  it('★ 理由生成抛错 ⇒ 同样 fail-open', async () => {
    const { svc, memoryManager } = setup(async () => { throw new Error('LLM 挂了'); });
    await svc.tick();
    const calls = memoryManager.recordLifeEvent.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.origin === 'decline')).toBe(false);
    expect(calls.some(c => c.type === 'chat')).toBe(true);
  });

  it('declineChance = 0 ⇒ 拒绝能力关闭（永不调用生成器）', async () => {
    const { svc, generateDecline } = setup();
    (svc as any).opts.declineChance = 0;
    await svc.tick();
    expect(generateDecline).not.toHaveBeenCalled();
  });

  it('没注入 generateDecline ⇒ 拒绝能力自动关闭（降级不留空窗）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T14:00:00'));
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      declineChance: 0.5,
      generateEvent: async () => CHAT_JSON,
    });
    await svc.tick();
    expect(qqOff.sendProactive).toHaveBeenCalled(); // 照常说话
  });

  it('拒绝理由的长度门槛是常量（不是魔法数字）', () => {
    expect(DECLINE_MIN_REASON_CHARS).toBeGreaterThanOrEqual(4);
    expect(MAX_CONSECUTIVE_DECLINES).toBeGreaterThanOrEqual(1);
  });
});
