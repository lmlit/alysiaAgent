// ★ 8-29 cr-p0-webui-auth：Bearer token 鉴权（服务模式强制，桌面模式豁免，health 豁免）
import { describe, it, expect, beforeEach } from 'vitest';
import { createWebuiApp } from '../src/webui/server.js';

/** mock core：最小方法集（/api/sessions 只依赖 listSessions） */
function makeCore(overrides: Record<string, any> = {}) {
  return {
    memoryManager: {
      listSessions: () => [],
      ...(overrides as Record<string, any>),
    },
  };
}

async function buildApp(opts: { webuiToken?: string; requireAuth?: boolean }, core: any) {
  const app = createWebuiApp(core, opts);
  await app.ready();
  return app;
}

describe('WebUI auth (cr-p0-webui-auth)', () => {
  beforeEach(() => {});

  it('服务模式 + 已配置 token：无 token → 401', async () => {
    const app = await buildApp({ webuiToken: 'secret-1', requireAuth: true }, makeCore());
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('服务模式 + 已配置 token：错误 token → 401', async () => {
    const app = await buildApp({ webuiToken: 'secret-1', requireAuth: true }, makeCore());
    const res = await app.inject({
      method: 'GET', url: '/api/sessions',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('服务模式 + 已配置 token：正确 token → 200', async () => {
    const app = await buildApp({ webuiToken: 'secret-1', requireAuth: true }, makeCore());
    const res = await app.inject({
      method: 'GET', url: '/api/sessions',
      headers: { authorization: 'Bearer secret-1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('服务模式 + 已配置 token：/api/health 豁免（容器 healthcheck 无 token）', async () => {
    const app = await buildApp({ webuiToken: 'secret-1', requireAuth: true }, makeCore());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('服务模式 + 未配置 token：fail closed——所有 /api/* 全 401（杜绝零鉴权裸奔）', async () => {
    const app = await buildApp({ webuiToken: '', requireAuth: true }, makeCore());
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('桌面模式（requireAuth=false）：免鉴权', async () => {
    const app = await buildApp({ webuiToken: '', requireAuth: false }, makeCore());
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
  });

  // ★ 9-24 console-local-serve 回归：原实现拦下**所有**请求（不只是 /api/*），
  //   导致浏览器导航到 `/` 拿 401、前端页面根本加载不出来。
  //   上面那批用例只测 /api/* 路径，所以没抓住这个 bug——这里补上非 API 路径。
  it('服务模式：静态路径不被鉴权拦截（浏览器导航带不上 Authorization 头）', async () => {
    const app = await buildApp({ webuiToken: 'secret-1', requireAuth: true }, makeCore());
    for (const url of ['/', '/life', '/_next/static/chunk.js', '/favicon.ico']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} 不应是 401`).not.toBe(401);
    }
  });

  it('服务模式：未配置 token 时静态路径仍可访问（fail closed 只针对 /api/*）', async () => {
    const app = await buildApp({ webuiToken: '', requireAuth: true }, makeCore());
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).not.toBe(401);
  });

  it('服务模式：带 query 的 /api/* 仍受保护（不能被 ? 绕过）', async () => {
    const app = await buildApp({ webuiToken: 'secret-1', requireAuth: true }, makeCore());
    const res = await app.inject({ method: 'GET', url: '/api/sessions?limit=1' });
    expect(res.statusCode).toBe(401);
  });

  it('服务模式：带 query 的 /api/health 仍豁免（原本只精确匹配无 query 形式）', async () => {
    const app = await buildApp({ webuiToken: 'secret-1', requireAuth: true }, makeCore());
    const res = await app.inject({ method: 'GET', url: '/api/health?probe=1' });
    expect(res.statusCode).toBe(200);
  });
});
