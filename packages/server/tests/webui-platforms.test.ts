// ★ 2026-10-16 · change: add-platforms-endpoint
// `GET /api/platforms` —— 契约在 `docs/Web-API-Design.md` §3.4，
// 此前**全仓没有实现**（唯一"文档了但完全没做"的接口）。
import { describe, it, expect, vi } from 'vitest';
import { createWebuiApp } from '../src/webui/server.js';

function makeCore(overrides: Record<string, any> = {}) {
  return { ...overrides };
}

async function buildApp(core: any) {
  const app = createWebuiApp(core, { requireAuth: false });
  await app.ready();
  return app;
}

describe('GET /api/platforms', () => {
  it('★ 透传 core 的平台快照', async () => {
    const getPlatformStatus = vi.fn(() => ({
      platforms: [
        { name: 'qq-official-1::private', scheduler: 'default' as const },
        { name: 'telegram::private', scheduler: 'custom' as const },
      ],
      count: 2,
    }));
    const app = await buildApp(makeCore({ getPlatformStatus }));

    const res = await app.inject({ method: 'GET', url: '/api/platforms' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      platforms: [
        { name: 'qq-official-1::private', scheduler: 'default' },
        { name: 'telegram::private', scheduler: 'custom' },
      ],
      count: 2,
    });
    expect(getPlatformStatus).toHaveBeenCalledTimes(1);
  });

  it('★ 一个平台都没接 → 空列表而不是 null（Web 端不该处理两种形状）', async () => {
    const app = await buildApp(makeCore({
      getPlatformStatus: () => ({ platforms: [], count: 0 }),
    }));

    const body = (await app.inject({ method: 'GET', url: '/api/platforms' })).json();

    expect(Array.isArray(body.platforms)).toBe(true);
    expect(body.platforms).toHaveLength(0);
    expect(body.count).toBe(0);
  });

  it('★ 不编造连接层字段（core 看不到适配器的 WebSocket 状态）', async () => {
    const app = await buildApp(makeCore({
      getPlatformStatus: () => ({ platforms: [{ name: 'a::private', scheduler: 'default' }], count: 1 }),
    }));

    const body = (await app.inject({ method: 'GET', url: '/api/platforms' })).json();
    const p = body.platforms[0];

    // 刻意断言"没有"：这些字段一旦凭空出现，Web 端会把它当成真实连接状态
    expect(p).not.toHaveProperty('connected');
    expect(p).not.toHaveProperty('lastHeartbeat');
    expect(p).not.toHaveProperty('lastMessageAt');
  });
});
