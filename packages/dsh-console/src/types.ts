/**
 * ★ dsh webServer 服务最小契约(自定,运行时零依赖)
 * 对齐 dsh rc.7 的 @deepseek-ai/dsh-host-webserver:
 *   - register({kind: 'exact'|'prefix', path, handler}):注册路由,返回 disposer
 *   - tapIndex(fn):改写 index.html(用于注入 <script>),返回 disposer
 * handler 签名沿用 Node http ServerResponse(与 dsh-whale-widget 一致)。
 */

import type { Context } from '@deepseek-ai/cordis'

/** Node http 风格 handler 入参(webServer 路由回调) */
export interface WebServerRouteHandler {
  (req: { url?: string; method?: string; headers: Record<string, string | string[] | undefined> }, res: {
    writeHead(status: number, headers?: Record<string, string>): void
    end(body?: string | Uint8Array): void
  }): void
}

/** dsh webServer 服务(host 平面) */
export interface WebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: WebServerRouteHandler
  }): () => void
  tapIndex(fn: (html: string) => string): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
}

export type { Context }
