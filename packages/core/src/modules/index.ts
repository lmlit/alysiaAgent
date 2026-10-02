/**
 * 内置模块清单（change: modularize-core-assembly）。
 *
 * 依赖图（DAG，由 `ModuleHost` 拓扑排序保证顺序）：
 *
 * ```
 * 层级0  al:db  al:vector  al:embed  al:memory-llm  al:provider  al:eventbus
 * 层级1  al:memory ←(db,vector,embed,memory-llm)   al:coalescer ←(eventbus)
 * 层级2  al:persona-seed / al:tools / al:commands ←(memory)
 * 层级3  al:pipeline ←(memory,provider,tools,commands,coalescer)
 * 层级4  al:boot ←(pipeline,eventbus)
 * ```
 *
 * ★ P2 会把每个模块挪到 `modules/<name>/` 独立目录；当前按主题分组，
 *   便于对照 `AlysiaCore.start()` 的原 13 步一起审阅。
 */

export { dbModule, vectorModule, embedModule, memoryLlmModule } from './resources.js';
export type { DbConfig, VectorConfig, HttpEndpointConfig } from './resources.js';

export { memoryModule, personaSeedModule } from './memory.js';
export type { MemoryConfig, PersonaSeedConfig } from './memory.js';

export {
  providerModule,
  toolsModule,
  commandsModule,
  registerChatTools,
  registerCodeTools,
} from './capabilities.js';
export type { ProviderConfig, ToolsConfig, CommandsConfig } from './capabilities.js';

export { eventbusModule, coalescerModule, pipelineModule, bootModule } from './loop.js';
export type { PipelineConfig } from './loop.js';
