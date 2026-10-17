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

const PROJECTS = { 'alysia-blog': { workspace: '/srv/blog', profile: 'alysia', publicUrl: 'http://example.test:3389/' } };

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
    /** ★ 2026-10-18（return-project-task-result）：结果回送原会话 */
    recordProjectTaskResult: vi.fn(async () => true),
    /** 让**她自己**说那句话（失败回落模板） */
    composeProjectTaskNotice: vi.fn(async () => '页面弄好啦，你看看顺不顺眼～'),
    /** ★ 2026-10-18：不指定项目时，由服务端挑"还有活的最老的项目" */
    nextQueuedProject: vi.fn(() => 'alysia-blog'),
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

/** 让 `void notifyProjectTaskResult(...)` 里的微任务跑完 */
const flush = () => new Promise((r) => setTimeout(r, 20));

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
    expect(res.json().project).toEqual({
      id: 'alysia-blog',
      workspace: '/srv/blog',
      profile: 'alysia',
      // ★ 2026-10-18：地址也随认领下发（runner / 回执都用得上）
      publicUrl: 'http://example.test:3389/',
    });
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

// ─────────────────────────────────────────────────────────────
// ★ 2026-10-18（change: `return-project-task-result`）
//   「结果回送原会话」两件事：① 记进记忆（她下次自然知道）② 主动推一条（QQ，有配额）
//   两条都必须**不能**反过来影响任务状态 —— 通知是增值项。
// ─────────────────────────────────────────────────────────────
describe('★ 结果回送原会话（return-project-task-result）', () => {
  const QQ_TASK = { ...TASK, originSessionId: 'qq-official-1:private_ABC123DEF' };

  async function postResult(
    task: Record<string, unknown> = QQ_TASK,
    mmOverrides: Record<string, unknown> = {},
    opts: Record<string, unknown> = {},
  ) {
    const h = makeHarness({
      submitProjectTaskResult: () => ({ ...task, status: 'needs_review', result: { final: '页面做好了' } }),
      ...mmOverrides,
    });
    const app = await buildApp(h.core, { push: h.push, ...opts });
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks/pt-1/result', payload: { status: 'needs_review' },
    });
    await flush();
    return { h, res };
  }

  it('★ 回传后 → 把结果记进**发起它的那个会话**（参数对得上）', async () => {
    const { h } = await postResult();
    expect(h.mm.recordProjectTaskResult).toHaveBeenCalledTimes(1);
    expect(h.mm.recordProjectTaskResult).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'pt-1',
      projectId: 'alysia-blog',
      revision: 0,
      status: 'needs_review',
      originSessionId: 'qq-official-1:private_ABC123DEF',
      summary: '页面做好了',
    }));
  });

  it('★ QQ 私聊会话 → 主动推送一次，openid 取得对', async () => {
    const { h } = await postResult();
    expect(h.push.sendProactive).toHaveBeenCalledTimes(1);
    const [openid, text] = h.push.sendProactive.mock.calls[0] as unknown as [string, string];
    expect(openid).toBe('ABC123DEF');
    // ★ 正文是**她的话**（notice），不是模板 —— 模板只在回落时出现
    expect(text).toBe('页面弄好啦，你看看顺不顺眼～');
  });

  // ★ 2026-10-18 真机踩到的 bug：真实会话 id 是**三段** `qq-official-1:private:private_<openid>`，
  //   旧正则最左匹配会把 `private_` 一起captured ⇒ QQ 返回 11255「请求的资源不存在」。
  it('★★ 三段式真实会话 id → openid 只取最后一段的前缀之后（不许带 private_）', async () => {
    const { h } = await postResult({ ...TASK, originSessionId: 'qq-official-1:private:private_ABC123DEF' });
    const [openid] = h.push.sendProactive.mock.calls[0] as unknown as [string, string];
    expect(openid, 'openid 多带了 private_ 前缀 → QQ 会报 11255').toBe('ABC123DEF');
  });

  it('★ 回执里带上**对外地址**（真机上用户问过「给我链接」，她答「我没存下地址」）', async () => {
    const { h } = await postResult();
    // 地址由**配置**提供、经 core 的 finalizeNotice 兜底逐字注入（core 单测覆盖）；
    // 路由层的责任是把 publicUrl 传下去。
    expect(h.mm.recordProjectTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({ publicUrl: 'http://example.test:3389/' }),
    );
    expect(h.mm.composeProjectTaskNotice).toHaveBeenCalledWith(
      expect.objectContaining({ publicUrl: 'http://example.test:3389/' }),
    );
  });

  // ★ 2026-10-18 真机撞出来的第二件事：QQ 实现会把「>60 字或含换行」的文本自动分段
  //   （≤3 段 —— 那是为"她说话像打字"设计的）。任务通知是**一条事**，必须传 maxSegments=1，
  //   否则用户会收到 3 条碎片消息。
  it('★★ 通知必须传 maxSegments=1（否则长文案被拆成 3 条 QQ 消息）', async () => {
    const { h } = await postResult();
    const call = h.push.sendProactive.mock.calls[0] as unknown as [string, string, { maxSegments?: number }?];
    expect(call[2]).toEqual({ maxSegments: 1 });
  });

  // ★ 用户原话「感觉好干啊，而且没有昔涟的味道」：
  //   这条事件是 role:assistant，等于"她说的话" ⇒ 必须让她自己说一遍，模板只做回落。
  it('★★ 用她自己的措辞（不是模板腔）同时落库与推送', async () => {
    const { h } = await postResult();
    expect(h.mm.composeProjectTaskNotice).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'alysia-blog', status: 'needs_review' }),
    );
    // 落库的那条要带上她的措辞
    expect(h.mm.recordProjectTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({ notice: '页面弄好啦，你看看顺不顺眼～' }),
    );
    // 推送的那条也是她的话，而不是"委托任务结束了：…"
    const [, text] = h.push.sendProactive.mock.calls[0] as unknown as [string, string];
    expect(text).toBe('页面弄好啦，你看看顺不顺眼～');
    expect(text).not.toContain('委托任务结束了');
  });

  it('★ 措辞生成失败 → 回落模板，但**照样**记回与推送（不许因此丢通知）', async () => {
    const { h } = await postResult(QQ_TASK, {
      composeProjectTaskNotice: vi.fn(async () => { throw new Error('llm 挂了'); }),
    });
    // 回落时**不带** notice 键（不是 notice: undefined —— 那是"有值但空"）
    const arg = (h.mm.recordProjectTaskResult.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(arg).not.toHaveProperty('notice');
    expect(arg).toEqual(expect.objectContaining({ taskId: 'pt-1', status: 'needs_review' }));
    const [, text] = h.push.sendProactive.mock.calls[0] as unknown as [string, string];
    expect(text).toContain('委托任务结束了'); // 回落口径：干，但诚实
    expect(text).toContain('http://example.test:3389/');
  });

  it('★ 非 QQ 会话（webui / 测试会话）→ **不推送**（不猜目标）', async () => {
    const { h } = await postResult({ ...TASK, originSessionId: 'webui:private:console' });
    expect(h.push.sendProactive, '往非 QQ 会话硬推了').not.toHaveBeenCalled();
  });

  it('★ 没有推送通道（桌面端）→ 不推、也不报错', async () => {
    const { h, res } = await postResult(QQ_TASK, {}, { push: { available: false, sendProactive: vi.fn() } });
    expect(res.statusCode).toBe(200);
    expect(h.push.sendProactive).not.toHaveBeenCalled();
  });

  it('★★ 推送抛异常 → 任务结果**照样**是 200（通知失败不许改任务状态）', async () => {
    const h = makeHarness({ submitProjectTaskResult: () => ({ ...QQ_TASK, status: 'needs_review' }) });
    h.push.sendProactive = vi.fn(async () => { throw new Error('QQ 配额炸了'); });
    const app = await buildApp(h.core, { push: h.push });
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks/pt-1/result', payload: { status: 'needs_review' } });
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe('needs_review');
  });

  it('★★ 记忆写入抛异常 → 不影响响应', async () => {
    const { res } = await postResult(QQ_TASK, {
      recordProjectTaskResult: vi.fn(async () => { throw new Error('db busy'); }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('★ 回传被拒（409）时**不**触发回送（没写进去就别通知）', async () => {
    const h = makeHarness({ submitProjectTaskResult: () => null });
    const app = await buildApp(h.core, { push: h.push });
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks/pt-1/result', payload: { status: 'completed' } });
    await flush();
    expect(res.statusCode).toBe(409);
    expect(h.mm.recordProjectTaskResult).not.toHaveBeenCalled();
    expect(h.push.sendProactive).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// ★ 2026-10-18 真机撞出来的：runner 按项目起服务 ⇒ 新登记的项目**永远没人认领**，
//   任务一路 queued 且静默（实测 580 秒）。修法：projectId 变可选，服务端挑最老的活。
// ─────────────────────────────────────────────────────────────
describe('★ 认领不指定项目（一个 runner 服务所有项目）', () => {
  it('★ 不带 projectId → 先问"谁有最老的活"，再认领那个项目', async () => {
    const h = makeHarness({ nextQueuedProject: vi.fn(() => 'alysia-blog') });
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next' });
    expect(res.statusCode).toBe(200);
    expect(h.mm.nextQueuedProject).toHaveBeenCalled();
    expect(h.mm.claimNextProjectTask).toHaveBeenCalledWith('alysia-blog');
    expect(res.json().project.id).toBe('alysia-blog');
    expect(res.json().project.workspace).toBe('/srv/blog');
  });

  it('没有排队的活 → 200 + task:null（空闲是常态，不是错误）', async () => {
    const h = makeHarness({ nextQueuedProject: vi.fn(() => null) });
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, task: null });
    expect(h.mm.claimNextProjectTask).not.toHaveBeenCalled();
  });

  it('★ 排队任务的项目已被注销 → 不执行、也不静默（留痕后返回空）', async () => {
    const h = makeHarness({ nextQueuedProject: vi.fn(() => 'ghost-project') });
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, task: null });
    expect(h.mm.claimNextProjectTask).not.toHaveBeenCalled();
  });

  it('显式指定未知项目 → 仍然 400 并列出已登记（错误信息要能照着改）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next?projectId=nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('alysia-blog');
  });
});

describe('鉴权：新端点与既有端点同一套（不新开通道）', () => {  it('requireAuth + 无 token → 全部 401', async () => {
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
