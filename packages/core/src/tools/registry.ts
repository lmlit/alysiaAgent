export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<string>;
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

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}. Available: ${[...this.tools.keys()].join(', ')}`);
    return tool.handler(args);
  }

  toToolSet(): ToolSet {
    const set = new ToolSet();
    for (const tool of this.tools.values()) {
      set.addTool(tool);
    }
    return set;
  }
}
