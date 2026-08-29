import { describe, it, expect, vi, afterEach } from 'vitest';
import { LifeService } from '../src/life.js';

/** MemoryManager / QQ 适配器 mock（按真实接口 getRecentMessages/ingest/listLifeEvents） */
function makeMocks(overrides: Record<string, any> = {}) {
  const memoryManager = {
    getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '', intimacy: 30, moodValue: 0, updatedAt: '' }),
    // ★ 旋钮（8-08：updateIntimacy 读 getPersonaSnapshot().memoryConfig，默认值 0.3/0.4/0.3/0.3）
    getPersonaSnapshot: vi.fn().mockReturnValue({
      name: '昔涟',
      tone: {}, speechStyle: {}, emotionalRange: {},
      memoryConfig: { retention_bias: 0.2, decay_rate: 0.3, importance_threshold: 0.4, recency_weight: 0.3, confirmation_bias: 0.3 },
    }),
    recordLifeEvent: vi.fn().mockReturnValue('life-mock-id'),
    getLifeEventInjection: vi.fn().mockReturnValue(''),
    getWorldbookSample: vi.fn().mockReturnValue([{ id: 'wb-mock', content: '设定' }]),
    getUserActivitySummary: vi.fn().mockReturnValue('用户最近在忙'),
    getRecentMessages: vi.fn().mockReturnValue([]),
    updateLifeState: vi.fn(),
    listLifeEvents: vi.fn().mockReturnValue([]),
    listLifeSummaries: vi.fn().mockReturnValue([]),
    // ★ 8-14 模板池迁库：pickTemplate 从库实时读取
    listLifeTemplates: vi.fn().mockReturnValue([
      { id: 'lt-1', activity: '给自己倒了杯水', type: 'internal', weight: 5, source: 'seed', category: '独处', groupName: 'none' },
    ]),
    listSessions: vi.fn().mockReturnValue([]),
    upsertDailySummary: vi.fn(),
    markLifeEventDelivered: vi.fn(),
    bumpWorldbookHit: vi.fn(),
    ingest: vi.fn().mockResolvedValue(undefined),
    // ★ 8-27 配角在场（ScenePresence）
    listPresentCharacters: vi.fn().mockReturnValue([]),
    listScenePresence: vi.fn().mockReturnValue([]),
    upsertScenePresence: vi.fn(),
    ...overrides,
  };
  const qqOff = { sendProactive: vi.fn().mockResolvedValue(true) };
  return { memoryManager, qqOff };
}

/**
 * 冻结本地时间（fake timers）。无时区后缀的日期字符串按本地时间解析，
 * 保证 getHours() 判定与机器时区无关。
 */
function freezeTime(hour: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`2026-08-06T${String(hour).padStart(2, '0')}:00:00`));
}

