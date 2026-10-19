/**
 * 异步唤醒的**路由契约**（★ change: `wake-her-on-task-result`）。
 *
 * 三件事：
 *   1. `/result` 落库 + **入队**（不再直接推送）；
 *   2. `/accept` 是她的验收入口（与执行方的 `/result` 分开）；
 *   3. runner 令牌的**端点白名单**（后台执行体不该握管理面）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createWebuiApp, isRunnerAllowed } from '../src/webui/server.js';

const PROJECTS = {
  'alysia-toys': {
    workspace: '/srv/toys',
    profile: 'alysia',
    publicUrl: 'http://example.test:3389/p/alysia-toys/',
  },
};

const TASK = {
  taskId: 'pt-1',
  requestKey: 'req-1',
  projectId: 'alysia-toys',
  originSessionId: 'qq-official-1:private:private_ABC123DEF',
  origin: 'delegated',
  kind: 'build',
  goal: '改成夜晚的',
  originalGoal: '做一个月光花园',
  acceptanceCriteria: '能打开',
  dshSessionId: 'session-1',
  status: 'running',
  revision: 0,
  result: null,
  artifacts: null,
  attempts: 1,
  lastError: null,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
};

function harness(overrides: Record<string, unknown> = {}) {
  const mm = {
    getProjectTask: vi.fn(() => TASK),
    submitProjectTaskResult: vi.fn(() => ({ ...TASK, status: 'needs_review' })),
    acceptProjectTask: vi.fn(() => ({ task: { ...TASK, status: 'completed' }, accepted: true })),
    recordProjectTaskResult: vi.fn(async () => true),
    composeProjectTaskNotice: vi.fn(async () => '好了'),
    ...overrides,
  };
  const push = { available: true, sendProactive: vi.fn(async () => true) };
  return { mm, push, core: { memoryManager: mm } };
}

async function buildApp(core: any, opts: Record<string, unknown> = {}) {
  const app = createWebuiApp(core, { requireAuth: false, projects: PROJECTS, ...opts } as never);
  await app.ready();
  return app;
}

describe('/result —— 落库 + 入队（唤醒开着）', () => {
  it('把结果事件交给 core（同事务），并**不再**直接推送', async () => {
    const h = harness();
    const app = await buildApp(h.core, { push: h.push });
    const res = await app.inject({
      method: 'POST',
      url: '/api/project-tasks/pt-1/result',
      payload: {
        status: 'needs_review',
        claimToken: 1,
        result: { final: '做完了', roundStartedAt: Date.now() - 1000 },
        artifacts: [{ path: 'moon.html', url: 'http://example.test:3389/w/alysia-toys/moon.html', mtime: Date.now() }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().eventId).toBe('pt-1:r0:result');

    const call = h.mm.submitProjectTaskResult.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(call[0]).toBe('pt-1');
    expect(call[1].claimToken).toBe(1);
    expect(call[1].event, '结果没入队 —— 崩溃就丢').toBeTruthy();
    expect(call[1].event.eventId).toBe('pt-1:r0:result');
    expect(call[1].event.payload.originalGoal).toBe('做一个月光花园');
    expect(call[1].event.payload.currentRequirement).toBe('改成夜晚的');
    expect(call[1].event.payload.evidence.fresh).toBe(true);

    // 唤醒路径下不许再走旧的一次性通知（否则同一结果两套汇报）
    await new Promise(r => setTimeout(r, 20));
    expect(h.mm.composeProjectTaskNotice).not.toHaveBeenCalled();
    expect(h.push.sendProactive).not.toHaveBeenCalled();
  });

  it('旧文件（mtime 早于本轮）→ evidence.fresh=false（不许当成功证据）', async () => {
    const h = harness();
    const app = await buildApp(h.core, { push: h.push });
    await app.inject({
      method: 'POST',
      url: '/api/project-tasks/pt-1/result',
      payload: {
        status: 'needs_review',
        result: { final: '做完了', roundStartedAt: Date.now() },
        artifacts: [{ path: 'old.html', mtime: Date.now() - 86_400_000 }],
      },
    });
    const call = h.mm.submitProjectTaskResult.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(call[1].event.payload.evidence.fresh).toBe(false);
  });
});

describe('/accept —— 她的验收入口', () => {
  it('成功 → 200 + completed', async () => {
    const h = harness();
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks/pt-1/accept', payload: { revision: 0, note: '这版像她' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe('completed');
    expect(h.mm.acceptProjectTask).toHaveBeenCalledWith('pt-1', expect.objectContaining({ revision: 0 }));
  });

  it('版本不对/不在待验收 → 409 + 原因（不冒充成功）', async () => {
    const h = harness({
      acceptProjectTask: vi.fn(() => ({ task: TASK, accepted: false, reason: '版本对不上' })),
    });
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks/pt-1/accept', payload: { revision: 3 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('版本对不上');
  });

  it('revision 缺失 → 400', async () => {
    const app = await buildApp(harness().core);
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks/pt-1/accept', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('runner 令牌白名单', () => {
  it('允许：记忆回传 / 人设 / 召回 / 结算 / 任务 / 页面清单 / 看图', () => {
    expect(isRunnerAllowed('POST', '/api/ingest')).toBe(true);
    expect(isRunnerAllowed('GET', '/api/persona/prompt')).toBe(true);
    expect(isRunnerAllowed('POST', '/api/memory/read')).toBe(true);
    expect(isRunnerAllowed('POST', '/api/sessions/dsh%3Asession-1/extract')).toBe(true);
    expect(isRunnerAllowed('GET', '/api/project-tasks/next')).toBe(true);
    expect(isRunnerAllowed('POST', '/api/project-tasks/pt-1/result')).toBe(true);
    expect(isRunnerAllowed('POST', '/api/host/pages')).toBe(true);
    expect(isRunnerAllowed('POST', '/api/vision/describe')).toBe(true);
  });

  it('拒绝：管理面（角色/知识库/隐私/人格调整/生活写操作）', () => {
    expect(isRunnerAllowed('POST', '/api/roles/import')).toBe(false);
    expect(isRunnerAllowed('DELETE', '/api/knowledge/1')).toBe(false);
    expect(isRunnerAllowed('POST', '/api/privacy')).toBe(false);
    expect(isRunnerAllowed('POST', '/api/persona/adjust')).toBe(false);
    expect(isRunnerAllowed('GET', '/api/sessions')).toBe(false);
    expect(isRunnerAllowed('POST', '/api/sessions/abc/extract/extra')).toBe(false);
  });

  it('真的走到钩子：runner 令牌调管理端点 → 403（不是 401）', async () => {
    const app = await buildApp(harness().core, {
      requireAuth: true,
      webuiToken: 'admin-token',
      runnerToken: 'runner-token',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/roles/import',
      headers: { authorization: 'Bearer runner-token' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('白名单');
  });

  it('runner 令牌调白名单端点 → 不 401/403', async () => {
    const app = await buildApp(harness().core, {
      requireAuth: true,
      webuiToken: 'admin-token',
      runnerToken: 'runner-token',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/project-tasks/window',
      headers: { authorization: 'Bearer runner-token' },
    });
    expect(res.statusCode).toBe(200);
  });
});
