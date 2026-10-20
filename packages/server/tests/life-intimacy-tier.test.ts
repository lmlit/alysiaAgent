/**
 * ★ 2026-10-20（change: `tie-intimacy-to-speech`；规则由用户授权代定）
 *
 * 这条测试守的是**行为**，不是数值：亲密度必须真的改变「她多主动」。
 *
 * 改之前：`intimacy` 只被注入 prompt（spec §11「用途」那句），推送判定三个条件
 * （冷却 / 日上限 / can_contact）**一个都不读它** —— 亲密度 20 和 90 说话频率一样。
 *
 * 四条规则各一组：
 *   1. 四档上限
 *   2. **只降不升**（配置再大也只能被压低）
 *   3. `silent` 档不推送、但生活照常记录
 *   4. 升档**迟滞 +5**（防 40 上下抖动）
 *   5. 「他回来了」只发生一次
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LifeService, intimacyTier, INTIMACY_TIERS } from '../src/life.js';

function makeMocks(overrides: Record<string, any> = {}) {
  const memoryManager = {
    getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '', intimacy: 80, moodValue: 0, updatedAt: '' }),
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
    listLifeTemplates: vi.fn().mockReturnValue([
      { id: 'lt-1', activity: '给自己倒了杯水', type: 'internal', weight: 5, source: 'seed', category: '独处', groupName: 'none' },
    ]),
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

/** chat 事件（可推送）的 LLM 输出 */
const CHAT_JSON = '{"content":"在阳台看书，看到一朵像兔子的云","message":"刚看到一朵像兔子的云","type":"chat"}';

function makeService(memoryManager: any, qqOff: any, opts: Record<string, any> = {}) {
  return new LifeService(memoryManager, qqOff, {
    ownerOpenid: 'openid-1',
    generateEvent: async () => CHAT_JSON,
    ...opts,
  });
}

/** 在冻结时间下跑到指定时刻 */
function at(hour: number, minute = 0) {
  vi.setSystemTime(new Date(`2026-08-06T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`));
}

