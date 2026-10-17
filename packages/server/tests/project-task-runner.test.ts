// ★ 2026-10-17 · change: add-project-task-delegation
//
// 宿主侧 runner 的**纯函数**部分（拼命令 / 解析事件流 / 终态映射）。
//
// 为什么放在 server 包下：runner 是 `scripts/` 下的独立脚本（宿主上用 node 直跑），
// 仓库没有「scripts 的测试归属」，而它**只与 server 的 API 契约对话**，放这里最贴近。
//
// ⚠️ 真正的**副作用**（spawn dsh、HTTP 轮询）不在这里测 —— 那是真机验收的事。
import { describe, it, expect } from 'vitest';
// @ts-expect-error —— 宿主脚本是 .mjs，没有类型声明（故意的：它要能被 node 直跑）
import { buildDshArgs, buildTaskText, parseRunEvents, mapOutcome, nextUrl } from '../../../scripts/project-task-runner.mjs';

const task = {
  taskId: 'pt-1', goal: '做一个关于我页面', acceptanceCriteria: '能构建', revision: 0, dshSessionId: null,
};

describe('拼命令', () => {
  it('★ 首轮**不带** --session-id（带了会报 unknown id）', () => {
    const args = buildDshArgs(task, 'alysia');
    expect(args).toContain('--profile');
    expect(args[args.indexOf('--profile') + 1]).toBe('alysia');
    expect(args).toContain('--json');
    expect(args, '首轮带了 --session-id').not.toContain('--session-id');
  });

  it('★★ 续作**必须**带 --session-id（不带就等于重新建站）', () => {
    const args = buildDshArgs({ ...task, revision: 2, dshSessionId: 'session-abc' }, 'alysia');
    expect(args[args.indexOf('--session-id') + 1]).toBe('session-abc');
  });

  it('任务正文含目标与验收标准（验收标准要进执行体，不能只留在服务端）', () => {
    const text = buildTaskText(task);
    expect(text).toContain('做一个关于我页面');
    expect(text).toContain('验收标准：能构建');
  });

  it('★ 续作轮要在正文里点明「同一个工程会话」（否则她可能重新搭）', () => {
    const text = buildTaskText({ ...task, revision: 3 });
    expect(text).toContain('同一个工程会话');
    expect(text).toContain('不要重新搭');
  });
});

describe('解析 dsh 的 --json 事件流', () => {
  const stream = [
    '{"type":"session","sessionId":"session-1","cwd":"/root/alysia-blog"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    '{"type":"text","text":"开始"}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    '{"type":"final","text":"做完了"}',
  ].join('\n');

  it('取出 sessionId / 终态 reason / final 文本', () => {
    const r = parseRunEvents(stream);
    expect(r.sessionId).toBe('session-1');
    expect(r.reason).toBe('completed');
    expect(r.finalText).toBe('做完了');
    expect(r.badLines).toBe(0);
  });

  it('★ 坏行要计数（非 JSON 混进来时不能静默当成「没输出」）', () => {
    const r = parseRunEvents(`${stream}\n这不是 JSON\n也不像 JSON`);
    expect(r.badLines).toBe(2);
    expect(r.reason, '坏行把好行也带偏了').toBe('completed');
  });

  it('空输入不抛（拿不到东西就是拿不到）', () => {
    expect(parseRunEvents('')).toEqual({ sessionId: null, reason: null, finalText: '', badLines: 0 });
  });
});

describe('★ 终态映射（runner 永远不写 completed）', () => {
  it('★★ dsh 正常结束 → **needs_review**，不是 completed', () => {
    const r = mapOutcome({ reason: 'completed', timedOut: false });
    expect(r.status, 'runner 把「跑完了」当成「验收通过」了 —— 那属于验收方，不属于执行方')
      .toBe('needs_review');
  });

  it('dsh 报错结束 → failed（有明确失败证据）', () => {
    expect(mapOutcome({ reason: 'error', timedOut: false }).status).toBe('failed');
  });

  it('★ 拿不到 reason → unknown，且说明**不自动重投**', () => {
    const r = mapOutcome({ reason: null, timedOut: false });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('无法确认');
  });

  it('★ 超时 → unknown（不许当成 failed 去重投：远端可能已经做完了）', () => {
    const r = mapOutcome({ reason: null, timedOut: true });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('不自动重投');
  });

  it('全量枚举：四种输入都不会产出 completed', () => {
    for (const input of [
      { reason: 'completed', timedOut: false },
      { reason: 'error', timedOut: false },
      { reason: null, timedOut: false },
      { reason: 'completed', timedOut: true },
    ]) {
      expect(mapOutcome(input).status).not.toBe('completed');
    }
  });
});

// ★ 2026-10-18 真机撞出来的：runner 按项目起服务（`--project alysia-blog`）⇒
//   新登记的项目**永远没人认领**，任务一路 queued 而且是静默的（实测等了 580 秒才发现）。
//   改成：不传 project ⇒ 不带查询参数 ⇒ 服务端挑"还有活的最老的项目"。
describe('★ 认领 URL（不指定项目 = 服务所有项目）', () => {
  it('★ 不传 project → **不带**查询参数（交给服务端决定）', () => {
    expect(nextUrl('')).toBe('/api/project-tasks/next');
    expect(nextUrl(undefined as unknown as string)).toBe('/api/project-tasks/next');
  });

  it('传了 project → 带 projectId（隔离/调试用）', () => {
    expect(nextUrl('alysia-blog')).toBe('/api/project-tasks/next?projectId=alysia-blog');
  });

  it('项目 id 要 encode（不能把特殊字符塞进 query）', () => {
    expect(nextUrl('a b&c')).toBe('/api/project-tasks/next?projectId=a%20b%26c');
  });
});
