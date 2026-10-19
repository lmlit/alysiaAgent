/**
 * 异步唤醒调度器单测（★ change: `wake-her-on-task-result`）。
 *
 * 测的是**调度语义**，不是模型行为（那部分由真机验收）：
 *   领取 → 版本核对 → 目标核对 → 跑一轮 → ack / 退避重试。
 * 每条都带反向守卫：过期结果不许唤起、群会话不许推、发不出去必须留痕。
 */
import { describe, it, expect, vi } from 'vitest';
import { MessageChain } from '@alysia/core/platform';
import { SubagentWake, parseReplyTarget } from '../src/subagent-dispatch.js';

const PAYLOAD = {
  eventId: 'pt-1:r0:result',
  taskId: 'pt-1',
  projectId: 'alysia-toys',
  revision: 0,
  kind: 'result' as const,
  status: 'needs_review',
  outcome: 'succeeded' as const,
  conversationId: 'qq-official-1:private:private_ABCDEF123456',
  originalGoal: '做一个月光花园',
  currentRequirement: '做一个月光花园',
  artifacts: [{ path: 'moon.html', url: 'http://s:3389/w/x/moon.html', mtime: Date.now() }],
  evidence: { fresh: true, pageVerified: true, pageUrl: 'http://s:3389/w/x/moon.html' },
  autoRework: { used: 0, max: 2 },
  createdAt: new Date().toISOString(),
};

const EVENT = {
  eventId: 'pt-1:r0:result',
  taskId: 'pt-1',
  projectId: 'alysia-toys',
  revision: 0,
  kind: 'result',
  status: 'claimed' as const,
  payload: PAYLOAD,
  attempts: 1,
  nextAt: '',
  claimedAt: new Date().toISOString(),
  processedAt: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const TASK = {
  taskId: 'pt-1',
  projectId: 'alysia-toys',
  revision: 0,
  status: 'needs_review',
  originSessionId: PAYLOAD.conversationId,
  dshSessionId: 'session-1',
};

function makeDeps(overrides: {
  event?: unknown;
  task?: unknown;
  push?: { available: boolean; sendProactive: ReturnType<typeof vi.fn> };
  execute?: (ev: any) => Promise<void>;
} = {}) {
  const mm = {
    claimNextProjectTaskEvent: vi.fn(() => overrides.event === undefined ? EVENT : overrides.event),
    getProjectTask: vi.fn(() => (overrides.task === undefined ? TASK : overrides.task)),
    finishProjectTaskEvent: vi.fn(() => true),
    failProjectTaskEvent: vi.fn(() => null),
    markProjectTaskNotified: vi.fn(),
    recordProjectTaskResult: vi.fn(async () => true),
    countProjectTaskEventsByStatus: vi.fn(() => ({ pending: 0 })),
  };
  const push = overrides.push ?? { available: true, sendProactive: vi.fn(async () => true) };
  const execute = overrides.execute ?? (async (ev: any) => {
    await ev.send(new MessageChain().message('我看了，这版可以，给你留着了。'));
  });
  const scheduler = { execute: vi.fn(execute) };
  return {
    mm,
    push,
    core: { memoryManager: mm, scheduler } as unknown as never,
  };
}

const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeWake(deps: ReturnType<typeof makeDeps>, over = {}) {
  return new SubagentWake(
    { core: deps.core, push: deps.push as never, log: quietLog as never },
    { enabled: true, intervalMs: 1000, turnTimeoutMs: 60_000, ...over },
  );
}

describe('parseReplyTarget（只认 QQ 私聊）', () => {
  it('三段式真实会话 → 平台 + 会话 + openid', () => {
    expect(parseReplyTarget('qq-official-1:private:private_ABCDEF123456')).toEqual({
      platformName: 'qq-official-1',
      sessionId: 'private_ABCDEF123456',
      openid: 'ABCDEF123456',
    });
  });

  it('群会话 / webui / 缺段 → null（不猜目标）', () => {
    expect(parseReplyTarget('qq-official-1:group:group_ABCDEF123456')).toBeNull();
    expect(parseReplyTarget('webui:private:abc')).toBeNull();
    expect(parseReplyTarget('qq-official-1:private')).toBeNull();
  });
});

describe('tick —— 正常一轮', () => {
  it('领取 → 记进记忆 → 跑完整管线 → 发出 → 标已通知 + ack', async () => {
    const deps = makeDeps();
    const wake = makeWake(deps);
    expect(await wake.tick()).toBe(true);

    // ① 记进她的记忆（role=engine 的那条，幂等 id 固定）
    expect(deps.mm.recordProjectTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'pt-1', status: 'needs_review', revision: 0 }),
    );
    // ② 跑的是**主 Agent 管线**（不是一次性补全）：scheduler.execute 被调用，且输入被标成工具结果
    const ev = deps.core.scheduler.execute.mock.calls[0][0] as any;
    expect(ev.getExtra('subagent_result')).toBeTruthy();
    expect(ev.messageStr).toContain('不是用户说的话');
    expect(ev.unifiedMsgOrigin).toBe(PAYLOAD.conversationId);
    // ③ 发出去了（她自己那句话，不是模板）
    expect(deps.push.sendProactive).toHaveBeenCalledWith('ABCDEF123456', '我看了，这版可以，给你留着了。');
    // ④ 状态：通知时间 + ack
    expect(deps.mm.markProjectTaskNotified).toHaveBeenCalledWith('pt-1');
    expect(deps.mm.finishProjectTaskEvent).toHaveBeenCalledWith('pt-1:r0:result');
  });

  it('队列空 → 什么都不做（空闲是常态）', async () => {
    const deps = makeDeps({ event: null });
    expect(await makeWake(deps).tick()).toBe(false);
    expect(deps.core.scheduler.execute).not.toHaveBeenCalled();
  });
});

