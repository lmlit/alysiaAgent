// tests/memory/current-state-reads.test.ts
// ★ 2026-10-21 · change: unify-memory-eligibility（T3 / 契约 C2）
//
// 钉住一件事：**「当前认知」与「历史记录」是两个读取档**，业务只许读前者。
//
// 立它之前的实况（proposal E2/E3）：
//   - `CronProcessor.deepProfile` 读 `user_profile.facts` 的**原始 JSON**（等价 `getAllFacts()`，
//     含 `superseded` / `expired`），据此重写 `basics` —— 而 `basics` 会作为 `[关于你]`
//     注入 prompt ⇒ **你纠正掉的旧说法换个形式又回来了**。
//   - 纠正候选池同样喂了全量事实 ⇒ 模型可能去"纠正"一条早已失效的旧说法。
//
// ⚠️ 本文件用**真的 `ProfileStore`**（内存库）而不是 mock：
//   这条链路的错法正是"读错了那个方法"，mock 掉 store 就等于把被测对象删了。
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database';
import { ProfileStore } from '../../src/memory/stores/ProfileStore';
import { CronProcessor } from '../../src/memory/processors/CronProcessor';
import { RealtimeProcessor } from '../../src/memory/processors/RealtimeProcessor';
import type { ProfileFact } from '../../src/memory/types';
import type { MemoryEvent } from '../../src/memory/types';

const NOW = () => new Date().toISOString();

function fact(factText: string, over: Partial<ProfileFact> = {}): ProfileFact {
  return {
    fact: factText,
    confidence: 0.9,
    evidence: `证据：${factText}`,
    source_event: 'evt-1',
    updated_at: NOW(),
    source: 'user',
    valid_from: NOW(),
    valid_until: null,
    status: 'active',
    category: 'general',
    ...over,
  } as ProfileFact;
}

/** 造一个"旧说法已被纠正"的画像：`旧` 是 superseded，`新` 是 active */
function profileWithCorrection(): { db: Database.Database; store: ProfileStore } {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const store = new ProfileStore(db);
  store.addFacts([fact('用户在长沙工作')]);
  // 用户后来纠正：其实在深圳
  store.supersede('长沙', fact('用户在深圳工作', { confidence: 1.0 }));
  return { db, store };
}

describe('★ C2 当前态：`basics` 只能由 active && 未过期 的事实派生（E2）', () => {
  it('★★ 已被纠正的旧事实**不得**出现在深度重写的输入里', async () => {
    const { db, store } = profileWithCorrection();
    const prompts: string[] = [];
    const llm = {
      complete: (async (_s: string, user: string) => {
        prompts.push(user);
        return '他在深圳工作（这是重写后的 basics）';
      }) as any,
    };

    const cron = new CronProcessor(
      { getUnprocessed: () => [], markProcessed: () => {} } as any,
      {} as any,
      { listActive: () => [] } as any,
      store,
      {} as any,
      llm,
      null,
    );
    await cron.process();

    expect(prompts).toHaveLength(1);
    expect(prompts[0], '旧说法（已被纠正）进了 basics 的原材料 —— 它会以 [关于你] 的形式回来')
      .not.toContain('长沙');
    expect(prompts[0], '当前事实反而没进去').toContain('深圳');

    expect(store.get().basics).toContain('深圳');
    db.close();
  });

  it('★ 全部事实都失效 ⇒ 不重写 basics（不把旧印象洗成空白）', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const store = new ProfileStore(db);
    store.addFacts([fact('用户在长沙工作')]);
    store.supersede('长沙', fact('用户在深圳工作'));
    // 再把深圳这条也置为过期
    const all = store.getAllFacts();
    store.replaceFacts(all.map(f => ({ ...f, status: 'expired' as const, valid_until: NOW() })));
    store.updateBasics('（原有的 [关于你] 文本）');

    const complete = vi.fn(async () => '重写后的 basics');
    const warn = vi.spyOn(console, 'warn');
    const cron = new CronProcessor(
      { getUnprocessed: () => [], markProcessed: () => {} } as any,
      {} as any,
      { listActive: () => [] } as any,
      store,
      {} as any,
      { complete } as any,
      null,
    );
    await cron.process();

    expect(complete, '当前态为空时仍调了 LLM（会拿空输入重写 basics）').not.toHaveBeenCalled();
    expect(store.get().basics, '当前态为空却把 basics 覆盖掉了 —— 她把你知道的一干二净').toBe('（原有的 [关于你] 文本）');
    warn.mockRestore();
    db.close();
  });

  it('`getCurrentFacts()` 与审计用的 `getAllFacts()` 必须分得清', () => {
    const { db, store } = profileWithCorrection();
    expect(store.getAllFacts().map(f => f.fact)).toEqual(expect.arrayContaining(['用户在长沙工作', '用户在深圳工作']));
    expect(store.getCurrentFacts().map(f => f.fact), '当前态里不该有被纠正的旧说法').toEqual(['用户在深圳工作']);
    db.close();
  });
});

describe('★ C2 纠正候选池只放当前事实（E3）', () => {
  function makeEvent(content: string): MemoryEvent {
    return {
      id: 'evt-c',
      session_id: 'webui:private:abc',
      source: 'chat',
      type: 'message',
      payload: { role: 'user', content },
      importance: 0.5,
      created_at: NOW(),
      processed: 0,
    } as MemoryEvent;
  }

  it('★★ 纠正提示词里没有已被纠正的旧事实', async () => {
    const { db, store } = profileWithCorrection();
    const seen: ProfileFact[][] = [];

    const processor = new RealtimeProcessor(
      { markProcessed: () => {} } as any,
      { match: async () => [] } as any,
      { processSignal: async () => null, apply: () => {} } as any,
      store,
      {
        detectCorrectionSignal: async (_text: string, existing: ProfileFact[]) => {
          seen.push(existing);
          return { isCorrection: false, rawText: '' };
        },
      } as any,
      { embed: async () => [0.1] } as any,
      null,
    );

    await processor.process(makeEvent('不是长沙，我在深圳'));

    expect(seen).toHaveLength(1);
    const texts = seen[0].map(f => f.fact);
    expect(texts, '纠正候选里混进了失效事实 —— 模型可能去"纠正"一条早就不成立的旧说法')
      .not.toContain('用户在长沙工作');
    expect(texts).toContain('用户在深圳工作');
    db.close();
  });
});
