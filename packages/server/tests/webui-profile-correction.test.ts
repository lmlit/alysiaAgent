// ★ 2026-10-16 · 最小版记忆纠正：画像纠正/失效两个写端点
//
// 背景：`MemoryManager.confirmProfileFact` 与 `ProfileStore.confirmFact`
// **早就实现了，但全仓没有任何调用方** —— 能力一直不可达
// （`/api/profile` 只能看、不能改）。这里补上写通道，并锁住三件事：
//   ① `?includeSuperseded=1` 才带已作废的
//   ② 纠正失败**不静默吞**（400 + 具体原因）
//   ③ `confirm` 的 `ok=false`（没找到）与"操作失败"是**两回事**，都要如实返回
import { describe, it, expect, vi } from 'vitest';
import { createWebuiApp } from '../src/webui/server.js';

function makeCore(overrides: Record<string, any> = {}) {
  return {
    memoryManager: {
      getProfileSnapshot: () => ({ facts: [], characterFacts: [], basics: '{}', preferences: '{}' }),
      correctProfileFact: vi.fn(() => ({ superseded: true, added: true })),
      confirmProfileFact: vi.fn(() => true),
      ...overrides,
    },
  };
}

async function buildApp(core: any) {
  const app = createWebuiApp(core, { requireAuth: false });
  await app.ready();
  return app;
}

describe('GET /api/profile — includeSuperseded', () => {
  it('默认**不带** includeSuperseded（画像展示只要"她现在相信的"）', async () => {
    const snapshot = vi.fn(() => ({ facts: [], characterFacts: [], basics: '{}', preferences: '{}' }));
    const app = await buildApp(makeCore({ getProfileSnapshot: snapshot }));

    await app.inject({ method: 'GET', url: '/api/profile' });

    expect(snapshot).toHaveBeenCalledWith({ includeSuperseded: false });
  });

  it('★ ?includeSuperseded=1 → 连已作废的一起返回（纠正页要能确认"真的失效了"）', async () => {
    const snapshot = vi.fn(() => ({ facts: [], characterFacts: [], basics: '{}', preferences: '{}' }));
    const app = await buildApp(makeCore({ getProfileSnapshot: snapshot }));

    await app.inject({ method: 'GET', url: '/api/profile?includeSuperseded=1' });

    expect(snapshot).toHaveBeenCalledWith({ includeSuperseded: true });
  });
});

describe('POST /api/profile/facts/correct', () => {
  it('★ 纠正成功 → 透传 { superseded, added }', async () => {
    const correct = vi.fn(() => ({ superseded: true, added: true }));
    const app = await buildApp(makeCore({ correctProfileFact: correct }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/profile/facts/correct',
      payload: { oldFact: '用户在长沙', newFact: '用户在上海' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, superseded: true, added: true });
    expect(correct).toHaveBeenCalledWith('用户在长沙', '用户在上海');
  });

  it('★ 旧事实没找到（superseded=false）也要如实返回，**不当失败**', async () => {
    const app = await buildApp(makeCore({
      correctProfileFact: () => ({ superseded: false, added: true }),
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/profile/facts/correct',
      payload: { oldFact: '不存在', newFact: '用户喜欢雨天' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, superseded: false, added: true });
  });

  it.each([
    ['缺 oldFact', { newFact: 'x' }],
    ['oldFact 为空', { oldFact: '   ', newFact: 'x' }],
    ['缺 newFact', { oldFact: 'x' }],
    ['newFact 为空', { oldFact: 'x', newFact: '' }],
    ['类型不对', { oldFact: 1, newFact: 2 }],
  ])('%s → 400 且带具体原因（不静默）', async (_label, payload) => {
    const correct = vi.fn();
    const app = await buildApp(makeCore({ correctProfileFact: correct }));

    const res = await app.inject({ method: 'POST', url: '/api/profile/facts/correct', payload });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/oldFact|newFact/);
    expect(correct, '参数不合就不该进 core').not.toHaveBeenCalled();
  });

  it('★ core 抛错 → 400 + 原因（不许 500 也不许假装成功）', async () => {
    const app = await buildApp(makeCore({
      correctProfileFact: () => { throw new Error('新事实不能为空'); },
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/profile/facts/correct',
      payload: { oldFact: 'a', newFact: 'b' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('新事实不能为空');
  });
});

describe('POST /api/profile/facts/confirm — 失效 / 续期', () => {
  it('★ stillValid=false → 让事实失效（这就是"使旧事实失效"的通道）', async () => {
    const confirm = vi.fn(() => true);
    const app = await buildApp(makeCore({ confirmProfileFact: confirm }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/profile/facts/confirm',
      payload: { fact: '用户在长沙', stillValid: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, found: true });
    expect(confirm).toHaveBeenCalledWith('用户在长沙', false);
  });

  it('★ 没找到这条事实（ok=false）→ 仍是 200，但 found=false（与"操作失败"区分开）', async () => {
    const app = await buildApp(makeCore({ confirmProfileFact: () => false }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/profile/facts/confirm',
      payload: { fact: '根本没这条', stillValid: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, found: false });
  });

  it.each([
    ['缺 fact', { stillValid: false }],
    ['fact 为空', { fact: '', stillValid: false }],
    ['缺 stillValid', { fact: 'x' }],
    ['stillValid 不是布尔', { fact: 'x', stillValid: 'yes' }],
  ])('%s → 400（不把 undefined 当 false 用）', async (_label, payload) => {
    const confirm = vi.fn();
    const app = await buildApp(makeCore({ confirmProfileFact: confirm }));

    const res = await app.inject({ method: 'POST', url: '/api/profile/facts/confirm', payload });

    expect(res.statusCode).toBe(400);
    expect(confirm).not.toHaveBeenCalled();
  });
describe('事实冲突 API（2026-10-28 resolve-fact-conflicts）', () => {
  it('GET /api/profile/conflicts → pending + stats', async () => {
    const app = await buildApp(makeCore({
      listFactConflicts: () => [{ id: 'fc-1', old_fact: '长沙', new_fact: '杭州' }],
      getFactConflictStats: () => ({ pending: 1, kept_old: 0, kept_new: 0, expired: 0 }),
    }));
    const res = await app.inject({ method: 'GET', url: '/api/profile/conflicts' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, pending: [{ id: 'fc-1' }], stats: { pending: 1 } });
  });

  it('POST /resolve：keep 非法 → 400；成功 → 透传', async () => {
    const resolve = vi.fn(() => ({ ok: true, oldFact: '长沙', newFact: '杭州' }));
    const app = await buildApp(makeCore({ resolveFactConflict: resolve }));

    const bad = await app.inject({ method: 'POST', url: '/api/profile/conflicts/fc-1/resolve', payload: { keep: 'x' } });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({ method: 'POST', url: '/api/profile/conflicts/fc-1/resolve', payload: { keep: 'new' } });
    expect(good.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith('fc-1', 'new');
    expect(good.json()).toMatchObject({ ok: true, newFact: '杭州' });
  });

  it('POST /resolve：已裁决/找不到 → 404', async () => {
    const app = await buildApp(makeCore({
      resolveFactConflict: () => ({ ok: false, error: 'conflict already kept_old' }),
    }));
    const res = await app.inject({ method: 'POST', url: '/api/profile/conflicts/fc-1/resolve', payload: { keep: 'old' } });
    expect(res.statusCode).toBe(404);
  });
});

});
