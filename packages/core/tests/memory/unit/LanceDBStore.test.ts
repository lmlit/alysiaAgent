// tests/memory/unit/LanceDBStore.test.ts
// ★ 2026-10-16 change: fix-store-write-trace（KI-14 / KI-15）
//
// KI-14：`LanceDBStore` 的 insert / delete / search / count **全部把失败吞掉**
//   （只 `logger.warn` 或直接 `return []` / `return 0`），于是：
//     - 上游**每一处** `try { await vectorStore.insert(...) } catch { warn }` 都是**死代码**
//       （真实 store 永不抛 ⇒ catch 永不触发 ⇒ 日志照样全绿）；
//     - `search` 的「故障」与「确实没有匹配」**完全同形**（都是 `[]`）；
//     - `count` 的「库读不了」与「库是空的」**完全同形**（都是 `0`）。
//
// 本文件守的是**失败必须能被调用方判**。契约见 `memory-system` §4.7。
//
// ★ 用假 table 注入而不是真 LanceDB：这里要测的正是**失败路径**，
//   真库不会按需失败。`ready=true` + 假 `table` 就足以覆盖这四个方法的契约。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LanceDBStore } from '../../../src/memory/stores/LanceDBStore.js';
import { logger } from '../../../src/utils/logger.js';

/** 造一个「已就绪 + 指定假 table」的 store（绕过真实 LanceDB 初始化） */
function readyStore(table: Record<string, unknown>): LanceDBStore {
  const s = new LanceDBStore(':memory:', 'vectors', 8);
  (s as any).ready = true;
  (s as any).table = table;
  return s;
}

/** 一个各方法都正常的假 table */
function okTable(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    add: async () => {},
    delete: async () => {},
    countRows: async () => 0,
    vectorSearch: () => ({
      distanceType: () => ({ limit: () => ({ toArray: async () => [] }) }),
    }),
    ...over,
  };
}

const META = { source: 'event' };

describe('LanceDBStore — KI-14 失败必须可判（不得吞成"成功"）', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { warn = vi.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('★★ 主症：insert 失败必须 reject（旧实现只 warn 就 return，上游 catch 永不触发）', async () => {
    const s = readyStore(okTable({ add: async () => { throw new Error('disk full'); } }));

    await expect(s.insert('id-1', [0, 0], '文本', META))
      .rejects.toThrow('disk full');
  });

  it('★ delete 失败必须 reject', async () => {
    const s = readyStore(okTable({ delete: async () => { throw new Error('table locked'); } }));

    await expect(s.delete('id-1')).rejects.toThrow('table locked');
  });

  it('★ search 失败必须 reject —— 不能返回 []（否则「无匹配」与「故障」同形）', async () => {
    const s = readyStore(okTable({
      vectorSearch: () => { throw new Error('index corrupt'); },
    }));

    await expect(s.search([0, 0], 3)).rejects.toThrow('index corrupt');
  });

  it('★ count 失败必须 reject —— 不能返回 0（否则「空库」与「读不了」同形）', async () => {
    const s = readyStore(okTable({ countRows: async () => { throw new Error('read failed'); } }));

    await expect(s.count()).rejects.toThrow('read failed');
  });

  it('★ LanceDB 不可用（ensureReady 失败）→ 四个方法都 reject，而不是静默降级', async () => {
    // 静默降级的后果：调用方以为「写进去了/没匹配到」，实际是「根本没库」
    const s = new LanceDBStore('/nonexistent');
    (s as any).ready = false;
    (s as any).initialize = async () => { throw new Error('lancedb not installed'); };

    await expect(s.insert('id-1', [0], 't', META)).rejects.toThrow(/lancedb not installed|不可用|unavailable/i);
    await expect(s.delete('id-1')).rejects.toThrow(/lancedb not installed|不可用|unavailable/i);
    await expect(s.search([0], 3)).rejects.toThrow(/lancedb not installed|不可用|unavailable/i);
    await expect(s.count()).rejects.toThrow(/lancedb not installed|不可用|unavailable/i);
  });

  it('★ upsert 的前置 delete 失败 → 至少**喊出来**（否则同 id 两条向量并存、召回去重）', async () => {
    // 这一处不能直接抛：LanceDB 的 delete 在"没匹配到"时是否抛未知，
    // 抛了会把每次正常写入都变成失败。但**必须留痕**，因为它会造成重复行。
    const s = readyStore(okTable({ delete: async () => { throw new Error('predicate rejected'); } }));

    await expect(s.insert('id-1', [0], 't', META)).resolves.toBeUndefined();
    const warned = (warn.mock.calls as unknown[][]).map(c => String(c[0])).join('\n');
    expect(warned, 'upsert 前置删除失败被静默了').toMatch(/id-1|upsert|重复/);
  });

  it('正常路径不受影响（回归）', async () => {
    const s = readyStore(okTable({
      countRows: async () => 7,
      vectorSearch: () => ({
        distanceType: () => ({ limit: () => ({ toArray: async () => [] }) }),
      }),
    }));

    await expect(s.insert('id-1', [0], 't', META)).resolves.toBeUndefined();
    await expect(s.delete('id-1')).resolves.toBeUndefined();
    expect(await s.count()).toBe(7);
    // 「确实没有匹配」→ 空数组（这与「故障」现在是**可区分**的两种结果）
    expect(await s.search([0], 3)).toEqual([]);
  });
});
