/**
 * ★ 2026-10-20（change: `observe-and-hold-context-compaction`）
 *
 * 守两件事：
 *   ① **压缩失败 → 暂不截断**（否则"截断已发生 + 摘要没生成"= 那段对话真的没了）
 *   ② **硬上限**：不截断不能变成超模型上下文（那是换一种崩法 —— API 400）
 *
 * 以及状态注册表本身的纪律：有界、会过期、能清。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  decideTruncation,
  HARD_CEILING_FACTOR,
} from '../../src/agent/truncation-policy';
import {
  markCompactionFailed,
  clearCompactionFailed,
  isCompactionFailed,
  _resetCompactionStatus,
  _compactionStatusSize,
  COMPACTION_FAILED_TTL_MS,
} from '../../src/memory/compaction-status';
import { AgentContext } from '../../src/agent/context';

describe('decideTruncation —— 截断策略', () => {
  it('压缩正常 ⇒ 照旧截断（正常路径零变化）', () => {
    expect(decideTruncation({ maxTokens: 16000, estimatedTokens: 99999, compactionFailed: false }))
      .toEqual({ action: 'truncate', reason: 'normal' });
  });

  it('★ 压缩失败 ⇒ 暂不截断（保住还没被摘要覆盖的对话）', () => {
    expect(decideTruncation({ maxTokens: 16000, estimatedTokens: 20000, compactionFailed: true }))
      .toEqual({ action: 'hold', reason: 'compaction-failed' });
  });

  it('★ 压缩失败但已超硬上限 ⇒ 只能截断（超模型上下文会 400）', () => {
    const over = 16000 * HARD_CEILING_FACTOR + 1;
    expect(decideTruncation({ maxTokens: 16000, estimatedTokens: over, compactionFailed: true }))
      .toEqual({ action: 'truncate', reason: 'over-hard-ceiling' });
  });

  it('硬上限边界：正好 2 倍仍算超（> 判定，不是 >=）', () => {
    const exact = 16000 * HARD_CEILING_FACTOR;
    expect(decideTruncation({ maxTokens: 16000, estimatedTokens: exact, compactionFailed: true }).action)
      .toBe('hold');
    expect(decideTruncation({ maxTokens: 16000, estimatedTokens: exact + 1, compactionFailed: true }).action)
      .toBe('truncate');
  });
});

describe('compaction-status —— 进程内状态', () => {
  beforeEach(() => _resetCompactionStatus());
  afterEach(() => _resetCompactionStatus());

  it('标记 → 查询为真；清除 → 为假', () => {
    expect(isCompactionFailed('s1')).toBe(false);
    markCompactionFailed('s1');
    expect(isCompactionFailed('s1')).toBe(true);
    clearCompactionFailed('s1');
    expect(isCompactionFailed('s1')).toBe(false);
  });

  it('按 session 隔离（s1 失败不该影响 s2 的截断）', () => {
    markCompactionFailed('s1');
    expect(isCompactionFailed('s1')).toBe(true);
    expect(isCompactionFailed('s2')).toBe(false);
  });

  it('★ 会过期：TTL 后自动失效（一次偶发失败不该永久压制截断）', () => {
    const t0 = 1_000_000;
    markCompactionFailed('s1', t0);
    expect(isCompactionFailed('s1', t0 + COMPACTION_FAILED_TTL_MS - 1)).toBe(true);
    expect(isCompactionFailed('s1', t0 + COMPACTION_FAILED_TTL_MS + 1)).toBe(false);
    // 过期条目被读取时回收
    expect(_compactionStatusSize()).toBe(0);
  });

  it('有界：超过 200 个 session 时丢最旧，不会无限增长', () => {
    for (let i = 0; i < 205; i++) markCompactionFailed(`s${i}`);
    expect(_compactionStatusSize()).toBe(200);
    // 最旧的几个已被淘汰
    expect(isCompactionFailed('s0')).toBe(false);
    expect(isCompactionFailed('s204')).toBe(true);
  });
});

describe('AgentContext.estimateTokens —— 估算口径（已知不准，先锁现状）', () => {
  it('length / 3（中文低估 —— 这条测试是"现状备忘"，改口径时它会红）', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'x'.repeat(30) });
    expect(ctx.estimateTokens()).toBe(10);
  });

  it('空上下文是 0（否则截断判定会误判）', () => {
    expect(new AgentContext().estimateTokens()).toBe(0);
  });
});
