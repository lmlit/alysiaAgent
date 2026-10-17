/**
 * `alysia-log-stderr` 单测。
 *
 * ★ 最该守的一条：**日志必须走 stderr，绝不能碰 stdout**。
 *   委托运行体的 stdout 是机器契约（`--json` 的 NDJSON 事件流 / 最终答案本身），
 *   而 dsh 官方的 console exporter 用的是 `console.log`（= stdout）
 *   —— 直接用它会把 `--json` 的输出流搅坏。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apply, name, renderMessage, renderArg, DEFAULT_LEVEL } from '../src/stderr-log.ts'
import type { Context } from '@deepseek-ai/cordis'

interface FakeExporter {
  colors?: number | false
  levels?: Record<string, number>
  export(message: any): void
}

function makeCtx() {
  let registered: FakeExporter | null = null
  const exporter = vi.fn((e: FakeExporter) => {
    registered = e
    return () => {}
  })
  const ctx = { logger: { exporter } } as unknown as Context
  return { ctx, exporter, get: () => registered! }
}

let errSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
  logSpy.mockRestore()
})

describe('alysia-log-stderr', () => {
  it('导出 cordis 插件名', () => {
    expect(name).toBe('alysia-log-stderr')
  })

  it('注册一个带级别上限的 exporter', () => {
    const { ctx, exporter, get } = makeCtx()
    apply(ctx)
    expect(exporter).toHaveBeenCalledTimes(1)
    // 数值语义见 logger.ts：ERROR=0 / INFO=1 / WARN=2 / DEBUG=3，过滤是「上限」
    expect(get().levels?.default).toBe(DEFAULT_LEVEL)
    expect(DEFAULT_LEVEL).toBe(2)
  })

  it('★ 日志写 stderr —— stdout 一次都不许碰（--json 的 NDJSON 会被搅坏）', () => {
    const { ctx, get } = makeCtx()
    apply(ctx)
    logSpy.mockClear()
    errSpy.mockClear()

    get().export({ ts: 1700000000000, name: 'alysia-adapter', type: 'info', level: 1, args: ['已挂载'] })

    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0][0])).toContain('已挂载')
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('装没装上必须自报一声（否则「没日志」分不清「没装」和「没输出」）', () => {
    const { ctx } = makeCtx()
    apply(ctx)
    const lines = errSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('alysia-log-stderr') && l.includes('已注册'))).toBe(true)
  })

  it('级别上限可配置，且原样交给 cordis（本插件不自己过滤）', () => {
    const { ctx, get } = makeCtx()
    apply(ctx, { levels: { default: 3, 'alysia-adapter': 1 } })
    expect(get().levels).toEqual({ default: 3, 'alysia-adapter': 1 })
  })
})

describe('渲染', () => {
  it('格式含时间戳 + 级别 + logger 名', () => {
    const line = renderMessage(
      { ts: Date.UTC(2026, 9, 17, 0, 0, 0), name: 'alysia', type: 'warn', level: 2, args: ['boom', { a: 1 }] },
      true,
    )
    expect(line).toContain('2026-10-17T00:00:00.000Z')
    expect(line).toContain('[WARN]')
    expect(line).toContain('[alysia]')
    expect(line).toContain('boom')
    expect(line).toContain('{"a":1}')
  })

  it('关掉时间戳时只要级别与正文', () => {
    const line = renderMessage({ ts: 0, name: 'x', type: 'error', level: 0, args: ['oops'] }, false)
    expect(line).toBe('[ERROR] [x] oops')
  })

  it('Error 取 message/stack，不落成 "{}"（本项目反复栽在「错误看不出是什么」）', () => {
    expect(renderArg(new Error('连接被拒'))).toContain('连接被拒')
    expect(renderArg({})).toBe('{}')
    expect(renderArg(undefined)).toBe('undefined')
  })

  it('循环引用不抛（日志路径永远不许因为格式化而炸）', () => {
    const a: any = {}
    a.self = a
    expect(() => renderArg(a)).not.toThrow()
  })
})
