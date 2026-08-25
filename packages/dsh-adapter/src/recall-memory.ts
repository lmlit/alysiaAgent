/**
 * ★ recall_memory 工具(MVP stub)
 * 一期:验证 tools.register 全链路(含 output 硬约束:schema 校验 + lossless JSON + render 投影),
 *      返回占位信息。二期:execute 内调 server API GET /api/memory/read 做真向量检索。
 */
import type { ContentBlock, ToolDefinition } from './types.ts'

export const recallMemory: ToolDefinition = {
  name: 'recall_memory',
  description:
    '查询昔涟的长期记忆。当用户提及过去的事、你们共同经历、或你需要确认与用户的关系状态时调用。'
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
  async execute(args: unknown, _exec: { signal: AbortSignal }): Promise<unknown> {
    // MVP stub:二期改调 server API(见 spec §2.4 工具表)
    return {
      memories: [],
      note: '记忆检索将在二期接入(server API 代写层)',
    }
  },
}
