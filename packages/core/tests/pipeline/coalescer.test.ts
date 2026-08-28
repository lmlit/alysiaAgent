// tests/pipeline/coalescer.test.ts — ★ 8-10 输入合并 + 打断（input-coalescing-and-abort）
// 8-10 修订行为：首条立即放行（无窗口延迟），新消息打断在飞 + 累计合并，回复已出则独立放行
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageEvent } from '../../src/platform/event';
import { MessageType } from '../../src/platform/types';
import type { Message } from '../../src/platform/message';
import { CoalescerStage } from '../../src/pipeline/stages/coalescer';
import { AbortRegistry } from '../../src/pipeline/abort-registry';
import { AgentRunner } from '../../src/agent/runner';
import type { PipelineContext } from '../../src/pipeline/types';

const SESSION = 't-1:private:private_owner';

function makeEvent(text: string, type: MessageType = MessageType.PRIVATE): MessageEvent {
  const message: Message = {
    sessionId: type === MessageType.PRIVATE ? 'private_owner' : 'group_123',
    groupId: type === MessageType.PRIVATE ? '' : 'group_123',
    sender: { userId: 'u1', nickname: '轻月' },
    messageId: `m-${text}`,
    type,
    content: [{ type: 'plain', text }],
    raw: {},
  };
  return new MessageEvent({
    messageStr: text,
    messageObj: message,
    platformMeta: { id: 't-1', name: 'test', description: '' },
    sessionId: message.sessionId,
  });
}

function makeCtx(): PipelineContext {
  return {
    memoryManager: undefined!,
    providerManager: undefined!,
    toolRegistry: undefined!,
    commandRegistry: undefined!,
    config: undefined!,
  } as PipelineContext;
}

