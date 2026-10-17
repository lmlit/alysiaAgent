// ★ 2026-10-17 · change: isolate-delegated-task-memory
//
// 服务端是**判定 `skip_profile` 的地方**：适配器只上报**事实**
// （`payload.dsh_origin` = 这个会话是机器发起的），策略在这里定。
//
// 本文件守四件事：
//   ① `dsh_origin` 非空 → 打 `skip_profile` **且** `synthetic`（两个都要，
//      因为 `RealtimeProcessor`/`ProfileExtractor` 认前者、`SessionEndProcessor` 只认后者）
//   ② ★ **没有这个字段时行为一字不变**（桌面端那份 adapter 不配它）
//   ③ 畸形输入（空串 / 非字符串）**拒收** —— 空串会让「机器发起」与「用户发起」分不开
//   ④ 与 `dsh_source` **正交**（会话级 / 消息级各管各的，同时命中时 synthetic 取更精确的那个）
import { describe, it, expect } from 'vitest';
import {
  normalizeIngestEvent,
  validateIngestEvent,
  DSH_ORIGIN_FIELD,
  RUNTIME_CONTEXT_SOURCE,
} from '../src/ingest.js';
import type { MemoryEvent } from '@alysia/core/memory';

const ORIGIN = 'delegated-task';

function ev(payload: Record<string, unknown>, over: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: 'dsh-session-1-42',
    session_id: 'dsh:session-1',
    source: 'code',
    type: 'message',
    payload: { role: 'user', content: 'x', ...payload },
    created_at: '2026-10-17T00:00:00.000Z',
    ...over,
  } as MemoryEvent;
}

describe('★ 机器发起的会话 → 打不学习闸（判定在服务端）', () => {
  it('★★ 主症：dsh_origin=delegated-task → skip_profile + synthetic 原因', () => {
    const out = normalizeIngestEvent(ev({ content: '把关于我页面做出来', [DSH_ORIGIN_FIELD]: ORIGIN }));
    expect(out.payload.skip_profile, '委托会话没被拦 —— 任务书会被当成用户发言写进画像').toBe(true);
    expect(out.payload.synthetic, '没记下跳过原因，事后无法复盘').toBe(ORIGIN);
  });

  it('★ 两个字段都要打：只打 skip_profile 会漏掉摘要这条路', () => {
    // SessionEndProcessor **刻意只过滤 synthetic**（群聊 NPC 的 skip_profile 进摘要是既有行为）
    // ⇒ 漏掉 synthetic 的后果是：委托会话的内容照样进摘要、日后被召回。
    const out = normalizeIngestEvent(ev({ [DSH_ORIGIN_FIELD]: ORIGIN }));
    expect(out.payload.skip_profile).toBe(true);
    expect(out.payload.synthetic, 'SessionEndProcessor 只认 synthetic —— 漏打等于摘要照收').toBe(ORIGIN);
  });

  it('★ 事件照常入库（拦的是「进学习管道」，不是「入库」——同 KI-20 的分工）', () => {
    const out = normalizeIngestEvent(ev({ content: '跑完了', [DSH_ORIGIN_FIELD]: ORIGIN }));
    expect(out.payload.content).toBe('跑完了');
    expect(out.payload[DSH_ORIGIN_FIELD]).toBe(ORIGIN); // 证据留在事件里，将来复盘要靠它
  });

  it('★ 不改动入参（不要就地改调用方的对象）', () => {
    const input = ev({ [DSH_ORIGIN_FIELD]: ORIGIN });
    normalizeIngestEvent(input);
    expect(input.payload.skip_profile).toBeUndefined();
    expect(input.payload.synthetic).toBeUndefined();
  });
});

describe('★ 反向守卫：没有标记就一切照旧', () => {
  it('★★ 普通 dsh 回传（无 dsh_origin）完全不变 —— 桌面端行为不许被改动', () => {
    const out = normalizeIngestEvent(ev({ content: '帮我看看这个函数' }));
    expect(out.payload.skip_profile, '正常编程对话被误判成机器发起了 —— 她的记忆会缺一块').toBeUndefined();
    expect(out.payload.synthetic).toBeUndefined();
  });

  it('★ 已有 skip_profile 的群聊 NPC 事件不受影响（原样保留、不当 synthetic）', () => {
    const out = normalizeIngestEvent(ev({ content: '路人甲', skip_profile: true }));
    expect(out.payload.skip_profile).toBe(true);
    expect(out.payload.synthetic).toBeUndefined();
  });
});

describe('★ 与 dsh_source 正交', () => {
  it('会话级 + 消息级同时命中 → 两个字段都在，synthetic 取更精确的**消息级**原因', () => {
    const out = normalizeIngestEvent(ev({
      content: 'Current runtime context. …',
      dsh_source: RUNTIME_CONTEXT_SOURCE,
      [DSH_ORIGIN_FIELD]: ORIGIN,
    }));
    expect(out.payload.skip_profile).toBe(true);
    // 「这条消息是 runtime-context 注入」比「这个会话是委托」更精确 —— 记前者更有诊断价值
    expect(out.payload.synthetic).toBe(RUNTIME_CONTEXT_SOURCE);
    expect(out.payload[DSH_ORIGIN_FIELD]).toBe(ORIGIN); // 会话级事实不丢
  });
});

describe('★ 畸形输入拒收（严进宽出：写接口是攻击面）', () => {
  it('空串 → 拒收，理由是具体的', () => {
    const reason = validateIngestEvent(ev({ [DSH_ORIGIN_FIELD]: '   ' }));
    expect(reason, '空串被放行 —— 服务端就分不开「机器发起」和「用户发起」了').toContain(DSH_ORIGIN_FIELD);
  });

  it.each([
    ['数字', 1],
    ['布尔', true],
    ['对象', { kind: 'delegated' }],
  ])('非字符串（%s）→ 拒收', (_label, value) => {
    const reason = validateIngestEvent(ev({ [DSH_ORIGIN_FIELD]: value }));
    expect(reason).toContain(DSH_ORIGIN_FIELD);
  });

  it('★ 合法值 → 通过校验', () => {
    expect(validateIngestEvent(ev({ [DSH_ORIGIN_FIELD]: ORIGIN }))).toBeNull();
  });

  it('★ 缺省 → 通过校验（绝大多数回传都没有这个字段）', () => {
    expect(validateIngestEvent(ev({ content: '你好' }))).toBeNull();
  });
});
