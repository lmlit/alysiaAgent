// ★ 9-25 optimize-recall-pipeline：多来源召回合并（保底配额 + 相对阈值 + 文本去重）
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/memory/types.js';
import type { SearchResult } from '../../src/memory/types.js';

function makeManager(db: Database.Database): MemoryManager {
  const embedService = { embed: async () => [0], dimension: () => 1024 };
  const llmService = { complete: async () => '{}' };
  return new MemoryManager(db as any, null, embedService as any, llmService as any);
}

/** 直取私有方法测（合并策略是纯函数逻辑，值得单独覆盖） */
function mergeRaw(
  mm: MemoryManager,
  groups: Array<{ source: string; items: SearchResult[] }>,
  limit: number,
) {
  return (mm as any).mergeWithQuota(groups, DEFAULT_MEMORY_CONFIG, limit) as {
    picked: SearchResult[];
    candidateCounts: Record<string, number>;
    keptCounts: Record<string, number>;
    pickedCounts: Record<string, number>;
    boosted: number;
  };
}

function merge(
  mm: MemoryManager,
  groups: Array<{ source: string; items: SearchResult[] }>,
  limit: number,
): SearchResult[] {
  return mergeRaw(mm, groups, limit).picked;
}

const r = (id: string, source: string, score: number, text = `text-${id}`): SearchResult => ({
  id,
  score,
  text,
  metadata: { source },
});