describe('LifeService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('聊天锁：用户互动窗口内 → 跳过事件生成（8-09 概率门移除后由锁承担）', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks({
      getRecentMessages: vi.fn().mockReturnValue([{ role: 'user', content: 'hi' }]),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"chat"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).not.toHaveBeenCalled();
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
  });

  it('tick generates + stores + pushes chat event on window', async () => {
    freezeTime(14); // 本地 14:00（白天，非深夜）
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      probability: 0.3,
      generateEvent: async () => '{"content":"在阳台看书，看到一朵像兔子的云","type":"chat","mood_delta":"开心"}',
    });
    await svc.tick();
    // 存储
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat', content: '在阳台看书，看到一朵像兔子的云' })
    );
    // 推送
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '在阳台看书，看到一朵像兔子的云');
    // 推送成功 → 回写记忆（assistant 角色）
    expect(memoryManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'chat',
        payload: expect.objectContaining({ content: '在阳台看书，看到一朵像兔子的云', role: 'assistant' }),
      })
    );
  });

  it('internal events never push', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"给自己倒了杯水","type":"internal","mood_delta":"平静"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalled();
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.ingest).toHaveBeenCalled(); // ★ 8-09 C：internal 也回写记忆
  });

  it('★ 8-28 深夜抑制关闭：深夜 chat 类型不再被强制转 internal，正常推送', async () => {
    freezeTime(2); // 本地 02:00（深夜 [0,7)——抑制已关闭，类型交 LLM）
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"深夜想说的话","type":"chat","mood_delta":"平静"}',
      deepNightHours: [0, 7],
    });
    await svc.tick();
    // chat 类型保留（不再强制 internal）+ 正常推送（深夜不再是推送门条件）
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat', content: '深夜想说的话' })
    );
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '深夜想说的话');
  });

  it('LLM 裸文本（无 JSON 外壳）→ 宽容解析直接作为事件内容并推送（8-09）', async () => {
    freezeTime(14); // 白天，非深夜
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      probability: 0.3,
      generateEvent: async () => '那夜为云描的月光，已随风陪我过了第三日。', // 07:16 实测案例
    });
    await svc.tick();
    // 裸文本不再被丢弃（原行为：fallback 模板）——直接作为 chat 事件
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat', content: '那夜为云描的月光，已随风陪我过了第三日。' })
    );
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '那夜为云描的月光，已随风陪我过了第三日。');
  });

  it('★ 8-28 深夜抑制关闭：裸文本深夜 → chat 类型 + 推送（不再强制 internal）', async () => {
    freezeTime(2); // 本地 02:00（深夜 [0,7)——抑制已关闭）
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '深夜的独白。',
      deepNightHours: [0, 7],
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat', content: '深夜的独白。' })
    );
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '深夜的独白。');
  });

  it('generateEvent 抛异常 → 模板 fallback 强制 internal，不推送（8-09）', async () => {
    freezeTime(14); // 白天
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      probability: 0.3,
      generateEvent: async () => { throw new Error('LLM down'); },
    });
    await svc.tick();
    // 模板事件强制 internal（原 t.type 可能为 chat 会推送——模板无剧情链，不再打扰用户）
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'internal', moodDelta: '平静' })
    );
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.ingest).toHaveBeenCalled(); // ★ 8-09 C：internal 也回写记忆
  });

  // ── P1 每日摘要：独立 generateSummary 纯文本回调，JSON 不污染 ──────────

  it('maybeGenerateDailySummary: generateSummary 返回 JSON 对象 → 剥出 content 字段入库（不污染摘要层）', async () => {
    freezeTime(0); // 本地 00:00（跨天检测触发）
    const { memoryManager, qqOff } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', createdAt: '2026-08-05T09:30:00', content: '在旧书店待了一下午' },
        { id: 'life-2', createdAt: '2026-08-05T15:00:00', content: '下雨听雨' },
      ]),
      upsertDailySummary: vi.fn(),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateSummary: async () => '{"content":"昨天在旧书店待了一下午，下雨听雨"}',
    });
    await svc.tick();
    expect(memoryManager.upsertDailySummary).toHaveBeenCalledWith('2026-08-05', '昨天在旧书店待了一下午，下雨听雨');
  });

  it('maybeGenerateDailySummary: ```json fence 包裹 → 剥 fence 再取 content', async () => {
    freezeTime(0);
    const { memoryManager, qqOff } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', createdAt: '2026-08-05T09:30:00', content: '在旧书店待了一下午' },
      ]),
      upsertDailySummary: vi.fn(),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateSummary: async () => '```json\n{"content":"昨天淘到一本讲星星的书"}\n```',
    });
    await svc.tick();
    expect(memoryManager.upsertDailySummary).toHaveBeenCalledWith('2026-08-05', '昨天淘到一本讲星星的书');
  });

  it('maybeGenerateDailySummary: 纯文本摘要原样入库（无 JSON 解析副作用）', async () => {
    freezeTime(0);
    const { memoryManager, qqOff } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', createdAt: '2026-08-05T09:30:00', content: '在旧书店待了一下午' },
      ]),
      upsertDailySummary: vi.fn(),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateSummary: async () => '在旧书店待了一下午，淘到星星的书',
    });
    await svc.tick();
    expect(memoryManager.upsertDailySummary).toHaveBeenCalledWith('2026-08-05', '在旧书店待了一下午，淘到星星的书');
  });

  it('maybeGenerateDailySummary: 无 generateSummary 回调 → 跳过（降级），不调用 generateEvent', async () => {
    freezeTime(0);
    const { memoryManager, qqOff } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', createdAt: '2026-08-05T09:30:00', content: '在旧书店待了一下午' },
      ]),
      upsertDailySummary: vi.fn(),
    });
    const genEvent = vi.fn();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: genEvent,
      // 不传 generateSummary
    });
    await svc.tick();
    expect(memoryManager.upsertDailySummary).not.toHaveBeenCalled();
  });

  // ── P6 摘要失败重试：成功入库后才置位 lastSummaryDate ────────────────

  it('摘要失败不置位 lastSummaryDate → 下次 tick 重试；成功后不再重复生成', async () => {
    freezeTime(0);
    const { memoryManager, qqOff } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', createdAt: '2026-08-05T09:30:00', content: '在旧书店待了一下午' },
      ]),
      upsertDailySummary: vi.fn(),
    });
    const gen = vi.fn()
      .mockRejectedValueOnce(new Error('LLM down'))       // tick 1: 失败
      .mockResolvedValueOnce('昨天在旧书店待了一下午')     // tick 2: 重试成功
      .mockResolvedValueOnce('不应再被调用');              // tick 3: 应已置位
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateSummary: gen,
    });
    await svc.tick();
    expect(memoryManager.upsertDailySummary).not.toHaveBeenCalled();
    await svc.tick();
    expect(memoryManager.upsertDailySummary).toHaveBeenCalledWith('2026-08-05', '昨天在旧书店待了一下午');
    await svc.tick();
    expect(memoryManager.upsertDailySummary).toHaveBeenCalledTimes(1);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  // ── P2 剧情链：reference_event_id 必须命中今天事件 ID（防幻觉）────────

  it('剧情链：reference_event_id 命中今天事件 ID → 透传落库', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-100', createdAt: '2026-08-06T09:30:00', content: '在阳台看书' },
      ]),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
      generateEvent: async () => '{"content":"这让我想起看书","type":"internal","reference_event_id":"life-100"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(expect.objectContaining({ referenceEventId: 'life-100' }));
  });

  it('剧情链：幻觉 reference_event_id（不在今天 ID 集合）→ 置 undefined 不落库', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-100', createdAt: '2026-08-06T09:30:00', content: '在阳台看书' },
      ]),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
      generateEvent: async () => '{"content":"这让我想起昨天看书","type":"internal","reference_event_id":"life-hallucinated"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(expect.objectContaining({ referenceEventId: undefined }));
  });

  // ── P3 世界书命中统计：prompt 带 [wb: id]，wb_entry_id 校验 + bump ──────

  it('生成器 prompt：今天事件带 [id:]，摘要行不带 ID，世界书带 [wb:]', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    let ctx = '';
    const { memoryManager, qqOff } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-100', createdAt: '2026-08-06T09:30:00', content: '在阳台看书' },
      ]),
      listLifeSummaries: vi.fn().mockReturnValue([{ date: '2026-08-05', summary: '在旧书店待了一下午' }]),
      getWorldbookSample: vi.fn().mockReturnValue([{ id: 'wb_1', content: '设定内容' }]),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
      generateEvent: async (c: string) => { ctx = c; return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    expect(ctx).toContain('[id: life-100]');
    expect(ctx).toContain('[wb: wb_1]');
    expect(ctx).toContain('- 2026-08-05: 在旧书店待了一下午');
  });

  it('世界书：wb_entry_id 命中采样 ID → recordLifeEvent 透传 + bumpWorldbookHit', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      getWorldbookSample: vi.fn().mockReturnValue([{ id: 'wb_1', content: '设定内容' }]),
      bumpWorldbookHit: vi.fn(),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
      generateEvent: async () => '{"content":"想起从前的约定","type":"internal","wb_entry_id":"wb_1"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(expect.objectContaining({ wbEntryId: 'wb_1' }));
    expect(memoryManager.bumpWorldbookHit).toHaveBeenCalledWith('wb_1');
  });

  it('世界书：幻觉 wb_entry_id → 丢弃且不 bump 命中', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      getWorldbookSample: vi.fn().mockReturnValue([{ id: 'wb_1', content: '设定内容' }]),
      bumpWorldbookHit: vi.fn(),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
      generateEvent: async () => '{"content":"想起从前的约定","type":"internal","wb_entry_id":"wb_hallucinated"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(expect.objectContaining({ wbEntryId: undefined }));
    expect(memoryManager.bumpWorldbookHit).not.toHaveBeenCalled();
  });

  // ── P5 delivered 接线：推送成功后标记 ──────────────────────────────────

  it('推送成功后 markLifeEventDelivered(recordLifeEvent 返回的 id)', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      recordLifeEvent: vi.fn().mockReturnValue('life-123'),
      markLifeEventDelivered: vi.fn(),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
      generateEvent: async () => '{"content":"在阳台看书","type":"chat"}',
    });
    await svc.tick();
    expect(qqOff.sendProactive).toHaveBeenCalled();
    expect(memoryManager.markLifeEventDelivered).toHaveBeenCalledWith('life-123');
  });

  it('推送失败 → 不标记 delivered', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      recordLifeEvent: vi.fn().mockReturnValue('life-123'),
      markLifeEventDelivered: vi.fn(),
    });
    qqOff.sendProactive.mockResolvedValue(false);
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
      generateEvent: async () => '{"content":"在阳台看书","type":"chat"}',
    });
    await svc.tick();
    expect(memoryManager.markLifeEventDelivered).not.toHaveBeenCalled();
  });

  // ── P4 亲密度无互动衰减（spec §11 + 旋钮接线：默认 threshold=2+(1-0.4)×10=8 天，decay=0.3×6=1.8/天）─────

  it('亲密度：5 天无 user 互动 → 未过 8 天阈值，不衰减（默认旋钮）', async () => {
    freezeTime(12);
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      role: 'user', content: `消息${i}`, createdAt: '2026-08-01T10:04:00', // 距现在 5 天
    }));
    const { memoryManager, qqOff } = makeMocks({ getRecentMessages: vi.fn().mockReturnValue(msgs) });
    const svc = new LifeService(memoryManager as any, qqOff as any, { ownerOpenid: 'openid-1' });
    svc.updateIntimacy();
    // weighted = 5条×max(0.1, 1-0.3×0.5=0.85)（全在 3 天外） = 4.25
    // freqScore = 4.25/4×5 = 5.3125；longScore=5×1.05=5.25；activeScore=1×3=3；raw=43.5625
    // 平滑：prev=30 + (43.5625-30)×(1-0.3×0.7=0.79) = 40.714
    const call = memoryManager.updateLifeState.mock.calls[0][0] as { intimacy: number };
    expect(call.intimacy).toBeCloseTo(40.714, 2);
  });

  it('亲密度：今天有 user 互动 → 不衰减，recency 加权生效', async () => {
    freezeTime(12);
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      role: 'user', content: `消息${i}`, createdAt: '2026-08-06T10:00:00', // 今天
    }));
    const { memoryManager, qqOff } = makeMocks({ getRecentMessages: vi.fn().mockReturnValue(msgs) });
    const svc = new LifeService(memoryManager as any, qqOff as any, { ownerOpenid: 'openid-1' });
    svc.updateIntimacy();
    // weighted = 5条×(1+0.3=1.3)（都在近 3 天）= 6.5 → freqScore=6.5/4×5=8.125
    // longScore=5.25；activeScore=3；raw=46.375 → 平滑 30+(46.375-30)×0.79=42.936
    const call = memoryManager.updateLifeState.mock.calls[0][0] as { intimacy: number };
    expect(call.intimacy).toBeCloseTo(42.936, 2);
  });
});

