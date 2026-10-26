// tests/memory/eligibility-wiring.test.ts
// ★ 2026-10-21 · change: unify-memory-eligibility（T2 接线）
//
// `eligibility.test.ts` 守**判据本身**；本文件守**判据被接上了** ——
// 判据写得再对，只要处理器还自带一份 `if`，行为就还是老样子。
//
// 钉住三件事（对应 proposal 的 E1 / E4）：
//   E4 她自己的话**不再**进人格扫描与纠正快路径，但仍可被嵌入（要能回忆"聊过什么"）
//   E1 正常摘要与补处理**共用同一个对话渲染器** —— 同一批事件，两条路径的输入必须逐字相同
//   C1 画像提取只吃「用户本人发言」这一种来源
import { describe, it, expect, vi } from 'vitest';
import { RealtimeProcessor } from '../../src/memory/processors/RealtimeProcessor';
import { SessionEndProcessor } from '../../src/memory/processors/SessionEndProcessor';
import { ProfileExtractor } from '../../src/memory/engines/ProfileExtractor';
import type { ILLMService } from '../../src/memory/interfaces/ILLMService';
import type { MemoryEvent } from '../../src/memory/types';

const SUMMARY_JSON = JSON.stringify({
  summary: '聊了看海的事',
  participants: ['user', 'assistant'],
  topics: [],
  key_decisions: [],
  character_perspective: '',
  important_moments: [],
});

function makeEvent(overrides: Partial<MemoryEvent> & { payload?: Record<string, unknown> }): MemoryEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    session_id: 'webui:private:abc',
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content: '我今天去看了海' },
    importance: 0.5,
    created_at: new Date().toISOString(),
    ...overrides,
  } as MemoryEvent;
}

