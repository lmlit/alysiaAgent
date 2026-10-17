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
  buildNoticePrompts,
  finalizeNotice,
  MAX_NOTICE_CHARS,
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

// ─────────────────────────────────────────────────────────────
// ★ 2026-10-18（用户原话：「返回的东西要过一遍提示词不，感觉好干啊，而且没有昔涟的味道」）
//   这条事件是 `role:'assistant'` —— 它以**她说过的话**的身份进她的对话史。
//   所以要有"她自己的措辞"，并且**地址必须逐字**（模型爱改 URL）。
// ─────────────────────────────────────────────────────────────
describe('★ 她的口吻：提示词', () => {
  const P = () =>
    buildNoticePrompts({
      personaName: '昔涟',
      projectId: 'alysia-blog',
      revision: 0,
      status: 'needs_review',
      summary: '页面做好了：index.html + style.css',
      artifacts: [{ path: 'public/index.html' }],
      publicUrl: 'http://example.test:3389/',
    });

  it('system 里钉住人格与禁令（不给列表、不许编、要原样抄地址）', () => {
    const { system } = P();
    expect(system).toContain('昔涟');
    expect(system).toContain('原样');
    expect(system).toContain('不要列表');
    expect(system).toContain('不要编造');
    // 不许让模型自由解释内部概念
    expect(system).toContain('不要提');
    expect(system).toContain('委托任务');
  });

  it('user 里只给事实（状态/产物/地址），不给"该怎么夸"', () => {
    const { user } = P();
    expect(user).toContain('alysia-blog');
    expect(user).toContain('needs_review');
    expect(user).toContain('public/index.html');
    expect(user).toContain('http://example.test:3389/');
  });

  it('没人设名时用默认称呼，不抛', () => {
    const { system } = buildNoticePrompts({ projectId: 'x', revision: 0, status: 'completed' });
    expect(system).toContain('昔涟');
  });
});

describe('★ 她的口吻：收口（finalizeNotice）', () => {
  const URL = 'http://example.test:3389/';

  it('★★ 模型把地址改写了 → 以代码为准，地址必须逐字出现', () => {
    const out = finalizeNotice('页面做好啦，在这儿：http://example.test:3389', URL);
    expect(out, '地址缺了结尾斜杠也必须补回原样').toContain(URL);
  });

  it('模型漏了地址 → 追加（不强求它记性）', () => {
    const out = finalizeNotice('做好啦，你看看～', URL);
    expect(out).toContain('做好啦');
    expect(out).toContain(URL);
  });

  it('地址本来就在 → 不重复追加', () => {
    const out = finalizeNotice(`做好啦，在这儿：${URL}`, URL);
    expect(out.split(URL).length - 1).toBe(1);
  });

  it('去掉代码块围栏与整段引号包裹', () => {
    expect(finalizeNotice('```\n做好啦\n```', '')).toBe('做好啦');
    expect(finalizeNotice('「做好啦」', '')).toBe('做好啦');
  });

  it('过长要截断（一条 QQ 消息放得下）', () => {
    const out = finalizeNotice('啊'.repeat(600), '');
    expect(out.length).toBeLessThanOrEqual(MAX_NOTICE_CHARS + 1);
  });

  it('空输入 + 有地址 → 只给地址（不吐空消息）', () => {
    expect(finalizeNotice('   ', URL)).toBe(URL);
  });
});

describe('★ 有她的措辞时，事件正文用她的（模板只在回落时用）', () => {
  it('notice 存在 ⇒ 正文是她的那句话，且**不再**出现"回执"这个词', () => {
    const e = buildProjectTaskResultEvent({
      ...BASE,
      notice: '页面弄好啦，你看看顺不顺眼～',
      publicUrl: 'http://example.test:3389/',
    })!;
    const text = String(e.payload.content);
    expect(text).toContain('页面弄好啦');
    expect(text, '模板腔不许混进"她说的话"').not.toContain('委托任务回执');
    expect(text).toContain('http://example.test:3389/');
  });

  it('没有 notice ⇒ 回落模板（并保留"回执"标记，诚实：这不是她的语气）', () => {
    const text = String(buildProjectTaskResultEvent(BASE)!.payload.content);
    expect(text).toContain('委托任务回执');
  });

  // ★ 2026-10-18 真机又撞一次：她的句子里带了地址，模板又追加一行 ⇒ 同一句里地址出现两遍
  it('★ 她的句子里已有地址 ⇒ 不再追加"外网地址："那一行（不许重复）', () => {
    const url = 'http://example.test:3389/';
    const e = buildProjectTaskResultEvent({ ...BASE, notice: `做好啦，在这儿：${url}`, publicUrl: url })!;
    const text = String(e.payload.content);
    expect(text.split(url).length - 1, '地址只许出现一次').toBe(1);
    expect(text).not.toContain('外网地址：');
  });

  it('她的句子里没有地址 ⇒ 照旧追加（用户问链接时要有东西给）', () => {
    const url = 'http://example.test:3389/';
    const e = buildProjectTaskResultEvent({ ...BASE, notice: '做好啦，你看看～', publicUrl: url })!;
    expect(String(e.payload.content)).toContain(`外网地址：${url}`);
  });
});
