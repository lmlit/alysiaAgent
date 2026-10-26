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

  /**
   * ★ 第二道闸（KI-23，change: `fix-dsh-ingest-and-settlement` 契约 7）。
   * 适配器已改成 fail closed（取不到 id 就不回传），这里防的是**上游契约再次变化**
   * ——dsh 已换过一次插件机制，`Session` 形状一变，退化路径就会静默开启。
   */
  it('★ 拒收 dsh:unknown —— 它会把多个真实会话混成一个桶', () => {
    const problem = validateIngestEvent(valid({ session_id: 'dsh:unknown' }));
    expect(problem).not.toBeNull();
    expect(problem).toContain('dsh:unknown');
    expect(problem, '拒绝原因要说清为什么，不能只说「不合法」').toMatch(/身份不明|混/);
  });

  it('拒收 dsh:unknown 不误伤正常会话（前缀相同但 id 真实）', () => {
    expect(validateIngestEvent(valid({ session_id: 'dsh:unknownish-1' }))).toBeNull();
    expect(validateIngestEvent(valid({ session_id: 'dsh:session-abc' }))).toBeNull();
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
    expect(typeof out.created_at).toBe('string');
    expect(Number.isNaN(Date.parse(out.created_at))).toBe(false);
  });

  it('已有值不覆盖', () => {
    const e = valid({ importance: 0.9, created_at: '2026-01-01T00:00:00Z' }) as unknown as MemoryEvent;
    const out = normalizeIngestEvent(e);
    expect(out.importance).toBe(0.9);
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

  /**
   * ★ 与适配器侧的**同一字面量**钉住（change: `fix-dsh-ingest-and-settlement` 契约 1）。
   *
   * 插件不能依赖 server 包，所以两边各有一份常量，只能靠测试对齐
   * （与 `DSH_SESSION_PREFIX` 同一套手法）。漂移的后果不是静默：
   * 适配器会按旧上限分片，超出的批次吃 413 → 被按**永久拒收**丢弃并响亮报警。
   * 改这个数字时，`packages/dsh-adapter/src/delivery.ts` 的
   * `SERVER_MAX_INGEST_BATCH` 必须一起改。
   */
  it('★ 值必须是 200（适配器侧 SERVER_MAX_INGEST_BATCH 与它逐字对齐）', () => {
    expect(MAX_INGEST_BATCH).toBe(200);
  });
});
