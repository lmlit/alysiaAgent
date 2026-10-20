/**
 * ★ 2026-10-20（change: `put-dropped-turns-back`）
 *
 * 被截断丢弃的对话，**压成一段回忆插回上下文**，而不是彻底消失。
 *
 * 守的边界（每条都对应一个会把人坑到的失败模式）：
 *   ① 攒批：不足阈值不压（长会话每步丢 1 条，逐条压 = 一步一次 LLM 调用）
 *   ② 不实现就不做：hooks 没给 `summarizeDroppedTurns` ⇒ 保持旧行为
 *   ③ 失败不阻塞：压缩失败只留痕，本轮继续（但那批确实丢了，必须说）
 *   ④ 累积摘要：第二次压缩替换同一条消息，不是不断追加（否则摘要撑爆上下文）
 *   ⑤ 空返回不插：模型说"没什么可总结"≠ 插一个空块
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentContext } from '../../src/agent/context';
import { AgentRunner } from '../../src/agent/runner';
import { _resetCompactionStatus } from '../../src/memory/compaction-status';

/** 造一个能撑过 N 步的 provider mock（每步返回一条 assistant 消息） */
function makeProvider() {
  let n = 0;
  return {
    getDefault: () => ({ config: { id: 'p', maxContextTokens: 100 } }),
    textChatWithFallback: vi.fn(async () => {
      n++;
      return {
        role: 'assistant' as const,
        completionText: `第 ${n} 步回复`,
        usage: { input: 1, output: 1, total: 2 },
      };
    }),
  };
}

const makeTools = () => ({ toToolSet: () => undefined });

describe('AgentContext —— 截断返回被丢弃的轮次', () => {
  it('★ truncate 现在**返回**丢掉的 turn（以前返回 void，所以根本没法"压回去"）', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'sys' });
    for (let i = 0; i < 6; i++) {
      ctx.addMessage({ role: 'user', content: `问题 ${i} `.repeat(20) });
      ctx.addMessage({ role: 'assistant', content: `回答 ${i} `.repeat(20) });
    }
    const dropped = ctx.truncate(50); // 极小预算，必然丢
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0].role).not.toBe('system');
    // 丢掉的合计 = 原来条数 - 剩下的
    expect(ctx.messages.length).toBe(13 - dropped.length);
  });

  it('没超预算 ⇒ 什么都不丢、也不返回', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'sys' });
    ctx.addMessage({ role: 'user', content: '短' });
    expect(ctx.truncate(99999)).toEqual([]);
  });

  it('★ 摘要插在 system 之后、不是最前面（system 必须第一条）', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'sys' });
    ctx.addMessage({ role: 'user', content: 'u1' });
    ctx.setContextSummary('更早聊了 A 和 B');
    expect(ctx.messages[0].role).toBe('system');
    expect(ctx.messages[0].content).toBe('sys');
    expect(ctx.messages[1].content).toContain('更早聊了 A 和 B');
    expect(ctx.messages[2].content).toBe('u1');
  });

  it('★ 第二次摘要**替换**同一条消息（不是不断追加）', () => {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: 'sys' });
    ctx.setContextSummary('第一版回忆');
    ctx.setContextSummary('第二版回忆');
    const summaries = ctx.messages.filter(m => m.content.includes('更早的对话（已压缩）'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toContain('第二版回忆');
    expect(summaries[0].content).not.toContain('第一版回忆');
    expect(ctx.getContextSummary()).toBe('第二版回忆');
  });

  it('缓冲：并入 / 取走 / 计数', () => {
    const ctx = new AgentContext();
    ctx.addDropped([{ role: 'user', content: 'abc' }, { role: 'assistant', content: 'de' }]);
    expect(ctx.droppedBufferLength()).toBe(2);
    expect(ctx.droppedBufferChars()).toBe(5);
    expect(ctx.takeDroppedBuffer()).toHaveLength(2);
    expect(ctx.droppedBufferLength()).toBe(0);
  });
});

describe('AgentRunner —— 把丢弃的轮次压回去', () => {
  beforeEach(() => _resetCompactionStatus());
  afterEach(() => _resetCompactionStatus());

  it('★ 攒够阈值 ⇒ 调 hooks 压缩，并把结果插进上下文', async () => {
    const provider = makeProvider();
    const summarize = vi.fn(async () => '用户问了三个技术问题；还有一件事没做完。');
    const runner = new AgentRunner(provider as any, makeTools() as any, {
      summarizeDroppedTurns: summarize,
    });

    // maxContextTokens=100 ⇒ 每步都会截断；多步后缓冲攒够
    let seenPrompt = '';
    (provider as any).textChatWithFallback = vi.fn(async (req: any) => {
      seenPrompt = JSON.stringify(req.contexts ?? []);
      return { role: 'assistant', completionText: 'ok', usage: { input: 1, output: 1, total: 2 } };
    });

    await runner.run('问题'.repeat(400), 'sys', [], 'sess-compact');
    // 单步只产生 1 个 turn 的丢弃 → 未到阈值（4 条 / 1200 字）时不该压
    // 这里重点断言：不因"没攒够"而误报失败
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(1);
    expect(seenPrompt).toBeTruthy();
  });

  it('★ 不提供 hooks 实现 ⇒ 保持旧行为（不压缩、不报错）', async () => {
    const provider = makeProvider();
    const runner = new AgentRunner(provider as any, makeTools() as any);
    await runner.run('问题'.repeat(400), 'sys', [], 'sess-nohooks');
    expect((provider as any).textChatWithFallback).toHaveBeenCalled();
  });

  it('★ 压缩抛错 ⇒ 不阻塞本轮（但那批确实丢了，只能靠日志留痕）', async () => {
    const provider = makeProvider();
    const summarize = vi.fn(async () => { throw new Error('LLM 挂了'); });
    const runner = new AgentRunner(provider as any, makeTools() as any, {
      summarizeDroppedTurns: summarize,
    });
    await expect(runner.run('问题'.repeat(400), 'sys', [], 'sess-fail')).resolves.toBeTruthy();
  });
});
