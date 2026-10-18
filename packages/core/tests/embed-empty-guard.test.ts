/**
 * 空 query 不该请求 embedding（★ 2026-10-19，change: `fix-empty-embed-query`）。
 *
 * 真机证据（容器日志，02:0x 前多次）：
 * ```
 * [WARN] [Memory] vector search failed, fallback to text search:
 *        Embed API error 400: {"error":{"code":"1213","message":"未正常接收到prompt参数。"}}
 * [INFO] [memory/read] query="" → 召回 5 条
 * ```
 * 也就是说：**查询是空字符串**（dsh 会话的系统组装、无用户发言时），
 * 而我们还是去请求了一次 embedding —— 智谱用 400 拒绝空 prompt。
 *
 * 两层修复：
 *   1. `MemoryManager.read`：空 query 直接走文本检索，**不碰 embed**（不是故障，别打 WARN）
 *   2. `embed`：空文本**不发网络请求**，抛明确错误（省一次 400，也便于定位调用方）
 *
 * ⚠️ 这条不需要真连 API：两层都是"**不发请求**"，所以断言点就是"fetch 没被调用"。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { embedModule } from '../src/modules/resources.js'

/** 极简 module ctx：只提供 `provide` 与 `logger` */
function makeCtx() {
  const provided: Record<string, unknown> = {}
  return {
    provided,
    ctx: {
      provide: (name: string, value: unknown) => {
        provided[name] = value
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as never,
  }
}

describe('embed：空文本不发请求', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const service = () => {
    const { ctx, provided } = makeCtx()
    embedModule.apply(ctx, { baseUrl: 'https://embed.test/v1', apiKey: 'k', model: 'embedding-2' })
    return provided['al:embed'] as { embed: (t: string) => Promise<number[]> }
  }

  it('★ 空字符串 ⇒ 抛错，且**没有**任何 HTTP 请求', async () => {
    const svc = service()
    await expect(svc.embed('')).rejects.toThrow('空文本')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('★ 纯空白 ⇒ 同样不发请求', async () => {
    const svc = service()
    await expect(svc.embed('   \n\t ')).rejects.toThrow('空文本')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('正常文本照样走请求（别把守卫写宽了）', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: new Array(1024).fill(0.01) }] }),
    })
    const svc = service()
    const v = await svc.embed('今天有点闷')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(v).toHaveLength(1024)
    // body 里的 input 是原文（智谱按字符串收）
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body)
    expect(body.input).toBe('今天有点闷')
  })

  it('服务端报错仍然抛出真实错误（不被守卫吞掉）', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' })
    const svc = service()
    await expect(svc.embed('测试')).rejects.toThrow('429')
  })
})
