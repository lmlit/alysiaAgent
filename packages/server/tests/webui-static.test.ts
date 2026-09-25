// ★ 9-24 console-local-serve：静态托管支持两种前端形态
//   - webui（Vue hash SPA）：未知路径回退 index.html
//   - console（Next.js 静态导出，多页）：/life → life.html；未命中 → 404.html
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWebuiApp } from '../src/webui/server.js';

function makeCore() {
  return { memoryManager: { listSessions: () => [] } };
}

/** 造一个假的产物目录 */
function makeDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'alysia-dist-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

async function buildApp(staticDist: string) {
  const app = createWebuiApp(makeCore(), { requireAuth: false, staticDist });
  await app.ready();
  return app;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function track(d: string) {
  dirs.push(d);
  return d;
}

// Next.js 静态导出的典型结构
let nextDist: string;
let spaDist: string;

beforeAll(() => {
  nextDist = track(
    makeDist({
      'index.html': '<title>LANDING</title>',
      'life.html': '<title>LIFE-PAGE</title>',
      'dashboard.html': '<title>DASH-PAGE</title>',
      '404.html': '<title>NOT-FOUND</title>',
      '_next/static/chunk.js': 'console.log(1)',
      '_next/static/media/font.woff2': 'FONTBYTES',
      'dashboard/index.html': '<title>DASH-DIR</title>',
    }),
  );
  // Vue SPA（hash 路由）：只有 index.html，没有 404.html
  spaDist = track(
    makeDist({
      'index.html': '<title>SPA-INDEX</title>',
      'assets/main.js': 'console.log(2)',
    }),
  );
});

describe('静态托管 — Next.js 多页导出', () => {
  it('/ 返回首页', async () => {
    const app = await buildApp(nextDist);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('LANDING');
  });

  it('/life 返回 life.html（不是首页——旧实现会回退 index.html）', async () => {
    const app = await buildApp(nextDist);
    const res = await app.inject({ method: 'GET', url: '/life' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('LIFE-PAGE');
  });

  it('/life/ 带尾斜杠同样命中', async () => {
    const app = await buildApp(nextDist);
    const res = await app.inject({ method: 'GET', url: '/life/' });
    expect(res.body).toContain('LIFE-PAGE');
  });

  it('目录形式 index.html 也能命中（兼容 trailingSlash 构建）', async () => {
    const app = await buildApp(nextDist);
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    // dashboard.html 优先于 dashboard/index.html
    expect(res.body).toContain('DASH-PAGE');
  });

  it('未知路径 → 404.html 且状态码 404（不是假装成功的首页）', async () => {
    const app = await buildApp(nextDist);
    const res = await app.inject({ method: 'GET', url: '/no-such-page' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('NOT-FOUND');
  });

  it('静态资源按路径直接命中，MIME 正确', async () => {
    const app = await buildApp(nextDist);
    const js = await app.inject({ method: 'GET', url: '/_next/static/chunk.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');

    const font = await app.inject({ method: 'GET', url: '/_next/static/media/font.woff2' });
    expect(font.statusCode).toBe(200);
    expect(font.headers['content-type']).toContain('font/woff2');
  });

  it('html 不缓存，静态资源长缓存', async () => {
    const app = await buildApp(nextDist);
    const html = await app.inject({ method: 'GET', url: '/life' });
    expect(html.headers['cache-control']).toContain('no-cache');
    const js = await app.inject({ method: 'GET', url: '/_next/static/chunk.js' });
    expect(js.headers['cache-control']).toContain('max-age');
  });

  it('/api/* 未知路径返回 JSON 404，不回退到 HTML', async () => {
    const app = await buildApp(nextDist);
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false });
  });
});

describe('静态托管 — webui SPA（hash 路由）', () => {
  it('未知路径回退 index.html 且 200（hash 路由行为不变）', async () => {
    const app = await buildApp(spaDist);
    const res = await app.inject({ method: 'GET', url: '/anything/deep' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA-INDEX');
  });

  it('资源仍按路径命中', async () => {
    const app = await buildApp(spaDist);
    const res = await app.inject({ method: 'GET', url: '/assets/main.js' });
    expect(res.statusCode).toBe(200);
  });
});

describe('静态托管 — 目录回退与安全', () => {
  it('staticDist 不存在 → 回退默认前端，不崩', async () => {
    const app = await buildApp(join(tmpdir(), 'definitely-not-here-' + Date.now()));
    // 不管默认 dist 是否存在，都不应因路径参数而 5xx
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBeLessThan(500);
  });

  it('目录穿越被挡（不读出产物目录外的文件）', async () => {
    const app = await buildApp(nextDist);
    // 编码后的 ../  与原始形式都应被拒或落回 404，不泄露文件
    for (const url of ['/../../package.json', '/%2e%2e%2f%2e%2e%2fpackage.json']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toContain('"name"');
    }
  });

  it('畸形百分号编码不 5xx', async () => {
    const app = await buildApp(nextDist);
    const res = await app.inject({ method: 'GET', url: '/%E0%A4%A' });
    expect(res.statusCode).toBeLessThan(500);
  });
});
