// ★ 2026-10-17 · change: add-project-task-delegation
//
// 委托任务四条路由 + 认领端点的 **HTTP 映射契约**。
//
// ★ **测试边界（写清楚，免得后人以为这里验了状态机）**：
//   本文件**只验路由的映射** —— 校验、状态码、拒绝原因、参数透传、鉴权。
//   状态机语义（去重 / 单并发 / 原子认领 / 超时回收 / 迟到回传）由
//   `packages/core/tests/memory/project-task-store.test.ts` 的 24 条用例覆盖。
//   ⇒ 这里**故意**用桩（canned outcome）而不是真库：
//     真库要 `better-sqlite3`，而它是 core 的依赖，server 包拿不到（pnpm 严格布局）。
//     在路由层再造一个「像 store 的东西」只会得到「用 mock 验 mock」的假安全感。
import { describe, it, expect, vi } from 'vitest';
import { createWebuiApp } from '../src/webui/server.js';

const PROJECTS = { 'alysia-blog': { workspace: '/root/alysia-blog', profile: 'alysia' } };

const TASK = {
  taskId: 'pt-1', requestKey: 'req-1', projectId: 'alysia-blog',
  originSessionId: 'qq:owner', origin: 'user', goal: '做一个关于我页面',
  acceptanceCriteria: '', dshSessionId: null, status: 'queued', revision: 0,
  result: null, artifacts: null, attempts: 0, lastError: null,
  createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z',
};

function makeHarness(overrides: Record<string, unknown> = {}) {
  const mm = {
    createProjectTask: vi.fn(() => ({ kind: 'created', task: TASK })),
    getProjectTask: vi.fn(() => TASK),
    claimNextProjectTask: vi.fn(() => TASK),
    addProjectTaskRevision: vi.fn(() => ({ ...TASK, status: 'queued', revision: 1, dshSessionId: 'session-abc' })),
    submitProjectTaskResult: vi.fn(() => ({ ...TASK, status: 'needs_review' })),
    ...overrides,
  };
  return { mm, core: { memoryManager: mm } };
}

async function buildApp(core: any, opts: Record<string, unknown> = {}) {
  const app = createWebuiApp(core, { requireAuth: false, projects: PROJECTS, ...opts } as never);
  await app.ready();
  return app;
}

const GOOD = {
  projectId: 'alysia-blog', goal: '做一个关于我页面', acceptanceCriteria: '能构建',
  requestKey: 'req-1', originSessionId: 'qq-official-1:private:owner',
};

describe('POST /api/project-tasks — 创建', () => {
  it('created → 200 + reason，并把参数**原样**透传给 core', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks', payload: GOOD });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('created');
    expect(res.json().task.taskId).toBe('pt-1');
    expect(h.mm.createProjectTask).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'alysia-blog',
      requestKey: 'req-1',
      goal: '做一个关于我页面',
      acceptanceCriteria: '能构建',
      origin: 'user',
    }));
  });

  it('deduped → 也是 200，但 reason 标出来（重试不是错误）', async () => {
    const h = makeHarness({ createProjectTask: () => ({ kind: 'deduped', task: TASK }) });
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks', payload: GOOD });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('deduped');
  });

  it('★ busy → 409 + reason=busy + **既有任务**（不是丢弃、也不是新建）', async () => {
    const h = makeHarness({ createProjectTask: () => ({ kind: 'busy', task: { ...TASK, status: 'running' } }) });
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks', payload: GOOD });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('busy');
    expect(res.json().task.taskId).toBe('pt-1');
    expect(res.json().error).toContain('pt-1');
  });

  it('★ 未知项目 → 400 且**列出已登记的项目**，且**不调用** core', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks', payload: { ...GOOD, projectId: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('alysia-blog');
    expect(h.mm.createProjectTask, '未知项目却把任务建出来了').not.toHaveBeenCalled();
  });

  it('★ 未配置任何项目 → 也是响亮拒绝（不是假装受理）', async () => {
    const app = await buildApp(makeHarness().core, { projects: {} });
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks', payload: GOOD });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('已登记：无');
  });

  it.each([
    ['缺 requestKey', { ...GOOD, requestKey: '  ' }, 'requestKey'],
    ['缺 goal', { ...GOOD, goal: '   ' }, 'goal'],
  ])('%s → 400（且不调用 core）', async (_l, payload, needle) => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(needle);
    expect(h.mm.createProjectTask).not.toHaveBeenCalled();
  });

  it('origin=delegated 会被透传（自主委托要能与用户指令区分）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    await app.inject({ method: 'POST', url: '/api/project-tasks', payload: { ...GOOD, origin: 'delegated' } });
    expect(h.mm.createProjectTask).toHaveBeenCalledWith(expect.objectContaining({ origin: 'delegated' }));
  });

  it('未知的 origin 值退化为 user（不把脏值写进库）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    await app.inject({ method: 'POST', url: '/api/project-tasks', payload: { ...GOOD, origin: 'root' } });
    expect(h.mm.createProjectTask).toHaveBeenCalledWith(expect.objectContaining({ origin: 'user' }));
  });
});

