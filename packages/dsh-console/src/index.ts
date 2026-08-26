/**
 * @alysia/dsh-console — 昔涟控制台 dsh 插件(标准 bundle 单包,仿 dsh-whale-widget 骨架)
 *
 * host 侧(本文件):
 *   - 反代 /alysia-api/* → config.serverBaseUrl/api/*(同源,规避 alysia server 无 CORS)
 *   - 托管 /alysia-console/widget.js(控制台入口脚本)
 *   - tapIndex 注入 <script> 标签(去重)
 * client 侧:悬浮球 + 面板(画像/会话),见 console-ui.ts。
 * core/server 零改动,全部复用 6185 现有端点。
 */

import type { Context } from './types.ts'
import { createProxyHandler } from './proxy.ts'
import { buildConsoleWidgetJs } from './console-ui.ts'

export const name = 'alysia-console'

/** host 服务依赖(webServer 由 dsh host 提供) */
export const inject = ['webServer']

export interface Config {
  /** alysia server 基址(默认本地 6185) */
  serverBaseUrl?: string
  /** 静态资源挂载路径 */
  mountPath?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const serverBase = config.serverBaseUrl ?? 'http://127.0.0.1:6185'
  const mount = config.mountPath ?? '/alysia-console'
  const widgetPath = mount + '/widget.js'
  const disposers: Array<() => void> = []

  // ── 1. 同源 API 反代(prefix 匹配 /alysia-api/*)──
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: '/alysia-api',
    handler: createProxyHandler(serverBase),
  }))

  // ── 2. 控制台入口脚本托管 ──
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: widgetPath,
    handler: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(buildConsoleWidgetJs(mount))
    },
  }))

  // ── 3. index.html 注入(去重:已注入则跳过)──
  disposers.push(ctx.webServer.tapIndex((html: string) => {
    if (html.includes(widgetPath)) return html
    const tag = `<script defer src="${widgetPath}"></script>`
    return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
  }))

  // 卸载清理
  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch { /* dispose failure non-fatal */ }
    }
  })
}
