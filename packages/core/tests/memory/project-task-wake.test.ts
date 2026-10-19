/**
 * 异步唤醒的**语义层**单测（★ change: `wake-her-on-task-result`）。
 *
 * 这里钉住四件最容易悄悄坏掉的事：
 *   1. 事件体形状（幂等 id / 归属 / 证据）
 *   2. 证据是否"这一轮的"（旧文件不能冒充）
 *   3. 渲染出来的输入**必须**标明「不是用户说的话」
 *   4. 验收与返工的幂等（重复事件不许排两轮、不许改错轮次）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { ProjectTaskStore } from '../../src/memory/stores/ProjectTaskStore.js';
import {
  buildSubagentResultPayload,
  computeEvidence,
  renderSubagentResultInput,
  outcomeOfStatus,
} from '../../src/memory/project-task-result.js';

const T0 = new Date('2026-10-19T00:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const basePayload = {
  taskId: 'pt-1',
  projectId: 'alysia-toys',
  revision: 0,
  status: 'needs_review',
  conversationId: 'qq-official-1:private:private_abcdef123456',
  originalGoal: '做一个月光花园',
  currentRequirement: '做一个月光花园',
  acceptanceCriteria: '能打开',
  artifacts: [
    { path: 'moon.html', url: 'http://s:3389/w/alysia-toys/moon.html', published: false, mtime: T0.getTime() + 60_000 },
  ],
  evidence: { roundStartedAt: T0.getTime(), pageVerified: true },
  now: T0,
};

describe('事件体形状', () => {
  it('eventId 幂等键 = taskId:r<rev>:result（重复回调不会叫醒两次）', () => {
    const p = buildSubagentResultPayload(basePayload);
    expect(p.eventId).toBe('pt-1:r0:result');
    const again = buildSubagentResultPayload({ ...basePayload, now: at(5) });
    expect(again.eventId).toBe(p.eventId);
  });

  it('outcome 只表达**执行结果**；completed 才叫 accepted', () => {
    expect(outcomeOfStatus('needs_review')).toBe('succeeded');
    expect(outcomeOfStatus('failed')).toBe('failed');
    expect(outcomeOfStatus('unknown')).toBe('unknown');
    expect(outcomeOfStatus('completed')).toBe('accepted');
  });

  it('地址由产物派生，不让模型提供', () => {
    const p = buildSubagentResultPayload(basePayload);
    expect(p.evidence.pageUrl).toBe('http://s:3389/w/alysia-toys/moon.html');
  });
});

describe('证据有效性（不能拿旧文件冒充这次）', () => {
  it('产物 mtime 早于本轮开始 → fresh=false 且给出原因', () => {
    const ev = computeEvidence({
      artifacts: [{ path: 'old.html', mtime: T0.getTime() - 3_600_000 }],
      roundStartedAt: T0.getTime(),
    });
    expect(ev.fresh).toBe(false);
    expect(ev.staleReason).toContain('old.html');
  });

  it('没有本轮开始时刻 → 一律不认（宁可说不知道）', () => {
    const ev = computeEvidence({ artifacts: [{ path: 'a.html', mtime: T0.getTime() }] });
    expect(ev.fresh).toBe(false);
    expect(ev.staleReason).toContain('没有报本轮开始时刻');
  });

  it('产物缺 mtime → 不认', () => {
    const ev = computeEvidence({ artifacts: [{ path: 'a.html' }], roundStartedAt: T0.getTime() });
    expect(ev.fresh).toBe(false);
  });

  it('全部产物都是本轮动的 → fresh=true（合法路径不被误伤）', () => {
    const ev = computeEvidence({
      artifacts: [{ path: 'a.html', mtime: T0.getTime() + 1 }],
      roundStartedAt: T0.getTime(),
      pageVerified: true,
      pageUrl: 'http://s:3389/p/x/',
    });
    expect(ev.fresh).toBe(true);
    expect(ev.pageVerified).toBe(true);
    expect(ev.pageUrl).toBe('http://s:3389/p/x/');
  });
});

describe('渲染成主 Agent 的输入', () => {
  const p = buildSubagentResultPayload(basePayload);

  it('第一行就标明「不是用户说的话」（子 Agent 输出不能冒充用户指令）', () => {
    const text = renderSubagentResultInput(p);
    expect(text.split('\n')[0]).toContain('不是用户说的话');
    expect(text).toContain('工具返回');
  });

  it('四样决策依据都在：原目标 / 当前要求 / 结果 / 证据', () => {
    const text = renderSubagentResultInput(
      buildSubagentResultPayload({ ...basePayload, currentRequirement: '改成夜晚的' }),
    );
    expect(text).toContain('做一个月光花园');   // 原目标
    expect(text).toContain('改成夜晚的');       // 当前要求（改过）
    expect(text).toContain('moon.html');        // 产物
    expect(text).toContain('证据是否可信');
    expect(text).toContain('accept_project_task');
    expect(text).toContain('continue_project_task');
    expect(text).toContain('pt-1:r0:result');   // fromEventId 直接给
  });

  it('证据不成立时明确禁止说「这次做好了」', () => {
    const stale = buildSubagentResultPayload({
      ...basePayload,
      artifacts: [{ path: 'old.html', mtime: T0.getTime() - 60_000 }],
    });
    expect(renderSubagentResultInput(stale)).toContain('不许**据此说');
  });

  it('返工到上限时明确叫停', () => {
    const capped = buildSubagentResultPayload({ ...basePayload, autoRework: { used: 2, max: 2 } });
    expect(renderSubagentResultInput(capped)).toContain('到上限了');
  });
});

describe('验收 / 返工的幂等', () => {
  let store: ProjectTaskStore;
  const base = {
    projectId: 'alysia-toys',
    requestKey: 'k1',
    goal: '做一个月光花园',
    originSessionId: 'qq-official-1:private:private_abcdef123456',
  };

  beforeEach(() => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    store = new ProjectTaskStore(db);
  });

  /** 建任务 → 认领 → 回传 needs_review（走到"等她验收"） */
  function toNeedsReview(): string {
    const created = store.create(base, T0);
    const id = (created as { task: { taskId: string } }).task.taskId;
    store.claimNext('alysia-toys', at(1));
    store.submitResult(id, { status: 'needs_review' }, at(2));
    return id;
  }

  it('原目标在返工后仍然保留；goal 变成新要求', () => {
    const id = toNeedsReview();
    const after = store.addRevision(id, '颜色再冷一点', at(3))!;
    expect(after.goal).toBe('颜色再冷一点');
    expect(after.originalGoal, '原目标被覆盖了 —— 验收时她看不到当初想做什么').toBe('做一个月光花园');
  });

  it('同一事件重复返工 → 不 +1 轮（回调重试不许排两轮）', () => {
    const id = toNeedsReview();
    const a = store.addRevision(id, '冷一点', at(3), { fromEventId: 'ev-1' })!;
    expect(a.revision).toBe(1);
    const b = store.addRevision(id, '冷一点', at(4), { fromEventId: 'ev-1' })!;
    expect(b.revision, '同一条结果事件排了两轮').toBe(1);
    // 不同事件 ⇒ 正常再排一轮（合法路径不被误伤）
    // 先把它跑回终态
    store.claimNext('alysia-toys', at(5));
    store.submitResult(id, { status: 'needs_review' }, at(6));
    const c = store.addRevision(id, '再暖回来', at(7), { fromEventId: 'ev-2' })!;
    expect(c.revision).toBe(2);
  });

  it('验收：只有 needs_review + revision 匹配才写 completed', () => {
    const id = toNeedsReview();
    const wrong = store.acceptResult(id, { revision: 3, by: 'x' }, at(3));
    expect(wrong.accepted).toBe(false);
    expect(store.get(id)!.status).toBe('needs_review');

    const ok = store.acceptResult(id, { revision: 0, by: 'main-agent', note: '这版像她' }, at(4));
    expect(ok.accepted).toBe(true);
    expect(store.get(id)!.status).toBe('completed');
    expect(store.get(id)!.acceptedBy).toBe('main-agent');
    expect(store.get(id)!.acceptedAt).toBe(at(4).toISOString());
  });

  it('重复验收是幂等空转（不报错、不改时间）', () => {
    const id = toNeedsReview();
    store.acceptResult(id, { revision: 0, by: 'a' }, at(4));
    const again = store.acceptResult(id, { revision: 0, by: 'b' }, at(5));
    expect(again.accepted).toBe(true);
    expect(store.get(id)!.acceptedBy).toBe('a');
  });

  it('在途任务不接受验收（跑都没跑完）', () => {
    const created = store.create(base, T0);
    const id = (created as { task: { taskId: string } }).task.taskId;
    const out = store.acceptResult(id, { revision: 0, by: 'x' }, at(1));
    expect(out.accepted).toBe(false);
    expect(out.reason).toContain('queued');
  });
});

