export { logger, startDailyLogCleanup } from './utils/logger.js';
// ★ 2026-10-02 observe-zero-row-writes：写入影响行数观测（只观测不拦截，看 KI-11）
export { traceZeroRows } from './utils/write-trace.js';
// ★ 9-25 fix-session-summary-silent-failure：LLM 结构化输出的共用解析入口
//   （life.ts 与 SessionEndProcessor 共用，详见 utils/llm-json.ts 头部说明）
export { parseLLMJson, stripMarkdownFence, looksTruncated } from './utils/llm-json.js';
export type { LLMJsonResult } from './utils/llm-json.js';
// ★ 8-10 采样参数统一配置（sampling-config-unify）：类型 + 默认 floor 导出，
//   server 侧 config.yml 覆盖时从主入口导入
export { DEFAULT_SAMPLING, mergeSampling, slotToBody } from './provider/sampling.js';
export type { SamplingConfig, SamplingSlot, DeepPartial } from './provider/sampling.js';
// ★ 2026-10-01 构造选项抽到 options.ts（change: modularize-core-assembly）：
//   modules/ 要消费 AlysiaFeatures，从 index.ts 导入会形成循环依赖。此处原样 re-export。
export type { AlysiaFeatures, AlysiaCoreOptions } from './options.js';

import { resolve } from 'path';
import { ModuleHost } from './kernel/index.js';
import { mergeSampling } from './provider/sampling.js';
import {
  dbModule,
  vectorModule,
  embedModule,
  memoryLlmModule,
  memoryModule,
  personaSeedModule,
  providerModule,
  toolsModule,
  commandsModule,
  eventbusModule,
  coalescerModule,
  pipelineModule,
  bootModule,
  // 别名：与下面的同名公开方法区分
  registerChatTools as registerChatToolsInto,
  registerCodeTools as registerCodeToolsInto,
} from './modules/index.js';
import type { SamplingConfig, DeepPartial } from './provider/sampling.js';
import type { AlysiaCoreOptions } from './options.js';
import type { MemoryManager } from './memory/MemoryManager.js';
import type { ProviderManager } from './provider/manager.js';
import type { ToolRegistry } from './tools/registry.js';
import type { CommandRegistry } from './commands/registry.js';
import type { EventBus } from './eventbus/EventBus.js';
import type { PipelineScheduler } from './pipeline/scheduler.js';
import type { CoalescerStage } from './pipeline/stages/coalescer.js';

/**
 * Alysia 核心 —— 记忆 / 人格 / Pipeline / 工具的装配门面。
 *
 * ★ 2026-10-01（change: modularize-core-assembly）：`start()` 从「13 步硬编码总装脚本」
 *   改为「注册一批 `Module` + 跑 `ModuleHost`」。模块定义在 `src/modules/`，
 *   装配契约见 `openspec/specs/module-kernel/spec.md`。
 *
 * **公开面与重构前逐字相同**（server / scripts / console 无感）：
 *   `memoryManager` / `providerManager` / `toolRegistry` / `commandRegistry` /
 *   `eventBus` / `scheduler` / `coalescer` / `sampling`
 *   `start()` / `stop()` / `registerPlatform()` / `isGenerating()` /
 *   `registerChatTools()` / `registerCodeTools()`
 */
export class AlysiaCore {
  memoryManager!: MemoryManager;
  providerManager!: ProviderManager;
  toolRegistry!: ToolRegistry;
  commandRegistry!: CommandRegistry;
  eventBus!: EventBus;
  scheduler!: PipelineScheduler;
  /** ★ 8-15 WebUI pending 查询（webui-chat-endpoints）：在途生成检查 */
  coalescer!: CoalescerStage;
  /** ★ 8-10 深合并后的采样配置（DEFAULT + opts.sampling） */
  sampling: SamplingConfig;

  /** 当前模块宿主（`start()` 时新建，`stop()` 时丢弃） */
  private host: ModuleHost | null = null;

  constructor(private opts: AlysiaCoreOptions) {
    // Intentionally async-free constructor — all heavy init happens in start()
    this.sampling = mergeSampling(opts.sampling);
  }

  registerPlatform(name: string, scheduler?: PipelineScheduler): void {
    this.eventBus.registerScheduler(name, scheduler ?? this.scheduler);
  }

  /** ★ 8-15 WebUI（webui-chat-endpoints）：会话是否有在途生成（Coalescer 打断注册表） */
  isGenerating(sessionId: string): boolean {
    return this.coalescer?.getAbortRegistry().isInFlight(sessionId) ?? false;
  }

  async start(): Promise<void> {
    const features = this.opts.features ?? { codeMode: false };
    const host = new ModuleHost();

    // 声明顺序不影响安装顺序——`ModuleHost` 按 inject 拓扑排序。
    // 这里按「资源 → 能力 → 循环 → 启动」排列，便于与旧版 start() 的 13 步对照。
    host
      .use(dbModule, { path: this.opts.dbPath })
      .use(vectorModule, {
        dir: resolve(this.opts.workspaceDir, 'lancedb'),
        table: 'vectors',
        dimension: 1024, // Zhipu embedding-2 dimension
      })
      .use(embedModule, this.opts.embedConfig)
      .use(memoryLlmModule, this.opts.llmConfig)
      .use(memoryModule, { sampling: this.sampling })
      .use(providerModule, { id: 'default', ...this.opts.llmConfig })
      .use(eventbusModule)
      .use(coalescerModule)
      .use(personaSeedModule, { workspaceDir: this.opts.workspaceDir })
      .use(toolsModule, { features, workspaceDir: this.opts.workspaceDir })
      .use(commandsModule, { ownerId: this.opts.ownerId })
      .use(pipelineModule, { sampling: this.sampling, ownerId: this.opts.ownerId })
      .use(bootModule);

    await host.start();
    this.host = host;

    // 回填公开字段 —— 对外 API 不变，server / scripts 无感
    this.memoryManager = host.get<MemoryManager>('al:memory')!;
    this.providerManager = host.get<ProviderManager>('al:provider')!;
    this.toolRegistry = host.get<ToolRegistry>('al:tools')!;
    this.commandRegistry = host.get<CommandRegistry>('al:commands')!;
    this.eventBus = host.get<EventBus>('al:eventbus')!;
    this.scheduler = host.get<PipelineScheduler>('al:pipeline')!;
    this.coalescer = host.get<CoalescerStage>('al:coalescer')!;
  }

  async stop(): Promise<void> {
    await this.host?.stop();
    this.host = null;
  }

  // ── Tool registration (public so desktop can call registerCodeTools later) ──

  /** 注册聊天工具：服务端 + 桌面端都启用 */
  registerChatTools(db: any): void {
    registerChatToolsInto(this.toolRegistry, this.memoryManager, db);
  }

  /** ★ 注册编程工具：仅桌面端调用。
   *  也可在构造后手动调用 `core.registerCodeTools()` 动态追加。 */
  registerCodeTools(): void {
    registerCodeToolsInto(this.toolRegistry, this.opts.workspaceDir, this.opts.features ?? {});
  }
}
