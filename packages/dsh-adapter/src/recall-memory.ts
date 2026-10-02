/**
 * `recall_memory` 工具 —— 她在 dsh 里**主动查记忆**的路径。
 *
 * ★ 与 context provider 的分工（change: bridge-memory-read）：
 *   - **本工具**：异步、带 query、即时准确。她想知道什么就查什么。
 *   - **context provider**（`index.ts` 的 `alysia:memory`）：被动背景，
 *     受 dsh「provider 必须同步」限制只能给缓存，可能有 1 轮延迟。
 *
 * 两者互补：context 让她**知道该问什么**，工具让她**问得到**。
 */

import type { ContentBlock, ToolDefinition } from './types.ts'
import type { AlysiaClient } from './alysia-client.ts'

/**
 * 造一个绑定到指定 alysia client 的 recall_memory 工具。
 *
 * （做成工厂而非静态对象：工具要发 HTTP，需要 client。见 `alysia-client.ts`。）
 */
export function createRecallMemoryTool(client: AlysiaClient): ToolDefinition {
  return {
    name: 'recall_memory',
    description:
      '查询昔涟的长期记忆（共同经历、用户的偏好与近况、过去聊过的事）。'
      // ★ 2026-10-02：原描述只说「何时可以调」，太被动——她倾向于用手上已有的信息直接回答。
      //   改成**主动引导**：讲清「自动带上的是概览且慢一拍」+「不确定就查」。
      + ' 系统每轮会自动带上**一部分**相关记忆，但那是概览、且可能慢一拍；'
      + '**当你需要回忆具体的事、或不确定自己记不记得时，主动查这里**——'
      + '尤其用户说「上次」「之前」「你还记得吗」的时候。宁可多查一次。'
      + ' 参数 query 是你要回忆的内容主题。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回忆的内容主题,如「用户上次聊到的猫」' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          memories: { type: 'array', items: { type: 'string' }, description: '命中的记忆片段' },
          note: { type: 'string', description: '检索备注' },
        },
        required: ['memories'],
      },
      render(args: unknown, value: unknown): ContentBlock[] {
        const { memories, note } = value as { memories: string[]; note?: string }
        if (memories.length === 0) {
          return [{ type: 'text', text: `(没有找到相关记忆${note ? ` — ${note}` : ''})` }]
        }
        const lines = memories.map((m, i) => `${i + 1}. ${m}`).join('\n')
        return [{ type: 'text', text: `回忆到:\n${lines}` }]
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown> {
      // ★ 协作取消：dsh 的取消是协作式的，execute 必须看 signal
      if (exec?.signal?.aborted) {
        return { memories: [], note: '已取消' }
      }

      const query = String((args as { query?: unknown })?.query ?? '').trim()
      if (!query) {
        return { memories: [], note: 'query 为空' }
      }

      const result = await client.readMemory(query)
      if (result === null) {
        // best-effort：服务不可达不是错误，如实说一句就行（比抛出去好——
        // 抛出去会让这一轮工具调用失败，而她只是想回忆点事）
        return { memories: [], note: '记忆服务不可达（alysia server 没在跑？）' }
      }

      return {
        memories: result.retrieved.map(r => r.text).filter(Boolean),
        note: result.retrieved.length === 0 ? '这次没找到相关的' : undefined,
      }
    },
  }
}
