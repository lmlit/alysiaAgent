/**
 * 委托任务**聊天侧工具**单测。
 *
 * ★ 2026-10-17（change: `add-project-task-delegation`）。
 *
 * 这一层是模型能碰到的**唯一入口**，所以守三件事：
 *   1. **能力开关**：没有登记项目 ⇒ 一个工具都不存在；
 *   2. **不让模型越权**：项目 id 必须在白名单里，路径/profile 根本不在参数里；
 *   3. **说人话**：每种状态（排队/在跑/跑完/失败/无法确认）都要能被模型读懂，
 *      尤其 `unknown` 必须明说「别当成成功、别重复提交」。
 */
import { describe, it, expect, vi } from 'vitest';
import { createProjectTaskTools } from '../src/tools/project-tasks.js';
import type { ProjectTask } from '../src/memory/stores/ProjectTaskStore.js';

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    taskId: 'pt-1', requestKey: 'k', projectId: 'alysia-blog', originSessionId: 'qq:owner',
    origin: 'delegated', goal: '做一个关于我页面', acceptanceCriteria: '能构建',
    dshSessionId: null, status: 'queued', revision: 0, result: null, artifacts: null,
    attempts: 0, lastError: null, createdAt: '', updatedAt: '',
    ...over,
  };
}

function makeHost(overrides: Record<string, unknown> = {}) {
  const host = {
    createProjectTask: vi.fn(() => ({ kind: 'created', task: task() })),
    getProjectTask: vi.fn(() => task()),
    addProjectTaskRevision: vi.fn(() => task({ revision: 1, status: 'queued', dshSessionId: 'session-1' })),
    ...overrides,
  };
  return host;
}

const OPTS = { projectIds: ['alysia-blog'] };

describe('★ 能力开关', () => {
  it('没有登记项目 ⇒ 一个工具都不注册', () => {
    expect(createProjectTaskTools(makeHost() as never, { projectIds: [] })).toEqual([]);
  });

  it('登记了就注册三个（且没有 cancel —— 协议层不支持，别假装有）', () => {
    const tools = createProjectTaskTools(makeHost() as never, OPTS);
    expect(tools.map(t => t.name)).toEqual(['start_project_task', 'get_project_task', 'continue_project_task']);
  });

  it('★ 参数里**没有**任何路径 / profile / dsh 参数（模型不该能指定这些）', () => {
    const start = createProjectTaskTools(makeHost() as never, OPTS)[0];
    const props = Object.keys(start.parameters.properties);
    expect(props.sort()).toEqual(['acceptanceCriteria', 'goal', 'projectId']);
    expect(props.join(',')).not.toMatch(/workspace|profile|path|session/i);
  });
});

describe('start_project_task', () => {
  const start = () => createProjectTaskTools(makeHost() as never, OPTS)[0];

  it('正常提交 → 立刻返回任务 id（不阻塞聊天）', async () => {
    const out = await start().handler({ projectId: 'alysia-blog', goal: '做一个关于我页面' }, 'qq:owner');
    expect(out).toContain('pt-1');
    expect(out).toContain('已提交');
    expect(out, '居然说做完了 —— 这是异步委托').not.toContain('已完成');
  });

  it('★ origin / originSessionId 如实带给 core（来源可判定）', async () => {
    const host = makeHost();
    const tools = createProjectTaskTools(host as never, OPTS);
    await tools[0].handler({ projectId: 'alysia-blog', goal: 'x' }, 'qq:owner');
    expect(host.createProjectTask).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'alysia-blog', goal: 'x', origin: 'delegated', originSessionId: 'qq:owner',
    }));
  });

  it('★ 未知项目 → 拒绝并**列出可选**，且不调用 core', async () => {
    const host = makeHost();
    const out = await createProjectTaskTools(host as never, OPTS)[0].handler({ projectId: 'nope', goal: 'x' });
    expect(out).toContain('拒绝');
    expect(out).toContain('alysia-blog');
    expect(host.createProjectTask, '未知项目却把任务建出来了').not.toHaveBeenCalled();
  });

  it('空 goal → 拒绝（否则执行端只能猜）', async () => {
    const out = await start().handler({ projectId: 'alysia-blog', goal: '   ' });
    expect(out).toContain('拒绝');
    expect(out).toContain('goal');
  });

  it('★ 项目在忙 → 明确说「没有新建」并给出既有任务（不是丢弃）', async () => {
    const host = makeHost({
      createProjectTask: () => ({ kind: 'busy', task: task({ status: 'running' }) }),
    });
    const out = await createProjectTaskTools(host as never, OPTS)[0].handler({ projectId: 'alysia-blog', goal: 'x' });
    expect(out).toContain('正忙');
    expect(out).toContain('没有');
    expect(out).toContain('pt-1');
    expect(out).toContain('running');
  });

  it('重复提交（deduped）→ 说明没重复创建', async () => {
    const host = makeHost({ createProjectTask: () => ({ kind: 'deduped', task: task() }) });
    const out = await createProjectTaskTools(host as never, OPTS)[0].handler({ projectId: 'alysia-blog', goal: 'x' });
    expect(out).toContain('重复');
    expect(out).toContain('pt-1');
  });
});