describe('mergeWithQuota — 保底配额', () => {
  let mm: MemoryManager;
  beforeEach(() => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('★ 四路都保底 top-1：小来源不会被大来源饿死', () => {
    const out = merge(
      mm,
      [
        { source: 'life_event', items: [r('l1', 'life_event', 0.30)] },
        { source: 'chat', items: [r('c1', 'chat', 0.90), r('c2', 'chat', 0.88)] },
        { source: 'conversation', items: [r('v1', 'conversation', 0.80)] },
        { source: 'knowledge', items: [r('k1', 'knowledge', 0.70)] },
      ],
      5,
    );
    const sources = out.map(x => x.metadata.source).sort();
    // 修复前：全局 sort 后 slice(0,5)，life_event 分最低必被挤掉
    expect(sources).toContain('life_event');
    expect(sources).toContain('knowledge');
    expect(new Set(sources).size).toBe(4);
  });

  it('某路无候选时名额让给其他路（不会少给）', () => {
    const out = merge(
      mm,
      [
        { source: 'life_event', items: [] },
        { source: 'chat', items: [r('c1', 'chat', 0.9), r('c2', 'chat', 0.8), r('c3', 'chat', 0.7)] },
        { source: 'conversation', items: [r('v1', 'conversation', 0.6)] },
      ],
      4,
    );
    expect(out).toHaveLength(4);
    expect(out.filter(x => x.metadata.source === 'chat').length).toBeGreaterThan(1);
  });

  it('候选不足 limit 时只返回现有的', () => {
    const out = merge(mm, [{ source: 'chat', items: [r('c1', 'chat', 0.5)] }], 5);
    expect(out).toHaveLength(1);
  });

  it('limit<=0 → 空', () => {
    expect(merge(mm, [{ source: 'chat', items: [r('c1', 'chat', 0.5)] }], 0)).toEqual([]);
  });
});

describe('mergeWithQuota — 路内相对阈值', () => {
  let mm: MemoryManager;
  beforeEach(() => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('★ 明显差于本路最佳的丢掉（相对，不看绝对分）', () => {
    const out = merge(
      mm,
      [
        {
          source: 'chat',
          items: [r('good', 'chat', 0.90), r('mid', 'chat', 0.80), r('bad', 'chat', 0.10)],
        },
      ],
      10,
    );
    const ids = out.map(x => x.id);
    expect(ids).toContain('good');
    expect(ids).toContain('mid');
    expect(ids).not.toContain('bad'); // 0.10 < 0.90 * 0.7
  });

  it('★ 阈值是相对的：整路分数都低时不误杀', () => {
    // 长文本来源（生活事件）绝对分天然低，但路内相对关系仍成立
    const out = merge(
      mm,
      [{ source: 'life_event', items: [r('l1', 'life_event', 0.30), r('l2', 'life_event', 0.25)] }],
      10,
    );
    // 0.25 >= 0.30 * 0.7 = 0.21 → 保留。绝对阈值（如 0.5）会把这整路杀光。
    expect(out.map(x => x.id)).toEqual(['l1', 'l2']);
  });

  it('全 0 分时不触发过滤（无信息可比，全保留）', () => {
    const out = merge(
      mm,
      [{ source: 'chat', items: [r('a', 'chat', 0), r('b', 'chat', 0)] }],
      10,
    );
    expect(out).toHaveLength(2);
  });
});

describe('mergeWithQuota — 文本去重', () => {
  let mm: MemoryManager;
  beforeEach(() => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('★ 同一段文字出现在两个来源时只留一份（type=chat 的生活事件会双写）', () => {
    const text = '窗外的云散开了，月亮正好露出来，在窗台上铺了一层银白色的光。';
    const out = merge(
      mm,
      [
        { source: 'life_event', items: [r('l1', 'life_event', 0.40, text)] },
        { source: 'chat', items: [r('c1', 'chat', 0.40, text)] },
      ],
      5,
    );
    expect(out).toHaveLength(1);
    // 先到先得 → life_event 排前面时它的标签胜出（语义更具体，perspective 过滤要用）
    expect(out[0].metadata.source).toBe('life_event');
  });

  it('空白差异不算不同（归一化后比较）', () => {
    const out = merge(
      mm,
      [
        { source: 'chat', items: [r('a', 'chat', 0.5, '你好   呀\n')] },
        { source: 'chat', items: [r('b', 'chat', 0.5, ' 你好 呀 ')] },
      ],
      5,
    );
    expect(out).toHaveLength(1);
  });

  it('不同文字不去重', () => {
    const out = merge(
      mm,
      [
        { source: 'chat', items: [r('a', 'chat', 0.5, '甲')] },
        { source: 'chat', items: [r('b', 'chat', 0.5, '乙')] },
      ],
      5,
    );
    expect(out).toHaveLength(2);
  });

  it('候选不够时去重后不会硬凑', () => {
    const text = '同一句';
    const out = merge(
      mm,
      [
        { source: 'chat', items: [r('a', 'chat', 0.5, text), r('b', 'chat', 0.4, text)] },
        { source: 'conversation', items: [r('c', 'conversation', 0.3, text)] },
      ],
      5,
    );
    expect(out).toHaveLength(1);
  });
});

// ★ 9-25 tune-recall-with-runtime-data：观测统计（调参靠它）
describe('mergeWithQuota — 观测统计', () => {
  let mm: MemoryManager;
  beforeEach(() => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('★ 候选/保留/选中 三级计数齐全（回答"被阈值丢了多少"）', () => {
    const out = mergeRaw(
      mm,
      [
        { source: 'life_event', items: [r('l1', 'life_event', 0.30), r('l2', 'life_event', 0.05)] },
        { source: 'chat', items: [r('c1', 'chat', 0.90), r('c2', 'chat', 0.85)] },
      ],
      3,
    );
    expect(out.candidateCounts).toMatchObject({ life_event: 2, chat: 2 });
    // l2 = 0.05 < 0.30*0.7 → 被相对阈值丢掉
    expect(out.keptCounts).toMatchObject({ life_event: 1, chat: 2 });
    expect(Object.values(out.pickedCounts).reduce((a, b) => a + b, 0)).toBe(out.picked.length);
  });

  it('★ boosted 统计重要度加分（接线前该值恒为 0）', () => {
    const withImportance = (id: string, score: number, importance: number): SearchResult => ({
      id,
      score,
      text: `t-${id}`,
      metadata: { source: 'chat', importance },
    });
    const out = mergeRaw(
      mm,
      [
        {
          source: 'chat',
          items: [
            withImportance('hi', 0.5, 0.9), // > 0.4 阈值 → 加分
            withImportance('lo', 0.5, 0.1), // 不加分
          ],
        },
      ],
      5,
    );
    expect(out.boosted).toBe(1);
    // 加分的排前面
    expect(out.picked[0].id).toBe('hi');
  });

  it('无 importance 数据时 boosted=0', () => {
    const out = mergeRaw(mm, [{ source: 'chat', items: [r('a', 'chat', 0.5)] }], 5);
    expect(out.boosted).toBe(0);
  });

  it('limit<=0 时统计也返回（不会 undefined 崩）', () => {
    const out = mergeRaw(mm, [{ source: 'chat', items: [r('a', 'chat', 0.5)] }], 0);
    expect(out.picked).toEqual([]);
    expect(out.boosted).toBe(0);
  });

  it('fmtCounts 输出紧凑格式且跳过 0', () => {
    const fmt = (mm as any).fmtCounts({ conversation: 2, knowledge: 0, chat: 3, life_event: 1 });
    expect(fmt).toBe('conv=2 chat=3 life=1');
    expect((mm as any).fmtCounts({})).toBe('—');
  });
});
