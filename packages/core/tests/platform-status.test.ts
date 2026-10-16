/**
 * ★ 2026-10-16 · change: `add-platforms-endpoint`
 *
 * `GET /api/platforms`（平台接入状态）在 `docs/Web-API-Design.md` §3.4 有契约、
 * 全仓**没有任何实现** —— 是"文档了但完全没做"的唯一一个接口。
 *
 * 本文件锁两件事：
 *   ① core 侧 `getPlatformStatus()` 真的反映 `registerPlatform()` 的注册结果；
 *   ② **它只报自己知道的** —— 不编造 `connected` / `lastHeartbeat` 这类
 *      连接层字段（core 看不到适配器的 WebSocket 状态，编出来 Web 端会当真）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AlysiaCore } from '../src/index.js';
import type { AlysiaCoreOptions } from '../src/index.js';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'alysia-platforms-'));
  tmpDirs.push(d);
  return d;
}

function makeCore(dir: string, over: Partial<AlysiaCoreOptions> = {}): AlysiaCore {
  return new AlysiaCore({
    dbPath: join(dir, 'alysia.db'),
    ownerId: 'owner-platforms',
    workspaceDir: dir,
    llmConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test' },
    embedConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test' },
    features: { codeMode: false },
    ...over,
  });
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

describe('AlysiaCore.getPlatformStatus', () => {
  it('★ 没注册任何平台 → 空列表（不是 null，也不抛）', async () => {
    const core = makeCore(tmp());
    await core.start();
    try {
      const s = core.getPlatformStatus();
      expect(s.platforms).toEqual([]);
      expect(s.count).toBe(0);
    } finally {
      await core.stop();
    }
  }, 60_000);

  it('★★ 注册的平台出现在快照里，且能区分默认/专属调度器', async () => {
    const core = makeCore(tmp());
    await core.start();
    try {
      core.registerPlatform('qq-official-1::private');              // 用默认调度器
      core.registerPlatform('qq-official-1::group');
      core.registerPlatform('telegram::private', core.scheduler);    // 显式传（仍是同一个）
      core.eventBus.registerScheduler('custom::private', { start: async () => {} } as never);

      const s = core.getPlatformStatus();
      const names = s.platforms.map(p => p.name);

      expect(names).toEqual([
        'custom::private',
        'qq-official-1::group',
        'qq-official-1::private',
        'telegram::private',
      ]);   // 排序：名字可比对
      expect(s.count).toBe(4);
      expect(s.platforms.find(p => p.name === 'qq-official-1::private')?.scheduler).toBe('default');
      expect(s.platforms.find(p => p.name === 'custom::private')?.scheduler).toBe('custom');
    } finally {
      await core.stop();
    }
  }, 60_000);

  it('★ 快照是"只读"的：改返回值不影响后续调用', async () => {
    const core = makeCore(tmp());
    await core.start();
    try {
      core.registerPlatform('a::private');
      const first = core.getPlatformStatus();
      first.platforms.push({ name: 'fake::private', scheduler: 'default' });
      first.platforms.sort(() => 1);

      expect(core.getPlatformStatus().platforms.map(p => p.name)).toEqual(['a::private']);
    } finally {
      await core.stop();
    }
  }, 60_000);
});