describe('LifeService — 事件驱动调度（8-09）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('next_in_hours 决定下一次事件时间', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { memoryManager } = makeMocks();
    const svc = new LifeService(memoryManager as any, { sendProactive: vi.fn().mockResolvedValue(true) } as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"在玩游戏","type":"internal","next_in_hours":3}',
    });
    await svc.tick();
    const next = (svc as any).state.nextEventAt;
    expect(next - Date.now()).toBeCloseTo(3 * 3_600_000, -2); // ≈3h（容差 ~10s）
  });

  it('next_in_hours 钳制：99 → 8h，0.1 → 0.5h', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // 99 → 钳到 8h
    const a = new LifeService(makeMocks().memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal","next_in_hours":99}',
    });
    await a.tick();
    expect((a as any).state.nextEventAt - Date.now()).toBeCloseTo(8 * 3_600_000, -2);
    // 0.1 → 钳到 0.5h
    const b = new LifeService(makeMocks().memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal","next_in_hours":0.1}',
    });
    await b.tick();
    expect((b as any).state.nextEventAt - Date.now()).toBeCloseTo(0.5 * 3_600_000, -2);
  });

  it('LLM 未给 next_in_hours → 默认间隔兜底（scheduleNextEvent 重排）', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { memoryManager } = makeMocks();
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      defaultIntervalHours: 2,
      generateEvent: async () => '{"content":"x","type":"internal"}', // 无 next_in_hours
    });
    await svc.tick();
    const next = (svc as any).state.nextEventAt;
    expect(next - Date.now()).toBeCloseTo(2 * 3_600_000, -2); // clampIntervalHours(undefined)=0 → scheduleNextEvent 默认 2h
  });

  it('重启重排：nextEventAt 已过 → 排未来默认间隔，不补发', () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { memoryManager } = makeMocks();
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1' });
    (svc as any).state.nextEventAt = Date.now() - 60_000; // 错过的事件
    svc.start();
    expect((svc as any).eventTimer).not.toBeNull();
    expect((svc as any).state.nextEventAt).toBeGreaterThan(Date.now() + 30 * 60_000);
    svc.stop();
  });

  // ── ★ 8-30 锁续期（life-schedule-renewal）：保底 + 时段 + 容错 ──────────

  it('白天未给 next_in_hours → 保底 1h（默认间隔）', async () => {
    freezeTime(14); // 白天
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { memoryManager } = makeMocks();
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal"}',
    });
    await svc.tick();
    expect((svc as any).state.nextEventAt - Date.now()).toBeCloseTo(1 * 3_600_000, -2);
  });

  it('夜间未给 next_in_hours → 保底 2h（睡觉节奏慢）', async () => {
    freezeTime(2); // 夜间 [0,7)
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { memoryManager } = makeMocks();
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      deepNightHours: [0, 7],
      generateEvent: async () => '{"content":"x","type":"internal"}',
    });
    await svc.tick();
    expect((svc as any).state.nextEventAt - Date.now()).toBeCloseTo(2 * 3_600_000, -2);
  });

  it('P1-6 修复：生成失败（LLM + 模板全空）→ 保底续期，不停摆', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { memoryManager } = makeMocks({
      listLifeTemplates: vi.fn().mockReturnValue([]), // 模板池也空 → evt null
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => { throw new Error('LLM down'); },
    });
    await svc.tick();
    // 不 record、但锁续期（保底 1h）——不再静默停摆
    expect(memoryManager.recordLifeEvent).not.toHaveBeenCalled();
    expect((svc as any).state.nextEventAt - Date.now()).toBeCloseTo(1 * 3_600_000, -2);
    expect((svc as any).eventTimer).not.toBeNull(); // 已重排
  });

  it('模型给值始终优先：夜间给 0.5h → 提前到 0.5h（不被夜间保底拖慢）', async () => {
    freezeTime(2); // 夜间
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { memoryManager } = makeMocks();
    const qqOff = { sendProactive: vi.fn().mockResolvedValue(true) };
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      deepNightHours: [0, 7],
      generateEvent: async () => '{"content":"深夜想找轻月聊天","type":"chat","next_in_hours":0.5}',
    });
    await svc.tick();
    expect((svc as any).state.nextEventAt - Date.now()).toBeCloseTo(0.5 * 3_600_000, -2);
  });
});

