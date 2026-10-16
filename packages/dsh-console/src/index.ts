/**
 * @alysia/dsh-console — 昔涟控制台 dsh 插件（标准 bundle 单包，仿 dsh-whale-widget 骨架）
 *
 * host 侧（本文件）：
 *   - 反代 `/alysia-api/*` → `config.serverBaseUrl/api/*`（同源，规避 alysia server 无 CORS）
 *   - 托管 `/alysia-console/widget.js`（控制台入口脚本）
 *   - **`webserver/index-inject` 注入入口脚本**（★ 2026-10-16 从 `tapIndex` 改过来，原因见下）
 * client 侧：悬浮球 + 面板（画像/会话），见 `console-ui.ts`。
 * core/server 零改动，全部复用 6185 现有端点。
 *
 * ★★ 为什么不能用 `tapIndex`（第一版踩的坑，2026-10-16 在 dsh 产物里逐条核实）：
 *   dsh 的 index 输入分两层——先渲染 `webserver/index-inject` 收集的**行**，
 *   再应用原始 `tapIndex` 转换。而**桌面端 UI 不走 `renderIndex()`** ⇒
 *   `tapIndex` 在桌面端**根本不执行**：插件装得上、路由注册得上，
 *   但入口脚本永远不会进页面（悬浮球不出现）。
 *   `tapIndex` 本身**没有废弃**（dsh 文档称它是"任何行都无法表达的标记的逃生口"），
 *   只是**这件事它管不到**。⇒ 改用行（`script-preload` + `script-src`），
 *   这也是 dsh 自己注入前端资源的做法，且**静态部署也会带上同样的行**。
 */

import type { Context, IndexInjectionTable } from './types.ts'
import { createProxyHandler } from './proxy.ts'
import { buildConsoleWidgetJs } from './console-ui.ts'

export const name = 'alysia-console'

/** host 服务依赖（webServer 由 dsh host 提供） */
export const inject = ['webServer']

export interface Config {
  /** alysia server 基址（默认本地 6185） */
  serverBaseUrl?: string
  /** 静态资源挂载路径 */
  mountPath?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const serverBase = config.serverBaseUrl ?? 'http://127.0.0.1:6185'
  const mount = config.mountPath ?? '/alysia-console'
  const widgetPath = mount + '/widget.js'
  const disposers: Array<() => void> = []

  // ── 1. 同源 API 反代（prefix 匹配 /alysia-api/*）──
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

  // ── 3. index 注入（★ 走 index-inject 行，不用 tapIndex）──
  //
  //   两条行分工（照 dsh 自己注入前端资源的方式）：
  //     · `script-preload` → head 里的 preload **提示**（更早开始下载，但**不执行**）
  //     · `script-src` + placement 'body' → 真正执行的 `<script src>`
  //       （放 body 尾 ⇒ DOM 已就绪；渲染器**不加 defer**，所以位置就是时序保证）
  //
  //   ⚠️ 不依赖"已注入则跳过"那种去重：注入表**每次渲染都是全新的**，
  //      而 widget 自身是幂等的（`window.__alysiaConsole` 守卫 + 复用旧 root），
  //      即便真被注两次也不会渲染两个悬浮球。
  disposers.push(ctx.on('webserver/index-inject', (table: IndexInjectionTable) => {
    table.push(
      { kind: 'script-preload', src: widgetPath },
      { kind: 'script-src', placement: 'body', src: widgetPath },
    )
  }) as unknown as () => void)

  // 卸载清理
  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch { /* dispose failure non-fatal */ }
    }
  })
}
