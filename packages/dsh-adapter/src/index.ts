/**
 * @alysia/dsh-adapter — 把 Alysia 昔涟人格/记忆系统接入 DeepSeek Harness 的插件。
 *
 * 一期(MVP):验证插件在 dsh 里的完整生命周期——persona 注入 / context+variable 骨架 /
 * recall_memory 工具 / 消息事件监听。数据层(真记忆检索 / ingest 写库)二期经
 * server API 代写层接入,本文件接口不动。
 *
 * 挂载方式:agent-preset composition 行引用本插件(见 presets/alysia/agent.cordis.yml),
 * 插件注册落入该 agent 的 scoped layer,随会话卸载自动清理。
 */

import type { Context } from './types.ts'
import { PERSONA_SECTION, PERSONA_ORDER } from './types.ts'
import type { AssembleContext, SessionEvent } from './types.ts'
import { personaSectionText } from './persona.ts'
import { recallMemory } from './recall-memory.ts'

/** Cordis 插件名(composition 行的 name 字段按此解析) */
export const name = 'alysia-adapter'

/**
 * 注入的服务依赖。★ cordis 4.0.1 的 ctx 是 Proxy:未声明的服务访问即抛
 * "cannot get property X without inject"——必须在此声明。
 * systemPrompt = prompt 注册表(tools 服务自身也依赖它);tools = 工具注册表。
 */
export const inject = ['systemPrompt', 'tools']

/** 插件配置(一期;二期:serverUrl / 记忆旋钮等) */
export interface Config {
  /**
   * 是否注册 persona section(默认 true)。
   * 关闭场景:全局平面(headless patch / host)已有同名 deployment:persona 时
   * 同层重复注册会 throw——此时关 persona 只挂工具/事件。
   * agent-preset 平面(scoped)无此冲突,保持默认。
   */
  persona?: boolean
  /** dsh 侧日志级别:'info' 默认;'debug' 打开 session/event 明细 */
  logLevel?: 'info' | 'debug'
}

/**
 * 插件应用入口。ctx 为挂载 scope 的上下文(preset 内 → 本 agent 层)。
 * 所有注册返回 exact disposer;ctx.on 随 ctx 卸载自动清理。
 */
export function apply(ctx: Context, config: Config = {}): void {
  // ── 1. persona:影子覆盖部署 persona(同名 deployment:persona + order 0)──
  //    全局平面已存在同名 section 时跳过(见 Config.persona)
  if (config.persona !== false) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      text: personaSectionText(),
    }), 'alysia-adapter.persona()')
  }

  // ── 2. 记忆 context 骨架 ──
  // AssembleContext 不含用户消息(dsh 契约),故插件自缓存最近一条 user/message;
  // 二期 provider 用它做检索 query,经 server API GET /api/memory/read 取结果注入。
  let latestUserMessage = ''
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'alysia:memory',
    order: -50,
    text: (_context: AssembleContext): string => {
      // 一期返回空字符串(空 text 不渲染,链路留位);二期替换为检索结果
      return ''
    },
  }), 'alysia-adapter.memory-context()')

  // ── 3. 生活事件 variable 骨架({{alysia_life}})──
  // dsh 对模板变量严格校验:section 未引用即安全;二期 provider 调
  // memory.getLifeEventInjection() 返回今日事件文本。
  ctx.effect(() => ctx.systemPrompt.variable(
    'alysia_life',
    (_context: AssembleContext): string | undefined => undefined,
  ), 'alysia-adapter.life-variable()')

  // ── 4. recall_memory 工具(MVP stub,output 硬约束验证)──
  ctx.effect(() => ctx.tools.register(recallMemory), 'alysia-adapter.recall-memory()')

  // ── 5. 消息 ingest hook(二期经 server API 代写,此处验证链路)──
  const debug = config.logLevel === 'debug'
  ctx.on('session/event', (_session, event: SessionEvent) => {
    if (event.type === 'user/message') {
      latestUserMessage = extractText(event.data)
    }
    // 只在关键消息 + debug 时打日志,避免 assemble/step 高频事件刷屏
    if (debug || event.type === 'user/message' || event.type === 'assistant/message') {
      ctx.logger.info(`[alysia-adapter] session/event ${event.type}`)
    }
  })
  // 会话结束 → 二期 memory.onSessionEnd()
  ctx.on('session/disposed', () => {
    ctx.logger.info('[alysia-adapter] session/disposed (onSessionEnd hook)')
  })
}

/** 从 dsh UserMessage data 提取文本(结构随版本微变,宽松处理) */
function extractText(data: unknown): string {
  const content = (data as { content?: unknown })?.content
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text ?? '' : ''))
      .join('')
  }
  return typeof content === 'string' ? content : ''
}
