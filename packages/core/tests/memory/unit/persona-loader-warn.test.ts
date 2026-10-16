// tests/memory/unit/persona-loader-warn.test.ts
// ★ 2026-10-16 change: fix-store-write-trace（KI-5 剩余 —— **并更正了 KI-5 的落点**）
//
// 先说清一个核查结论（避免后人被旧的 KI 描述误导）：
//   KI-5 把这条记成「`MemoryManager.getWorldviewBlock` 会把失败**永久缓存成空**」。
//   核查后**不成立**：
//     ① `readWorldviewBlock()` 自己就有裸 catch、**永不抛** ⇒ MemoryManager 那个 catch 是死代码；
//     ② 旧代码 `catch { this._worldviewBlock = '' }` 里 `''` 是 **falsy**，
//        所以 `if (!this._worldviewBlock)` 下次仍会重试 —— 并没有"永久缓存"。
//
//   真正在吞错的是**这里**：`persona/loader.ts` 的三个读函数
//     （`readPersonaFile` / `readWorldviewBlock` / `readWorldbookFile`）
//     全部裸 catch 返回空串 ⇒「`soul.md` 读不到」与「文件本来就是空的」**完全同形**，
//     而**人格核心静默缺失**正是本项目栽过的事故类型。
//   本文件测的就是这条：读失败必须留痕。
import { describe, it, expect, vi, afterEach } from 'vitest';

// 只让 worldview.md 读失败，其余文件走真实实现（不影响别的调用方）
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: ((p: any, ...rest: any[]) => {
      if (String(p).includes('worldview.md')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return (actual.readFileSync as any)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});

import { readWorldviewBlock, buildPersonaSystemPrompt } from '../../../src/persona/loader.js';
import { logger } from '../../../src/utils/logger.js';
import { __resetThrottledWarnings } from '../../../src/utils/write-trace.js';

describe('persona-loader — 文件读不到必须留痕（KI-5）', () => {
  afterEach(() => { vi.restoreAllMocks(); __resetThrottledWarnings(); });

  it('★ 读 worldview.md 失败 → 仍返回空串（行为不变），但**有 warn**', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(readWorldviewBlock()).toBe('');

    const out = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(out, '读失败被静默了 —— 与"没有世界观文件"不可区分').toMatch(/worldview\.md/);
    expect(out).toMatch(/静默缺失|读取/);
    expect(out, '要把真原因带出来，别只说"失败了"').toMatch(/EACCES/);
  });

  it('★ 组装 system prompt 时读到坏文件也要留痕（人格核心缺失不能无声）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    buildPersonaSystemPrompt();

    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/worldview\.md/);
  });

  it('限频：反复读同一个坏文件不会把日志刷爆', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 10; i++) readWorldviewBlock();

    expect(warn.mock.calls.length).toBeLessThanOrEqual(3);
    expect(warn.mock.calls.length, '也不能一声不吭').toBeGreaterThan(0);
  });

  it('正常文件不受影响（不误报）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // soul.md 没被 mock 成失败 → 真实读到，不该有 warn
    const prompt = buildPersonaSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).not.toMatch(/soul\.md/);
  });
});