describe('LifeService — 剧情延续与推送节奏（8-09）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('★ 8-28 间隔叙事：8h 内 internal 事件 → prompt 含【上次事件】延续引导，continuation_of 透传', async () => {
    freezeTime(14);
    const ctx: string[] = [];
    const { memoryManager } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', content: '在阳台看书', type: 'internal', createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx.push(c); return '{"content":"继续看书","type":"internal","continuation_of":"life-1"}'; },
    });
    await svc.tick();
    expect(ctx[0]).toContain('【上次事件】');
    expect(ctx[0]).toContain('在阳台看书');
    expect(ctx[0]).toContain('continuation_of');
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ continuationOf: 'life-1' })
    );
  });

  it('★ 8-28 间隔叙事：非延续事件（间隔补写）→ prompt 含间隔覆盖引导', async () => {
    freezeTime(14);
    const ctx: string[] = [];
    const { memoryManager } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-9', content: '泡了杯茶', type: 'chat', createdAt: new Date(Date.now() - 4 * 3_600_000).toISOString() },
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx.push(c); return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    expect(ctx[0]).toContain('【上次事件】');
    expect(ctx[0]).toContain('覆盖从上次事件到现在');
    expect(ctx[0]).toContain('泡了杯茶');
  });

  // ── ★ 8-30 补写强度渐变 + 延续链限制（life-schedule-renewal）────────

  it('短间隔（≤1h）：此刻即间隔——不引导"覆盖从上次到现在"', async () => {
    freezeTime(14);
    const ctx: string[] = [];
    const { memoryManager } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', content: '在阳台看书', type: 'chat', createdAt: new Date(Date.now() - 30 * 60_000).toISOString() }, // 30min 前
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx.push(c); return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    expect(ctx[0]).toContain('【上次事件】');
    expect(ctx[0]).toContain('此刻自然延续它');
    expect(ctx[0]).not.toContain('覆盖从上次事件到现在');
  });

  it('长间隔（>2h）：重补写引导保留（幕间 advance——沉浸/重启空白）', async () => {
    freezeTime(14);
    const ctx: string[] = [];
    const { memoryManager } = makeMocks({
      // chat 类型 → 不走延续候选（internal 才走），gap 4h > 2 → 重补写引导
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-9', content: '泡了杯茶', type: 'chat', createdAt: new Date(Date.now() - 4 * 3_600_000).toISOString() },
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx.push(c); return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    expect(ctx[0]).toContain('覆盖从上次事件到现在');
  });

  it('延续链 ≥3：不再引导续写同一件事（强制开新事，防流水账）', async () => {
    freezeTime(14);
    const ctx: string[] = [];
    const now = Date.now();
    const { memoryManager } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-3', content: '还在看书,第三页', type: 'internal', createdAt: new Date(now - 40 * 60_000).toISOString() },
        { id: 'life-2', content: '继续看书', type: 'internal', createdAt: new Date(now - 100 * 60_000).toISOString() },
        { id: 'life-1', content: '在阳台看书', type: 'internal', createdAt: new Date(now - 160 * 60_000).toISOString() },
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx.push(c); return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    // 连续 internal 已 3 个 → 走"此刻自然延续/开新事"引导，不再带 continuation_of 强引导
    expect(ctx[0]).not.toContain('优先续写推进这件事');
    expect(ctx[0]).not.toContain('continuation_of 填该事件 id');
  });

  it('延续链 <3：延续引导保留', async () => {
    freezeTime(14);
    const ctx: string[] = [];
    const now = Date.now();
    const { memoryManager } = makeMocks({
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', content: '在阳台看书', type: 'internal', createdAt: new Date(now - 60 * 60_000).toISOString() },
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx.push(c); return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    expect(ctx[0]).toContain('优先续写推进这件事');
  });

  it('用户互动后重置沉浸：聊天锁命中 → 不生成事件（延续上下文不注入）', async () => {
    freezeTime(14);
    const gen = vi.fn().mockResolvedValue('{"content":"x","type":"internal"}');
    const { memoryManager } = makeMocks({
      getRecentMessages: vi.fn().mockReturnValue([{ role: 'user', content: 'hi' }]),
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-1', content: '在玩游戏', type: 'internal', createdAt: new Date(Date.now() - 1 * 3_600_000).toISOString() },
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1', generateEvent: gen });
    await svc.tick();
    expect(gen).not.toHaveBeenCalled();
  });

  it('chat 推送软上限：当日已满 → chat 事件降级入库不推送', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      maxChatPushesPerDay: 1,
      cooldownHours: 0,
      generateEvent: async () => '{"content":"想分享的事","type":"chat"}',
    });
    // ★ lastSummaryDate 置今天：防止 tick 开头的跨天检测把计数重置为 0
    (svc as any).state.lastSummaryDate = '2026-08-06';
    (svc as any).state.chatPushesToday = 1; // 当日已满
    await svc.tick();
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat' }));
    expect(memoryManager.markLifeEventDelivered).not.toHaveBeenCalled();
  });

  it('chat 冷却：lastProactiveAt 1h 内 → 不推送（降级入库）', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      cooldownHours: 1,
      generateEvent: async () => '{"content":"想分享的事","type":"chat"}',
    });
    (svc as any).state.lastProactiveAt = Date.now() - 30 * 60_000; // 30min 前推过
    await svc.tick();
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat' }));
  });

  it('跨天重置：chat 推送计数归零', async () => {
    freezeTime(23); // 今天
    const { memoryManager, qqOff } = makeMocks({ listLifeEvents: vi.fn().mockReturnValue([]) });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', stateFile: undefined,
      generateEvent: async () => '{"content":"x","type":"chat"}',
    });
    (svc as any).state.chatPushesToday = 4;
    (svc as any).state.lastSummaryDate = '2026-08-05'; // 非今天 → 触发跨天逻辑
    // 直接验证 maybeGenerateDailySummary 的重置副作用
    await (svc as any).maybeGenerateDailySummary(new Date('2026-08-06T23:30:00'));
    expect((svc as any).state.chatPushesToday).toBe(0);
  });
});

