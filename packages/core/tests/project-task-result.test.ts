/**
 * 「委托任务回执」事件单测（★ change: `return-project-task-result`）。
 *
 * 这条事件的形状就是这个 change 的**契约本体**，所以直接钉：
 *   · 幂等 id（同一条结果重复回传不产生第二条）
 *   · 三个标记位都要在（少一个就有一条泄漏路径）
 *   · 没有 originSessionId 时**不许猜**会话
 *   · 正文要像"她自己的话"，而不是机器 dump
 */
import { describe, it, expect } from 'vitest';
import {
  buildProjectTaskResultEvent,
  MAX_RESULT_SUMMARY_CHARS,
} from '../src/memory/project-task-result.js';

const BASE = {
  taskId: 'pt-1',
  projectId: 'alysia-blog',
  revision: 0,
  status: 'needs_review',
  originSessionId: 'qq-official-1:private_ABC123DEF',
};

describe('幂等键', () => {
  it('★ 同一任务同一轮 → 同一个 id（重复回传只命中既有事件）', () => {
    const a = buildProjectTaskResultEvent({ ...BASE, now: new Date('2026-10-18T00:00:00Z') })!;
    const b = buildProjectTaskResultEvent({ ...BASE, now: new Date('2026-10-18T01:00:00Z') })!;
    expect(a.id).toBe(b.id);
    expect(a.id).toBe('project-task:pt-1:r0');
  });

  it('★ 不同轮 → 不同 id（第 2 轮的回执不能被第 1 轮吃掉）', () => {
    const r0 = buildProjectTaskResultEvent({ ...BASE, revision: 0 })!;
    const r1 = buildProjectTaskResultEvent({ ...BASE, revision: 1 })!;
    expect(r1.id).not.toBe(r0.id);
  });
});

describe('★ 标记位（少一个就有一条泄漏路径）', () => {
  const ev = () => buildProjectTaskResultEvent(BASE)!;

  it('skip_profile：不进画像/人格/嵌入', () => {
    expect(ev().payload.skip_profile, '漏了它 → 画像会从回执里"学"出用户事实').toBe(true);
  });

  it('synthetic：不进摘要（SessionEndProcessor 只认这个字段）', () => {
    expect(ev().payload.synthetic).toBe('project-task-result');
  });

  it('project_task_result：可枚举的类型标记（不靠正文前缀猜）', () => {
    expect(ev().payload.project_task_result).toBe(true);
  });

  it('source=system + role=assistant + perspective=self（是"她自己的事"，不是互动）', () => {
    const e = ev();
    expect(e.source).toBe('system');
    expect(e.payload.role).toBe('assistant');
    expect(e.perspective).toBe('self');
  });

  it('★ 落回的会话就是发起它的那个会话', () => {
    expect(ev().session_id).toBe(BASE.originSessionId);
  });
});

describe('★ 不猜目标', () => {
  it.each([[''], ['   '], [undefined as unknown as string]])(
    'originSessionId=%j → 返回 null（宁可不记）',
    (sid) => {
      expect(buildProjectTaskResultEvent({ ...BASE, originSessionId: sid })).toBeNull();
    },
  );
});

describe('正文', () => {
  it('含项目/轮次/状态，并带上产物相对路径', () => {
    const e = buildProjectTaskResultEvent({
      ...BASE,
      revision: 2,
      artifacts: [{ path: 'public/index.html' }, { path: 'public/style.css' }, { bad: 1 }],
    })!;
    const text = String(e.payload.content);
    expect(text).toContain('alysia-blog');
    expect(text).toContain('第 3 轮');
    expect(text).toContain('needs_review');
    expect(text).toContain('public/index.html');
    expect(text).toContain('public/style.css');
  });

  it('★ 过长摘要要截断并标明（这条会进「最近对话」窗口）', () => {
    const e = buildProjectTaskResultEvent({ ...BASE, summary: 'x'.repeat(5000) })!;
    const text = String(e.payload.content);
    expect(text).toContain('已截断');
    expect(text.length).toBeLessThan(MAX_RESULT_SUMMARY_CHARS + 200);
  });

  it('没有摘要时也不出空行噪声', () => {
    const e = buildProjectTaskResultEvent({ ...BASE, summary: '   ' })!;
    expect(String(e.payload.content).trim().endsWith('。')).toBe(true);
  });

  it('dshSessionId 有才记（续作要靠它，别记个 undefined）', () => {
    expect(buildProjectTaskResultEvent(BASE)!.payload.dsh_session_id).toBeUndefined();
    expect(
      buildProjectTaskResultEvent({ ...BASE, dshSessionId: 'session-abc' })!.payload.dsh_session_id,
    ).toBe('session-abc');
  });
});
