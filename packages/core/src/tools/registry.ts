// 临时桩 — Task 10 将实现完整类型
export interface ToolRegistry {
  toToolSet(): ToolSet | undefined;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// 临时桩 — 供 Task 8 provider 使用
export interface ToolSet {
  tools: Array<Record<string, unknown>>;
  toOpenAI(): Array<Record<string, unknown>>;
}
