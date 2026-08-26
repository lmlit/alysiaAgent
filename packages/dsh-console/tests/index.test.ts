/**
 * host 侧注册断言 + 反代转发逻辑测试。
 * 不依赖 dsh 运行时——mock webServer 验证 apply 注册行为;用本地 HTTP 服务验证反代。
 */
import { describe, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { apply, name } from '../src/index.ts'
import { createProxyHandler } from '../src/proxy.ts'
import type { Context } from '@deepseek-ai/cordis'

function makeMockCtx() {
  const routes: Array<{ kind: string; path: string; handler: unknown }> = []
  const tapIndexFns: Array<(html: string) => string> = []
  const register = vi.fn((route: { kind: string; path: string; handler: unknown }) => {
    routes.push(route)
    return () => {}
  })
  const tapIndex = vi.fn((fn: (html: string) => string) => {
    tapIndexFns.push(fn)
    return () => {}
  })
  const effect = vi.fn((cb: () => unknown) => { cb(); return () => {} })
  const ctx = { webServer: { register, tapIndex }, effect } as unknown as Context
  return { ctx, register, tapIndex, routes, tapIndexFns }
}

describe('alysia-console 插件', () => {
  it('导出插件名', () => {
    expect(name).toBe('alysia-console')
  })

  it('apply 注册反代 prefix + widget 托管 + tapIndex 注入', () => {
    const { ctx, routes, tapIndexFns } = makeMockCtx()
    apply(ctx)
    expect(routes).toHaveLength(2)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/alysia-api' })
    expect(routes[1]).toMatchObject({ kind: 'exact', path: '/alysia-console/widget.js' })
    expect(tapIndexFns).toHaveLength(1)
  })

  it('tapIndex 注入 script 且去重', () => {
    const { ctx, tapIndexFns } = makeMockCtx()
    apply(ctx)
    const fn = tapIndexFns[0]
    const injected = fn('<html><body></body></html>')
    expect(injected).toContain('<script defer src="/alysia-console/widget.js"></script>')
    // 已注入 → 原样返回
    expect(fn(injected)).toBe(injected)
  })

  it('widget.js 返回合法 JS 脚本(自执行 IIFE)', () => {
    const { ctx, routes } = makeMockCtx()
    apply(ctx)
    const handler = routes[1].handler as (req: unknown, res: { writeHead(...a: unknown[]): void; end(b?: string): void }) => void
    const res = { writeHead: vi.fn(), end: vi.fn((b?: string) => b) }
    handler({ url: '/alysia-console/widget.js', method: 'GET', headers: {} }, res)
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'application/javascript; charset=utf-8' }))
    const js = res.end.mock.calls[0][0] as string
    expect(js).toContain('window.__alysiaConsole')
    expect(js).toContain('alysia-console-fab')
  })
})

describe('反代 createProxyHandler', () => {
  it('路径重写 /alysia-api/* → /api/* 并透传响应', async () => {
    // 起一个本地"alysia server"返回 JSON
    const upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ echo: req.url }))
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
    const port = (upstream.address() as AddressInfo).port
    try {
      const handler = createProxyHandler(`http://127.0.0.1:${port}`)
      const res = {
        writeHead: vi.fn(),
        end: vi.fn((b?: string | Uint8Array) => b),
      }
      handler(
        { url: '/alysia-api/profile?x=1', method: 'GET', headers: { accept: 'application/json' } },
        res as never,
      )
      await new Promise(r => setTimeout(r, 100))
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'application/json' }))
      const raw = res.end.mock.calls[0][0]
      const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw)
      const body = JSON.parse(text)
      expect(body.echo).toBe('/api/profile?x=1') // 路径正确重写
    } finally {
      upstream.close()
    }
  })

  it('server 未启动 → 502 JSON', async () => {
    const handler = createProxyHandler('http://127.0.0.1:1') // 端口 1 必挂
    const res = { writeHead: vi.fn(), end: vi.fn((b?: string) => b) }
    handler({ url: '/alysia-api/profile', method: 'GET', headers: {} }, res as never)
    await new Promise(r => setTimeout(r, 300))
    expect(res.writeHead).toHaveBeenCalledWith(502, expect.objectContaining({ 'content-type': 'application/json; charset=utf-8' }))
    const body = JSON.parse(String(res.end.mock.calls[0][0]))
    expect(body.error).toContain('alysia server unavailable')
  })
})