// ══════════════════════════════════════════════════════════════════
// E4 — 她自己的话不是"用户对她的反馈"
// ══════════════════════════════════════════════════════════════════
describe('★ E4 人格扫描与纠正快路径只认用户发言', () => {
  function harness() {
    const personaSpy = vi.fn(async () => null);
    const correctionSpy = vi.fn(async () => ({ isCorrection: false, rawText: '' }));
    const insertSpy = vi.fn(async () => {});

    const processor = new RealtimeProcessor(
      {} as any,
      { match: async () => [] } as any,
      { processSignal: personaSpy, apply: () => {} } as any,
      // ★ C2：纠正候选池读的是**当前态**（`getCurrentFacts`），全量 `getAllFacts` 已是审计专用
      { getCurrentFacts: () => [], getAllFacts: () => [] } as any,
      { detectCorrectionSignal: correctionSpy } as any,
      { embed: async () => [0.1, 0.2], dimension: () => 2 } as any,
      { insert: insertSpy, search: async () => [], delete: async () => {}, count: async () => 0 } as any,
    );
    return { processor, personaSpy, correctionSpy, insertSpy };
  }

  it('★★ 她说的话不进人格扫描、不做纠正判定（同样的文本换 role=user 就会进）', async () => {
    const h = harness();

    // 同一句话：她说的
    await h.processor.process(makeEvent({ payload: { role: 'assistant', content: '不要再说这个啦' } }));
    expect(h.personaSpy, '她因为自己说的话改变了自己（E4）').not.toHaveBeenCalled();
    expect(h.correctionSpy, '她的一句"不对"去纠正了他的事实').not.toHaveBeenCalled();
    // 但她说过的话仍是对话历史的一部分 —— 要能被回忆
    expect(h.insertSpy, '她的回答连向量都不进了，日后就回忆不起"聊过什么"').toHaveBeenCalledTimes(1);

    // 同一句话：用户说的
    h.personaSpy.mockClear();
    h.correctionSpy.mockClear();
    await h.processor.process(makeEvent({ payload: { role: 'user', content: '不要再说这个啦' } }));
    expect(h.personaSpy, '闸装反了：用户的话反而不触发人格扫描').toHaveBeenCalled();
    expect(h.correctionSpy).toHaveBeenCalled();
  });

  it('★ 用户发言仍触发人格扫描与纠正（别把闸焊死）', async () => {
    const h = harness();
    await h.processor.process(makeEvent({ payload: { role: 'user', content: '我喜欢看海' } }));
    expect(h.personaSpy).toHaveBeenCalled();
    expect(h.correctionSpy).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
// E1 — 两条摘要路径的输入必须逐字相同
// ══════════════════════════════════════════════════════════════════
describe('★ E1 正常摘要与补处理共用同一个对话渲染器', () => {
  const SYNTHETIC_EVT = makeEvent({
    session_id: 'sess-1',
    payload: {
      role: 'user',
      content: 'Current runtime context. This snapshot supersedes earlier snapshots.',
      skip_profile: true,
      synthetic: 'runtime-context',
    },
  });
  const REAL_EVT = makeEvent({ session_id: 'sess-1', payload: { role: 'user', content: '我今天去看了海' } });
  const HER_EVT = makeEvent({ session_id: 'sess-1', payload: { role: 'assistant', content: '海风很大吧' } });

  /** 记录每次 LLM 调用的 user 段（摘要 prompt） */
  function makeLlm(prompts: string[]): ILLMService {
    return {
      complete: (async (_system: string, user: string) => {
        prompts.push(user);
        return SUMMARY_JSON;
      }) as any,
    };
  }

  function makeProcessor(events: MemoryEvent[], llm: ILLMService, updated: any[]) {
    return new SessionEndProcessor(
      { getBySession: () => events, updateImportance: () => {} } as any,
      {
        insert: async () => {},
        updateSummaryResult: async (...args: any[]) => { updated.push(args); return { rows: 1, vector: 'stored' }; },
        // ★ C4：事实状态是独立的一笔记账
        updateFactsStatus: () => ({ rows: 1 }),
        incrementFactsAttempts: () => {},
      } as any,
      { addFacts: () => {}, addCharacterFacts: () => {} } as any,
      {} as any,
      {} as any,
      { extract: async () => ({ facts: [], characterFacts: [] }) } as any,
      { processSignal: async () => null, apply: () => {} } as any,
      llm,
      { embed: async () => [0.1, 0.2] } as any,
      { insert: async () => {} } as any,
    );
  }

  it('★★ 同一批事件：`process()` 与 `retryFailedSummary()` 喂给模型的对话**逐字相同**', async () => {
    const prompts: string[] = [];
    const llm = makeLlm(prompts);
    const updated: any[] = [];
    const p = makeProcessor([SYNTHETIC_EVT, REAL_EVT, HER_EVT], llm, updated);

    // 路径一：正常摘要
    await p.process('sess-1');
    const normal = prompts[0];

    // 路径二：补处理（修复前这条路径**没有** synthetic 过滤，见 E1）
    await p.retryFailedSummary(
      { id: 'conv-1', session_id: 'sess-1', summary: '', ended_at: new Date().toISOString() } as any,
      new Date(0),
    );
    const retried = prompts[1];

    expect(retried, '两条摘要路径的输入不一致 —— 同一窗口"第一次滤掉、第二次收进去"').toBe(normal);
    expect(normal, '合成注入进了摘要（会被召回并回灌）').not.toContain('supersedes');
    expect(normal, '真实对话被一起滤掉了').toContain('我今天去看了海');
    expect(normal, '她的回答是对话历史的一部分，应当进摘要').toContain('海风很大吧');
  });
});

// ══════════════════════════════════════════════════════════════════
// C1 — 画像提取只吃用户发言
// ══════════════════════════════════════════════════════════════════
describe('★ C1 画像提取只吃「用户本人发言」', () => {
  // ⚠️ 诚实说明：这一组在**改之前也是绿的** —— 旧的三段手写 filter
  //   （`type==='message'` + `role==='user'` + `skip_profile!==true`）恰好把
  //   synthetic / npc 都挡住了（因为 ingest 侧会给它们都打 `skip_profile`）。
  //   所以它不是"修了一个漏"，而是**把巧合签成契约**：
  //   本 change 之后判据只剩一个出处，若有人改了 `skip_profile` 的语义、
  //   或新增一种机器来源却漏打标记，这里会立刻红。
  it('★★ assistant / synthetic / npc 的文本都不进提取 prompt', async () => {
    const prompts: string[] = [];
    const llm: ILLMService = {
      complete: (async (_s: string, user: string) => {
        prompts.push(user);
        return JSON.stringify({ facts: [], character_facts: [] });
      }) as any,
    };
    const extractor = new ProfileExtractor(llm);

    await extractor.extract([
      makeEvent({ payload: { role: 'user', content: '我养了一只猫' } }),
      makeEvent({ payload: { role: 'assistant', content: '猫叫什么名字呀' } }),
      makeEvent({ payload: { role: 'user', content: 'injected snapshot', skip_profile: true, synthetic: 'runtime-context' } }),
      makeEvent({ payload: { role: 'user', content: '群里的路人甲', skip_profile: true } }),
    ]);

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt).toContain('我养了一只猫');
    expect(prompt, '她的问句被当成"用户说过的事实"').not.toContain('猫叫什么名字呀');
    expect(prompt, '合成注入进了画像（KI-20 的第四条泄漏路径）').not.toContain('injected snapshot');
    expect(prompt).not.toContain('群里的路人甲');
  });

  it('★ 全是机器来源 ⇒ 一次 LLM 都不调（别白烧）', async () => {
    const complete = vi.fn(async () => '{}');
    const extractor = new ProfileExtractor({ complete } as any);

    const r = await extractor.extract([
      makeEvent({ payload: { role: 'assistant', content: '我记住了' } }),
      makeEvent({ payload: { role: 'user', content: 'snapshot', skip_profile: true, synthetic: 'runtime-context' } }),
    ]);

    expect(complete, '没有可提取的发言仍然调了 LLM').not.toHaveBeenCalled();
    expect(r.facts).toEqual([]);
    expect(r.characterFacts).toEqual([]);
  });
});
