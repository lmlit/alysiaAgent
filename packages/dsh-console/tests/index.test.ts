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
  /** 按事件名存 handler —— index-inject 的测试要手动触发 */
  const handlers = new Map<string, (...a: unknown[]) => void>()
  const register = vi.fn((route: { kind: string; path: string; handler: unknown }) => {
    routes.push(route)
    return () => {}
  })
  const tapIndex = vi.fn((fn: (html: string) => string) => {
    tapIndexFns.push(fn)
    return () => {}
  })
  const on = vi.fn((type: string, fn: (...a: unknown[]) => void) => {
    handlers.set(type, fn)
    return () => {}
  })
  const effect = vi.fn((cb: () => unknown) => { cb(); return () => {} })
  const ctx = { webServer: { register, tapIndex }, on, effect } as unknown as Context
  /** 触发某个已注册事件，参数原样透传 */
  const emit = (type: string, ...args: unknown[]): void => {
    const h = handlers.get(type)
    if (!h) throw new Error(`没有注册 ${type} 的 handler`)
    h(...args)
  }
  /** 收集一次注入表（语义同 dsh：每次渲染发一次事件、订阅方 push） */
  const collectRows = () => {
    const rows: unknown[] = []
    emit('webserver/index-inject', rows as unknown as { push(...r: unknown[]): unknown })
    return rows
  }
  return { ctx, register, tapIndex, on, routes, tapIndexFns, handlers, emit, collectRows }
}

describe('alysia-console 插件', () => {
  it('导出插件名', () => {
    expect(name).toBe('alysia-console')
  })

  it('apply 注册反代 prefix + widget 托管 + 订阅 index-inject', () => {
    const { ctx, routes, on } = makeMockCtx()
    apply(ctx)
    expect(routes).toHaveLength(2)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/alysia-api' })
    expect(routes[1]).toMatchObject({ kind: 'exact', path: '/alysia-console/widget.js' })
    expect(on).toHaveBeenCalledWith('webserver/index-inject', expect.any(Function))
  })

  // ─────────────────────────────────────────────────────────────
  // ★ 2026-10-16 · 注入方式从 `tapIndex` 改为 `index-inject` 行
  //
  // 第一版用 `tapIndex`，而 **dsh 桌面端 UI 不走 `renderIndex()`** ⇒ `tapIndex` 不执行
  // ⇒ 插件装得上、路由注册得上，但**入口脚本永远不进页面**（悬浮球不出现）。
  // 下列断言锁住"改用行"，并**明确断言不再用 tapIndex**（回归守卫）。
  // ─────────────────────────────────────────────────────────────

  it('★ index-inject 推入两条行：preload 提示 + 真正执行的 script-src', () => {
    const { ctx, collectRows } = makeMockCtx()
    apply(ctx)

    expect(collectRows()).toEqual([
      // preload 只是提示（更早开始下载）——**不执行**
      { kind: 'script-preload', src: '/alysia-console/widget.js' },
      // 真正加载：放 body 尾 ⇒ DOM 已就绪（dsh 渲染器**不加 defer**，位置就是时序保证）
      { kind: 'script-src', placement: 'body', src: '/alysia-console/widget.js' },
    ])
  })

  it('★★ 回归守卫：**不再使用 `tapIndex`**（它在桌面端不执行，是本包第一版失效的原因）', () => {
    const { ctx, tapIndex, tapIndexFns } = makeMockCtx()
    apply(ctx)

    expect(
      tapIndex,
      '又用回 tapIndex 了 —— 桌面端不执行它，悬浮球不会出现',
    ).not.toHaveBeenCalled()
    expect(tapIndexFns).toHaveLength(0)
  })

  it('★ mountPath 配置要一路生效到注入行与托管路由（不是写死的）', () => {
    const { ctx, routes, collectRows } = makeMockCtx()
    apply(ctx, { mountPath: '/my-console' })

    expect(routes[1]).toMatchObject({ path: '/my-console/widget.js' })
    expect(collectRows()).toEqual([
      { kind: 'script-preload', src: '/my-console/widget.js' },
      { kind: 'script-src', placement: 'body', src: '/my-console/widget.js' },
    ])
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
    expect(js).toContain('alysia-fab')
    expect(js).toContain('alysia-console-panel')
    // ★ 语法校验:注入脚本任何引号/模板事故都会让整段脚本挂掉(历史事故:onerror 内联
    //   单引号与外层字符串冲突 → 悬浮球完全不渲染)。new Function 抛错即语法错误。
    expect(() => new Function(js)).not.toThrow()
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
      // ★ 2026-10-28：固定 100ms 在满载并行测试时会假红（proxy 本身没坏）。
      //   改成等 mock 真正被调用，最多 3s。
      const deadline = Date.now() + 3000
      while (res.writeHead.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20))
      }
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
