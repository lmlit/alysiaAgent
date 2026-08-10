// tests/pipeline/coalescer.test.ts — ★ 8-10 输入合并 + 打断（input-coalescing-and-abort）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageEvent } from '../../src/platform/event';
import { MessageType } from '../../src/platform/types';
import type { Message } from '../../src/platform/message';
import { CoalescerStage } from '../../src/pipeline/stages/coalescer';
import { AbortRegistry } from '../../src/pipeline/abort-registry';
import { AgentRunner } from '../../src/agent/runner';
import type { PipelineContext } from '../../src/pipeline/types';

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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('私聊首条消息缓冲不 yield（后续 stage 不执行），debounce 后 flush 单条', async () => {
    const stage = new CoalescerStage(undefined, { debounceMs: 1000, maxWaitMs: 5000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const ev = makeEvent('你好');
    const gen = stage.process(ev);
    const r = await gen.next();
    expect(r.done).toBe(true); // 不 yield → scheduler 不再跑后续 stage
    expect(put).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);
    const merged = put.mock.calls[0][0] as MessageEvent;
    expect(merged.messageStr).toBe('你好');
    expect(merged.getExtra('coalesced')).toBe(true);
  });

  it('连发 3 条 → 只 flush 1 次合并（换行拼接），EventBus 只收到 1 个合并事件', async () => {
    const stage = new CoalescerStage(undefined, { debounceMs: 1000, maxWaitMs: 5000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    for (const text of ['第一条', '第二条', '第三条']) {
      const gen = stage.process(makeEvent(text));
      expect((await gen.next()).done).toBe(true);
    }
    expect(put).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);
    const merged = put.mock.calls[0][0] as MessageEvent;
    expect(merged.messageStr).toBe('第一条\n第二条\n第三条');
    expect(merged.getExtra('coalesced')).toBe(true);
    // 合并事件无图片组件（纯文本，DeepSeek 只看描述）
    expect(merged.getMessages()).toHaveLength(1);
    expect(merged.getMessages()[0].type).toBe('plain');
  });

  it('涓流上限：新消息不断重置 debounce，maxWait 到点强制 flush', async () => {
    const stage = new CoalescerStage(undefined, { debounceMs: 1000, maxWaitMs: 2000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const texts = ['a', 'b', 'c'];
    for (let i = 0; i < texts.length; i++) {
      const gen = stage.process(makeEvent(texts[i]));
      await gen.next();
      await vi.advanceTimersByTimeAsync(500); // 每条间隔 500ms < debounce，窗口内持续重置
    }
    expect(put).not.toHaveBeenCalled(); // 600ms + 1100ms + 1600ms 均未到 debounce 终点

    await vi.advanceTimersByTimeAsync(500); // 2100ms > maxWait 2000ms → 强制 flush
    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0][0] as MessageEvent).messageStr).toBe('a\nb\nc');
  });

  it('群聊消息直接 yield（不合并不打断，逐条处理）', async () => {
    const stage = new CoalescerStage(undefined, { debounceMs: 1000, maxWaitMs: 5000 });
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
    const stage = new CoalescerStage(undefined, { debounceMs: 1000, maxWaitMs: 5000 });
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

  it('图片预热：flush 时 await pending 描述并拼入合并文本（描述前置）', async () => {
    const stage = new CoalescerStage(undefined, { debounceMs: 1000, maxWaitMs: 5000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    const ev = makeEvent('看看这张图');
    ev.setExtra('pending_image_descs', [
      Promise.resolve('一只橘猫在沙发上睡觉'),
    ]);
    const gen = stage.process(ev);
    await gen.next();

    await vi.advanceTimersByTimeAsync(1000);
    const merged = put.mock.calls[0][0] as MessageEvent;
    expect(merged.messageStr).toBe('[图片内容: 一只橘猫在沙发上睡觉]\n看看这张图');
  });

  it('新消息到达即 abort 在飞 controller（打断注册表）', async () => {
    const registry = new AbortRegistry();
    const stage = new CoalescerStage(registry, { debounceMs: 1000, maxWaitMs: 5000 });
    await stage.initialize(makeCtx());
    const put = vi.fn();
    stage.setEventBus({ put } as any);

    // 第一条消息入桶 → 模拟 llm-agent 取 controller（在飞请求）
    const gen1 = stage.process(makeEvent('第一条'));
    await gen1.next();
    const ctrl1 = registry.getOrCreate('t-1:private:private_owner');

    // 第二条消息到达 → 打断在飞
    const gen2 = stage.process(makeEvent('第二条'));
    await gen2.next();
    expect(ctrl1.signal.aborted).toBe(true);

    // 新 controller 可用（合并请求用）
    const ctrl2 = registry.getOrCreate('t-1:private:private_owner');
    expect(ctrl2.signal.aborted).toBe(false);
    expect(ctrl2).not.toBe(ctrl1);
  });
});

describe('AbortRegistry', () => {
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
});
