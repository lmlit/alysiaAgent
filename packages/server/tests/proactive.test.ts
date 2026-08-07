import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProactiveService } from '../src/proactive.js';

function makeService(stateFile?: string, memoryExtras: Record<string, any> = {}) {
  const qqOff = { sendProactive: vi.fn().mockResolvedValue(true) } as any;
  const memoryManager = {
    listSessions: vi.fn().mockResolvedValue([]),
    // 问候上下文素材（contextSnippet 用，默认空）
    getUserActivitySummary: vi.fn().mockReturnValue(''),
    listLifeEvents: vi.fn().mockReturnValue([]),
    getLifeSnapshot: vi.fn().mockReturnValue(null),
    ...memoryExtras,
  } as any;
  const svc = new ProactiveService(qqOff, memoryManager, {
    ownerOpenid: 'TEST_OWNER_OPENID_0000',
    ...(stateFile ? { stateFile } : {}),
  });
  return { svc, qqOff };
}

describe('ProactiveService — 问候独立调度器 (scheduleNextGreeting/fireGreeting)', () => {
  afterEach(() => vi.useRealTimers());

  it('9 点前启动 → 到点 9:00 精确触发', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 8, 0, 0));
    const { svc } = makeService();
    const spy = vi.spyOn(svc as any, 'fireGreeting').mockResolvedValue(undefined);
    (svc as any).scheduleNextGreeting();
    vi.advanceTimersByTime(3600 * 1000 + 100); // 1h 后
    expect(spy).toHaveBeenCalledWith(9, 0);
    svc.stop();
  });

  it('今天问候全过 → 排明天最早时段', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 22, 0, 0)); // 21:30 已过
    const { svc } = makeService();
    const spy = vi.spyOn(svc as any, 'fireGreeting').mockResolvedValue(undefined);
    (svc as any).scheduleNextGreeting();
    vi.advanceTimersByTime(11 * 3600 * 1000 + 100); // 明天 9:00
    expect(spy).toHaveBeenCalledWith(9, 0);
    svc.stop();
  });

  it('重启补发：9:30 启动且当天未发 → 立即发送 9:00 问候', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 9, 30, 0));
    const { svc, qqOff } = makeService();
    (svc as any).scheduleNextGreeting();
    await vi.advanceTimersByTimeAsync(0); // flush fireGreeting 异步链
    expect(qqOff.sendProactive).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it('发送成功 → 标记去重，重复触发不再发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 9, 0, 5));
    const { svc, qqOff } = makeService();
    await (svc as any).fireGreeting(9, 0);
    expect(qqOff.sendProactive).toHaveBeenCalledTimes(1);
    expect((svc as any).sentGreetings.has('2026-08-08-9')).toBe(true);
    await (svc as any).fireGreeting(9, 0); // 去重命中
    expect(qqOff.sendProactive).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it('发送失败 → 10min 重试，最多 2 次后放弃', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 9, 0, 5));
    const { svc, qqOff } = makeService();
    qqOff.sendProactive.mockResolvedValue(false);
    await (svc as any).fireGreeting(9, 0);
    expect(qqOff.sendProactive).toHaveBeenCalledTimes(1); // 首次失败
    vi.advanceTimersByTime(10 * 60_000); // 重试 1
    await vi.advanceTimersByTimeAsync(0);
    expect(qqOff.sendProactive).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10 * 60_000); // 重试 2（上限）
    await vi.advanceTimersByTimeAsync(0);
    expect(qqOff.sendProactive).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(30 * 60_000); // 不再重试
    await vi.advanceTimersByTimeAsync(0);
    expect(qqOff.sendProactive).toHaveBeenCalledTimes(3);
    svc.stop();
  });
});

describe('ProactiveService — 问候上下文注入 (contextSnippet)', () => {
  it('素材缺失时返回空串（不阻塞问候）', () => {
    const { svc } = makeService();
    expect((svc as any).contextSnippet()).toBe('');
  });

  it('用户近况 + 今天生活事件 + 亲密度注入 prompt', () => {
    const { svc } = makeService(undefined, {
      getUserActivitySummary: vi.fn().mockReturnValue('昨天聊到在玩老头环'),
      listLifeEvents: vi.fn().mockReturnValue([
        { content: '在阳台看书', createdAt: new Date().toISOString() },
        { content: '听了很久的雨', createdAt: new Date(2026, 7, 6, 21, 0).toISOString() }, // 昨天，被过滤
      ]),
      getLifeSnapshot: vi.fn().mockReturnValue({ intimacy: 62 }),
    });
    const snippet = (svc as any).contextSnippet();
    expect(snippet).toContain('用户近况：昨天聊到在玩老头环');
    expect(snippet).toContain('我今天的日常：在阳台看书');
    expect(snippet).not.toContain('听了很久的雨'); // 昨天的事件不注入
    expect(snippet).toContain('亲密度：62/100');
    expect(snippet).toContain('不要生硬引用');
  });

  it('素材接口抛异常时静默降级', () => {
    const { svc } = makeService(undefined, {
      getUserActivitySummary: vi.fn().mockImplementation(() => { throw new Error('boom'); }),
    });
    expect(() => (svc as any).contextSnippet()).not.toThrow();
    expect((svc as any).contextSnippet()).toBe('');
  });
});

