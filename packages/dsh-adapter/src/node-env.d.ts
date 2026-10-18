/**
 * 最小 Node 环境声明。
 *
 * ★ 为什么需要它（2026-10-17，change: `connect-server-dsh-bridge`）：
 *   本包是 **dsh 进程内的 cordis 插件**，Node 运行时由宿主提供，
 *   故 devDependencies 里**刻意不含 `@types/node`**。
 *   而「Bearer token 缺省读 `ALYSIA_WEBUI_TOKEN` 环境变量」是本包第一次用到 `process`
 *   ⇒ 不声明就无法通过 `tsc`（`TS2591: Cannot find name 'process'`）。
 *
 * 这里**只声明用到的那一点**，而不是把整套 Node 类型拉进来：
 * 拉进来会让本包凭空获得「可以用 fs / net」的类型假象，而它在 preset 层本就不该有那些能力。
 */
declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

/**
 * 同理只声明用到的 `console.error`。
 *
 * ★ 为什么必须是 **error**（= stderr）而不是 log（= stdout）：
 *   委托运行体的 stdout 是**机器契约** —— `dsh --profile headless --json` 用
 *   NDJSON 事件流占满 stdout，不带 `--json` 时 stdout 是最终答案本身。
 *   往 stdout 写任何日志行都会污染这个契约（dsh 自己的
 *   `dsh-sdk-jsonrpc-server` 文档把这条写成硬约束：stdout 只许有协议帧）。
 */
declare const console: {
  error(...args: unknown[]): void;
};

/**
 * ★ 2026-10-19（change: `give-her-a-publish-tool`）：本包第一次**真的需要文件系统**。
 *
 * 上面那段的原话是「拉进来会凭空获得"可以用 fs/net"的类型假象，而它在 preset 层本就不该有那些能力」。
 * 现在情况变了，但变化的理由要写清楚：
 *
 * - "上线"从「她往 `public/` 里 cp + 我们事后没收」改成「调 `publish_page` 工具」；
 * - 工具必须**读写宿主工作区**（复制进 `public/`）并**自己 HTTP 验一遍**，
 *   而它就跑在 dsh 进程里（cwd = 工作区、同一用户）—— 那是它能看见文件的唯一位置；
 * - ⇒ 这是**刻意授予的一项能力**（capability），不是"顺手打开了门"：
 *   能做什么被 `publish-page.ts` 里的路径/扩展名白名单限死，且 `ALYSIA_ALLOW_PUBLISH=0` 时直接拒绝。
 *
 * 仍然**只声明用到的那几个函数**（不是整套 Node 类型），保持本包"能力可见"的可读性。
 */
declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function copyFileSync(from: string, to: string): void
  export function appendFileSync(path: string, data: string): void
  export function statSync(path: string): { isFile(): boolean }
  export function readdirSync(path: string): string[]
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(p: string): string
  export function relative(from: string, to: string): string
  export const sep: string
}

/** 本机预览服务的自证用（Node 22 自带 fetch）；`arrayBuffer()` 用来读掉 body（不读会让 undici 崩） */
declare const fetch: (
  url: string,
  init?: { signal?: unknown },
) => Promise<{ status: number; ok: boolean; arrayBuffer(): Promise<unknown> }>

declare const AbortSignal: {
  timeout(ms: number): unknown
}
