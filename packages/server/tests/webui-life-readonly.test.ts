// ★ 9-25 add-life-readonly-endpoints：每日摘要 / 配角在场 两个只读补口
import { describe, it, expect } from 'vitest';
import { createWebuiApp } from '../src/webui/server.js';

function makeCore(overrides: Record<string, any> = {}) {
  return {
    memoryManager: {
      listSessions: () => [],
      listLifeSummaries: () => [],
      listScenePresence: () => [],
      ...overrides,
    },
  };
}

async function buildApp(core: any, opts: Record<string, any> = {}) {
  const app = createWebuiApp(core, { requireAuth: false, ...opts });
  await app.ready();
  return app;
}

describe('GET /api/life/summaries', () => {
  it('返回 { summaries: [...] }，透传 core 结果', async () => {
    const app = await buildApp(
      makeCore({
        listLifeSummaries: () => [
          { date: '2026-08-27', summary: '夜风翻页到暮色染金' },
          { date: '2026-08-28', summary: '昨夜给画册添了颗星' },
        ],
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/life/summaries' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summaries).toHaveLength(2);
    expect(body.summaries[0]).toEqual({ date: '2026-08-27', summary: '夜风翻页到暮色染金' });
  });

  it('空结果返回空数组，不是 null', async () => {
    const app = await buildApp(makeCore());
    const body = (await app.inject({ method: 'GET', url: '/api/life/summaries' })).json();
    expect(Array.isArray(body.summaries)).toBe(true);
    expect(body.summaries).toHaveLength(0);
  });

  it('窗口固定 7 天，与 /api/life 一致', async () => {
    let asked: number | null = null;
    const app = await buildApp(
      makeCore({
        listLifeSummaries: (d: number) => {
          asked = d;
          return [];
        },
      }),
    );
    await app.inject({ method: 'GET', url: '/api/life/summaries' });
    expect(asked).toBe(7);
  });
});

describe('GET /api/life/companions', () => {
  it('返回 { companions: [...] }，含 basis 与 updatedAt', async () => {
    const app = await buildApp(
      makeCore({
        listScenePresence: () => [
          { name: '迷迷', status: 'present', basis: '在我腿上趴了两个多钟头', updatedAt: '2026-09-24T15:59:55.715Z' },
          { name: '阿樟', status: 'off-scene', updatedAt: '2026-09-20T02:00:00.000Z' },
        ],
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/life/companions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.companions).toHaveLength(2);
    expect(body.companions[0].name).toBe('迷迷');
    expect(body.companions[1].basis).toBeUndefined();
  });

  it('空结果返回空数组', async () => {
    const app = await buildApp(makeCore());
    const body = (await app.inject({ method: 'GET', url: '/api/life/companions' })).json();
    expect(body.companions).toEqual([]);
  });
});

describe('新端点与既有路由不冲突', () => {
  it('/api/life/templates 仍可访问（不会被 /api/life/summaries 抢路由）', async () => {
    const app = await buildApp(makeCore({ listLifeTemplates: () => [] }));
    const res = await app.inject({ method: 'GET', url: '/api/life/templates' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('templates');
  });

  it('/api/life 本体不受影响', async () => {
    const app = await buildApp(
      makeCore({
        getLifeSnapshot: () => ({ currentActivity: 'x', mood: 'y', intimacy: 1, moodValue: 0, moodNote: '', updatedAt: '' }),
        listLifeEvents: () => [],
      }),
    );
    const body = (await app.inject({ method: 'GET', url: '/api/life' })).json();
    expect(body).toHaveProperty('snapshot');
    expect(body).toHaveProperty('events');
  });
});

describe('新端点仍受鉴权保护（服务模式）', () => {
  it('无 token → 401', async () => {
    const app = await buildApp(makeCore(), { webuiToken: 'secret-1', requireAuth: true });
    for (const url of ['/api/life/summaries', '/api/life/companions']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('带正确 token → 200', async () => {
    const app = await buildApp(makeCore(), { webuiToken: 'secret-1', requireAuth: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/life/summaries',
      headers: { authorization: 'Bearer secret-1' },
    });
    expect(res.statusCode).toBe(200);
  });
});
