// tests/memory/eligibility.test.ts
// ★ 2026-10-21 · change: unify-memory-eligibility（C1）
//
// 这份用例守的是**一件事**：来源 → 用途的资格判据**只有一个出处**。
//
// 立它之前的实况（见 proposal E1–E4）：同一个问题被四份代码各答一次，写法互不相同 ——
//   `EventStore` 的 SQL（role=user + 两 flag）/ `RealtimeProcessor`（只看 skip_profile）/
//   `ProfileExtractor`（role + skip_profile，不看 synthetic）/
//   `SessionEndProcessor`（只看 synthetic，不看 role）。
// 于是"能不能学"取决于你恰好走哪条路径。
//
// ⚠️ 本文件**只测判据**，不测处理器行为（那是 T2 的事）。
//   判据测试的价值在于：矩阵每一格都有明确答案，且"禁止"必须给得出理由。
import { describe, it, expect } from 'vitest';
import {
  isEligible,
  originOf,
  ELIGIBILITY,
  MEMORY_USES,
  EVENT_ORIGINS,
  type EventOrigin,
  type MemoryUse,
} from '../../src/memory/eligibility';
import type { MemoryEvent } from '../../src/memory/types';

function makeEvent(overrides: Partial<MemoryEvent> & { payload?: Record<string, unknown> } = {}): MemoryEvent {
  return {
    id: 'evt-1',
    session_id: 'webui:private:abc',
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content: '我今天去看了海' },
    importance: 0.5,
    created_at: new Date().toISOString(),
    processed: 0,
    ...overrides,
  } as MemoryEvent;
}

/** 服务端打的两个机器标记（`packages/server/src/ingest.ts`） */
const SYNTHETIC = { skip_profile: true, synthetic: 'runtime-context', dsh_source: 'runtime-context' };
const DELEGATED = { skip_profile: true, synthetic: 'delegated-task', dsh_origin: 'delegated-task' };

describe('★ C1 判据矩阵：每一格都有明确答案', () => {
  it('矩阵覆盖全部来源 × 全部用途，且"禁止"必须给得出理由', () => {
    for (const origin of EVENT_ORIGINS) {
      for (const use of MEMORY_USES) {
        const v = ELIGIBILITY[origin]?.[use];
        expect(typeof v, `矩阵缺格：${origin} × ${use}`).toBe('boolean');
      }
    }
    // 「禁止」不许静默：每个来源的每一种用法被拒时，isEligible 都要带 reason
    for (const origin of EVENT_ORIGINS) {
      for (const use of MEMORY_USES) {
        if (ELIGIBILITY[origin][use]) continue;
        const e = eventOfOrigin(origin);
        const v = isEligible(e, use);
        expect(v.ok).toBe(false);
        expect(v.reason, `${origin} × ${use} 被拒但没给理由 —— "滤掉了"与"本来没采到"会同形`).toBeTruthy();
      }
    }
  });
});

describe('★ C1 来源判定（先判来源，再判用途）', () => {
  it('role=user → user', () => {
    expect(originOf(makeEvent()).origin).toBe('user');
  });

  it('旧数据：没有 role 但有 sender_id → 仍按 user（否则老事实来源会整批消失）', () => {
    const e = makeEvent({ payload: { content: '老消息', sender_id: 'u1' } });
    expect(originOf(e).origin).toBe('user');
  });

  it('role=assistant → assistant', () => {
    const e = makeEvent({ payload: { role: 'assistant', content: '我记住了' } });
    expect(originOf(e).origin).toBe('assistant');
  });

  it('role=engine（执行回执）→ engine，不是 assistant', () => {
    const e = makeEvent({ payload: { role: 'engine', content: '（委托任务回执）' } });
    expect(originOf(e).origin).toBe('engine');
  });

  it('synthetic 优先于 skip_profile / role：机器注入永远不是"用户发言"', () => {
    const e = makeEvent({ payload: { role: 'user', content: 'Current runtime context', ...SYNTHETIC } });
    const v = originOf(e);
    expect(v.origin).toBe('synthetic');
    expect(v.because, '原因里必须带得出 synthetic 的值，事后才能复盘').toContain('runtime-context');
  });

  it('委托任务会话 → agent-delegated（同样是机器发起，但不是合成注入）', () => {
    expect(originOf(makeEvent({ payload: { role: 'user', content: '把页面做出来', ...DELEGATED } })).origin)
      .toBe('agent-delegated');
  });

  it('只有 skip_profile（群聊 NPC）→ npc，不是 synthetic（否则日志会被 NPC 淹掉）', () => {
    const e = makeEvent({ payload: { role: 'user', content: '路人甲说话', skip_profile: true } });
    expect(originOf(e).origin).toBe('npc');
  });

  it('perspective=self（她自己的事）→ self-life', () => {
    const e = makeEvent({ perspective: 'self', payload: { role: 'assistant', content: '我今天在河边坐了很久' } });
    expect(originOf(e).origin).toBe('self-life');
  });

  it('非 message 事件（tool_call/tool_result）→ tool', () => {
    const e = makeEvent({ type: 'tool_result', payload: { content: '{"ok":true}' } });
    expect(originOf(e).origin).toBe('tool');
  });

  it('role 缺失且无 sender_id → unknown（诚实兜底，不猜成 user）', () => {
    const e = makeEvent({ payload: { content: '来源不明的一段话' } });
    expect(originOf(e).origin).toBe('unknown');
  });
});

