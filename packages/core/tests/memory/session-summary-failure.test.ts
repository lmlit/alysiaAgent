// tests/memory/session-summary-failure.test.ts
// ★ 9-25 fix-session-summary-silent-failure
//
// 这组测试**直接编码线上事故**（2026-09-04 ~ 09-25 会话摘要 100% 失败，52 条占位符）：
//   1. 围栏响应必须能解析（线上真实报错之一）
//   2. 失败时**绝不写占位符**，而是留可见的失败标记
//   3. 失败时**不生成 embedding**（垃圾向量比缺向量更糟——会被召回出来当真内容）
//   4. 反例测试：库中永不出现 `Session <id> summary` 这种字面占位符
import { describe, it, expect } from 'vitest';
import { SessionEndProcessor } from '../../src/memory/processors/SessionEndProcessor.js';
import type { MemoryEvent } from '../../src/memory/types.js';

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

/** 完整 mock：覆盖 process() 全路径，捕获真正写库/嵌入的内容 */
function makeHarness(llm: { response?: string; throws?: Error }) {
  const events = [ev('e1', '我今天养了只猫'), ev('e2', '好可爱呀')];
  const inserted: Array<{ conv: any; vec?: number[] }> = [];
  const embedded: string[] = [];
  const processed: string[] = [];

  const p = new SessionEndProcessor(
    {
      getBySession: () => events,
      markProcessed: (id: string) => processed.push(id),
      updateImportance: () => {},
    } as any,
    { insert: async (conv: any, vec?: number[]) => inserted.push({ conv, vec }) } as any,
    { addFacts: () => {}, addCharacterFacts: () => {} } as any,
    {} as any,
    {} as any,
    { extract: async () => ({ facts: [], characterFacts: [] }) } as any,
    { processSignal: async () => null, apply: () => {} } as any,
    {
      complete: async () => {
        if (llm.throws) throw llm.throws;
        return llm.response ?? '';
      },
    } as any,
    { embed: async (t: string) => { embedded.push(t); return [0.1, 0.2]; } } as any,
    { insert: async () => {} } as any,
  );
  return { p, inserted, embedded, processed };
}

describe('成功路径 — 围栏响应必须能解析', () => {
  it('【9-21 线上原样】markdown 围栏的 JSON → 正确写入摘要（不是占位符）', async () => {
    const h = makeHarness({
      response: '```json\n{"summary":"聊了养猫的事","participants":["user","assistant"],"topics":["宠物"],"key_decisions":[],"character_perspective":"","important_moments":[]}\n```',
    });
    await h.p.process('s1');

    expect(h.inserted).toHaveLength(1);
    const conv = h.inserted[0].conv;
    expect(conv.summary).toBe('聊了养猫的事');
    expect(JSON.parse(conv.topics)).toEqual(['宠物']);
    expect(conv.summary_status).toBe('ok');
  });

  it('成功时正常生成 embedding', async () => {
    const h = makeHarness({ response: '{"summary":"聊了养猫的事"}' });
    await h.p.process('s1');
    expect(h.embedded).toEqual(['聊了养猫的事']);
    expect(h.inserted[0].vec).toEqual([0.1, 0.2]);
  });
});

describe('失败路径 — 绝不写占位符', () => {
  it('【9-18/9-25 线上原样】截断的 JSON → summary 为空 + status=failed', async () => {
    const h = makeHarness({ response: '{"summary":"今天过得不坏，只是那片干叶子碎在手里时，我有' });
    await h.p.process('s1');

    expect(h.inserted).toHaveLength(1);
    const conv = h.inserted[0].conv;
    expect(conv.summary).toBe('');           // ★ 绝不写占位符
    expect(conv.summary_status).toBe('failed');
  });

  it('【9-21 线上原样】空白响应 → 同上', async () => {
    const h = makeHarness({ response: '   \n ' });
    await h.p.process('s1');
    expect(h.inserted[0].conv.summary).toBe('');
    expect(h.inserted[0].conv.summary_status).toBe('failed');
  });

  it('★ 失败时不生成 embedding（垃圾向量会被召回出来当真内容）', async () => {
    const h = makeHarness({ response: '{"summary":"被截断的' });
    await h.p.process('s1');
    expect(h.embedded).toEqual([]);
    expect(h.inserted[0].vec).toBeUndefined();
  });

  it('LLM 抛异常（如 API 报错）→ 同样记 failed，不炸掉整个会话归档', async () => {
    const h = makeHarness({ throws: new Error('LLM API error 429: rate limit') });
    await expect(h.p.process('s1')).resolves.toBeUndefined();
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].conv.summary_status).toBe('failed');
  });

  it('失败仍然插入行（保留 message_count / 时间 / 事件关联，供回填）', async () => {
    const h = makeHarness({ response: '不是 JSON 的一段人话' });
    await h.p.process('s1');
    const conv = h.inserted[0].conv;
    expect(conv.message_count).toBe(2);
    expect(conv.session_id).toBe('s1');
    expect(conv.started_at).toBeTruthy();
    expect(conv.ended_at).toBeTruthy();
  });

  it('失败不阻塞后续步骤：事件仍被标记处理，画像提取照常跑', async () => {
    const h = makeHarness({ response: '不是 JSON' });
    await h.p.process('s1');
    expect(h.processed).toEqual(['e1', 'e2']);
  });
});

describe('★ 反例测试 —— 把事故固化成断言', () => {
  it('任何路径下，summary 都不得是 `Session <id> summary` 形式的占位符', async () => {
    const placeholder = /^Session .+ summary$/;
    const responses = [
      '```json\n{"summary":"正常摘要"}\n```',
      '{"summary":"被截断的',
      '   ',
      '完全不是 JSON 的一段话',
    ];
    for (const response of responses) {
      const h = makeHarness({ response });
      await h.p.process('s1');
      for (const { conv } of h.inserted) {
        expect(placeholder.test(conv.summary)).toBe(false);
      }
    }
  });

  it('失败行的 summary 为空字符串，而非任何"看起来像内容"的字符串', async () => {
    const h = makeHarness({ throws: new Error('boom') });
    await h.p.process('s1');
    expect(h.inserted[0].conv.summary).toBe('');
  });
});
