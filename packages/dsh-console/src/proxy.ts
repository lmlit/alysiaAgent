/**
 * ★ 同源 API 反代:/alysia-api/* → http://127.0.0.1:6185/api/*
 * 目的:alysia server(Fastify 6185)未开 CORS,浏览器直连跨域挂;
 * 反代后 client 同源访问,切端口/域名只改 config.serverBaseUrl 一处。
 */

import type { WebServerRouteHandler } from './types.ts'

/** 透传响应头白名单(排除 hop-by-hop 头) */
const FORWARD_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']

/**
 * 构造反代 handler。
 * @param serverBase - alysia server 基址,如 http://127.0.0.1:6185
 */
export function createProxyHandler(serverBase: string): WebServerRouteHandler {
  return (req, res) => {
    void proxyOnce(serverBase, req, res)
  }
}

async function proxyOnce(
  serverBase: string,
  req: { url?: string; method?: string; headers: Record<string, string | string[] | undefined> },
  res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string | Uint8Array): void },
): Promise<void> {
  const url = req.url ?? '/'
  // /alysia-api/profile?x=1 → /api/profile?x=1
  const targetPath = url.replace(/^\/alysia-api/, '/api')
  const target = serverBase + targetPath
  const method = (req.method ?? 'GET').toUpperCase()
  try {
    const headers: Record<string, string> = {}
    for (const key of FORWARD_HEADERS) {
      const v = req.headers[key]
      if (typeof v === 'string') headers[key] = v
    }
    const r = await fetch(target, { method, headers })
    // 读 body 再转发(Uint8Array,控制台接口体量小,足够)
    const body = new Uint8Array(await r.arrayBuffer())
    const outHeaders: Record<string, string> = {}
    for (const key of FORWARD_HEADERS) {
      const v = r.headers.get(key)
      if (v) outHeaders[key] = v
    }
    res.writeHead(r.status, outHeaders)
    res.end(body)
  } catch (err) {
    // server 未启动/网络错误 → 502,附简短诊断(不泄露内部细节)
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'alysia server unavailable', detail: (err as Error)?.message ?? String(err) }))
  }
}