describe('★ C1 用途判定：谁能学什么', () => {
  it('user：六种用途全开', () => {
    const e = makeEvent();
    for (const use of MEMORY_USES) expect(isEligible(e, use).ok, `user × ${use}`).toBe(true);
  });

  it('assistant：可进摘要与向量（要能回忆"我们聊过什么"），不可进画像/人格/纠正', () => {
    const e = makeEvent({ payload: { role: 'assistant', content: '不要再说这个啦' } });
    expect(isEligible(e, 'summary').ok, '她的回答是对话历史的一部分').toBe(true);
    expect(isEligible(e, 'embed').ok).toBe(true);
    expect(isEligible(e, 'profile-facts').ok, '她的自述不是"关于用户的证据"').toBe(false);
    expect(isEligible(e, 'persona-evidence').ok, '她会因为自己说的话改变自己（E4）').toBe(false);
    expect(isEligible(e, 'correction').ok, '她的一句"不对"不该去纠正他事实').toBe(false);
  });

  it('synthetic / agent-delegated / engine：只可参与 worldbook 匹配（机器文本不是学习材料）', () => {
    const cases: Array<[string, MemoryEvent]> = [
      ['synthetic', makeEvent({ payload: { role: 'user', content: 'runtime', ...SYNTHETIC } })],
      ['agent-delegated', makeEvent({ payload: { role: 'user', content: '任务', ...DELEGATED } })],
      ['engine', makeEvent({ payload: { role: 'engine', content: '（回执）' } })],
    ];
    for (const [name, e] of cases) {
      expect(isEligible(e, 'worldbook').ok, `${name} × worldbook`).toBe(true);
      for (const use of ['profile-facts', 'persona-evidence', 'correction', 'summary', 'embed'] as MemoryUse[]) {
        expect(isEligible(e, use).ok, `${name} × ${use} 应被拒`).toBe(false);
      }
    }
  });

  it('npc：可进摘要（既有群聊行为），但不进画像/人格/嵌入', () => {
    const e = makeEvent({ payload: { role: 'user', content: '路人甲说话', skip_profile: true } });
    expect(isEligible(e, 'summary').ok, '改这条会静默改变群聊摘要，属于另一个决定').toBe(true);
    expect(isEligible(e, 'profile-facts').ok).toBe(false);
    expect(isEligible(e, 'persona-evidence').ok).toBe(false);
    expect(isEligible(e, 'embed').ok).toBe(false);
  });

  it('self-life：可被嵌入与匹配，但不进画像/人格/纠正', () => {
    const e = makeEvent({ perspective: 'self', payload: { role: 'assistant', content: '我在河边坐了很久' } });
    expect(isEligible(e, 'embed').ok).toBe(true);
    expect(isEligible(e, 'persona-evidence').ok, 'D2：她自己产出的内容不能形塑权威').toBe(false);
    expect(isEligible(e, 'profile-facts').ok).toBe(false);
  });

  it('tool：工具输出不是学习材料，但可以被检索', () => {
    const e = makeEvent({ type: 'tool_result', payload: { content: '{"ok":true}' } });
    expect(isEligible(e, 'embed').ok).toBe(true);
    expect(isEligible(e, 'persona-evidence').ok).toBe(false);
    expect(isEligible(e, 'profile-facts').ok).toBe(false);
  });
});

/** 每个来源一个代表事件（矩阵完整性用） */
function eventOfOrigin(origin: EventOrigin): MemoryEvent {
  switch (origin) {
    case 'user': return makeEvent();
    case 'assistant': return makeEvent({ payload: { role: 'assistant', content: '我记住了' } });
    case 'self-life': return makeEvent({ perspective: 'self', payload: { role: 'assistant', content: '我在河边' } });
    case 'engine': return makeEvent({ payload: { role: 'engine', content: '（回执）' } });
    case 'agent-delegated': return makeEvent({ payload: { role: 'user', content: '任务', ...DELEGATED } });
    case 'synthetic': return makeEvent({ payload: { role: 'user', content: 'runtime', ...SYNTHETIC } });
    case 'npc': return makeEvent({ payload: { role: 'user', content: '路人', skip_profile: true } });
    case 'tool': return makeEvent({ type: 'tool_call', payload: { content: '调用工具' } });
    case 'unknown': return makeEvent({ payload: { content: '来源不明' } });
  }
}