describe('亲密度 → 推送档位', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('四档映射（阈值 70 / 40 / 25）', () => {
    expect(intimacyTier(90).tier).toBe('close');
    expect(intimacyTier(70).tier).toBe('close');
    expect(intimacyTier(69).tier).toBe('normal');
    expect(intimacyTier(40).tier).toBe('normal');
    expect(intimacyTier(39).tier).toBe('distant');
    expect(intimacyTier(25).tier).toBe('distant');
    expect(intimacyTier(24).tier).toBe('silent');
    expect(intimacyTier(10).tier).toBe('silent');
    // 配置再怎么看，档位上限是硬表
    expect(INTIMACY_TIERS.map(t => t.cap)).toEqual([5, 3, 1, 0]);
  });

  it('★ 只降不升：配置 10 条 + 「疏远」档 ⇒ 实际只能发 1 条', async () => {
    vi.useFakeTimers();
    const { memoryManager, qqOff } = makeMocks({
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '', intimacy: 30, moodValue: 0, updatedAt: '' }),
    });
    const svc = makeService(memoryManager, qqOff, { maxChatPushesPerDay: 10 });

    // 疏远档冷却 4h：14:00 / 19:00 / 23:00 三次都在同一天且都过了冷却
    for (const h of [14, 19, 23]) { at(h); await svc.tick(); }

    expect(qqOff.sendProactive, '配置 10 不能盖过档位的 1').toHaveBeenCalledTimes(1);
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledTimes(3); // 生活照常记录
  });

  it('★ 「久无往来」档：一条都不推，但生活事件照常入库', async () => {
    vi.useFakeTimers();
    const { memoryManager, qqOff } = makeMocks({
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '', intimacy: 15, moodValue: 0, updatedAt: '' }),
    });
    const svc = makeService(memoryManager, qqOff, { maxChatPushesPerDay: 5 });

    for (const h of [14, 20]) { at(h); await svc.tick(); }

    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledTimes(2);
  });

  it('「平常」档：上限 3（不是默认 5）', async () => {
    vi.useFakeTimers();
    const { memoryManager, qqOff } = makeMocks({
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '', intimacy: 50, moodValue: 0, updatedAt: '' }),
    });
    const svc = makeService(memoryManager, qqOff);

    for (const h of [9, 12, 15, 18]) { at(h); await svc.tick(); }

    expect(qqOff.sendProactive).toHaveBeenCalledTimes(3);
  });

  it('★ 升档迟滞 +5：39 → 42 仍是「疏远」，46 才回到「平常」', () => {
    vi.useFakeTimers();
    at(14);
    const snapshot = { currentActivity: '', mood: '', intimacy: 39, moodValue: 0, updatedAt: '' };
    const { memoryManager, qqOff } = makeMocks({
      getLifeSnapshot: vi.fn(() => snapshot),
    });
    const svc: any = makeService(memoryManager, qqOff);

    expect(svc.resolveIntimacyTier(new Date()).tier).toBe('distant');

    snapshot.intimacy = 42; // 越过 40 但没越过 40+5
    expect(svc.resolveIntimacyTier(new Date()).tier, '42 就升档会导致频率在 40 上下抖动').toBe('distant');

    snapshot.intimacy = 46;
    expect(svc.resolveIntimacyTier(new Date()).tier).toBe('normal');

    // 降档不需要迟滞：立刻生效
    snapshot.intimacy = 24;
    expect(svc.resolveIntimacyTier(new Date()).tier).toBe('silent');
  });

  it('★ 「他回来了」只在真的安静过之后发生一次', () => {
    vi.useFakeTimers();
    at(14);
    const snapshot = { currentActivity: '', mood: '', intimacy: 80, moodValue: 0, updatedAt: '' };
    const { memoryManager, qqOff } = makeMocks({ getLifeSnapshot: vi.fn(() => snapshot) });
    const svc: any = makeService(memoryManager, qqOff);

    // 亲密度一直很高：从来不是「回来了」
    svc.resolveIntimacyTier(new Date());
    svc.relationshipBlock(new Date());
    expect(svc.state.recoveryPending, '一直很亲近的人不该出现「他回来了」').toBeFalsy();

    // 掉到 silent，再回到 46
    snapshot.intimacy = 15;
    svc.resolveIntimacyTier(new Date());
    snapshot.intimacy = 46;
    svc.resolveIntimacyTier(new Date());
    expect(svc.state.recoveryPending).toBe(true);

    // 第一次生成事件时消费掉
    const block1 = svc.relationshipBlock(new Date());
    expect(block1).toContain('他回来了');
    expect(svc.state.recoveryPending).toBeFalsy();

    // 第二次不再出现
    const block2 = svc.relationshipBlock(new Date());
    expect(block2).not.toContain('他回来了');
  });

  it('「最近在忙吗」每 7 天最多一次', () => {
    vi.useFakeTimers();
    at(14);
    const snapshot = { currentActivity: '', mood: '', intimacy: 30, moodValue: 0, updatedAt: '' };
    const { memoryManager, qqOff } = makeMocks({
      getLifeSnapshot: vi.fn(() => snapshot),
      getLastUserMessageAt: vi.fn(() => new Date(Date.now() - 5 * 86_400_000).toISOString()),
    });
    const svc: any = makeService(memoryManager, qqOff);

    expect(svc.relationshipBlock(new Date())).toContain('最近在忙');
    // 同一天再生成：已经问过了
    expect(svc.relationshipBlock(new Date())).not.toContain('最近在忙');
    // 第 8 天：又可以问一次
    vi.setSystemTime(new Date(Date.now() + 8 * 86_400_000));
    expect(svc.relationshipBlock(new Date())).toContain('最近在忙');
  });
});