describe('claimToken（迟到结果不许覆盖新认领）', () => {
  function setup() {
    const db = new Database(':memory:');
    initializeDatabase(db);
    return { db, store: new ProjectTaskStore(db, { claimedTimeoutMs: 60_000 }) };
  }

  it('批次对不上 → 409（返回 null），任务状态不变', () => {
    const { store } = setup();
    const created = store.create(
      { projectId: 'p', requestKey: 'k', goal: 'g', originSessionId: 's' },
      T0,
    );
    const id = (created as { task: { taskId: string } }).task.taskId;
    const claimed = store.claimNext('p', at(1))!;
    expect(claimed.attempts).toBe(1);

    const late = store.submitResult(id, { status: 'needs_review', claimToken: 9 }, at(2));
    expect(late, '过期批次的回传被接受了').toBeNull();
    expect(store.get(id)!.status).toBe('running');

    const ok = store.submitResult(id, { status: 'needs_review', claimToken: 1 }, at(3));
    expect(ok!.status).toBe('needs_review');
  });

  it('不带 claimToken 时行为与以前一致（老 runner 不受影响）', () => {
    const { store } = setup();
    const created = store.create(
      { projectId: 'p', requestKey: 'k2', goal: 'g', originSessionId: 's' },
      T0,
    );
    const id = (created as { task: { taskId: string } }).task.taskId;
    store.claimNext('p', at(1));
    expect(store.submitResult(id, { status: 'needs_review' }, at(2))!.status).toBe('needs_review');
  });
});

