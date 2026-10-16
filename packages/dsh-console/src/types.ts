/**
 * ★ dsh webServer / index 注入服务的**最小契约**（自定，运行时零依赖）
 *
 * 对齐 dsh 当前的 `@deepseek-ai/dsh-host-webserver`：
 *   - `register({kind: 'exact'|'prefix', path, handler})` → 注册路由，返回 disposer
 *   - `webserver/index-inject` 事件 → 每次渲染 index.html 时**收集一次注入表**，
 *     订阅方往 `table` 里 `push` 若干「行」
 *   - `tapIndex(fn)` → 原始 HTML 字符串转换（**保留，但见下**）
 *
 * ## ★★ 为什么注入必须走 `index-inject` 而**不是** `tapIndex`（2026-10-16 核实）
 *
 * dsh 的 index 启动输入**分两层**（dsh 自己的文档原话）：
 *   1. `collectIndexInjections()` 收集注入**行** → `renderIndex(html)` 渲染进正文；
 *   2. 再按注册顺序应用原始 `tapIndex(transform)` 转换。
 *
 * ⚠️ **桌面端 UI 不走 `renderIndex()`** ⇒ **`tapIndex` 在桌面端不执行**。
 *    插件能装上、路由能注册，但**入口脚本永远不会被注入页面**（悬浮球不出现）——
 *    这就是本包第一版"装上了却没反应"的原因。
 *
 * ⇒ 正确做法：`ctx.on('webserver/index-inject', table => table.push(...rows))`。
 *    行在**动态渲染与静态部署**两条路径上都会带上（文档明说
 *    "静态部署会在启动 payload 中携带同一批行"），`tapIndex` 则只是
 *    "**任何行都无法表达的标记的逃生口**" —— 我们这件事（注入一个 `<script>`）行能表达。
 *
 * `tapIndex` 仍然保留在类型里（它**没有废弃**，程序还在），但本包**不再使用**。
 */

import type { Context } from '@deepseek-ai/cordis'

/** Node http 风格 handler 入参(webServer 路由回调) */
export interface WebServerRouteHandler {
  (req: { url?: string; method?: string; headers: Record<string, string | string[] | undefined> }, res: {
    writeHead(status: number, headers?: Record<string, string>): void
    end(body?: string | Uint8Array): void
  }): void
}

/** 行插在 `<head>` 还是 `<body>`（dsh: `IndexInjectionPlacement`） */
export type IndexInjectionPlacement = 'head' | 'body'

/**
 * 一条 index 注入**行**（对齐 dsh 的 `IndexInjection` 联合类型，逐字核过）。
 *
 * 渲染结果（dsh `renderRow`）：
 *   - `global`         → `<script>globalThis[name] = value</script>`（恒在 head）
 *   - `script`         → `<script>text</script>`
 *   - `script-src`     → `<script src="…"></script>` ⚠️ **不带 defer/type=module**
 *   - `script-preload` → `<link rel="preload" as="script" href="…">` ⚠️ **只是提示，不执行**
 *   - `style`          → `<style>text</style>`（恒在 head）
 *   - `html`           → 原样插入（**逃生口**：行表达不了的标记才用它）
 */
export type IndexInjection =
  | { kind: 'global'; name: string; value: unknown }
  | { kind: 'script'; placement: IndexInjectionPlacement; text: string }
  | { kind: 'script-src'; placement: IndexInjectionPlacement; src: string }
  | { kind: 'script-preload'; src: string }
  | { kind: 'style'; text: string }
  | { kind: 'html'; placement: IndexInjectionPlacement; html: string }

/** 注入表：每次渲染收集一次，订阅方往里 push（dsh 侧就是数组语义） */
export interface IndexInjectionTable {
  push(...rows: IndexInjection[]): unknown
}

/** dsh webServer 服务(host 平面) */
export interface WebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: WebServerRouteHandler
  }): () => void
  /**
   * 原始 HTML 字符串转换。⚠️ **桌面端 UI 不执行它** ——
   * 本包**不再使用**，保留在类型里只为如实反映 dsh 的服务面。
   */
  tapIndex(fn: (html: string) => string): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
  /**
   * ★ 声明 dsh 的 index 注入事件。
   *
   * 不声明的话 `ctx.on('webserver/index-inject', …)` 通不过 tsc
   *（`Argument of type '"webserver/index-inject"' is not assignable to parameter of type 'keyof Events'`）——
   * 这是**编译期**的严格性，运行时本来就能收到。
   */
  interface Events {
    'webserver/index-inject'(table: IndexInjectionTable): void
  }
}

export type { Context }