describe('get_project_task', () => {
  const get = (host: ReturnType<typeof makeHost>) => createProjectTaskTools(host as never, OPTS)[1];

  it('未知任务 → 提示 id 抄错（不抛）', async () => {
    const host = makeHost({ getProjectTask: () => null });
    expect(await get(host).handler({ taskId: 'pt-x' })).toContain('没有这个任务');
  });

  it('★ unknown 必须明说「别当成成功、别重复提交」', async () => {
    const host = makeHost({ getProjectTask: () => task({ status: 'unknown', lastError: '超时' }) });
    const out = await get(host).handler({ taskId: 'pt-1' });
    expect(out).toContain('无法确认');
    expect(out).toContain('别重复提交');
  });

  it('needs_review 要说清「等你验收」，completed 要说「不等于已发布」', async () => {
    const nr = await get(makeHost({ getProjectTask: () => task({ status: 'needs_review' }) })).handler({ taskId: 'pt-1' });
    expect(nr).toContain('验收');

    const cp = await get(makeHost({ getProjectTask: () => task({ status: 'completed' }) })).handler({ taskId: 'pt-1' });
    expect(cp, 'completed 被说成发布完了').toContain('不等于已发布');
  });

  it('★ 超长结果被截断并标明（别把整份文件塞回 prompt）', async () => {
    const host = makeHost({
      getProjectTask: () => task({ status: 'needs_review', result: { final: 'x'.repeat(5000) } }),
    });
    const out = await get(host).handler({ taskId: 'pt-1' });
    expect(out).toContain('已截断');
    expect(out.length).toBeLessThan(3000);
  });

  it('产物只给相对路径（不给绝对路径 —— 那是宿主信息）', async () => {
    const host = makeHost({
      getProjectTask: () => task({ status: 'needs_review', artifacts: [{ path: 'about.html' }] }),
    });
    const out = await get(host).handler({ taskId: 'pt-1' });
    expect(out).toContain('about.html');
    expect(out).not.toContain('/root/');
  });
});

describe('continue_project_task', () => {
  const cont = (host: ReturnType<typeof makeHost>) => createProjectTaskTools(host as never, OPTS)[2];

  it('★ 成功 → 说明「同一个工程会话、不会重新搭」', async () => {
    const out = await cont(makeHost()).handler({ taskId: 'pt-1', feedback: '标题改短' });
    expect(out).toContain('第 2 轮');
    expect(out).toContain('同一个工程会话');
    expect(out).toContain('不会重新搭');
  });

  it('★ 在途 → 明确拒绝并说出当前状态（别让模型瞎猜）', async () => {
    const host = makeHost({
      getProjectTask: () => task({ status: 'running' }),
      addProjectTaskRevision: () => null,
    });
    const out = await cont(host).handler({ taskId: 'pt-1', feedback: '改一下' });
    expect(out).toContain('不接受');
    expect(out).toContain('running');
  });

  it('未知任务 → 提示；空 feedback → 拒绝', async () => {
    const host = makeHost({ getProjectTask: () => null });
    expect(await cont(host).handler({ taskId: 'pt-x', feedback: 'x' })).toContain('没有这个任务');
    expect(await cont(makeHost()).handler({ taskId: 'pt-1', feedback: '  ' })).toContain('拒绝');
  });
});
