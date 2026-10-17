/**
 * `AlysiaClient` 单测。
 *
 * ★★ 最该守的一条：**一切调用永不抛出**。
 *    alysia server 没起是常态（用户可能根本没开它），
 *    这个通道是「锦上添花」，它的失败**绝不能**让 dsh 的会话不可用。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlysiaClient, DEFAULT_ALYSIA_BASE_URL, TOKEN_ENV_VAR } from '../src/alysia-client.ts';

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

/** 让 fetch 抛指定错误 */
function fetchThrows(err: Error): void {
  globalThis.fetch = (async () => { throw err; }) as never;
}

/** 让 fetch 返回指定响应 */
function fetchReturns(body: unknown, status = 200): void {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as never;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('构造', () => {
  it('默认基址是本地 alysia 端口', () => {
    expect(DEFAULT_ALYSIA_BASE_URL).toBe('http://127.0.0.1:6185');
  });

  it('基址尾部斜杠会被去掉（避免拼出 //api）', async () => {
    let url = '';
    globalThis.fetch = (async (u: string) => {
      url = String(u);
      return { ok: true, json: async () => ({ prompt: 'x' }) };
    }) as never;
    await new AlysiaClient({ baseUrl: 'http://127.0.0.1:6185///' }).getPersonaPrompt();
    expect(url).toBe('http://127.0.0.1:6185/api/persona/prompt');
  });
});

describe('★ 永不抛出（alysia 挂了 dsh 必须照常可用）', () => {
  it.each([
    ['连接被拒', new Error('fetch failed')],
    ['超时', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['DNS 失败', new Error('getaddrinfo ENOTFOUND')],
  ])('%s → 读路径返回 null / 回传标记可重试，都不抛', async (_label, err) => {
    fetchThrows(err);
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger: makeLogger() });
    await expect(c.getPersonaPrompt()).resolves.toBeNull();
    // ★ 契约 3（fix-dsh-ingest-and-settlement）：回传**不再压成 null** ——
    //   「连不上」（可重试）必须与服务端「拒收」（重试无用）区分开。
    await expect(c.ingest([{ id: 'x' } as never])).resolves.toMatchObject({ kind: 'unreachable' });
    await expect(c.extractSession('dsh:s')).resolves.toBe(false);
  });

  it('HTTP 非 2xx → 返回 null，且把响应体带进日志（只说 HTTP 400 等于没说）', async () => {
    fetchReturns({ error: 'events 必须是非空数组' }, 400);
    const logger = makeLogger();
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger });
    await expect(c.getPersonaPrompt()).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 400'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('events 必须是非空数组'));
  });

  it('响应不是 JSON → 返回 null 而不是抛', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    })) as never;
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger: makeLogger() });
    await expect(c.getPersonaPrompt()).resolves.toBeNull();
  });
});

describe('失败降噪', () => {
  it('连续失败只吼前 3 次（alysia 没起时每轮都失败，会把 dsh 日志淹掉）', async () => {
    fetchThrows(new Error('fetch failed'));
    const logger = makeLogger();
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger });
    for (let i = 0; i < 6; i++) await c.getPersonaPrompt();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls[2][0]).toContain('后续同类失败将静默');
  });

  it('成功一次后重新开始报（不是永久闭嘴）', async () => {
    const logger = makeLogger();
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger });
    fetchThrows(new Error('x'));
    for (let i = 0; i < 5; i++) await c.getPersonaPrompt();
    fetchReturns({ prompt: 'ok' });
    await c.getPersonaPrompt();
    fetchThrows(new Error('x'));
    await c.getPersonaPrompt();
    expect(logger.warn).toHaveBeenCalledTimes(4); // 3 次降噪 + 恢复后的这一次
  });
});

describe('getPersonaPrompt', () => {
  it('拿到非空 prompt', async () => {
    fetchReturns({ prompt: '你是昔涟本人……' });
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(c.getPersonaPrompt()).resolves.toBe('你是昔涟本人……');
  });

  it.each([
    ['空串', { prompt: '' }],
    ['缺字段', {}],
    ['类型不对', { prompt: 123 }],
  ])('%s → null（调用方据此保留旧人设，而不是把它清空）', async (_l, body) => {
    fetchReturns(body);
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(c.getPersonaPrompt()).resolves.toBeNull();
  });
});