describe('GET /api/project-tasks/next — runner 认领', () => {
  it('★ 认领成功时**把项目配置一起下发**（runner 不必再读一份配置）', async () => {
    const app = await buildApp(makeHarness().core);
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next?projectId=alysia-blog' });
    expect(res.statusCode).toBe(200);
    expect(res.json().project).toEqual({ id: 'alysia-blog', workspace: '/root/alysia-blog', profile: 'alysia' });
    expect(res.json().task.taskId).toBe('pt-1');
  });

  it('★ 空闲 → { ok: true, task: null }（空转是常态，不是错误）', async () => {
    const h = makeHarness({ claimNextProjectTask: () => null });
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next?projectId=alysia-blog' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, task: null });
  });

  it('★ /next 不会被当成 :id（静态段优先）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    await app.inject({ method: 'GET', url: '/api/project-tasks/next?projectId=alysia-blog' });
    expect(h.mm.getProjectTask, '/next 落到 :id 路由了').not.toHaveBeenCalled();
  });

  it('未知项目 → 400，且不认领', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next?projectId=nope' });
    expect(res.statusCode).toBe(400);
    expect(h.mm.claimNextProjectTask).not.toHaveBeenCalled();
  });
});

describe('GET /api/project-tasks/:id — 查询', () => {
  it('查得到 / 查不到（404 且带 id）', async () => {
    const found = await buildApp(makeHarness().core);
    const ok = await found.inject({ method: 'GET', url: '/api/project-tasks/pt-1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().task.goal).toBe(TASK.goal);

    const missing = await buildApp(makeHarness({ getProjectTask: () => null }).core);
    const miss = await missing.inject({ method: 'GET', url: '/api/project-tasks/pt-nope' });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error).toContain('pt-nope');
  });
});

describe('POST /api/project-tasks/:id/revision — 提出修改意见', () => {
  it('★ 成功 → 返回新 revision（沿用工程会话由 core 保证）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks/pt-1/revision', payload: { feedback: '标题改短一点' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.revision).toBe(1);
    expect(h.mm.addProjectTaskRevision).toHaveBeenCalledWith('pt-1', '标题改短一点');
  });

  it('★ 在途（core 返回 null）→ 409，且**说清当前状态**', async () => {
    const h = makeHarness({
      getProjectTask: () => ({ ...TASK, status: 'running' }),
      addProjectTaskRevision: () => null,
    });
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks/pt-1/revision', payload: { feedback: '插一句' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('running');
  });

  it('未知任务 → 404；空 feedback → 400', async () => {
    const app = await buildApp(makeHarness({ getProjectTask: () => null }).core);
    expect((await app.inject({ method: 'POST', url: '/api/project-tasks/pt-x/revision', payload: { feedback: 'x' } })).statusCode).toBe(404);

    const h = makeHarness();
    const app2 = await buildApp(h.core);
    expect((await app2.inject({ method: 'POST', url: '/api/project-tasks/pt-1/revision', payload: { feedback: ' ' } })).statusCode).toBe(400);
    expect(h.mm.addProjectTaskRevision).not.toHaveBeenCalled();
  });
});

describe('POST /api/project-tasks/:id/result — runner 回传', () => {
  it('合法终态 → 200，并透传 dshSessionId / artifacts', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks/pt-1/result',
      payload: { status: 'needs_review', dshSessionId: 'session-1', artifacts: [{ path: 'about.html' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(h.mm.submitProjectTaskResult).toHaveBeenCalledWith('pt-1', expect.objectContaining({
      status: 'needs_review', dshSessionId: 'session-1', artifacts: [{ path: 'about.html' }],
    }));
  });

  it.each([['queued'], ['running'], [''], ['done']])(
    '★ 非法 status「%s」→ 400（queued/running 由服务端自己管）',
    async (bad) => {
      const h = makeHarness();
      const app = await buildApp(h.core);
      const res = await app.inject({ method: 'POST', url: '/api/project-tasks/pt-1/result', payload: { status: bad } });
      expect(res.statusCode).toBe(400);
      expect(h.mm.submitProjectTaskResult).not.toHaveBeenCalled();
    },
  );

  it('★★ 非 running（core 返回 null）→ 409（迟到的回传不许覆盖）', async () => {
    const h = makeHarness({ submitProjectTaskResult: () => null });
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks/pt-1/result', payload: { status: 'completed' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('running');
  });
});

describe('鉴权：新端点与既有端点同一套（不新开通道）', () => {
  it('requireAuth + 无 token → 全部 401', async () => {
    const app = await buildApp(makeHarness().core, { requireAuth: true, webuiToken: 'secret' });
    for (const [method, url] of [
      ['POST', '/api/project-tasks'],
      ['GET', '/api/project-tasks/next?projectId=alysia-blog'],
      ['GET', '/api/project-tasks/pt-1'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? GOOD : undefined });
      expect(res.statusCode, `${method} ${url} 没被鉴权挡住`).toBe(401);
    }
  });

  it('带对 token → 放行', async () => {
    const app = await buildApp(makeHarness().core, { requireAuth: true, webuiToken: 'secret' });
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks', payload: GOOD, headers: { authorization: 'Bearer secret' },
    });
    expect(res.statusCode).toBe(200);
  });
});
