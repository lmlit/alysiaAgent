/**
 * `/api/ingest` 的事件校验单测（change: connect-dsh-alysia-bridge）。
 *
 * ★ 这是**写接口**：畸形事件一旦放进去就成了她的记忆。
 *   所以正例要具体，反例要逐个覆盖（每条拒绝都要给得出人话原因）。
 */

import { describe, it, expect } from 'vitest';
import {
  validateIngestEvent,
  normalizeIngestEvent,
  MAX_INGEST_BATCH,
  DSH_SESSION_PREFIX,
} from '../src/ingest.js';
import type { MemoryEvent } from '@alysia/core/memory';

/** 一条合法事件（测试里按需覆盖字段） */
function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dsh-1',
    session_id: `${DSH_SESSION_PREFIX}sess-abc`,
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content: '你好' },
    created_at: '2026-10-01T12:00:00Z',
    ...over,
  };
}

describe('validateIngestEvent / 正例', () => {
  it('合法事件通过', () => {
    expect(validateIngestEvent(valid())).toBeNull();
  });

  it('importance 可省略（回传方不必凑齐所有字段）', () => {
    expect(validateIngestEvent(valid({ importance: undefined }))).toBeNull();
  });

  it.each(['user', 'assistant'])('role=%s 通过（提取器按它区分谁说的）', (role) => {
    expect(validateIngestEvent(valid({ payload: { role, content: 'x' } }))).toBeNull();
  });

  it("★ source='code' 通过 —— dsh 回传就用它（RealtimeProcessor 按它分流世界书 scope）", () => {
    expect(validateIngestEvent(valid({ source: 'code' }))).toBeNull();
  });
});

describe('validateIngestEvent / ★ 会话前缀是安全边界', () => {
  it.each(['qq-official-1:private:abc', 'webui:private:abc', 'sess-abc', ''])(
    '★ 拒绝非 dsh: 前缀的会话（%s）——写接口不该能往别的来源注入消息',
    (sid) => {
      const problem = validateIngestEvent(valid({ session_id: sid }));
      expect(problem).not.toBeNull();
      expect(problem).toContain(DSH_SESSION_PREFIX);
    },
  );

  it('session_id 非字符串也拒绝', () => {
    expect(validateIngestEvent(valid({ session_id: 123 }))).not.toBeNull();
  });
});

describe('validateIngestEvent / 反例', () => {
  it.each([
    ['非对象', null],
    ['数组', []],
    ['字符串', 'nope'],
  ])('%s → 拒绝', (_label, raw) => {
    expect(validateIngestEvent(raw)).not.toBeNull();
  });

  it('缺 id → 拒绝（它是去重键，不能让服务端编）', () => {
    expect(validateIngestEvent(valid({ id: undefined }))).toContain('id');
    expect(validateIngestEvent(valid({ id: '' }))).toContain('id');
  });

  it('payload 不是对象 → 拒绝', () => {
    expect(validateIngestEvent(valid({ payload: 'x' }))).toContain('payload');
    expect(validateIngestEvent(valid({ payload: [] }))).toContain('payload');
  });

  it('content 为空/纯空白 → 拒绝', () => {
    expect(validateIngestEvent(valid({ payload: { role: 'user', content: '' } }))).toContain('content');
    expect(validateIngestEvent(valid({ payload: { role: 'user', content: '   ' } }))).toContain('content');
  });

  it('★ role 非法 → 拒绝（判错会把画像写反：把人设当用户事实）', () => {
    expect(validateIngestEvent(valid({ payload: { role: 'system', content: 'x' } }))).toContain('role');
    expect(validateIngestEvent(valid({ payload: { content: 'x' } }))).toContain('role');
  });

  it('source 非法 → 拒绝', () => {
    expect(validateIngestEvent(valid({ source: 'dsh' }))).toContain('source');
  });

  it('importance 非数字 → 拒绝', () => {
    expect(validateIngestEvent(valid({ importance: 'high' }))).toContain('importance');
    expect(validateIngestEvent(valid({ importance: NaN }))).toContain('importance');
  });

  it('拒绝原因里带上事件 id（否则回传方只看到「没生效」）', () => {
    const problem = validateIngestEvent(valid({ id: 'dsh-42', payload: { role: 'user', content: '' } }));
    expect(problem).toContain('dsh-42');
  });
});

describe('normalizeIngestEvent', () => {
  it('补齐可安全默认的字段', () => {
    const e = { id: 'a', session_id: 'dsh:s', source: 'chat', type: 'message', payload: {} } as unknown as MemoryEvent;
    const out = normalizeIngestEvent(e);
    expect(out.importance).toBe(0.5);
    expect(out.processed).toBe(0);
    expect(typeof out.created_at).toBe('string');
    expect(Number.isNaN(Date.parse(out.created_at))).toBe(false);
  });

  it('已有值不覆盖', () => {
    const e = valid({ importance: 0.9, processed: 3, created_at: '2026-01-01T00:00:00Z' }) as unknown as MemoryEvent;
    const out = normalizeIngestEvent(e);
    expect(out.importance).toBe(0.9);
    expect(out.processed).toBe(0); // processed 恒归零：新喂入的事件必须重新走处理
    expect(out.created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('不改动原对象（避免调用方拿到被改过的引用）', () => {
    const e = valid() as unknown as MemoryEvent;
    const before = { ...e };
    normalizeIngestEvent(e);
    expect(e).toEqual(before);
  });
});

describe('批次上限', () => {
  it('是个正整数（路由按它做 413 判定）', () => {
    expect(Number.isInteger(MAX_INGEST_BATCH)).toBe(true);
    expect(MAX_INGEST_BATCH).toBeGreaterThan(0);
  });
});