describe('ingest', () => {
  it('空批次直接返回，不发请求', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as never;
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(c.ingest([])).resolves.toEqual({ kind: 'ok', accepted: 0, rejected: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('POST /api/ingest，带 { events } 包体', async () => {
    let url = ''; let init: any = null;
    globalThis.fetch = (async (u: string, i: any) => {
      url = String(u); init = i;
      return { ok: true, json: async () => ({ ok: true, accepted: 2, rejected: [] }) };
    }) as never;
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' });
    const r = await c.ingest([{ id: 'a' } as never, { id: 'b' } as never]);
    expect(url).toBe('http://127.0.0.1:1/api/ingest');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).events).toHaveLength(2);
    expect(r).toEqual({ kind: 'ok', accepted: 2, rejected: [] });
  });

  it('把服务端的 rejected 原样带回来（静默丢弃会让「回传成功」和「没进库」长得一样）', async () => {
    fetchReturns({ ok: true, accepted: 1, rejected: ['qq-bad: session_id 必须以 "dsh:" 开头'] });
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' });
    const r = await c.ingest([{ id: 'a' } as never]);
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' ? r.rejected[0] : '').toContain('dsh:');
  });
});

/**
 * ★ 契约 3：三类必须分得开。
 *
 * 旧契约把它们全压成 `null` ⇒ 上层只能把 413 也当「alysia 不可达」放回队列，
 * 于是**同样的输入永远重复同一个 413**，队列永久卡死（KI-24 的邻居缺陷）。
 */
describe('★ ingest 的故障分类（契约 3）', () => {
  const one = [{ id: 'a' } as never];

  it('4xx → permanent（重试无用）', async () => {
    fetchReturns({ error: 'events 必须是非空数组' }, 400);
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger: makeLogger() });
    const r = await c.ingest(one);
    expect(r.kind).toBe('permanent');
    expect(r.kind === 'permanent' ? r.reason : '').toContain('400');
  });

  it('★ 413（契约漂移：服务端上限被下调）→ permanent，不许当可重试', async () => {
    fetchReturns({ error: '单批最多 200 条' }, 413);
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger: makeLogger() });
    const r = await c.ingest(one);
    expect(r.kind, '413 被当成可重试 ⇒ 同样的输入会无限重复同一个 413').toBe('permanent');
    expect(r.kind === 'permanent' ? r.reason : '').toContain('413');
  });

  it('5xx → unreachable（服务端暂时故障，可重试）', async () => {
    fetchReturns({ error: 'internal' }, 503);
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger: makeLogger() });
    const r = await c.ingest(one);
    expect(r.kind).toBe('unreachable');
  });
});

describe('extractSession', () => {
  it('POST 到 /api/sessions/<编码后的 id>/extract', async () => {
    let url = '';
    globalThis.fetch = (async (u: string) => {
      url = String(u);
      return { ok: true, json: async () => ({ factsExtracted: 1 }) };
    }) as never;
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(c.extractSession('dsh:sess/with slash')).resolves.toBe(true);
    // id 必须编码 —— 裸斜杠会把路径拆成两段
    expect(url).toBe('http://127.0.0.1:1/api/sessions/dsh%3Asess%2Fwith%20slash/extract');
  });
});

/**
 * ★ 2026-10-17（change: `connect-server-dsh-bridge`）：Bearer 鉴权。
 *
 * 为什么值得单独守：alysia 在**需要鉴权**的部署下（绑非回环地址）对 `/api/*`
 * 强制 `Authorization: Bearer <token>`，而本客户端按设计 best-effort 降级
 * ⇒ 漏带这个头的症状只是「人设/记忆全空」，**不报错、不留痕**。
 * 服务器侧实测 `鉴权: 开`，所以这条是「桥接能不能用」的硬前提。
 *
 * 同时守反向：**没配 token 时不许偷偷带一个空 Authorization**——
 * 那会让「本机免鉴权部署」与「配错 token」两种情形长得一样。
 */
describe('★ Bearer 鉴权（connect-server-dsh-bridge）', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[TOKEN_ENV_VAR]; delete process.env[TOKEN_ENV_VAR]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[TOKEN_ENV_VAR];
    else process.env[TOKEN_ENV_VAR] = saved;
  });

  /** 抓一次请求的 headers */
  async function captureHeaders(client: AlysiaClient): Promise<Record<string, string>> {
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_u: string, i: any) => {
      headers = i.headers ?? {};
      return { ok: true, json: async () => ({ prompt: 'x' }) };
    }) as never;
    await client.getPersonaPrompt();
    return headers;
  }

  it('显式 token → 发 Authorization: Bearer', async () => {
    const h = await captureHeaders(new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', token: 'secret-token' }));
    expect(h.Authorization).toBe('Bearer secret-token');
  });

  it('缺省从环境变量取 token', async () => {
    process.env[TOKEN_ENV_VAR] = 'from-env';
    const h = await captureHeaders(new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' }));
    expect(h.Authorization).toBe('Bearer from-env');
  });

  it('显式 token 优先于环境变量', async () => {
    process.env[TOKEN_ENV_VAR] = 'from-env';
    const h = await captureHeaders(new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', token: 'explicit' }));
    expect(h.Authorization).toBe('Bearer explicit');
  });

  it('★ 没配 token → 不带 Authorization 头（不是空值头）', async () => {
    const h = await captureHeaders(new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' }));
    expect(h.Authorization).toBeUndefined();
    expect(h['Content-Type']).toBe('application/json');
  });

  it('显式空串 = 明确不带（即使环境变量配了）', async () => {
    process.env[TOKEN_ENV_VAR] = 'from-env';
    const h = await captureHeaders(new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', token: '' }));
    expect(h.Authorization).toBeUndefined();
  });

  it('401 时把响应体带进日志（否则「没配 token」与「token 错」分不开）', async () => {
    fetchReturns({ error: 'unauthorized' }, 401);
    const logger = makeLogger();
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger });
    await expect(c.getPersonaPrompt()).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('401'));
  });
});
