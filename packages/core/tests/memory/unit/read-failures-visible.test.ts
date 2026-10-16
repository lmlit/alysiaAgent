// tests/memory/unit/read-failures-visible.test.ts
// ★ 2026-10-16 change: fix-store-write-trace（KI-5 剩余）
//
// KI-5 的方向是「能改探测式的改探测式，**改不了的至少喊一次**」。
// 本文件守两件最容易再退回去的事：
//   ① 读失败**不得被永久缓存**（缓存了就等于"以后连重试都没有"）；
//   ② 热路径上的失败**喊了**（限频），不能是裸 catch。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database.js';
import { MemoryManager } from '../../../src/memory/MemoryManager.js';
import { logger } from '../../../src/utils/logger.js';
import { warnThrottled, __resetThrottledWarnings } from '../../../src/utils/write-trace.js';

// 世界观文件是磁盘读取 —— mock 掉才能精确控制"第一次失败、第二次成功"
vi.mock('../../../src/persona/loader.js', () => ({
  readWorldviewBlock: vi.fn(),
  seedPersona: vi.fn(),
  seedWorldbook: vi.fn(),
}));
import { readWorldviewBlock } from '../../../src/persona/loader.js';

function makeMM() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const mm = new MemoryManager(
    db as any, null as any,
    { embed: async () => [0.1], dimension: () => 1024 } as any,
    { complete: async () => '{}' } as any,
  );
  return { db, mm };
}

describe('KI-5 — 读失败不得被永久缓存（getWorldviewBlock）', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    ({ db, mm } = makeMM());
    vi.restoreAllMocks();
    __resetThrottledWarnings();
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  // ⚠️ **核查更正**：KI-5 说这里「会把失败永久缓存成空」——**不成立**。
  //   旧代码 `catch { this._worldviewBlock = '' }` 里 `''` 是 falsy，
  //   所以下次调用仍会重试；真正的静默吞错在 `persona/loader.ts`（见
  //   `persona-loader-warn.test.ts`）。下面这条因此是**防御性**测试：
  //   它 mock 掉 callee 让它抛，验证「万一哪天 loader 改成会抛」，这里不会再无声吞掉、
  //   也不会把失败缓存住。**它在改动前也是绿的**，故不是复现测试。
  it('★★ 防御性：callee 抛错 → 不注入，且**不把失败缓存住**（下次仍会重试）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const mocked = readWorldviewBlock as unknown as ReturnType<typeof vi.fn>;
    mocked.mockReset();
    mocked.mockImplementationOnce(() => { throw new Error('EACCES: 世界观文件读不了'); });
    mocked.mockReturnValue('## 跨世界之窗\n窗口正文');

    expect(mm.getWorldviewBlock('all')).toBe('');
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/世界观/);

    expect(mm.getWorldviewBlock('all'), '失败被缓存住了').toContain('窗口正文');
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('成功一次后就缓存，不再重复读盘（回归：别修成每次都读）', () => {
    const mocked = readWorldviewBlock as unknown as ReturnType<typeof vi.fn>;
    mocked.mockReset();
    mocked.mockReturnValue('## 跨世界之窗\n正文');

    mm.getWorldviewBlock('all');
    mm.getWorldviewBlock('all');
    mm.getWorldviewBlock('all');

    expect(mocked).toHaveBeenCalledTimes(1);
  });
});

describe('KI-5 — 生活衔接块失败要留痕（热路径，限频）', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    ({ db, mm } = makeMM());
    vi.restoreAllMocks();
    __resetThrottledWarnings();
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('★ lifeStore 读失败 → 不抛、返回空串，但有 warn（不再与"确实没有生活事件"同形）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    (mm as any).lifeStore.getEventsSince = () => { throw new Error('db locked'); };

    expect(mm.getLifeContinuityBlock()).toBe('');
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/生活衔接/);
  });

  it('真的没有生活事件时**不该**报警（别把正常路径变成噪声）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    (mm as any).lifeStore.getEventsSince = () => [];

    expect(mm.getLifeContinuityBlock()).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('warnThrottled — 前 N 次喊、之后静默（不把日志淹掉）', () => {
  afterEach(() => { vi.restoreAllMocks(); __resetThrottledWarnings(); });

  it('同一 tag 只喊 limit 次，且最后一次说明"此后静默"', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 10; i++) warnThrottled('t', `第${i}次失败`, 3);

    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[2][0])).toContain('此后静默');
  });

  it('不同 tag 各自计数（一个坏了不掩盖另一个）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    warnThrottled('a', 'a 失败', 3);
    warnThrottled('b', 'b 失败', 3);

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
