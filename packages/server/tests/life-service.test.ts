import { describe, it, expect, vi, afterEach } from 'vitest';
import { LifeService } from '../src/life.js';

/** MemoryManager / QQ 适配器 mock（按真实接口 getRecentMessages/ingest/listLifeEvents） */
function makeMocks(overrides: Record<string, any> = {}) {
  const memoryManager = {
    getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '', intimacy: 30 }),
    recordLifeEvent: vi.fn(),
    getLifeEventInjection: vi.fn().mockReturnValue(''),
    getWorldbookSample: vi.fn().mockReturnValue([{ content: '设定' }]),
    getUserActivitySummary: vi.fn().mockReturnValue('用户最近在忙'),
    getRecentMessages: vi.fn().mockReturnValue([]),
    updateLifeState: vi.fn(),
    listLifeEvents: vi.fn().mockReturnValue([]),
    listSessions: vi.fn().mockReturnValue([]),
    upsertDailySummary: vi.fn(),
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
});
