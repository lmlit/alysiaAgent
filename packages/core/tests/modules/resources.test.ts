/**
 * 基础资源模块（`modules/resources.ts`）单测。
 *
 * 重点守两条**容易静默失效**的语义：
 *   ① LanceDB 失败必须降级（提供 null）而不是中止整树；
 *   ② 采样槽必须真的进到请求体（`slotToBody` 的接线）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dbModule, vectorModule, embedModule, memoryLlmModule } from '../../src/modules/resources.js';
import { runModule } from './helpers.js';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'alysia-mod-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄未释放，留给 OS */ }
  }
});

// ── al:db ─────────────────────────────────────────────────────

describe('al:db', () => {
  it('建库并初始化 schema，然后把句柄作为服务提供出去', async () => {
    const path = join(tmp(), 'alysia.db');
    const r = await runModule(dbModule, { path });

    const db = r.get<any>('al:db');
    expect(db).toBeDefined();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => t.name);
    expect(tables).toContain('events');   // initializeDatabase 建的核心表
    expect(tables).toContain('user_profile');
    await r.stop();
  });

  it('缺配置时立刻抛错（不建到 cwd 去）', async () => {
    await expect(runModule(dbModule, undefined as never)).rejects.toThrow(/缺少配置/);
  });
});

// ── al:vector ─────────────────────────────────────────────────

describe('al:vector', () => {
  it('正常时提供 LanceDB store', async () => {
    const r = await runModule(vectorModule, { dir: join(tmp(), 'lancedb'), table: 'vectors', dimension: 1024 });
    expect(r.get('al:vector')).toBeTruthy();
    await r.stop();
  });

  it('★ 失败时降级：提供 null 并 warn，**不中止整树**', async () => {
    // 用非法目录（Windows 上 NUL 是保留名）逼 LanceDB 初始化失败
    const r = await runModule(vectorModule, { dir: '\0bad\0', table: 'vectors', dimension: 1024 });

    // 模块照常装上（critical:false），服务值是 null —— 上层据此走文本检索兜底
    expect(r.host.has('al:vector')).toBe(true);
    expect(r.get('al:vector')).toBeNull();
    expect(
      r.logger.lines.some(l => l.level === 'warn' && /using text search fallback/.test(l.msg)),
      '降级必须是 warn 级且带原因（原语义：logger.warn 不是 error）',
    ).toBe(true);
    await r.stop();
  });
});

// ── al:embed ──────────────────────────────────────────────────

describe('al:embed', () => {
  const cfg = { baseUrl: 'https://embed.test/v1', apiKey: 'k', model: 'embedding-2' };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('embed() 打对端点、带 Bearer、返回向量；dimension() 固定 1024', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedAuth = '';
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      capturedAuth = init.headers['Authorization'];
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) } as any;
    }) as any;

    const r = await runModule(embedModule, cfg);
    const svc = r.get<any>('al:embed');

    expect(await svc.embed('你好')).toEqual([0.1, 0.2, 0.3]);
    expect(capturedUrl).toBe('https://embed.test/v1/embeddings');
    expect(capturedAuth).toBe('Bearer k');
    expect(capturedBody).toEqual({ model: 'embedding-2', input: '你好' });
    expect(svc.dimension()).toBe(1024);
    await r.stop();
  });

  it('响应体异常时抛错并带上原文（不静默返回空向量）', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ unexpected: 'shape' }),
    })) as any;

    const r = await runModule(embedModule, cfg);
    await expect(r.get<any>('al:embed').embed('x')).rejects.toThrow(/unexpected response/);
    await r.stop();
  });
});

// ── al:memory-llm ─────────────────────────────────────────────

describe('al:memory-llm', () => {
  const cfg = { baseUrl: 'https://chat.test/v1', apiKey: 'k', model: 'deepseek-v4-flash' };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('★ 第三参 sampling 必须进到请求体（分槽机制的实际落点）', async () => {
    let body: any = null;
    globalThis.fetch = (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as any;
    }) as any;

    const r = await runModule(memoryLlmModule, cfg);
    const out = await r.get<any>('al:memory-llm').complete('sys', 'usr', {
      temperature: 0.1,
      max_tokens: 4096,
      response_format: 'json_object',
    });

    expect(out).toBe('ok');
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(4096);
    // provider 侧要把 'json_object' 包成 { type: 'json_object' }
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    await r.stop();
  });

  it('不传 sampling 时请求体里没有这些字段（走服务端默认）', async () => {
    let body: any = null;
    globalThis.fetch = (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as any;
    }) as any;

    const r = await runModule(memoryLlmModule, cfg);
    await r.get<any>('al:memory-llm').complete('s', 'u');
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    await r.stop();
  });
});
