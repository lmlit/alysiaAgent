import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProactiveService } from '../src/proactive.js';

function makeService(stateFile?: string) {
  const qqOff = { sendProactive: vi.fn().mockResolvedValue(true) } as any;
  const memoryManager = { listSessions: vi.fn().mockResolvedValue([]) } as any;
  const svc = new ProactiveService(qqOff, memoryManager, {
    ownerOpenid: 'TEST_OWNER_OPENID_0000',
    ...(stateFile ? { stateFile } : {}),
  });
  return { svc, qqOff };
}

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
  it('今天无问候无节日时返回空串', () => {
    const { svc } = makeService();
    expect(svc.getTodayActivity()).toBe('');
  });

  it('已发早安 + 节日时返回对应描述', () => {
    const { svc } = makeService();
    (svc as any).sentGreetings.add('2026-08-07-9');
    (svc as any).sentFestivals.add('2026-08-07'); // 立秋
    const act = svc.getTodayActivity();
    expect(act).toContain('早安问候');
    expect(act).toContain('立秋节日祝福');
  });

  it('晚间问候归类为晚安', () => {
    const { svc } = makeService();
    (svc as any).sentGreetings.add('2026-08-07-21');
    expect(svc.getTodayActivity()).toContain('晚安问候');
  });
});
