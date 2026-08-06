import { describe, it, expect, vi, afterEach } from 'vitest';
import { LifeService } from '../src/life.js';

/** MemoryManager / QQ 适配器 mock（按真实接口 getRecentMessages/ingest/listLifeEvents） */
function makeMocks(overrides: Record<string, any> = {}) {
  const memoryManager = {
    getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '', intimacy: 30 }),
    recordLifeEvent: vi.fn().mockReturnValue('life-mock-id'),
    getLifeEventInjection: vi.fn().mockReturnValue(''),
    getWorldbookSample: vi.fn().mockReturnValue([{ id: 'wb-mock', content: '设定' }]),
    getUserActivitySummary: vi.fn().mockReturnValue('用户最近在忙'),
    getRecentMessages: vi.fn().mockReturnValue([]),
    updateLifeState: vi.fn(),
    listLifeEvents: vi.fn().mockReturnValue([]),
    listLifeSummaries: vi.fn().mockReturnValue([]),
    listSessions: vi.fn().mockReturnValue([]),
    upsertDailySummary: vi.fn(),
    markLifeEventDelivered: vi.fn(),
    bumpWorldbookHit: vi.fn(),
    ingest: vi.fn().mockResolvedValue(undefined),
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

  it('tick does nothing when probability gate fails (random > 0.3)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
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
    expect(memoryManager.ingest).not.toHaveBeenCalled();
  });

  it('deep night forces internal type — chat event stored as internal, never pushed', async () => {
    freezeTime(2); // 本地 02:00（深夜 [0,7)）
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"深夜看星星","type":"chat","mood_delta":"平静"}',
      deepNightHours: [0, 7],
    });
    await svc.tick();
    // LLM 返回 chat 类型，但深夜被强制转 internal 存储
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'internal', content: '深夜看星星' })
    );
    // 深夜不推送、不回写
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.ingest).not.toHaveBeenCalled();
  });

  it('LLM returns invalid JSON → falls back to weighted template (pickTemplate)', async () => {
    freezeTime(14); // 白天，非深夜
    // Math.random 同时用于概率门（0.1 ≤ 0.3 通过）与模板加权选择（r = 0.1 * total < 首条权重 5 → 选中首条）
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      probability: 0.3,
      generateEvent: async () => 'not json', // LLM 返回非法 JSON → 解析失败 → 回落模板
    });
    await svc.tick();
    // 模板库首条（权重最大）: 给自己倒了杯水（internal）
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'internal', content: '给自己倒了杯水', moodDelta: '平静' })
    );
    // 模板事件都是 internal → 不推送、不回写
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    expect(memoryManager.ingest).not.toHaveBeenCalled();
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

  // ── P4 亲密度无互动衰减（spec §11：近 3 天无互动每天 -2，下限 10）─────

  it('亲密度：近 3 天无 user 互动 → 频率分按天数 -2 衰减', async () => {
    freezeTime(12);
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      role: 'user', content: `消息${i}`, createdAt: '2026-08-01T10:04:00', // 距现在 5 天
    }));
    const { memoryManager, qqOff } = makeMocks({ getRecentMessages: vi.fn().mockReturnValue(msgs) });
    const svc = new LifeService(memoryManager as any, qqOff as any, { ownerOpenid: 'openid-1' });
    svc.updateIntimacy();
    // freqScore = min(35, 5/4*5=6.25) − 2×5天 → 0；longScore=5×1.05=5.25；activeScore=1×3=3；base=30 → 38.25
    const call = memoryManager.updateLifeState.mock.calls[0][0] as { intimacy: number };
    expect(call.intimacy).toBeCloseTo(38.25, 4);
  });

  it('亲密度：3 天内有 user 互动 → 不衰减', async () => {
    freezeTime(12);
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      role: 'user', content: `消息${i}`, createdAt: '2026-08-06T10:00:00', // 今天
    }));
    const { memoryManager, qqOff } = makeMocks({ getRecentMessages: vi.fn().mockReturnValue(msgs) });
    const svc = new LifeService(memoryManager as any, qqOff as any, { ownerOpenid: 'openid-1' });
    svc.updateIntimacy();
    // 30 + 6.25 + 5.25 + 3 = 44.5（idleDays=0，无衰减）
    const call = memoryManager.updateLifeState.mock.calls[0][0] as { intimacy: number };
    expect(call.intimacy).toBeCloseTo(44.5, 4);
  });
});
