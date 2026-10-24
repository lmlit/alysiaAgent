/**
 * `AlysiaClient.readMemory()` 的**请求体契约**
 * （★ 2026-10-24，change: `align-dsh-memory-blocks-with-scope`）。
 *
 * 这个测试存在的唯一理由：dsh 侧**必须显式**告诉服务端两个字段。
 *
 *   - `blocks: 'chat'`          → 要人味块（code 表里一个都没有）
 *   - `worldbookScope: 'code'`  → 要 code scope 的世界书，**并且靠"显式给出"触发注入**
 *
 * 少传任何一个，就会退回到"mode 一词三义"的老毛病：默认 chat ⇒ 世界书 triggers
 * 匹配完被组装器扔掉 ⇒ dsh 的世界书一条都进不了 prompt（潜伏了一个月的那个洞）。
 * 这个 bug 是**静默**的，所以只能靠断言请求体来钉住。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AlysiaClient } from '../src/alysia-client.ts';

describe('readMemory() 请求体', () => {
  let captured: any;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    captured = null;
    globalThis.fetch = (async (_url: string, init: any) => {
      captured = init?.body ? JSON.parse(init.body) : null;
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ context: '记忆块', retrieved: [] }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  it('★ 必须带 blocks=chat 与 worldbookScope=code', async () => {
    const client = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', token: '' });
    const r = await client.readMemory('他上次说的猫', 'dsh:sess-1');

    expect(r?.context).toBe('记忆块');
    expect(captured, '请求体没发出去').toBeTruthy();
    expect(captured.query).toBe('他上次说的猫');
    expect(captured.sessionId).toBe('dsh:sess-1');
    expect(captured.limit).toBe(5);
    // ↓ 这两行就是本 change 的全部意义
    expect(captured.blocks, '少传 blocks ⇒ 落到 chat 块表靠的是默认值，不该靠运气').toBe('chat');
    expect(captured.worldbookScope, '少传 scope ⇒ 世界书 triggers 会被静默丢弃').toBe('code');
  });

  it('预热（空 query）也带同样两个字段 —— 否则第一轮世界书仍然进不来', async () => {
    const client = new AlysiaClient({ baseUrl: 'http://127.0.0.1:1', token: '' });
    await client.readMemory('');
    expect(captured.query).toBe('');
    expect(captured.blocks).toBe('chat');
    expect(captured.worldbookScope).toBe('code');
  });
});