describe('LifeService — todayProactive 感知（方案 B：避免重复打扰）', () => {
  it('已发问候时 prompt 注入感知块，生成器可据此避开重复内容', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    let capturedContext = '';
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      todayProactive: () => '早安问候、立秋节日祝福',
      generateEvent: async (context: string) => {
        capturedContext = context;
        return '{"content":"在阳台看书","type":"internal","mood_delta":"平静"}';
      },
    });
    await svc.tick();
    expect(capturedContext).toContain('【今天已主动联系】今天已经发过: 早安问候、立秋节日祝福');
    expect(capturedContext).toContain('不要生成同类问候/祝福内容');
    vi.restoreAllMocks();
  });

  it('无今日主动联系时不注入感知块', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    let capturedContext = '';
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      todayProactive: () => '',
      generateEvent: async (context: string) => {
        capturedContext = context;
        return '{"content":"发呆","type":"internal","mood_delta":"平静"}';
      },
    });
    await svc.tick();
    expect(capturedContext).not.toContain('【今天已主动联系】');
    vi.restoreAllMocks();
  });
});

// ── ★ 8-27 叙事化重构（life-system-narrative-refactor）──────────────────

describe('LifeService — 8-27 配角在场（ScenePresence）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('事件提到在场角色 → upsertScenePresence(present, 带依据)', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      listPresentCharacters: vi.fn().mockReturnValue(['迷迷']),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"迷迷在我腿边团成一团","type":"internal"}',
    });
    await svc.tick();
    expect(memoryManager.upsertScenePresence).toHaveBeenCalledWith(
      '迷迷', 'present', expect.stringContaining('迷迷')
    );
  });

  it('生成 prompt 注入【在场角色】；空在场 → 提示不要凭空召唤角色', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    let ctx = '';
    const { memoryManager } = makeMocks();
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx = c; return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    expect(ctx).toContain('【在场角色】');
    expect(ctx).toContain('不要凭空召唤其他角色');
  });

  it('prompt 注入在场名单', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    let ctx = '';
    const { memoryManager } = makeMocks({
      listPresentCharacters: vi.fn().mockReturnValue(['迷迷', '风堇']),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx = c; return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    expect(ctx).toContain('- 迷迷');
    expect(ctx).toContain('- 风堇');
  });

  it('post-check ⑦：内容出现不在场配角 → 拒绝并重试', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const gen = vi.fn()
      .mockResolvedValueOnce('{"content":"白厄在院子里劈柴","type":"internal"}')  // 白厄不在场 → 拒绝
      .mockResolvedValueOnce('{"content":"安安静静看书","type":"internal"}');       // 重试通过
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: gen,
    });
    await svc.tick();
    expect(gen).toHaveBeenCalledTimes(2);
    // 重试请求带修正反馈
    expect(String(gen.mock.calls[1][0])).toContain('不在场');
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ content: '安安静静看书' })
    );
  });

  it('post-check ⑦：在场配角出现 → 直接通过不重试', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const gen = vi.fn().mockResolvedValue('{"content":"迷迷在我腿边蹭了蹭","type":"internal"}');
    const { memoryManager } = makeMocks({
      listPresentCharacters: vi.fn().mockReturnValue(['迷迷']),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: gen,
    });
    await svc.tick();
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('pickTemplate：在场角色组模板优先（在场有迷迷 → 选迷迷组）', () => {
    const { memoryManager } = makeMocks({
      listLifeTemplates: vi.fn().mockReturnValue([
        { id: 'a', activity: '迷迷在腿边团成一团', type: 'internal', weight: 3, source: 'seed', category: '互动', groupName: '迷迷' },
        { id: 'b', activity: '给自己倒了杯水', type: 'internal', weight: 5, source: 'seed', category: '独处', groupName: 'none' },
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1' });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 落在池内任意权重区间
    const t = (svc as any).pickTemplate(['迷迷']);
    expect(t.groupName).toBe('迷迷');
    vi.restoreAllMocks();
  });
});

describe('LifeService — 8-27 情绪惯性（mood_value）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('同方向加成：mood_value 20 + mood_shift 2 → 23（×1.5）', () => {
    freezeTime(14);
    const { memoryManager } = makeMocks({
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '开心', intimacy: 30, moodValue: 20, updatedAt: '2026-08-06T14:00:00' }),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1' });
    (svc as any).updateMoodValue(2, new Date('2026-08-06T14:00:00')); // updatedAt=now → 无回归
    const call = memoryManager.updateLifeState.mock.calls[0][0];
    expect(call.moodValue).toBe(23); // 20 + 2×1.5 = 23
  });

  it('反方向衰减：mood_value 20 + mood_shift -4 → 20×0.5-4 = 6', () => {
    freezeTime(14);
    const { memoryManager } = makeMocks({
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '开心', intimacy: 30, moodValue: 20, updatedAt: '2026-08-06T14:00:00' }),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1' });
    (svc as any).updateMoodValue(-4, new Date('2026-08-06T14:00:00'));
    const call = memoryManager.updateLifeState.mock.calls[0][0];
    expect(call.moodValue).toBe(6); // 20×0.5 - 4 = 6
  });

  it('8h 回归：满 8h 未更新 → 归 0', () => {
    freezeTime(14);
    const { memoryManager } = makeMocks({
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '开心', intimacy: 30, moodValue: 40, updatedAt: '2026-08-06T02:00:00' }),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1' });
    (svc as any).updateMoodValue(0, new Date('2026-08-06T14:00:00')); // 12h 后 → elapsed 钳到 1 → 归 0
    const call = memoryManager.updateLifeState.mock.calls[0][0];
    expect(call.moodValue).toBe(0);
  });

  it('mood_value 极性联动 mood 文本：+15 → 开心，-15 → 低落', () => {
    freezeTime(14);
    const base = { currentActivity: '', intimacy: 30, updatedAt: '2026-08-06T14:00:00' };
    const pos = makeMocks({ getLifeSnapshot: vi.fn().mockReturnValue({ ...base, mood: '', moodValue: 20 }) });
    new LifeService(pos.memoryManager as any, {} as any, { ownerOpenid: 'openid-1' });
    (new LifeService(pos.memoryManager as any, {} as any, { ownerOpenid: 'openid-1' }) as any).updateMoodValue(0, new Date('2026-08-06T14:00:00'));
    const posCall = pos.memoryManager.updateLifeState.mock.calls[0][0];
    expect(posCall.mood).toBe('开心');
    const neg = makeMocks({ getLifeSnapshot: vi.fn().mockReturnValue({ ...base, mood: '', moodValue: -20 }) });
    (new LifeService(neg.memoryManager as any, {} as any, { ownerOpenid: 'openid-1' }) as any).updateMoodValue(0, new Date('2026-08-06T14:00:00'));
    const negCall = neg.memoryManager.updateLifeState.mock.calls[0][0];
    expect(negCall.mood).toBe('低落');
  });
});

