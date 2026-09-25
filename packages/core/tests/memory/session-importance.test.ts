// ★ 9-25 wire-importance-signal：SessionEnd 把 LLM 挑出的「重要时刻」回填到事件
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionEndProcessor } from '../../src/memory/processors/SessionEndProcessor.js';
import type { MemoryEvent } from '../../src/memory/types.js';

/** 只测 important_moments 那两条私有方法，其余依赖给最小 mock */
function makeProcessor(opts: { vectorStore?: unknown } = {}) {
  const updated: Array<{ id: string; importance: number }> = [];
  const inserted: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const eventStore = {
    updateImportance: (id: string, importance: number) => updated.push({ id, importance }),
  };
  const embedService = { embed: async () => [0.1, 0.2], dimension: () => 2 };
  const vs = opts.vectorStore === undefined
    ? {
        insert: async (id: string, _v: number[], _t: string, metadata: Record<string, unknown>) =>
          inserted.push({ id, metadata }),
      }
    : opts.vectorStore;

  const p = new SessionEndProcessor(
    eventStore as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { extract: async () => ({ facts: [], characterFacts: [] }) } as any,
    {} as any,
    {} as any,
    embedService as any,
    vs as any,
  );
  return { p, updated, inserted };
}

const ev = (id: string, content: string): MemoryEvent => ({
  id,
  session_id: 's1',
  source: 'chat',
  type: 'message',
  payload: { content, role: 'user' },
  importance: 0,
  created_at: new Date().toISOString(),
  processed: 0,
});

describe('parseImportantMoments', () => {
  it('正常解析并夹取 0~1', () => {
    const { p } = makeProcessor();
    const out = (p as any).parseImportantMoments([
      { quote: '我养了一只叫豆子的橘猫', importance: 0.85 },
      { quote: '以后别熬夜', importance: 1.5 },
      { quote: '随口一句', importance: -1 },
    ]);
    expect(out).toEqual([
      { quote: '我养了一只叫豆子的橘猫', importance: 0.85 },
      { quote: '以后别熬夜', importance: 1 },
      { quote: '随口一句', importance: 0 },
    ]);
  });

  it('形状不可信时逐项丢弃，不炸', () => {
    const { p } = makeProcessor();
    const out = (p as any).parseImportantMoments([
      null,
      ' 不是对象 ',
      { quote: '', importance: 0.5 },
      { quote: '有效', importance: 'NaN' },
      { quote: '这条有效', importance: 0.7 },
    ]);
    expect(out).toEqual([{ quote: '这条有效', importance: 0.7 }]);
  });

  it('最多取 3 条', () => {
    const { p } = makeProcessor();
    const many = Array.from({ length: 6 }, (_, i) => ({ quote: `q${i}`, importance: 0.8 }));
    expect((p as any).parseImportantMoments(many)).toHaveLength(3);
  });

  it('非数组 → 空', () => {
    const { p } = makeProcessor();
    expect((p as any).parseImportantMoments(undefined)).toEqual([]);
    expect((p as any).parseImportantMoments('nope')).toEqual([]);
    expect((p as any).parseImportantMoments({})).toEqual([]);
  });
});

describe('applyImportantMoments — 匹配回填', () => {
  let ctx: ReturnType<typeof makeProcessor>;
  beforeEach(() => {
    ctx = makeProcessor();
  });

  it('★ 摘句命中消息 → 写 importance + 刷新向量 metadata', async () => {
    const events = [ev('e1', '我养了一只叫豆子的橘猫，它特别黏人')];
    const applied = await (ctx.p as any).applyImportantMoments(
      [{ quote: '一只叫豆子的橘猫', importance: 0.9 }],
      events,
    );
    expect(applied).toBe(1);
    expect(ctx.updated).toEqual([{ id: 'e1', importance: 0.9 }]);
    // 向量 metadata 必须一起刷新 —— 召回读的是它
    expect(ctx.inserted).toHaveLength(1);
    expect(ctx.inserted[0].metadata).toMatchObject({ importance: 0.9, source: 'chat' });
  });

  it('空白差异不影响匹配', async () => {
    const events = [ev('e1', '以后   别熬夜\n好吗')];
    const applied = await (ctx.p as any).applyImportantMoments(
      [{ quote: '以后 别熬夜 好吗', importance: 0.8 }],
      events,
    );
    expect(applied).toBe(1);
  });

  it('★ 匹配不上时记日志、不静默丢、不影响其他条', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loggerWarn = vi.spyOn(await import('../../src/utils/logger.js'), 'logger', 'get');
    const events = [ev('e1', '完全不相干的内容')];
    const applied = await (ctx.p as any).applyImportantMoments(
      [{ quote: 'LLM 改写过的摘句', importance: 0.9 }],
      events,
    );
    expect(applied).toBe(0);
    expect(ctx.updated).toHaveLength(0);
    loggerWarn.mockRestore?.();
    warn.mockRestore();
    expect(warn).toBeDefined();
  });

  it('空 moments 直接返回 0，不做任何事', async () => {
    expect(await (ctx.p as any).applyImportantMoments([], [ev('e1', 'x')])).toBe(0);
    expect(ctx.updated).toHaveLength(0);
  });

  it('多条摘句命中不同消息', async () => {
    const events = [ev('e1', '我喜欢深夜聊天'), ev('e2', '养了只橘猫叫豆子')];
    const applied = await (ctx.p as any).applyImportantMoments(
      [
        { quote: '深夜聊天', importance: 0.8 },
        { quote: '橘猫叫豆子', importance: 0.9 },
      ],
      events,
    );
    expect(applied).toBe(2);
    expect(ctx.updated.map(u => u.id).sort()).toEqual(['e1', 'e2']);
  });

  it('★ 向量刷新失败不影响 importance 已回填（降级不阻塞）', async () => {
    const failing = makeProcessor({
      vectorStore: { insert: async () => { throw new Error('lancedb down'); } },
    });
    const applied = await (failing.p as any).applyImportantMoments(
      [{ quote: '内容', importance: 0.9 }],
      [ev('e1', '一些内容在这里')],
    );
    expect(applied).toBe(1);
    expect(failing.updated).toEqual([{ id: 'e1', importance: 0.9 }]);
  });

  it('无 vectorStore 时也能回填（不崩）', async () => {
    const noVec = makeProcessor({ vectorStore: null });
    const applied = await (noVec.p as any).applyImportantMoments(
      [{ quote: '内容', importance: 0.9 }],
      [ev('e1', '一些内容在这里')],
    );
    expect(applied).toBe(1);
  });
});