describe('ProactiveService — 节日识别 (todayFestival)', () => {
  it('公历节日：1月1日元旦', () => {
    const { svc } = makeService();
    const f = (svc as any).todayFestival(new Date(2026, 0, 1));
    expect(f?.name).toBe('元旦');
  });

  it('农历映射：2026年七夕（农历7-7 → 公历8-19）', () => {
    const { svc } = makeService();
    const f = (svc as any).todayFestival(new Date(2026, 7, 19));
    expect(f?.name).toBe('七夕节');
  });

  it('二十四节气：1月5日小寒', () => {
    const { svc } = makeService();
    const f = (svc as any).todayFestival(new Date(2026, 0, 5));
    expect(f?.name).toBe('小寒');
  });

  it('普通日期无节日', () => {
    const { svc } = makeService();
    const f = (svc as any).todayFestival(new Date(2026, 7, 2));
    expect(f).toBeNull();
  });

  it('映射表缺失年份不触发农历节日（2030年无映射表，非公历节日非节气的日期）', () => {
    const { svc } = makeService();
    const f = (svc as any).todayFestival(new Date(2030, 2, 15));
    expect(f).toBeNull();
  });
});

describe('ProactiveService — sessionId 解析 openid (extractOpenid)', () => {
  it('解析私聊会话 ID', () => {
    const { svc } = makeService();
    expect((svc as any).extractOpenid('qq-official-1:private:private_DD71D797')).toBe('DD71D797');
  });

  it('群聊/异常格式返回 null', () => {
    const { svc } = makeService();
    expect((svc as any).extractOpenid('qq-official-1:group:group_xxx')).toBeNull();
    expect((svc as any).extractOpenid('no-colon')).toBeNull();
  });
});

describe('ProactiveService — 去重状态持久化', () => {
  it('变更后 stop() 写盘，新实例加载恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alysia-proactive-'));
    const stateFile = join(dir, 'state.json');
    try {
      // 实例 1：记录已发问候 → stop 落盘
      const { svc } = makeService(stateFile);
      (svc as any).sentGreetings.add('2026-08-02-9');
      (svc as any).sentFestivals.add('2026-08-02');
      (svc as any).lastCareByUser.set('DD71D797', '2026-08-02');
      svc.stop();

      // 文件已写入且结构正确
      expect(existsSync(stateFile)).toBe(true);
      const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
      expect(saved.sentGreetings).toContain('2026-08-02-9');
      expect(saved.sentFestivals).toContain('2026-08-02');
      expect(saved.lastCare['DD71D797']).toBe('2026-08-02');

      // 实例 2：加载恢复（模拟重启）
      const { svc: svc2 } = makeService(stateFile);
      expect((svc2 as any).sentGreetings.has('2026-08-02-9')).toBe(true);
      expect((svc2 as any).sentFestivals.has('2026-08-02')).toBe(true);
      expect((svc2 as any).lastCareByUser.get('DD71D797')).toBe('2026-08-02');
      svc2.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无 stateFile 时不写盘也不报错', () => {
    const { svc } = makeService();
    (svc as any).sentGreetings.add('x');
    expect(() => svc.stop()).not.toThrow();
  });

  it('状态文件损坏时安全启动（fresh）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alysia-proactive-'));
    const stateFile = join(dir, 'state.json');
    require('fs').writeFileSync(stateFile, '{{{broken json');
    try {
      const { svc } = makeService(stateFile);
      expect((svc as any).sentGreetings.size).toBe(0);
      svc.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ProactiveService — getTodayActivity (LifeService 感知用)', () => {
  // ★ 动态 today key（测试用硬编码日期会在跨天后失效——2026-08-08 踩坑）
  const todayKey = () => {
    const n = new Date();
    const p = (x: number) => String(x).padStart(2, '0');
    return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
  };

  it('今天无问候无节日时返回空串', () => {
    const { svc } = makeService();
    expect(svc.getTodayActivity()).toBe('');
  });

  it('已发早安 + 节日时返回对应描述', () => {
    // ★ 固定到 8-07（立秋）：getTodayActivity 按当前日期判断节日，跨天会失效
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 7, 10, 0));
    const { svc } = makeService();
    (svc as any).sentGreetings.add('2026-08-07-9');
    (svc as any).sentFestivals.add('2026-08-07');
    const act = svc.getTodayActivity();
    expect(act).toContain('早安问候');
    expect(act).toContain('立秋节日祝福');
    vi.useRealTimers();
  });

  it('晚间问候归类为晚安', () => {
    const { svc } = makeService();
    (svc as any).sentGreetings.add(`${todayKey()}-21`);
    expect(svc.getTodayActivity()).toContain('晚安问候');
  });
});