describe('终态与入队同事务', () => {
  it('submitResult 带 event → 同一事务里出现事件行', () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const store = new ProjectTaskStore(db);
    const created = store.create(
      { projectId: 'p', requestKey: 'k3', goal: 'g', originSessionId: 's' },
      T0,
    );
    const id = (created as { task: { taskId: string } }).task.taskId;
    store.claimNext('p', at(1));
    store.submitResult(
      id,
      {
        status: 'needs_review',
        event: {
          eventId: `${id}:r0:result`,
          taskId: id,
          projectId: 'p',
          revision: 0,
          kind: 'result',
          payload: { hello: 'world' },
        },
      },
      at(2),
    );
    const row = db.prepare('SELECT * FROM project_task_events WHERE event_id = ?').get(`${id}:r0:result`);
    expect(row, '终态写了但事件没入队 —— 结果又会丢').toBeTruthy();
  });

  it('回传被拒（不在 running）→ 不留下事件行', () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const store = new ProjectTaskStore(db);
    const created = store.create(
      { projectId: 'p', requestKey: 'k4', goal: 'g', originSessionId: 's' },
      T0,
    );
    const id = (created as { task: { taskId: string } }).task.taskId;
    // 还没认领就回传 —— 必须拒绝，且不许入队
    store.submitResult(id, {
      status: 'needs_review',
      event: { eventId: 'x', taskId: id, projectId: 'p', revision: 0, payload: {} },
    });
    const n = db.prepare('SELECT COUNT(*) AS n FROM project_task_events').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
