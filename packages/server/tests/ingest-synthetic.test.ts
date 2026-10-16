// ★ 2026-10-16 · change: filter-synthetic-context-inflow（KI-20）
//
// 服务端是**判定 `skip_profile` 的地方**：适配器只上报 dsh 的 `source.kind`（事实），
// 策略在这里定。本文件守三件事：
//   ① 合成注入（`dsh_source === 'runtime-context'`）→ 打 `skip_profile` + `synthetic`
//   ② **仍然入库**（事件日志不可变；拦的是"进学习管道"，不是"入库"）
//   ③ ★ **用户自己粘贴类似文本不许被误伤**（change R6）——
//      判据只认结构化来源，**不认文本前缀**
import { describe, it, expect } from 'vitest';
import { normalizeIngestEvent, RUNTIME_CONTEXT_SOURCE } from '../src/ingest.js';
import type { MemoryEvent } from '@alysia/core/memory';

const RUNTIME_CONTEXT_TEXT =
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n[关于你]…';

function ev(payload: Record<string, unknown>, over: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: 'dsh-session-1-42',
    session_id: 'dsh:session-1',
    source: 'code',
    type: 'message',
    payload: { role: 'user', content: 'x', ...payload },
    created_at: '2026-10-16T00:00:00.000Z',
    ...over,
  } as MemoryEvent;
}

describe('★ 合成注入 → 打 skip_profile（判定在服务端）', () => {
  it('★★ 主症：dsh_source=runtime-context → skip_profile + synthetic 原因', () => {
    const out = normalizeIngestEvent(
      ev({ content: RUNTIME_CONTEXT_TEXT, dsh_source: RUNTIME_CONTEXT_SOURCE }),
    );

    expect(out.payload.skip_profile, '合成注入没被拦，会继续喂画像/人格/摘要').toBe(true);
    expect(out.payload.synthetic, '没记下跳过原因，事后无法复盘').toBe(RUNTIME_CONTEXT_SOURCE);
  });

  it('★★ R4：事件**内容与 id 原样保留**（拦的是学习，不是入库）', () => {
    const input = ev({ content: RUNTIME_CONTEXT_TEXT, dsh_source: RUNTIME_CONTEXT_SOURCE });
    const out = normalizeIngestEvent(input);

    expect(out.id).toBe(input.id);
    expect(out.payload.content).toBe(RUNTIME_CONTEXT_TEXT);
    expect(out.session_id).toBe('dsh:session-1');
    // 原始来源标记留着 —— 它是"为什么被跳过"的证据
    expect(out.payload.dsh_source).toBe(RUNTIME_CONTEXT_SOURCE);
  });

  it('★ 不修改传入对象（纯函数；调用方可能还要用原件）', () => {
    const input = ev({ content: RUNTIME_CONTEXT_TEXT, dsh_source: RUNTIME_CONTEXT_SOURCE });
    normalizeIngestEvent(input);

    expect(input.payload.skip_profile).toBeUndefined();
    expect(input.payload.synthetic).toBeUndefined();
  });

  it('★ assistant 的 runtime context（若 dsh 也这么标）同样拦得住', () => {
    const out = normalizeIngestEvent(
      ev({ role: 'assistant', content: RUNTIME_CONTEXT_TEXT, dsh_source: RUNTIME_CONTEXT_SOURCE }),
    );
    expect(out.payload.skip_profile).toBe(true);
  });
});

describe('★★ R6：真用户消息不许被误伤', () => {
  it('★★ 用户**粘贴**了那段文本（无结构化来源）→ 照常学习', () => {
    // 这正是"只按文本前缀过滤"会踩的坑：内容是同一段文本，但它是用户打的
    const out = normalizeIngestEvent(ev({ content: RUNTIME_CONTEXT_TEXT }));

    expect(out.payload.skip_profile, '用户粘贴的文本被当成合成注入了 —— 她的真实发言会被丢掉').toBeUndefined();
    expect(out.payload.synthetic).toBeUndefined();
  });

  it('★ 真用户消息带别的 source.kind → 照常学习', () => {
    const out = normalizeIngestEvent(ev({ content: '我今天去看了海', dsh_source: 'user' }));
    expect(out.payload.skip_profile).toBeUndefined();
  });

  it('★ 已有 skip_profile 的群聊 NPC 事件不受影响（原样保留）', () => {
    const out = normalizeIngestEvent(ev({ content: '路人甲', skip_profile: true }));
    expect(out.payload.skip_profile).toBe(true);
    // 但不是 synthetic —— 它不该进"合成注入"的留痕统计
    expect(out.payload.synthetic).toBeUndefined();
  });

  it('★ 普通 dsh 回传（无 dsh_source 字段）完全不变', () => {
    const out = normalizeIngestEvent(ev({ content: '帮我看看这个函数' }));
    expect(out.payload).toEqual({ role: 'user', content: '帮我看看这个函数' });
  });
});
