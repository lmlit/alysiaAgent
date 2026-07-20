import type { PipelineContext, Stage } from './types.js';

// 占位实现 — 后续 Task 逐步填充
export function createPipelineContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    memoryManager: undefined!,
    providerManager: undefined!,
    toolRegistry: undefined!,
    commandRegistry: undefined!,
    config: {
      bot: { name: 'Alysia', ownerId: '' },
      llm: {
        primary: { baseUrl: '', apiKey: '', model: '' },
        embedding: { baseUrl: '', apiKey: '', model: '' },
      },
      server: { port: 6185 },
    },
    ...overrides,
  };
}
