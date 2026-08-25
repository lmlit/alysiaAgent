/**
 * ★ dsh 插件最小契约(自定,避免 npm 链断)
 * 背景:dsh 本地包(dsh-system-prompt/dsh-tools)版本 0.1.0-rc.5 未完整发布 npm
 * (npm 仅 0.0.1-rc.1 且依赖链断 @deepseek-ai/dsh-type-meta 404)。
 * 因此运行时只依赖 @deepseek-ai/cordis(4.0.1 已发布,链完整),
 * 本文件自定 dsh 插件的注册 API 最小类型——与 dsh 源码对齐的契约:
 *   - PERSONA_SECTION/PERSONA_ORDER: packages/core/system-prompt/src/index.ts 导出常量
 *   - PromptSection/PromptContext/AssembleContext: 同文件接口
 *   - ToolDefinition: packages/core/tools/src/index.ts(output 硬约束)
 * 若 dsh 这些常量/接口变更,本文件需同步(升级 dsh 时检查)。
 */

import type { Context } from '@deepseek-ai/cordis'

/** dsh system-prompt 的部署 persona 槽位名(order 0)——同名注册即 shadow 覆盖 */
export const PERSONA_SECTION = 'deployment:persona'
export const PERSONA_ORDER = 0

/** dsh system-prompt 组装上下文:只有 scope/signal,不含用户消息(需插件自缓存) */
export interface AssembleContext {
  scope?: unknown
  signal?: AbortSignal
}

/** 一个有序 prompt section(注册进调用 scope) */
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly complete?: boolean
}

/** 一个有序动态 context(渲染为 user-role runtime snapshot) */
export interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
}

/** 模型可见的工具 schema(仅 name/description/parameters 上送) */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** 模型可见的内容块 */
export interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** 工具 output 硬约束(dsh rc.5):schema 校验 + render 投影 */
export interface ToolOutputDefinition {
  readonly schema: Record<string, unknown>
  render(args: unknown, value: unknown): ContentBlock[]
}

/** 注册工具:必须声明 output;execute 须协作 exec.signal */
export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

/** session 日志事件(来自 dsh-session SessionEventMap 的投影) */
export interface SessionEvent {
  readonly id: number
  readonly seq: number
  readonly type: string // 'user/message' | 'assistant/message' | 'turn/start' | ...
  readonly data: unknown
  readonly time: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: {
      section(section: PromptSection): () => void
      context(context: PromptContext): () => void
      variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void
    }
    tools: {
      register(definition: ToolDefinition): () => void
    }
  }
  interface Events {
    /** session 日志追加(Scope-filtered:preset 内挂载只收本 agent 事件) */
    'session/event'(session: unknown, event: SessionEvent): void
    /** 会话离开 store(= 会话结束,onSessionEnd hook) */
    'session/disposed'(session: unknown): void
  }
}

export type { Context }
