/**
 * `AlysiaClient` 单测。
 *
 * ★★ 最该守的一条：**一切调用永不抛出**。
 *    alysia server 没起是常态（用户可能根本没开它），
 *    这个通道是「锦上添花」，它的失败**绝不能**让 dsh 的会话不可用。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlysiaClient, DEFAULT_ALYSIA_BASE_URL } from '../src/alysia-client.ts';

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
  ])('%s → 返回 null 而不是抛', async (_label, err) => {
    fetchThrows(err);
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', logger: makeLogger() });
    await expect(c.getPersonaPrompt()).resolves.toBeNull();
    await expect(c.ingest([{ id: 'x' } as never])).resolves.toBeNull();
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
    await expect(c.ingest([])).resolves.toEqual({ accepted: 0, rejected: [] });
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
    expect(r).toEqual({ accepted: 2, rejected: [] });
  });

  it('把服务端的 rejected 原样带回来（静默丢弃会让「回传成功」和「没进库」长得一样）', async () => {
    fetchReturns({ ok: true, accepted: 1, rejected: ['qq-bad: session_id 必须以 "dsh:" 开头'] });
    const c = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1' });
    const r = await c.ingest([{ id: 'a' } as never]);
    expect(r?.rejected[0]).toContain('dsh:');
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
