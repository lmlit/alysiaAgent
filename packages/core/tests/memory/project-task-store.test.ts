/**
 * `ProjectTaskStore` 单测 —— 委托任务的**契约层**。
 *
 * ★ 2026-10-17（change: `add-project-task-delegation`）。
 *
 * 这一层不做执行，只守四件最容易出错的事（见源文件头）：
 * 去重 / 单并发 / 原子认领 / 认领后自愈。
 * 本文件按这四条组织，且每条都带**反向守卫**（合法路径不许被误伤）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { ProjectTaskStore } from '../../src/memory/stores/ProjectTaskStore.js';

const T0 = new Date('2026-10-17T00:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function makeStore(opts: Parameters<typeof ProjectTaskStore.prototype.constructor>[1] = {}) {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return { db, store: new ProjectTaskStore(db, opts) };
}

const base = {
  projectId: 'alysia-blog',
  requestKey: 'req-1',
  goal: '做一个关于我页面',
  acceptanceCriteria: '能构建、能预览',
  originSessionId: 'qq-official-1:private:owner',
};

describe('建任务 / 去重 / 单并发', () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => { s = makeStore(); });

  it('新建 → queued / revision 0 / 还没有工程会话', () => {
    const out = s.store.create(base, T0);
    expect(out.kind).toBe('created');
    const t = out.task;
    expect(t.status).toBe('queued');
    expect(t.revision).toBe(0);
    expect(t.dshSessionId, '首轮不该有 dsh 会话 id —— 有的话会带错 --session-id').toBeNull();
    expect(s.store.get(t.taskId)!.goal).toBe('做一个关于我页面');
  });

  it('★ 同 requestKey 再来一次 → deduped，且**只产生一个任务**', () => {
    const a = s.store.create(base, T0);
    const b = s.store.create(base, at(1));
    expect(b.kind, '重试被判成新提交了 —— 会做两遍同一份活').toBe('deduped');
    expect(b.task.taskId).toBe(a.task.taskId);
    expect(s.store.listByProject('alysia-blog')).toHaveLength(1);
  });

  it('★ 同项目已有一个在途任务 → busy，并**返回既有任务**（不是丢弃）', () => {
    const a = s.store.create(base, T0);
    const b = s.store.create({ ...base, requestKey: 'req-2', goal: '再加一页' }, at(1));
    expect(b.kind, '同项目起了第二个并发任务 —— 两份改同一份工作区').toBe('busy');
    expect(b.task.taskId).toBe(a.task.taskId);
  });

  it('★ 反向守卫：不同项目互不影响（blog 在忙 ≠ 别的项目也忙）', () => {
    s.store.create(base, T0);
    const other = s.store.create({ ...base, projectId: 'other-project', requestKey: 'req-x' }, at(1));
    expect(other.kind).toBe('created');
  });

  it('★ 反向守卫：**去重优先于忙碌**（同 requestKey 的第二次调用必须报 deduped）', () => {
    // 顺序写反的话，第二次调用会被判 busy，调用方就以为「新提交被拒绝了」
    const a = s.store.create(base, T0);
    const again = s.store.create(base, at(1));
    expect(again.kind).toBe('deduped');
    expect(again.task.taskId).toBe(a.task.taskId);
  });

  it('任务结束后同 requestKey 仍然 deduped（不因状态变化而重新建）', () => {
    const a = s.store.create(base, T0);
    s.store.claimNext('alysia-blog', at(1));
    s.store.submitResult(a.task.taskId, { status: 'completed' }, at(2));
    const again = s.store.create(base, at(3));
    expect(again.kind).toBe('deduped');
  });
});

describe('原子认领', () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => { s = makeStore(); });

  it('没有待办 → null（runner 空转是常态，不是错误）', () => {
    expect(s.store.claimNext('alysia-blog', T0)).toBeNull();
  });

  it('★ 认领 → running + attempts + 1', () => {
    const { task } = s.store.create(base, T0) as { task: { taskId: string } };
    const claimed = s.store.claimNext('alysia-blog', at(1))!;
    expect(claimed.taskId).toBe(task.taskId);
    expect(claimed.status).toBe('running');
    expect(claimed.attempts).toBe(1);
  });

  it('★★ 同一个任务不会被认领两次（并发下只能有一个 runner 拿到）', () => {
    s.store.create(base, T0);
    const first = s.store.claimNext('alysia-blog', at(1));
    const second = s.store.claimNext('alysia-blog', at(2));
    expect(first, '第一轮就该认领到').not.toBeNull();
    expect(second, '同一个任务被认领了两遍 —— 两份改同一份工作区').toBeNull();
  });

  it('有多条待办时按 created_at 先来先服务', () => {
    const a = s.store.create(base, T0);
    // 第一条先认领走，才能建下一条（单并发）
    s.store.claimNext('alysia-blog', at(1));
    s.store.submitResult((a as { task: { taskId: string } }).task.taskId, { status: 'completed' }, at(2));
    const b = s.store.create({ ...base, requestKey: 'req-later', goal: '第二件' }, at(3));
    const claimed = s.store.claimNext('alysia-blog', at(4))!;
    expect(claimed.taskId).toBe((b as { task: { taskId: string } }).task.taskId);
  });

  it('★ 反向守卫：只认领**本项目**的任务', () => {
    s.store.create({ ...base, projectId: 'p1', requestKey: 'r1' }, T0);
    expect(s.store.claimNext('p2', at(1)), '认领串项目了').toBeNull();
  });
});

describe('★ 认领后自愈（runner 崩了不能永久占住项目）', () => {
  it('认领超时后可被重新认领（attempts 递增）', () => {
    const s = makeStore({ claimedTimeoutMs: 30 * 60_000 });
    s.store.create(base, T0);
    s.store.claimNext('alysia-blog', at(1));
    // 还没超时：拿不到
    expect(s.store.claimNext('alysia-blog', at(10)), '没超时就回收 = 会把在跑的活抢走').toBeNull();
    // 超时后：可回收
    const again = s.store.claimNext('alysia-blog', at(60))!;
    expect(again.status).toBe('running');
    expect(again.attempts).toBe(2);
  });

  it('★★ 重试次数用尽 → failed（响亮失败，不是静默饿死）', () => {
    const s = makeStore({ claimedTimeoutMs: 10 * 60_000, maxAttempts: 2 });
    const { task } = s.store.create(base, T0) as { task: { taskId: string } };
    s.store.claimNext('alysia-blog', at(1));     // attempts 1
    s.store.claimNext('alysia-blog', at(30));    // 超时 → 回收，attempts 2
    s.store.claimNext('alysia-blog', at(60));    // 超时且用尽 → 该任务转 failed
    const after = s.store.get(task.taskId)!;
    expect(after.status).toBe('failed');
    expect(after.lastError, '失败了却没说为什么').toContain('不再重投');
    // 而且不会再被认领
    expect(s.store.claimNext('alysia-blog', at(90))).toBeNull();
  });

  it('★ 反向守卫：claimedTimeoutMs=0 时关闭回收（不许把在跑的活抢走）', () => {
    const s = makeStore({ claimedTimeoutMs: 0 });
    s.store.create(base, T0);
    s.store.claimNext('alysia-blog', at(1));
    expect(s.store.claimNext('alysia-blog', at(999))).toBeNull();
  });
});

describe('回传结果', () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => { s = makeStore(); });

  it('running → 写入状态/结果/工程会话 id', () => {
    const { task } = s.store.create(base, T0) as { task: { taskId: string } };
    s.store.claimNext('alysia-blog', at(1));
    const after = s.store.submitResult(task.taskId, {
      status: 'needs_review',
      dshSessionId: 'session-abc',
      result: { summary: '页面已生成' },
      artifacts: [{ path: 'about.html', note: '预览' }],
    }, at(2))!;
    expect(after.status).toBe('needs_review');
    expect(after.dshSessionId).toBe('session-abc');
    expect(after.result).toEqual({ summary: '页面已生成' });
    expect(after.artifacts).toEqual([{ path: 'about.html', note: '预览' }]);
  });

  it('★ 失败也有明确证据（last_error 留着）', () => {
    const { task } = s.store.create(base, T0) as { task: { taskId: string } };
    s.store.claimNext('alysia-blog', at(1));
    const after = s.store.submitResult(task.taskId, { status: 'failed', error: '构建失败' }, at(2))!;
    expect(after.status).toBe('failed');
    expect(after.lastError).toBe('构建失败');
  });

  it('★★ 迟到的回传不许覆盖（任务已被回收重认领时）', () => {
    const { task } = s.store.create(base, T0) as { task: { taskId: string } };
    s.store.claimNext('alysia-blog', at(1));
    // 先正常回传一次（此时已不在 running）
    s.store.submitResult(task.taskId, { status: 'completed' }, at(2));
    // 再回传一次（模拟迟到的重复回传）
    const late = s.store.submitResult(task.taskId, { status: 'failed', error: '迟到的' }, at(3));
    expect(late, '迟到的回传把已完成的任务改回失败了').toBeNull();
    expect(s.store.get(task.taskId)!.status).toBe('completed');
  });

  it('**没被认领过**的任务不接受回传（不能凭空写结果）', () => {
    const { task } = s.store.create(base, T0) as { task: { taskId: string } };
    expect(s.store.submitResult(task.taskId, { status: 'completed' }, at(1))).toBeNull();
  });

  it('未知任务回传 → null（不抛）', () => {
    expect(s.store.submitResult('pt-nope', { status: 'completed' }, at(1))).toBeNull();
  });
});

describe('★ 续作（新 revision）', () => {
  let s: ReturnType<typeof makeStore>;
  beforeEach(() => { s = makeStore(); });

  function toNeedsReview() {
    const { task } = s.store.create(base, T0) as { task: { taskId: string } };
    s.store.claimNext('alysia-blog', at(1));
    s.store.submitResult(task.taskId, {
      status: 'needs_review', dshSessionId: 'session-abc', result: { summary: '第一版' },
    }, at(2));
    return task.taskId;
  }

  it('★★ 追加意见 → 回 queued、revision +1、**沿用同一个工程会话**', () => {
    const id = toNeedsReview();
    const after = s.store.addRevision(id, '把标题改短一点', at(3))!;
    expect(after.status).toBe('queued');
    expect(after.revision).toBe(1);
    expect(after.dshSessionId, '丢了工程会话 id —— 第二轮会变成重新建站').toBe('session-abc');
    expect(after.goal).toBe('把标题改短一点');
    // 上一轮结果保留（调用方还能看到），但会被下一轮回传覆盖
    expect(after.result).toEqual({ summary: '第一版' });
  });

  it('★ 续作能被重新认领，且此时 dsh 会话 id 已在（runner 该带 --session-id）', () => {
    const id = toNeedsReview();
    s.store.addRevision(id, '再改一次', at(3));
    const claimed = s.store.claimNext('alysia-blog', at(4))!;
    expect(claimed.revision).toBe(1);
    expect(claimed.dshSessionId).toBe('session-abc');
  });

  it('★ 在途（running/queued）不接受修改意见', () => {
    const { task } = s.store.create(base, T0) as { task: { taskId: string } };
    expect(s.store.addRevision(task.taskId, '插一句话', at(1)), '还没跑完就插话').toBeNull();
    s.store.claimNext('alysia-blog', at(2));
    expect(s.store.addRevision(task.taskId, '再插一句', at(3))).toBeNull();
  });

  it('completed / failed / unknown 都能续作（一轮结束就能提意见）', () => {
    for (const finalStatus of ['completed', 'failed', 'unknown'] as const) {
      const s2 = makeStore();
      const { task } = s2.store.create(base, T0) as { task: { taskId: string } };
      s2.store.claimNext('alysia-blog', at(1));
      s2.store.submitResult(task.taskId, { status: finalStatus, dshSessionId: 'sess-1' }, at(2));
      const after = s2.store.addRevision(task.taskId, '继续', at(3));
      expect(after, `${finalStatus} 之后不能续作 —— 用户提不了意见`).not.toBeNull();
      expect(after!.status).toBe('queued');
    }
  });

  it('未知任务追加意见 → null（不抛）', () => {
    expect(s.store.addRevision('pt-nope', 'x', at(1))).toBeNull();
  });
});
