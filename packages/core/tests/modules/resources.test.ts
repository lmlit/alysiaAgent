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

  // ── ★ 2026-10-16 unify-core-shutdown：停机必须真的关句柄 ──
  it('★ 停机时关闭 SQLite 句柄（旧实现 stop() 只停 EventBus）', async () => {
    const path = join(tmp(), 'close.db');
    const r = await runModule(dbModule, { path });
    const db = r.get<any>('al:db');
    expect(db.open).toBe(true);

    await r.stop();

    expect(db.open, 'stop() 之后句柄仍开着 —— Windows 上临时目录删不掉就是在说这件事').toBe(false);
  });

  it('★ 「关太早」必须**响亮失败**，不是静默丢弃（行为变更）', async () => {
    const path = join(tmp(), 'close2.db');
    const r = await runModule(dbModule, { path });
    const db = r.get<any>('al:db');
    await r.stop();

    // 停机后仍有写入 = 调用方假设错了；必须抛，不许静默成功
    expect(() => db.prepare('SELECT 1 AS x').get()).toThrow(/not open|closed/i);
  });
});

// ── al:vector ─────────────────────────────────────────────────

describe('al:vector', () => {
  it('正常时提供 LanceDB store', async () => {
    const r = await runModule(vectorModule, { dir: join(tmp(), 'lancedb'), table: 'vectors', dimension: 1024 });
    expect(r.get('al:vector')).toBeTruthy();
    await r.stop();
  });

  it('★ 停机时释放 LanceDB 句柄（unify-core-shutdown；尽力而为）', async () => {
    const r = await runModule(vectorModule, { dir: join(tmp(), 'lancedb-close'), table: 'vectors', dimension: 1024 });
    const store = r.get<any>('al:vector');
    expect(store.ready).toBe(true);

    await r.stop();

    // ⚠️ 这里只能断言「本包装放掉了引用」—— LanceDB 是 napi 绑定，
    //    原生侧是否立刻释放（Windows 目录能否删掉）**需要在真实 e2e 里确认**。
    expect(store.ready, 'stop() 后仍持有句柄').toBe(false);
    expect(store.table).toBeNull();
  });

  it('★ 降级路径（提供 null）不应注册关闭 effect —— 没有东西可关', async () => {
    const r = await runModule(vectorModule, { dir: '\0bad\0', table: 'vectors', dimension: 1024 });
    expect(r.get('al:vector')).toBeNull();
    await expect(r.stop()).resolves.toBeUndefined();   // 不因为 null 而抛
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

  // ── 预算观测（change: instrument-memory-llm，spec §4.1.3 契约 5）──────────
  //
  // 记忆链路是**独立于 OpenAIProvider 的第二个 LLM 客户端**，此前一条日志都不打，
  // 于是摘要/画像/cron/人格四个槽位的失败恰好落在观测盲区里。
  // 下面五条守「观测必须存在」且「判定口径必须可区分」。

  it('★ 成功调用留下预算现场：tokens= / finish= / reasoning=', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"summary":"x"}' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1200, completion_tokens: 310, total_tokens: 1510,
          completion_tokens_details: { reasoning_tokens: 242 },
        },
      }),
    })) as any;

    const r = await runModule(memoryLlmModule, cfg);
    await r.get<any>('al:memory-llm').complete('sys', 'usr');

    const line = r.logger.lines.find(l => l.level === 'info' && l.msg.includes('[LLM:memory]'));
    expect(line, '记忆链路必须留一行 [LLM:memory]（此前一条日志都没有）').toBeDefined();
    expect(line!.msg).toContain('tokens=1200+310=1510');
    expect(line!.msg).toContain('finish=stop');
    expect(line!.msg).toContain('reasoning=242');
    await r.stop();
  });

  it('★ 空响应 + finish=length → warn 指向「预算耗尽」（契约 4 的判定现场）', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: {
          prompt_tokens: 900, completion_tokens: 1024, total_tokens: 1924,
          completion_tokens_details: { reasoning_tokens: 1024 },
        },
      }),
    })) as any;

    const r = await runModule(memoryLlmModule, cfg);
    expect(await r.get<any>('al:memory-llm').complete('s', 'u')).toBe('');

    const w = r.logger.lines.find(l => l.level === 'warn' && l.msg.includes('EMPTY content'));
    expect(w).toBeDefined();
    expect(w!.msg).toContain('finish=length');
    expect(w!.msg).toMatch(/max_tokens 预算耗尽/);
    await r.stop();
  });

  it('★ 空响应 + finish=stop → warn 明确说【不是】预算问题（防误导）', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
    })) as any;

    const r = await runModule(memoryLlmModule, cfg);
    await r.get<any>('al:memory-llm').complete('s', 'u');

    const w = r.logger.lines.find(l => l.level === 'warn' && l.msg.includes('EMPTY content'));
    expect(w).toBeDefined();
    expect(w!.msg).toContain('不是预算问题');
    expect(w!.msg).not.toMatch(/max_tokens 预算耗尽/);
    await r.stop();
  });

  it('★ 字段缺失（非推理模型 / 老响应）→ 显示 ? 且不抛不崩', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    })) as any;

    const r = await runModule(memoryLlmModule, cfg);
    expect(await r.get<any>('al:memory-llm').complete('s', 'u')).toBe('ok');

    const line = r.logger.lines.find(l => l.level === 'info' && l.msg.includes('[LLM:memory]'));
    expect(line!.msg).toContain('tokens=?');
    expect(line!.msg).toContain('finish=?');
    expect(line!.msg).toContain('reasoning=?');
    await r.stop();
  });

  it('非 2xx → 抛错且错误文本含响应体（不静默返回空串）', async () => {
    globalThis.fetch = (async () => ({
      ok: false, status: 400, text: async () => '{"error":{"message":"bad json"}}',
    })) as any;

    const r = await runModule(memoryLlmModule, cfg);
    await expect(r.get<any>('al:memory-llm').complete('s', 'u')).rejects.toThrow(/bad json/);
    await r.stop();
  });

  // ── 超时（change: add-memory-llm-timeout，spec §4.1.3 契约 6）────────────
  //
  // 守的是线上那次 117 分钟挂起（KI-21）：记忆链路原先**没有超时**，
  // 断网时请求不会失败、只会挂住——不报错、不降级、不留痕。

  it('★ 请求永不返回 → 在超时点抛错（不再是无限等待）', async () => {
    const r = await runModule(memoryLlmModule, cfg);
    globalThis.fetch = (() => new Promise(() => {})) as any;   // 永不 settle

    vi.useFakeTimers();
    try {
      const p = r.get<any>('al:memory-llm').complete('s', 'u');
      // 必须先挂上断言再推进定时器，否则 rejection 会变成 unhandled
      const assertion = expect(p).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      vi.useRealTimers();
      await r.stop();
    }
  });

  it('★ 超时会 abort 底层 fetch（只抛不 abort 会泄漏连接/socket）', async () => {
    const r = await runModule(memoryLlmModule, cfg);
    let captured: any = null;
    globalThis.fetch = ((_u: any, init: any) => {
      captured = init.signal;
      return new Promise(() => {});
    }) as any;

    vi.useFakeTimers();
    try {
      const p = r.get<any>('al:memory-llm').complete('s', 'u');
      const assertion = expect(p).rejects.toThrow();
      expect(captured, 'fetch 必须拿到 AbortSignal').toBeInstanceOf(AbortSignal);
      expect(captured.aborted, '超时之前不应已 abort').toBe(false);

      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(captured.aborted, '超时后底层 fetch 必须被 abort').toBe(true);
    } finally {
      vi.useRealTimers();
      await r.stop();
    }
  });

  it('正常路径也把 AbortSignal 接线到 fetch（机制确实生效，不是摆设）', async () => {
    let sig: any = null;
    globalThis.fetch = (async (_u: any, init: any) => {
      sig = init.signal;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as any;
    }) as any;

    const r = await runModule(memoryLlmModule, cfg);
    expect(await r.get<any>('al:memory-llm').complete('s', 'u')).toBe('ok');
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig.aborted).toBe(false);
    await r.stop();
  });
});
