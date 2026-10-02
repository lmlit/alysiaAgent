/**
 * 人设变量 `{{alysia_persona}}` 的注册方 —— **host 插件**（profile 级）。
 *
 * ★ 为什么必须是 host 行，而不是塞进 preset 插件：
 *   模板变量由谁注册，决定了它**什么时候可用**。preset 插件要等 preset 被选中
 *   才挂载，而 persona 行的模板在同一层渲染 —— 时序上「插件还没挂、模板已渲染」
 *   并非不可能，一旦如此，dsh 对未知模板变量是**直接 throw**，
 *   后果是会话连请求都发不出去（硬失败，不是降级）。
 *
 *   dsh 自己就是这么做的：`@deepseek-ai/dsh-agent-loop` 在 **host 层**注册
 *   `provider` / `model` / `cwd`，而出厂 preset 的 persona 直接引用 `{{model}}`。
 *
 * ★★ 动态人设（2026-10-01，change: connect-dsh-alysia-bridge）：
 *   人设文本改成从 alysia server 拉（`GET /api/persona/prompt`），
 *   这样她在 dsh 里的成长会实时反映到人设上。
 *
 *   ⚠️ **provider 是同步的，HTTP 是异步的** —— provider 里不能 await。故走
 *   「**缓存 + 后台刷新**」：provider 同步返回缓存值，后台按间隔去拉。
 *   拿不到就保留旧值（**旧人设也远好于 throw**）；首次启动用静态文本兜底。
 */

import type { Context } from './types.ts'
import { PERSONA_VARIABLE, XILIAN_PERSONA, NATIVE_PERSONA } from './persona.ts'
import type { PersonaMode } from './persona.ts'
import { AlysiaClient, DEFAULT_ALYSIA_BASE_URL } from './alysia-client.ts'

/** Cordis 插件名（patch 行的 name 按此解析） */
export const name = 'alysia-persona'

/** 只需 prompt 注册表 */
export const inject = ['systemPrompt']

/** 默认刷新间隔：5 分钟。人格演化是慢变量，不必更勤 */
export const DEFAULT_REFRESH_MS = 5 * 60_000

export interface Config {
  /** `xilian` = 昔涟（默认，走动态人设）；`native` = DeepSeek 原版（静态） */
  persona?: PersonaMode
  /** alysia server 基址 */
  alysiaBaseUrl?: string
  /** 动态人设刷新间隔（毫秒）。`0` = 关闭刷新，只用静态兜底文本 */
  refreshMs?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const mode: PersonaMode = config.persona ?? 'xilian'
  const client = new AlysiaClient({
    baseUrl: config.alysiaBaseUrl ?? DEFAULT_ALYSIA_BASE_URL,
    logger: ctx.logger,
  })

  /**
   * 人设缓存。初始为静态文本 —— **绝不可能是空串/undefined**：
   * 变量 provider 返回 undefined 会让 dsh 在渲染时 throw，会话直接发不出请求。
   */
  let cached: string = XILIAN_PERSONA

  ctx.logger.info(
    `[alysia-persona] 人设变量已注册：persona=${mode} · alysia=${config.alysiaBaseUrl ?? DEFAULT_ALYSIA_BASE_URL}`,
  )

  // ── 后台刷新（仅动态模式需要）──
  const refreshMs = config.refreshMs ?? DEFAULT_REFRESH_MS
  if (mode === 'xilian' && refreshMs > 0) {
    const refresh = async (): Promise<void> => {
      const fresh = await client.getPersonaPrompt()
      if (fresh) {
        if (fresh !== cached) ctx.logger.info(`[alysia-persona] 人设已更新（${fresh.length} 字）`)
        cached = fresh
      }
      // fresh === null：alysia 没起或返回空 —— 保留旧值，客户端已记日志
    }

    // 启动时拉一次（不 await：不能拖慢 dsh 启动）
    void refresh()

    const timer = setInterval(() => { void refresh() }, refreshMs)
    ctx.effect(() => () => clearInterval(timer), 'alysia-persona.refresh-timer')
  }

  // ★ provider **同步**返回，且**永远非空字符串**：
  //   dsh 对模板变量严格校验，「注册了但值为 undefined」在渲染时 throw。
  ctx.effect(() => ctx.systemPrompt.variable(
    PERSONA_VARIABLE,
    () => (mode === 'native' ? NATIVE_PERSONA : cached),
  ), 'alysia-persona.variable()')
}
