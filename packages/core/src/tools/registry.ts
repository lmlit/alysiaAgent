import { logger } from '../utils/logger.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
  /** handler 第二个参数：当前消息的会话 ID（工具需要知道"发给谁"时使用） */
  handler: (args: Record<string, unknown>, sessionId?: string) => Promise<string>;
}

export class ToolSet {
  tools: ToolDefinition[] = [];

  addTool(tool: ToolDefinition): void {
    this.tools.push(tool);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.find(t => t.name === name);
  }

  names(): string[] {
    return this.tools.map(t => t.name);
  }

  toOpenAI(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: object };
  }> {
    return this.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  async execute(name: string, args: Record<string, unknown>, sessionId?: string): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}. Available: ${[...this.tools.keys()].join(', ')}`);
    // ★ 统一工具调用日志：参数/结果摘要 + 耗时，任何工具出问题都能在这里看到
    const argSummary = JSON.stringify(args ?? {}).slice(0, 200);
    logger.info(`[Tool] ${name} ← ${argSummary}${sessionId ? ` (session ${sessionId.slice(-20)})` : ''}`);
    const start = Date.now();
    try {
      const result = await tool.handler(args, sessionId);
      logger.info(`[Tool] ${name} → ${String(result).slice(0, 200)} (${Date.now() - start}ms)`);
      return result;
    } catch (err: any) {
      logger.error(`[Tool] ${name} failed (${Date.now() - start}ms): ${err.message}`);
      throw err;
    }
  }

  toToolSet(): ToolSet {
    const set = new ToolSet();
    for (const tool of this.tools.values()) {
      set.addTool(tool);
    }
    return set;
  }
}