describe('LifeService — 8-27 Agency Window 与对话余波', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('agency.can_contact=false → chat 事件降级 internal 不推送', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      cooldownHours: 0,
      generateEvent: async () => '{"content":"想分享的事","type":"chat","agency":{"can_contact":false,"reason":"沉浸中"}}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat' }));
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
  });

  it('agency.can_contact 缺失/true → 正常推送', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { qqOff } = makeMocks();
    const svc = new LifeService(makeMocks().memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      cooldownHours: 0,
      generateEvent: async () => '{"content":"在阳台看星星","type":"chat"}',
    });
    await svc.tick();
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '在阳台看星星');
  });

  it('对话余波：最后 user 消息 15min 后 → 生成 internal followup 事件（不推送）', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: '在吗', createdAt: new Date(Date.now() - 20 * 60_000).toISOString() }, // 20min 前
      ]),
      listLifeEvents: vi.fn().mockReturnValue([]), // 无余波
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"想到刚才说的话，有点不好意思","type":"internal"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'internal', origin: 'followup', content: '想到刚才说的话，有点不好意思' })
    );
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.ingest).toHaveBeenCalled(); // 余波回写记忆
  });

  it('对话余波去重：3h 内已有 followup → 不再生成', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const gen = vi.fn().mockResolvedValue('{"content":"x","type":"internal"}');
    const { memoryManager } = makeMocks({
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: '在吗', createdAt: new Date(Date.now() - 20 * 60_000).toISOString() },
      ]),
      listLifeEvents: vi.fn().mockReturnValue([
        { id: 'life-follow-1', origin: 'followup', createdAt: new Date(Date.now() - 60 * 60_000).toISOString() },
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1', generateEvent: gen });
    await svc.tick();
    expect(gen).not.toHaveBeenCalled(); // 余波跳过 + 聊天锁内（20min < 30min 锁）→ 主事件也不生成
  });

  it('对话余波窗口：15min 内不生成', async () => {
    freezeTime(14);
    const gen = vi.fn().mockResolvedValue('{"content":"x","type":"internal"}');
    const { memoryManager } = makeMocks({
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: '在吗', createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }, // 5min 前
      ]),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1', generateEvent: gen });
    await svc.tick();
    expect(gen).not.toHaveBeenCalled(); // 聊天锁内，不生成
  });

  it('prompt 注入【心情】块（mood_value 极性）', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    let ctx = '';
    const { memoryManager } = makeMocks({
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '开心', intimacy: 30, moodValue: 22, updatedAt: '' }),
    });
    const svc = new LifeService(memoryManager as any, {} as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async (c: string) => { ctx = c; return '{"content":"x","type":"internal"}'; },
    });
    await svc.tick();
    expect(ctx).toContain('【心情】');
    expect(ctx).toContain('开心');
  });
});

