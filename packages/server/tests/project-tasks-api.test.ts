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
  /**
   * ★ 2026-10-19（change: `wake-her-on-task-result`）：
   *   这一段验的是**回退路径**（`subagentWake:false`）—— 也就是"不做异步唤醒时"的旧行为。
   *   唤醒路径由 `subagent-wake.test.ts` 覆盖。两条路都必须一直有人测：
   *   回退开关是出事时唯一能立刻退回去的地方。
   */
  const QQ_TASK = { ...TASK, originSessionId: 'qq-official-1:private:private_ABC123DEF' };

  async function postResult(
    task: Record<string, unknown> = QQ_TASK,
    mmOverrides: Record<string, unknown> = {},
    opts: Record<string, unknown> = {},
  ) {
    const h = makeHarness({
      submitProjectTaskResult: () => ({ ...task, status: 'needs_review', result: { final: '页面做好了' } }),
      ...mmOverrides,
    });
    const app = await buildApp(h.core, { push: h.push, subagentWake: false, ...opts });
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
      originSessionId: 'qq-official-1:private:private_ABC123DEF',
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

  // ★ 2026-10-19（wake-her-on-task-result）：**群会话不推**。
  //   旧正则同时放行 group_，而 sendProactive 打的是私聊端点 —— 群 openid 会被当私聊发。
  it('★ 群会话 → 不推送（私聊端点发不了群，且不该把群 id 当 openid）', async () => {
    const { h } = await postResult({ ...TASK, originSessionId: 'qq-official-1:group:group_ABC123DEF' });
    expect(h.push.sendProactive).not.toHaveBeenCalled();
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

  // ★ 用户原话「感觉好干啊，而且没有昔涟的味道」→ 那句话用在**推送**上；
  //   但 ★ 2026-10-18 又被指出：「她以为是我命令输出的」⇒ **记忆里那条不能借她的口吻**。
  it('★★ 她的措辞只进**推送**；记忆回执不带 notice（归属不能伪造）', async () => {
    const { h } = await postResult();
    expect(h.mm.composeProjectTaskNotice).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'alysia-blog', status: 'needs_review' }),
    );
    // 落库那条**不许**带 notice —— 它是「工程回执」（role=engine），不是她的话
    const arg = (h.mm.recordProjectTaskResult.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(arg).not.toHaveProperty('notice');
    // 推送那条是她的话
    const [, text] = h.push.sendProactive.mock.calls[0] as unknown as [string, string];
    expect(text).toBe('页面弄好啦，你看看顺不顺眼～');
  });

  it('★ 措辞生成失败 → 推送回落模板，但**照样**记回与推送（不许因此丢通知）', async () => {
    const { h } = await postResult(QQ_TASK, {
      composeProjectTaskNotice: vi.fn(async () => { throw new Error('llm 挂了'); }),
    });
    // 记忆侧**本来就不带** notice（回执是工程端的，不是她的）
    const arg = (h.mm.recordProjectTaskResult.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(arg).not.toHaveProperty('notice');
    expect(arg).toEqual(expect.objectContaining({ taskId: 'pt-1', status: 'needs_review' }));
    const [, text] = h.push.sendProactive.mock.calls[0] as unknown as [string, string];
    // ★ 2026-10-19（`unify-her-voice-across-engineering`）：回落口径也改第一人称 ——
    //   「委托任务结束了」把她自己说成第三方；现在是「我这一轮跑完了」。
    //   仍然"干，但诚实"：机械模板 + 逐字地址。
    expect(text).toContain('我这一轮跑完了');
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
// ─────────────────────────────────────────────────────────────
// ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）
//   DeepSeek 的高峰时段（北京时间工作日 9-12 / 14-18）**只排队不执行**。
//   钱按执行时间算，排队不花；而拒收任务等于让用户与模型都去记时段。
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// ★ 2026-10-18（change: `make-author-iterate`）：状态机推进
//   runner 把**从工作区读到的事实**发上来，服务端据此决定进下一阶段/原地/收工。
//   ⚠️ 判据在服务端（纯函数），执行端不能自己宣布"我改好了"。
// ─────────────────────────────────────────────────────────────
describe('★ 阶段推进（POST /advance）', () => {
  const TASK_INTENT = { ...TASK, phase: 'intent', loopState: { rounds: 0, visits: {}, revisions: 0 } };

  function harness(overrides: Record<string, unknown> = {}) {
    const h = makeHarness({
      getProjectTask: () => TASK_INTENT,
      advanceProjectTaskLoop: vi.fn(() => ({
        decision: { next: 'sketch', prompt: '去画草图', done: false, detail: '意图已写（20 字）', state: { rounds: 1, visits: {}, revisions: 0 } },
        task: { ...TASK_INTENT, phase: 'sketch' },
      })),
      ...overrides,
    });
    return h;
  }

  it('★ 缺 facts → 400（事实必须由 runner 给，不许服务端猜）', async () => {
    const h = harness();
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/project-tasks/pt-1/advance', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('facts');
  });

  it('★ 正常推进 → 返回 decision（next/detail）并把事实原样传给 core', async () => {
    const h = harness();
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks/pt-1/advance',
      payload: { facts: { notes: '## 意图\n想做点安静的', drafts: [], shots: [], builtPages: [], published: false } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision.next).toBe('sketch');
    const arg = (h.mm.advanceProjectTaskLoop.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(arg.notes).toContain('意图');
  });

  it('★ 事实字段形状不对 -> 归一成安全值（不炸、也不当成 true）', async () => {
    const h = harness();
    const app = await buildApp(h.core);
    await app.inject({
      method: 'POST', url: '/api/project-tasks/pt-1/advance',
      payload: { facts: { notes: 123, drafts: 'nope', shots: null, builtPages: [{ file: 'a.html' }, { mtime: 1 }], published: 'yes' } },
    });
    const arg = (h.mm.advanceProjectTaskLoop.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(arg.notes).toBe('');
    expect(arg.drafts).toEqual([]);
    expect(arg.builtPages).toEqual([{ file: 'a.html', mtime: 0 }]);
    expect(arg.published).toBe(false); // 'yes' 不是 true
  });

  it('未知任务 → 404', async () => {
    const h = harness({ advanceProjectTaskLoop: vi.fn(() => null) });
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST', url: '/api/project-tasks/nope/advance', payload: { facts: {} },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('★ 高峰时段不认领（执行窗口）', () => {  /**
   * 用**注入时钟**锁死时刻：2026-10-19 周一 10:15（北京时间）—— 正经的高峰。
   * ⚠️ 不能靠"跑测试那天恰好是工作日"：周末判定会在高峰之前短路，
   *    那样这条用例在周日会假通过/假失败。
   */
  const MON_PEAK = () => new Date('2026-10-19T02:15:00.000Z'); // = 北京 10:15
  const MON_OFFPEAK = () => new Date('2026-10-19T04:15:00.000Z'); // = 北京 12:15（午休）

  it('★★ 高峰（周一 10:15）→ 200 + task:null + paused，且**不许**认领', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core, { clock: MON_PEAK });
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.task).toBeNull();
    expect(body.paused.reason).toBe('peak');
    expect(body.paused.message).toContain('高峰');
    expect(body.paused.until).toBe('2026-10-19T04:00:00.000Z'); // 北京 12:00
    expect(h.mm.claimNextProjectTask, '高峰还去认领了 —— 等于白烧钱').not.toHaveBeenCalled();
  });

  it('★ 工作日午休（12:15）→ 照常认领（空闲窗口不能把正常链路拦住）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core, { clock: MON_OFFPEAK });
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next' });
    expect(res.statusCode).toBe(200);
    expect(res.json().task).not.toBeNull();
    expect(res.json().paused).toBeUndefined();
    expect(h.mm.claimNextProjectTask).toHaveBeenCalled();
  });

  it('★ 法定节假日的高峰时刻 → 照常认领（节假日全天算空闲）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core, { clock: MON_PEAK, projectTasks: { holidays: ['2026-10-19'] } });
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next' });
    expect(res.json().task).not.toBeNull();
  });

  it('★ 周末的高峰时刻 → 照常认领（按用户规则：周末全天算空闲）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core, { clock: () => new Date('2026-10-24T02:15:00.000Z') }); // 周六 10:15
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next' });
    expect(res.json().task).not.toBeNull();
  });

  // 「我的任务为什么不动」是闸门上线后第一个问题 —— 这个端点就是答案
  it('★ GET /api/project-tasks/window 说清判定依据（含用的配置）', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core, {
      clock: MON_PEAK,
      projectTasks: { holidays: ['2026-01-01'], peakWindows: [[540, 720]] },
    });
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/window' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window.offPeak).toBe(false);
    expect(body.window.reason).toBe('peak');
    expect(body.window.until).toBe('2026-10-19T04:00:00.000Z');
    expect(body.config.peakWindows).toEqual([[540, 720]]);
    expect(body.config.holidays).toEqual(['2026-01-01']);
  });

  it('★ 排障用 nowOverride（config）与 clock 等价，且 config 里能看见它在生效', async () => {
    const h = makeHarness();
    const app = await buildApp(h.core, {
      projectTasks: { nowOverride: '2026-10-19T02:15:00.000Z' }, // 周一 10:15
    });
    const res = await app.inject({ method: 'GET', url: '/api/project-tasks/next' });
    expect(res.json().paused?.reason).toBe('peak');
  });
});

describe('★ 认领不指定项目（一个 runner 服务所有项目）', () => {  it('★ 不带 projectId → 先问"谁有最老的活"，再认领那个项目', async () => {
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
