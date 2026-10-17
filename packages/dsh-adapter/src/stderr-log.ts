/**
 * `alysia-log-stderr` —— 把 cordis 日志导出到 **stderr** 的 exporter。
 *
 * ★★ 为什么需要它（2026-10-17，change: `connect-server-dsh-bridge`）：
 *
 *   1. **dsh 默认看不到任何 `ctx.logger` 输出。** cordis 的 LoggerService 启动时
 *      只注册**一个内存环形缓冲** exporter（缓冲 1000 条，从不打印）；
 *      真正往终端打印的是**独立的** `@deepseek-ai/cordis-plugin-logger-console`，
 *      而 dsh 的 base / headless / web-app 三个组合包**都不含这一行**
 *      （实测：`dsh --profile headless --dump-config` 里没有任何 logger 行）。
 *      ⇒ adapter 的 `[alysia-adapter] 已挂载` / `[alysia] … HTTP 401` 这类诊断
 *      **一条都不会出现**，桥接失败时会表现为「什么都没有发生」。
 *
 *   2. **但不能直接用官方的 console exporter** —— 它 `export()` 里是 `console.log`
 *      （写 **stdout**），而委托运行体的 stdout 是机器契约：
 *      `dsh --profile headless --json` 用 NDJSON 占满 stdout，
 *      不带 `--json` 时 stdout 就是最终答案。混进日志行会**破坏解析**。
 *
 *   所以本插件做的是同一件事，只把出口换成 **stderr**：
 *   既不污染机器契约，又让「桥接到底通没通」可见。
 *
 * 用法（profile patch）：
 * ```yaml
 * - insert:
 *     - id: alysia-log-stderr
 *       name: '@alysia/dsh-adapter/stderr-log'
 *       config:
 *         levels: { default: 2 }   # ERROR=0 / INFO=1 / WARN=2 / DEBUG=3
 * ```
 */

import type { Context } from './types.ts'

/** Cordis 插件名（patch 行的 name 解析用） */
export const name = 'alysia-log-stderr'

/**
 * cordis 的数值级别（`vendor/cordis/src/logger.ts` 的 `LoggerLevel`）：
 * `ERROR = 0` / `INFO = 1` / `WARN = 2` / `DEBUG = 3`。
 *
 * ⚠️ 过滤判据是 `targetLevel < level ⇒ 丢弃`（即 target 是**上限**，不是下限）。
 * 所以 `default: 2` = 收 error + info + warn，丢 debug —— 正是我们要的粒度。
 */
export const DEFAULT_LEVEL = 2

export interface Config {
  /** 每个 logger 名的可见上限；`default` 兜底（缺省见 {@link DEFAULT_LEVEL}） */
  levels?: Record<string, number>
  /** 是否加 ISO 时间戳（默认开） */
  timestamps?: boolean
}

/** cordis 投递给 exporter 的结构化记录（只声明本文件用到的字段） */
export interface LogMessage {
  ts: number
  name: string
  type: string
  level: number
  args: unknown[]
}

/** 单个日志参数 → 一行文本（Error 取栈，其余尽量 JSON） */
export function renderArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message
  if (value === undefined) return 'undefined'
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** 一条记录 → 一行文本（导出出来便于单测直接断言格式） */
export function renderMessage(message: LogMessage, timestamps = true): string {
  const ts = timestamps ? `${new Date(message.ts || Date.now()).toISOString()} ` : ''
  const label = message.name ? `[${message.name}] ` : ''
  const type = `[${String(message.type).toUpperCase()}]`
  return `${ts}${type} ${label}${(message.args ?? []).map(renderArg).join(' ')}`
}

export function apply(ctx: Context, config: Config = {}): void {
  const levels = config.levels ?? { default: DEFAULT_LEVEL }
  const timestamps = config.timestamps ?? true

  /**
   * `ctx.logger.exporter()` 的签名在 vendored cordis 的 **interface** 上没写
   * （只有 class 上有），而官方 `ConsoleExporter` 用的就是这个调用。
   * 这里按同一形状断言，不改 types.ts 的公共契约。
   */
  const logger = ctx.logger as unknown as {
    exporter(exporter: {
      colors?: number | false
      levels?: Record<string, number>
      export(message: LogMessage): void
    }): unknown
  }

  // ★ 注册即生效，且 exporter 的清理由 ctx.logger.exporter() 内部用 ctx.effect 负责
  logger.exporter({
    colors: false,
    levels,
    export: (message) => {
      console.error(renderMessage(message, timestamps))
    },
  })

  // 自报一声：装没装上必须能被观测（否则「没日志」既可能是没装，也可能是没有日志）
  console.error(`[alysia-log-stderr] exporter 已注册（stderr）· levels=${JSON.stringify(levels)}`)
}
