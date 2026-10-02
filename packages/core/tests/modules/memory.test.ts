/**
 * 记忆模块（`modules/memory.ts`）单测。
 *
 * 守的是「4 个基础资源服务 → MemoryManager」的接线，
 * 以及**降级路径**：`al:vector` 为 null 时 MemoryManager 仍要能构造
 * （线上 LanceDB 不可用时的兜底，见 `resources.ts` 的 vectorModule）。
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import { initializeDatabase } from '../../src/memory/database.js';
import { DEFAULT_SAMPLING } from '../../src/provider/sampling.js';
import { memoryModule, personaSeedModule } from '../../src/modules/memory.js';
import { runModule } from './helpers.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

/** 四个基础资源；vector 可注入 null 模拟 LanceDB 降级 */
function resourceDeps(vector: unknown) {
  return [
    ['al:db', makeDb()],
    ['al:vector', vector],
    ['al:embed', { embed: async () => [], dimension: () => 1024 }],
    ['al:memory-llm', { complete: async () => '' }],
  ] as Array<[string, unknown]>;
}

describe('al:memory', () => {
  it('拿到 4 个资源后构造出 MemoryManager', async () => {
    const r = await runModule(memoryModule, { sampling: DEFAULT_SAMPLING }, resourceDeps({ kind: 'lancedb' }));
    expect(r.get('al:memory')).toBeInstanceOf(MemoryManager);
    await r.stop();
  });

  it('★ vector 为 null（LanceDB 降级）时仍能构造 —— 文本检索兜底', async () => {
    const r = await runModule(memoryModule, { sampling: DEFAULT_SAMPLING }, resourceDeps(null));
    expect(r.get('al:memory')).toBeInstanceOf(MemoryManager);
    await r.stop();
  });

  it('缺配置时立刻抛错', async () => {
    await expect(runModule(memoryModule, undefined as never, resourceDeps(null))).rejects.toThrow(/缺少配置/);
  });
});

describe('al:persona-seed', () => {
  it('把 persona 与世界书种进库，且不对外提供服务', async () => {
    const r = await runModule(
      personaSeedModule,
      { workspaceDir: 'C:/nonexistent-ws' },
      resourceDeps(null),
      [[memoryModule, { sampling: DEFAULT_SAMPLING }]],
    );

    const mm = r.get<MemoryManager>('al:memory')!;
    expect(mm.getActiveSystemPrompt().length).toBeGreaterThan(0);
    expect(mm.listWorldbookEntries().length).toBeGreaterThan(0);

    // provides:false —— 它是纯副作用模块，不该占用服务名
    expect(r.host.has('al:persona-seed')).toBe(false);
    await r.stop();
  });

  it('★ roles 目录不存在时静默跳过（原语义，不是漏改）', async () => {
    const r = await runModule(
      personaSeedModule,
      { workspaceDir: 'C:/nonexistent-ws' },
      resourceDeps(null),
      [[memoryModule, { sampling: DEFAULT_SAMPLING }]],
    );
    // 没有角色包可加载时**不应**报错——`loadRolePackages` 的整个包在 try/catch 里
    expect(r.logger.lines.some(l => l.level === 'error' && /Role package/.test(l.msg))).toBe(false);
    await r.stop();
  });
});
