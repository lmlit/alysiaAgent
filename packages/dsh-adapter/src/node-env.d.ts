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
