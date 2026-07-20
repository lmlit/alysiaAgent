import type { MemoryManager } from '../memory/MemoryManager.js';

// Stage 接口
export interface Stage {
  initialize(ctx: PipelineContext): Promise<void>;
  process(event: MessageEvent): Promise<void> | AsyncGenerator<void, void, void>;
}

// PipelineContext — 全局依赖注入
export interface PipelineContext {
  memoryManager: MemoryManager;
  providerManager: ProviderManager;
  toolRegistry: ToolRegistry;
  commandRegistry: CommandRegistry;
  config: AlysiaConfig;
}

// 前向声明 (避免循环依赖)
import type { MessageEvent } from '../platform/event.js';
import type { ProviderManager } from '../provider/manager.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { AlysiaConfig } from '../config/types.js';