describe('LifeService — 8-28 情绪漂移触发（memory-character-perspective）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('mood_value 极性跨 ±15 阈值 → 触发 adjustPersonaFromMood', () => {
    freezeTime(14);
    const { memoryManager } = makeMocks({
      // mood_shift 钳制 -5..+5：0 + 5×1.5 = 7.5 → 8，未到阈值——用较高起点跨阈值
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '开心', intimacy: 30, moodValue: 10, updatedAt: '2026-08-06T14:00:00' }),
      adjustPersonaFromMood: vi.fn().mockReturnValue(true),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1' });
    (svc as any).updateMoodValue(5, new Date('2026-08-06T14:00:00')); // 10 + 5×1.5 = 17.5 → 18 ≥ 15 → 跨阈值
    expect(memoryManager.adjustPersonaFromMood).toHaveBeenCalledWith(18);
  });

  it('极性未跨阈值（0 → 10）→ 不触发', () => {
    freezeTime(14);
    const { memoryManager } = makeMocks({
      getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '平静', intimacy: 30, moodValue: 0, updatedAt: '2026-08-06T14:00:00' }),
      adjustPersonaFromMood: vi.fn().mockReturnValue(true),
    });
    const svc = new LifeService(memoryManager as any, {} as any, { ownerOpenid: 'openid-1' });
    (svc as any).updateMoodValue(3, new Date('2026-08-06T14:00:00')); // 0 + 3×1.5 = 4.5 → 5,未到 15
    expect(memoryManager.adjustPersonaFromMood).not.toHaveBeenCalled();
  });

  it('回写记忆带 perspective=self（生活事件 → 角色视角）', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"在阳台看书","type":"internal"}',
    });
    await svc.tick();
    expect(memoryManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ perspective: 'self' })
    );
  });
});

