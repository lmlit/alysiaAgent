/**
 * `/api/memory/read` —— `blocks` / `worldbookScope` 两个字段的**转发契约**
 * （★ 2026-10-24，change: `align-dsh-memory-blocks-with-scope`）。
 *
 * 这个端点自己不做判据，只做三件事：解析 → 透传 → 把报告的 text 当 context 返回。
 * 所以这里守的是「**解析与透传不能错**」，判据本身在 core 的 worldbook-injection 测例里。
 *
 * 为什么值得单独测：`mode` 曾经是**唯一**入口，dsh 不传就落到 chat，
 * 于是世界书 triggers 匹配完被组装器丢弃 —— 而路由层看起来完全正常。
 */
import { describe, it, expect, vi } from 'vitest';
import { createWebuiApp } from '../src/webui/server.js';

function harness() {
  const mm = {
    read: vi.fn(async () => ({
      context: '',
      persona_hint: '',
      retrieved: [{ id: 'm1', score: 0.9, text: '记忆一条', metadata: {} }],
      worldbook_triggers: [
        {
          id: 'wb1', trigger_keys: '["x"]', trigger_mode: 'any', content: '情境一条',
          scope: 'code', priority: 0, cooldown_sec: 0, last_triggered: null, hit_count: 0,
          created_at: '2026-10-24T00:00:00.000Z', updated_at: '2026-10-24T00:00:00.000Z',
        },
      ],
    })),
    assembleWithReport: vi.fn(async () => ({ text: '组装结果', dropped: [], worldbookInjected: 1 })),
  };
  return { mm, core: { memoryManager: mm } };
}

async function buildApp(core: any) {
  const app = createWebuiApp(core, { requireAuth: false } as never);
  await app.ready();
  return app;
}

describe('POST /api/memory/read —— 拆参数契约', () => {
  it('★ 不传新字段 ⇒ 旧行为（mode 缺省 chat，两个新字段都不透传）', async () => {
    const h = harness();
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/memory/read', payload: { query: 'q' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().context).toBe('组装结果');

    const readArg = h.mm.read.mock.calls[0][0] as Record<string, unknown>;
    expect(readArg.mode).toBe('chat');
    // ★ F10（2026-10-24）：`read()` 不接收 `blocks` —— 它只负责匹配，块表选择属于组装。
    //   曾经有这个字段但 `read()` 从头到尾没读过（"看着接上其实没接"），所以这里断言它**不存在**。
    expect(Object.keys(readArg), 'read() 不该收到 blocks（它不读它）').not.toContain('blocks');
    expect(readArg.worldbookScope).toBeUndefined();

    const asm = h.mm.assembleWithReport.mock.calls[0] as unknown as any[];
    expect(asm[0]).toBe('chat');
    expect(asm[4]).toEqual({ blocks: undefined, worldbookScope: undefined });
  });

  it('★ dsh 的调用形态：blocks=chat + worldbookScope=code，必须两个都透传', async () => {
    const h = harness();
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST',
      url: '/api/memory/read',
      payload: { query: 'q', blocks: 'chat', worldbookScope: 'code' },
    });

    expect(res.statusCode).toBe(200);
    const readArg = h.mm.read.mock.calls[0][0] as Record<string, unknown>;
    expect(readArg.worldbookScope, 'scope 必须传到 read（它决定匹配哪个 scope）').toBe('code');
    expect(Object.keys(readArg)).not.toContain('blocks');

    const asm = h.mm.assembleWithReport.mock.calls[0] as unknown as any[];
    expect(asm[4]).toEqual({ blocks: 'chat', worldbookScope: 'code' });
  });

  it('★ blocks 可以独立于 mode：mode=code 但 blocks=chat', async () => {
    const h = harness();
    const app = await buildApp(h.core);
    await app.inject({
      method: 'POST',
      url: '/api/memory/read',
      payload: { query: 'q', mode: 'code', blocks: 'chat' },
    });

    const asm = h.mm.assembleWithReport.mock.calls[0] as unknown as any[];
    expect(asm[0], 'mode 原样透传（它仍是 read 的 scope 缺省）').toBe('code');
    expect(asm[4]).toEqual({ blocks: 'chat', worldbookScope: undefined });
  });

  it('非法值不炸、按缺省处理（不把垃圾值透传进 core）', async () => {
    const h = harness();
    const app = await buildApp(h.core);
    const res = await app.inject({
      method: 'POST',
      url: '/api/memory/read',
      payload: { query: 'q', blocks: 'nonsense', worldbookScope: 123 },
    });
    expect(res.statusCode).toBe(200);
    const readArg = h.mm.read.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(readArg), '非法 blocks 也不该以任何形式进 read()').not.toContain('blocks');
    expect(readArg.worldbookScope).toBeUndefined();
  });
});