describe('tick —— 过期结果不许覆盖新需求', () => {
  it('任务已经进到第 2 轮 → 直接 ack，不唤起她', async () => {
    const deps = makeDeps({ task: { ...TASK, revision: 1, status: 'running' } });
    expect(await makeWake(deps).tick()).toBe(false);
    expect(deps.core.scheduler.execute, '旧版本的结果把她叫醒了').not.toHaveBeenCalled();
    expect(deps.mm.finishProjectTaskEvent).toHaveBeenCalledWith('pt-1:r0:result');
  });
});

describe('tick —— 没有目标就不猜', () => {
  it('非 QQ 私聊会话 → 只留痕 + ack，不发消息', async () => {
    const deps = makeDeps({
      event: { ...EVENT, payload: { ...PAYLOAD, conversationId: 'webui:private:abc' } },
      task: { ...TASK, originSessionId: 'webui:private:abc' },
    });
    expect(await makeWake(deps).tick()).toBe(false);
    expect(deps.push.sendProactive).not.toHaveBeenCalled();
    expect(deps.mm.finishProjectTaskEvent).toHaveBeenCalled();
  });

  it('没有推送通道 → 只记进记忆（不假装送达）', async () => {
    const deps = makeDeps({ push: { available: false, sendProactive: vi.fn() } });
    expect(await makeWake(deps).tick()).toBe(false);
    expect(deps.mm.finishProjectTaskEvent).toHaveBeenCalled();
  });
});

describe('tick —— 发不出去必须留痕并重试', () => {
  it('通道返回 false → fail（退避重试），不 ack', async () => {
    const deps = makeDeps({ push: { available: true, sendProactive: vi.fn(async () => false) } });
    const wake = makeWake(deps, { sendRetries: 0 });
    expect(await wake.tick()).toBe(true);
    expect(deps.mm.failProjectTaskEvent).toHaveBeenCalledWith('pt-1:r0:result', expect.stringContaining('false'));
    expect(deps.mm.finishProjectTaskEvent).not.toHaveBeenCalled();
    expect(deps.mm.markProjectTaskNotified).not.toHaveBeenCalled();
  });

  it('send 抛错 → fail，错误信息带上（不许静默吞）', async () => {
    const deps = makeDeps({
      push: { available: true, sendProactive: vi.fn(async () => { throw new Error('QQ 401'); }) },
    });
    const wake = makeWake(deps, { sendRetries: 0 });
    await wake.tick();
    expect(deps.mm.failProjectTaskEvent).toHaveBeenCalledWith('pt-1:r0:result', expect.stringContaining('QQ 401'));
  });

  it('管线抛错 → fail（不是静默成功）', async () => {
    const deps = makeDeps({ execute: async () => { throw new Error('provider down'); } });
    await makeWake(deps).tick();
    expect(deps.mm.failProjectTaskEvent).toHaveBeenCalledWith(
      'pt-1:r0:result',
      expect.stringContaining('provider down'),
    );
  });

  it('她这一轮没说话（空回复）→ fail，不当成送达', async () => {
    const deps = makeDeps({ execute: async (ev: any) => { await ev.send(new MessageChain().message('   ')); } });
    await makeWake(deps).tick();
    expect(deps.mm.failProjectTaskEvent).toHaveBeenCalled();
  });
});
