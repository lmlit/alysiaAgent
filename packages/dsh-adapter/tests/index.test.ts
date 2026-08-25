/**
 * 插件注册断言:mock ctx 上验证 5 类注册(section/context/variable/tool/事件)发生。
 * 不依赖 dsh 运行时——只验证 apply() 的注册行为与契约形状。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apply, name } from '../src/index.ts'
import { PERSONA_SECTION, PERSONA_ORDER } from '../src/types.ts'
import type { Context } from '@deepseek-ai/cordis'

function makeMockCtx() {
  const section = vi.fn(() => () => {})
  const context = vi.fn(() => () => {})
  const variable = vi.fn(() => () => {})
  const register = vi.fn(() => () => {})
  const on = vi.fn(() => () => {})
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const effect = vi.fn((cb: () => unknown) => { cb(); return () => {} })
  const ctx = {
    systemPrompt: { section, context, variable },
    tools: { register },
    on,
    effect,
    logger,
  } as unknown as Context
  return { ctx, section, context, variable, register, on, logger, effect }
}

describe('alysia-adapter 插件', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('导出 cordis 插件名', () => {
    expect(name).toBe('alysia-adapter')
  })

  it('apply 注册 persona section(影子覆盖部署 persona)', () => {
    const { ctx, section } = makeMockCtx()
    apply(ctx)
    expect(section).toHaveBeenCalledTimes(1)
    const input = section.mock.calls[0][0]
    expect(input.name).toBe(PERSONA_SECTION)
    expect(input.order).toBe(PERSONA_ORDER)
    expect(typeof input.text).toBe('string')
    expect(input.text.length).toBeGreaterThan(50)
    expect(input.complete).toBeUndefined()
  })

  it('apply 注册记忆 context 骨架(alysia:memory)', () => {
    const { ctx, context } = makeMockCtx()
    apply(ctx)
    expect(context).toHaveBeenCalledTimes(1)
    const input = context.mock.calls[0][0]
    expect(input.name).toBe('alysia:memory')
    // 一期 provider 返回空字符串(空 text 不渲染)
    expect(input.text({})).toBe('')
  })

  it('apply 注册生活事件 variable(alysia_life)', () => {
    const { ctx, variable } = makeMockCtx()
    apply(ctx)
    expect(variable).toHaveBeenCalledTimes(1)
    expect(variable.mock.calls[0][0]).toBe('alysia_life')
    expect(variable.mock.calls[0][1]({})).toBeUndefined()
  })

  it('apply 注册 recall_memory 工具(带 output 硬约束)', () => {
    const { ctx, register } = makeMockCtx()
    apply(ctx)
    expect(register).toHaveBeenCalledTimes(1)
    const tool = register.mock.calls[0][0]
    expect(tool.name).toBe('recall_memory')
    expect(tool.output).toBeDefined()
    expect(typeof tool.output.schema).toBe('object')
    expect(typeof tool.output.render).toBe('function')
    expect(typeof tool.execute).toBe('function')
  })

  it('apply 监听 session/event 与 session/disposed', () => {
    const { ctx, on } = makeMockCtx()
    apply(ctx)
    expect(on).toHaveBeenCalledTimes(2)
    expect(on.mock.calls[0][0]).toBe('session/event')
    expect(on.mock.calls[1][0]).toBe('session/disposed')
  })

  it('user/message 事件触发日志(ingest hook 链路可证)', () => {
    const { ctx, logger, on } = makeMockCtx()
    apply(ctx)
    const listener = on.mock.calls[0][1] as (session: unknown, event: { type: string; data: unknown }) => void
    listener(null, { type: 'user/message', data: { content: [{ type: 'text', text: '早上好' }] } })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('session/event user/message'))
  })
})

describe('recall_memory 工具(MVP stub)', () => {
  function applyAndGetTool() {
    const { ctx, register } = makeMockCtx()
    apply(ctx)
    return register.mock.calls[0][0]
  }

  it('execute 返回占位记忆 + 二期 note', async () => {
    const tool = applyAndGetTool()
    const result = await tool.execute({ query: '测试' }, { signal: new AbortController().signal })
    expect(result).toMatchObject({ memories: [], note: expect.stringContaining('二期') })
  })

  it('render 空记忆输出占位文本', () => {
    const tool = applyAndGetTool()
    const blocks = tool.output.render({ query: 'x' }, { memories: [], note: 'n/a' })
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('没有找到相关记忆')
  })
})