describe('LifeService — 8-28 意图系统（ai-life-intent-system）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('事件 can_contact=false + intent → 存 intent（不推送）', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      saveIntent: vi.fn().mockReturnValue('intent-1'),
      completeIntent: vi.fn().mockReturnValue(true),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      cooldownHours: 0,
      generateEvent: async () => '{"content":"想告诉轻月粉蝶花开了","type":"chat","agency":{"can_contact":false,"reason":"沉浸中"},"intent":{"type":"proactive-contact","delay_hours":1,"content":"想告诉轻月粉蝶花开了"}}',
    });
    await svc.tick();
    // 不推送 + 存 intent（trigger_at = now + 1h）
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.saveIntent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'proactive-contact',
      content: '想告诉轻月粉蝶花开了',
      source: 'life-event',
    }));
    const triggerAt = memoryManager.saveIntent.mock.calls[0][0].triggerAt as number;
    expect(triggerAt - Date.now()).toBeCloseTo(3600_000, -3);
  });

  it('事件 can_contact=true 无 intent → 不存 intent', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({
      saveIntent: vi.fn(),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      cooldownHours: 0,
      generateEvent: async () => '{"content":"在阳台看星星","type":"chat"}',
    });
    await svc.tick();
    expect(memoryManager.saveIntent).not.toHaveBeenCalled();
    expect(qqOff.sendProactive).toHaveBeenCalled();
  });

  it('tick 扫描到期 intent：proactive-contact 到期推送 + completed', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks({
      listDueIntents: vi.fn().mockReturnValue([
        { id: 'i1', type: 'proactive-contact', content: '想告诉轻月粉蝶花开了', triggerAt: Date.now() - 1000, source: 'life-event', sessionId: '' },
      ]),
      completeIntent: vi.fn().mockReturnValue(true),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal"}',
    });
    await svc.tick();
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '想告诉轻月粉蝶花开了');
    expect(memoryManager.completeIntent).toHaveBeenCalledWith('i1');
  });

  it('tick 扫描到期 intent：delayed-reply 三选一裁决 → fulfill 兑现推送', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks({
      listDueIntents: vi.fn().mockReturnValue([
        { id: 'i2', type: 'delayed-reply', content: '关于猫的事', triggerAt: Date.now() - 1000, source: 'dialogue', sessionId: 's1' },
      ]),
      completeIntent: vi.fn().mockReturnValue(true),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal"}',
      generateIntentMessage: async () => '{"action":"fulfill","content":"想好了！关于猫的事，我觉得你说的有道理"}',
    });
    await svc.tick();
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '想好了！关于猫的事，我觉得你说的有道理');
    expect(memoryManager.completeIntent).toHaveBeenCalledWith('i2');
  });

  it('tick 扫描到期 intent：裁决 defer → 延期重排 + 推送延期说明（defer_count 上限内）', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks({
      listDueIntents: vi.fn().mockReturnValue([
        { id: 'i4', type: 'promise', content: '看画', triggerAt: Date.now() - 1000, source: 'dialogue', sessionId: '', deferCount: 1 },
      ]),
      completeIntent: vi.fn().mockReturnValue(true),
      deferIntent: vi.fn().mockReturnValue(true),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal"}',
      generateIntentMessage: async () => '{"action":"defer","content":"那幅画还差一点，再给我一天","delay_hours":6}',
    });
    await svc.tick();
    // 延期:重排 trigger_at(now+6h)+推送延期说明;不 complete
    expect(memoryManager.deferIntent).toHaveBeenCalledWith('i4', expect.any(Number));
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '那幅画还差一点，再给我一天');
    expect(memoryManager.completeIntent).not.toHaveBeenCalled();
  });

  it('tick 扫描到期 intent：裁决 defer 但已延期 2 次 → 强制兑现', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks({
      listDueIntents: vi.fn().mockReturnValue([
        { id: 'i5', type: 'promise', content: '看画', triggerAt: Date.now() - 1000, source: 'dialogue', sessionId: '', deferCount: 2 },
      ]),
      completeIntent: vi.fn().mockReturnValue(true),
      deferIntent: vi.fn().mockReturnValue(true),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal"}',
      generateIntentMessage: async () => '{"action":"defer","content":"再等等","delay_hours":6}',
    });
    await svc.tick();
    expect(memoryManager.deferIntent).not.toHaveBeenCalled(); // 超限不再延
    expect(qqOff.sendProactive).toHaveBeenCalled(); // 强制兑现推送
    expect(memoryManager.completeIntent).toHaveBeenCalledWith('i5');
  });

  it('tick 扫描到期 intent：裁决 cancel → 推送歉意说明 + completed', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks({
      listDueIntents: vi.fn().mockReturnValue([
        { id: 'i6', type: 'promise', content: '帮你查资料', triggerAt: Date.now() - 1000, source: 'dialogue', sessionId: '' },
      ]),
      completeIntent: vi.fn().mockReturnValue(true),
    });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal"}',
      generateIntentMessage: async () => '{"action":"cancel","content":"那件事我可能做不到了，对不起"}',
    });
    await svc.tick();
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '那件事我可能做不到了，对不起');
    expect(memoryManager.completeIntent).toHaveBeenCalledWith('i6');
  });

  it('tick 扫描到期 intent：推送失败 → 保留 pending 不标记 completed', async () => {
    freezeTime(14);
    const { memoryManager, qqOff } = makeMocks({
      listDueIntents: vi.fn().mockReturnValue([
        { id: 'i3', type: 'promise', content: '看画', triggerAt: Date.now() - 1000, source: 'dialogue', sessionId: '' },
      ]),
      completeIntent: vi.fn().mockReturnValue(true),
    });
    qqOff.sendProactive.mockResolvedValue(false);
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"x","type":"internal"}',
    });
    await svc.tick();
    expect(memoryManager.completeIntent).not.toHaveBeenCalled();
  });
});

describe('LifeService — 8-29 事件/对话拆分（life-event-message-split）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('chat 事件带 message → 推送 message（对轻月说话），不是 content 叙述', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      cooldownHours: 0,
      generateEvent: async () => '{"content":"收了晾了三天的袜子,想起忘收衣服","type":"chat","message":"轻月,我刚收了晾了三天的袜子——你也总忘收衣服对吧?"}',
    });
    await svc.tick();
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '轻月,我刚收了晾了三天的袜子——你也总忘收衣服对吧?');
    // 入库的仍是 content(生活叙述)
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(expect.objectContaining({ content: '收了晾了三天的袜子,想起忘收衣服' }));
  });

  it('chat 事件无 message → 回落推 content（兼容旧行为）', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { qqOff } = makeMocks();
    const svc = new LifeService(makeMocks().memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      cooldownHours: 0,
      generateEvent: async () => '{"content":"在阳台看星星","type":"chat"}',
    });
    await svc.tick();
    expect(qqOff.sendProactive).toHaveBeenCalledWith('openid-1', '在阳台看星星');
  });

  it('回写记忆的是 message（用户看到的），不是 content', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      cooldownHours: 0,
      generateEvent: async () => '{"content":"生活叙述","type":"chat","message":"对轻月说的话"}',
    });
    await svc.tick();
    expect(memoryManager.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ content: '对轻月说的话' }) })
    );
  });

  it('can_contact=false + message → intent 存 message（想对轻月说的话）', async () => {
    freezeTime(14);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks({ saveIntent: vi.fn() });
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"在忙手头的事","type":"chat","message":"想告诉你粉蝶花开了","agency":{"can_contact":false},"intent":{"type":"proactive-contact","delay_hours":1}}',
    });
    await svc.tick();
    expect(memoryManager.saveIntent).toHaveBeenCalledWith(expect.objectContaining({ content: '想告诉你粉蝶花开了' }));
  });
});
