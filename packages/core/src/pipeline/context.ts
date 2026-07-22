import type { PipelineContext, Stage } from './types.js';

// Local config type for pipeline initialization
interface LocalConfig {
  bot: { name: string; ownerId: string };
  llm: {
    primary: { baseUrl: string; apiKey: string; model: string };
    embedding: { baseUrl: string; apiKey: string; model: string };
  };
  server: { port: number };
}

// 占位实现 — 后续 Task 逐步填充
export function createPipelineContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config: LocalConfig = {
    bot: { name: 'Alysia', ownerId: '' },
    llm: {
      primary: { baseUrl: '', apiKey: '', model: '' },
      embedding: { baseUrl: '', apiKey: '', model: '' },
    },
    server: { port: 6185 },
  };
  return {
    memoryManager: undefined!,
    providerManager: undefined!,
    toolRegistry: undefined!,
    commandRegistry: undefined!,
    config,
    ...overrides,
  };
}