describe('CoalescerStage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('首条消息立即放行（yield，不等窗口），回复未出时新消息打断在飞并累计', async () => {
    const stage = new CoalescerStage(undefined, { maxWaitMs: 10_000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    // 首条：无在飞 → yield（后续 stage 立即跑，LLM 请求即刻发出）
    const gen1 = stage.process(makeEvent('第一条'));
    const r1 = await gen1.next();
    expect(r1.done).toBe(false); // yield = 立即放行
    expect(put).not.toHaveBeenCalled();

    // 模拟 llm-agent 已在飞（取 controller）
    const registry = stage.getAbortRegistry();
    const ctrl = registry.getOrCreate(SESSION);
    expect(registry.isInFlight(SESSION)).toBe(true);

    // 第二条：回复未出 → 打断 + 缓冲（不 yield），不立即 put
    const gen2 = stage.process(makeEvent('第二条'));
    const r2 = await gen2.next();
    expect(r2.done).toBe(true); // 不 yield（等合并）
    expect(ctrl.signal.aborted).toBe(true);
    expect(put).not.toHaveBeenCalled();
    expect(registry.isInFlight(SESSION)).toBe(false);
  });

  it('被打断的生成结束（onGenerationAborted）→ 即时 flush 合并事件（含被打断文本）', async () => {
    const stage = new CoalescerStage(undefined, { maxWaitMs: 10_000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const gen1 = stage.process(makeEvent('第一条'));
    await gen1.next();
    const registry = stage.getAbortRegistry();
    registry.getOrCreate(SESSION);

    const gen2 = stage.process(makeEvent('第二条'));
    await gen2.next();

    // 模拟 llm-agent：第一条生成被打断 → 回调 onGenerationAborted
    const abortedEvent = makeEvent('第一条'); // 被打断事件（llm-agent 传入）
    const customSend = vi.fn(); // 模拟 adapter 挂的实例 send 回调
    abortedEvent.send = customSend;
    await stage.onGenerationAborted(SESSION, abortedEvent);

    expect(put).toHaveBeenCalledTimes(1);
    const merged = put.mock.calls[0][0] as MessageEvent;
    expect(merged.messageStr).toBe('第一条\n第二条'); // 被打断文本 + 累计消息
    expect(merged.getExtra('coalesced')).toBe(true);
    expect(merged.getMessages()[0].type).toBe('plain');

    // ★ 8-10 合并事件必须继承原事件 send（adapter 回调闭包）——否则回复静默丢失
    expect(merged.send).toBe(customSend);
  });

  it('回复已出（无在飞）→ 新消息独立放行（不合并）', async () => {
    const stage = new CoalescerStage(undefined, { maxWaitMs: 10_000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const gen1 = stage.process(makeEvent('第一条'));
    await gen1.next();
    // 第一条请求正常完成（release）→ 无在飞
    stage.getAbortRegistry().release(SESSION);

    const gen2 = stage.process(makeEvent('第二条'));
    const r2 = await gen2.next();
    expect(r2.done).toBe(false); // 直接放行，独立请求
    expect(put).not.toHaveBeenCalled();
  });

  it('打断累计：多次打断后合并文本包含全部消息（没有回复就能累计）', async () => {
    const stage = new CoalescerStage(undefined, { maxWaitMs: 10_000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    // 首条放行 → 在飞
    const gen1 = stage.process(makeEvent('m1'));
    await gen1.next();
    stage.getAbortRegistry().getOrCreate(SESSION);

    // m2 打断 → 累计
    const gen2 = stage.process(makeEvent('m2'));
    await gen2.next();
    await stage.onGenerationAborted(SESSION, makeEvent('m1'));
    const merged1 = put.mock.calls[0][0] as MessageEvent;
    expect(merged1.messageStr).toBe('m1\nm2');

    // 合并事件重入 → 放行（coalesced）→ 在飞
    const gen3 = stage.process(merged1);
    await gen3.next();
    const ctrl2 = stage.getAbortRegistry().getOrCreate(SESSION);

    // m3 再打断 → 累计 → 合并 = 前次合并文本 + m3
    const gen4 = stage.process(makeEvent('m3'));
    await gen4.next();
    expect(ctrl2.signal.aborted).toBe(true);
    await stage.onGenerationAborted(SESSION, merged1);
    const merged2 = put.mock.calls[1][0] as MessageEvent;
    expect(merged2.messageStr).toBe('m1\nm2\nm3');
  });

  it('群聊消息直接 yield（不合并不打断，逐条处理）', async () => {
    const stage = new CoalescerStage(undefined, { maxWaitMs: 10_000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const ev = makeEvent('群聊消息', MessageType.GROUP);
    const gen = stage.process(ev);
    const r = await gen.next();
    expect(r.done).toBe(false); // yield → scheduler 继续后续 stage
    await gen.next();
    expect(put).not.toHaveBeenCalled();
  });

  it('合并事件（coalesced 标记）直接放行不再次缓冲', async () => {
    const stage = new CoalescerStage(undefined, { maxWaitMs: 10_000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const ev = makeEvent('合并文本');
    ev.setExtra('coalesced', true);
    const gen = stage.process(ev);
    const r = await gen.next();
    expect(r.done).toBe(false); // yield 放行
    expect(put).not.toHaveBeenCalled();
  });

  it('图片预热：flush 时 await 被打断事件 + 累计消息的 pending 描述并前置拼接', async () => {
    const stage = new CoalescerStage(undefined, { maxWaitMs: 10_000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const gen1 = stage.process(makeEvent('看看这张图'));
    await gen1.next();
    stage.getAbortRegistry().getOrCreate(SESSION);

    const ev2 = makeEvent('还有这张');
    ev2.setExtra('pending_image_descs', [Promise.resolve('一只橘猫在沙发上睡觉')]);
    const gen2 = stage.process(ev2);
    await gen2.next();

    const aborted = makeEvent('看看这张图');
    aborted.setExtra('pending_image_descs', [Promise.resolve('一张夕阳照片')]);
    await stage.onGenerationAborted(SESSION, aborted);

    const merged = put.mock.calls[0][0] as MessageEvent;
    expect(merged.messageStr).toBe(
      '[图片内容: 一张夕阳照片]\n[图片内容: 一只橘猫在沙发上睡觉]\n看看这张图\n还有这张',
    );
  });

  it('兜底上限：onGenerationAborted 未触发时 maxWait 到点强制 flush（用 in-flight 基底）', async () => {
    vi.useFakeTimers();
    const stage = new CoalescerStage(undefined, { maxWaitMs: 1000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const gen1 = stage.process(makeEvent('第一条'));
    await gen1.next();
    stage.getAbortRegistry().getOrCreate(SESSION);

    const gen2 = stage.process(makeEvent('第二条'));
    await gen2.next();
    expect(put).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1100); // capTimer 到点
    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0][0] as MessageEvent).messageStr).toBe('第一条\n第二条');
  });

  // ★ 8-28 思考中提示已移除（remove-thinking-indicator），cancel_thinking 测试随之删除

  it('无累计消息时 onGenerationAborted 不产生合并事件', async () => {
    const stage = new CoalescerStage(undefined, { maxWaitMs: 10_000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const gen1 = stage.process(makeEvent('第一条'));
    await gen1.next();
    stage.getAbortRegistry().getOrCreate(SESSION);

    // 被打断但没有新消息累计 → 无桶 → 不 flush
    await stage.onGenerationAborted(SESSION, makeEvent('第一条'));
    expect(put).not.toHaveBeenCalled();
  });
});

describe('AbortRegistry', () => {
  it('isInFlight：controller 存在且未 abort 才为 true', () => {
    const r = new AbortRegistry();
    expect(r.isInFlight('s1')).toBe(false);
    const ctrl = r.getOrCreate('s1');
    expect(r.isInFlight('s1')).toBe(true);
    r.abort('s1');
    expect(r.isInFlight('s1')).toBe(false);
  });

  it('release 不 abort 只清理', () => {
    const r = new AbortRegistry();
    const ctrl = r.getOrCreate('s1');
    r.release('s1');
    expect(ctrl.signal.aborted).toBe(false);
    expect(r.getOrCreate('s1')).not.toBe(ctrl);
  });
});

describe('AgentRunner abort', () => {
  it('signal 已 aborted → 返回 aborted 标记（不产回复）', async () => {
    const providerManager = {
      textChatWithFallback: vi.fn().mockResolvedValue({ role: 'assistant', completionText: '不会走到这' }),
    };
    const toolRegistry = { toToolSet: () => undefined, execute: vi.fn() };
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const ctrl = new AbortController();
    ctrl.abort();
    const result = await runner.run('hi', 'sys', [], 's1', undefined, ctrl.signal);
    expect(result.aborted).toBe(true);
    expect(result.chain.getComponents()).toHaveLength(0);
    expect(providerManager.textChatWithFallback).not.toHaveBeenCalled();
  });

  // ★ 8-10 竞态修复（coalescer-abort-race-fix）：fetch 已 resolve（回复文本已产出），
  //   但返回前 signal 才被 abort → 必须返回 aborted 丢弃文本，否则与合并重发双重回复
  it('fetch 已 resolve 但返回前 signal 被 abort → 返回 aborted（丢弃已产出文本）', async () => {
    const ctrl = new AbortController();
    const providerManager = {
      getDefault: () => undefined,
      textChatWithFallback: vi.fn().mockImplementation(async () => {
        ctrl.abort(); // 模拟：LLM 响应完整返回的瞬间，新消息打断
        return { role: 'assistant', completionText: '这是回复 A（不应发送）' };
      }),
    };
    const toolRegistry = { toToolSet: () => undefined, execute: vi.fn() };
    const runner = new AgentRunner(providerManager as any, toolRegistry as any);

    const result = await runner.run('hi', 'sys', [], 's1', undefined, ctrl.signal);
    expect(result.aborted).toBe(true);
    expect(result.chain.getComponents()).toHaveLength(0); // 已产出文本被丢弃
    expect(providerManager.textChatWithFallback).toHaveBeenCalledTimes(1); // 请求确实发出过
  });
});
