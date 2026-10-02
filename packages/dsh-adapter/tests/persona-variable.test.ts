/**
 * host 行 `alysia-persona` 的单测 —— 人格切换开关的落点。
 *
 * ★ 它是 **host 插件**（profile 级），不是 preset 插件。理由见 src/persona-variable.ts：
 *   变量必须在 persona 模板渲染之前就已注册，否则 dsh 对未知模板变量**直接 throw**，
 *   表现为「会话连请求都发不出去」的硬失败。
 */

import { describe, it, expect, vi } from 'vitest';
import { apply, name } from '../src/persona-variable.ts';
import { PERSONA_VARIABLE, XILIAN_PERSONA, NATIVE_PERSONA } from '../src/persona.ts';
import type { Context } from '@deepseek-ai/cordis';

function makeMockCtx() {
  const variable = vi.fn(() => () => {});
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const effect = vi.fn((cb: () => unknown) => { cb(); return () => {}; });
  const ctx = { systemPrompt: { variable }, effect, logger } as unknown as Context;
  return { ctx, variable, logger };
}

/** 取注册进去的 provider */
function provider(got: ReturnType<typeof makeMockCtx>): (c: unknown) => unknown {
  return got.variable.mock.calls[0][1] as (c: unknown) => unknown;
}

describe('alysia-persona（host 行）', () => {
  it('导出 cordis 插件名与 inject', () => {
    expect(name).toBe('alysia-persona');
  });

  it(`注册变量 ${PERSONA_VARIABLE}`, () => {
    const got = makeMockCtx();
    apply(got.ctx);
    expect(got.variable).toHaveBeenCalledTimes(1);
    expect(got.variable.mock.calls[0][0]).toBe(PERSONA_VARIABLE);
  });

  it('★ 默认（未配置）给昔涟人设', () => {
    const got = makeMockCtx();
    apply(got.ctx);
    expect(provider(got)({})).toBe(XILIAN_PERSONA);
  });

  it('★ persona=xilian 给昔涟人设', () => {
    const got = makeMockCtx();
    apply(got.ctx, { persona: 'xilian' });
    expect(provider(got)({})).toBe(XILIAN_PERSONA);
  });

  it('★ persona=native 给 DeepSeek 原版人设（这就是「切回原模式」）', () => {
    const got = makeMockCtx();
    apply(got.ctx, { persona: 'native' });
    expect(provider(got)({})).toBe(NATIVE_PERSONA);
  });

  it('★ provider 永远返回非空字符串', () => {
    // dsh 对模板变量严格校验：「注册了但值为 undefined」在渲染时 throw。
    // 空串同样危险（会让人设段消失），故一并禁掉。
    for (const mode of [undefined, 'xilian', 'native'] as const) {
      const got = makeMockCtx();
      apply(got.ctx, mode ? { persona: mode } : {});
      const value = provider(got)({});
      expect(typeof value, `mode=${mode}`).toBe('string');
      expect((value as string).length, `mode=${mode}`).toBeGreaterThan(0);
    }
  });

  it('未知 persona 值回落昔涟（不返回 undefined 触发 throw）', () => {
    const got = makeMockCtx();
    apply(got.ctx, { persona: 'nonsense' as never });
    expect(provider(got)({})).toBe(XILIAN_PERSONA);
  });

  it('启动日志带上当前模式（挂没挂上、用的哪套人设都要能观测）', () => {
    const got = makeMockCtx();
    apply(got.ctx, { persona: 'native' });
    expect(got.logger.info).toHaveBeenCalledWith(expect.stringContaining('native'));
  });
});
