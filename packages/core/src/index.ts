export { logger, startDailyLogCleanup } from './utils/logger.js';
// ★ 8-10 采样参数统一配置（sampling-config-unify）：类型 + 默认 floor 导出，
//   server 侧 config.yml 覆盖时从主入口导入
export { DEFAULT_SAMPLING, mergeSampling, slotToBody } from './provider/sampling.js';
export type { SamplingConfig, SamplingSlot, DeepPartial } from './provider/sampling.js';

import { MemoryManager } from './memory/MemoryManager.js';
import { initializeDatabase } from './memory/database.js';
import { PipelineScheduler } from './pipeline/scheduler.js';
import { createPipelineContext } from './pipeline/context.js';
import { EventBus } from './eventbus/EventBus.js';
import { ProviderManager } from './provider/manager.js';
import { ToolRegistry } from './tools/registry.js';
import { CommandRegistry } from './commands/registry.js';
import { PIIFilterStage } from './pipeline/stages/pii-filter.js';
import { MemoryIngestStage } from './pipeline/stages/memory-ingest.js';
import { WorldbookStage } from './pipeline/stages/worldbook.js';
import { MemoryRetrievalStage } from './pipeline/stages/memory-retrieval.js';
import { LLMAgentStage } from './pipeline/stages/llm-agent.js';
import { RespondStage } from './pipeline/stages/respond.js';
import { CoalescerStage } from './pipeline/stages/coalescer.js';
import { createWebSearchTool, createWeatherTool } from './tools/web-search.js';
import { createWorldbookTool } from './tools/worldbook.js';
import { createReminderTool, createListRemindersTool, createCancelReminderTool } from './tools/reminder.js';
import { createShellExecTool } from './tools/shell.js';
import { createWriteFileTool, createReadFileTool, createListFilesTool } from './tools/filesystem.js';
import { createSessionCommands } from './commands/session.js';
import { createStatsCommand } from './commands/stats.js';
import { seedPersona, seedWorldbook, buildPersonaSystemPrompt } from './persona/loader.js';
import { logger } from './utils/logger.js';
import { mergeSampling, slotToBody } from './provider/sampling.js';
import type { SamplingConfig, SamplingSlot, DeepPartial } from './provider/sampling.js';

// ── Feature flags ──────────────────────────────────────

/** 控制 AlysiaCore 启动时激活的能力模块 */
export interface AlysiaFeatures {
  /** 编程模式：启用 shell + filesystem 工具 + CodeContextStore。
   *  服务端默认 false，桌面端设置为 true。 */
  codeMode?: boolean;
  /** Shell 执行工具（需 codeMode）。默认 true（当 codeMode 开启时）。 */
  shell?: boolean;
  /** 文件系统工具 — write/read/list（需 codeMode）。默认 true（当 codeMode 开启时）。 */
  filesystem?: boolean;
  /** 流式输出（LLM 逐 token 推送，桌面端 Live2D 口型同步需要）。默认 false。 */
  streaming?: boolean;
}

export interface AlysiaCoreOptions {
  dbPath: string;
  ownerId: string;
  workspaceDir: string;
  llmConfig: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  embedConfig: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  /** 能力开关。未提供时全部使用默认值（codeMode=false）。 */
  features?: AlysiaFeatures;
  /** ★ 8-10 采样参数统一配置（与 DEFAULT_SAMPLING 深合并，缺省走默认 floor）。
   *  对应 config.yml 的 sampling: 节。 */
  sampling?: DeepPartial<SamplingConfig>;
}

export class AlysiaCore {
  memoryManager!: MemoryManager;
  providerManager!: ProviderManager;
  toolRegistry!: ToolRegistry;
  commandRegistry!: CommandRegistry;
  eventBus!: EventBus;
  scheduler!: PipelineScheduler;
  /** ★ 8-10 深合并后的采样配置（DEFAULT + opts.sampling） */
  sampling: SamplingConfig;

  constructor(private opts: AlysiaCoreOptions) {
    // Intentionally async-free constructor — all heavy init happens in start()
    this.sampling = mergeSampling(opts.sampling);
  }

  registerPlatform(name: string, scheduler?: PipelineScheduler): void {
    this.eventBus.registerScheduler(name, scheduler ?? this.scheduler);
  }

  async start(): Promise<void> {
    // Database (lazy init)
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(this.opts.dbPath);
    db.pragma('journal_mode = WAL');
    initializeDatabase(db);

    // ★ LanceDB vector store — embedded vector database.
    // On failure (missing native lib, etc.), falls back to SQLite text search.
    let vectorStore: any = null;
    try {
      const { LanceDBStore } = await import('./memory/stores/LanceDBStore.js');
      const { resolve } = await import('path');
      const lanceStore = new LanceDBStore(
        resolve(this.opts.workspaceDir, 'lancedb'),
        'vectors',
        1024, // Zhipu embedding-2 dimension
      );
      await lanceStore.initialize();
      vectorStore = lanceStore;
      logger.info('LanceDB vector store ready');
    } catch (err: any) {
      logger.warn(`LanceDB unavailable, using text search fallback: ${err.message}`);
    }

    // Embed service
    const embedService = {
      embed: async (text: string) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch(`${this.opts.embedConfig.baseUrl}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.opts.embedConfig.apiKey}` },
            body: JSON.stringify({ model: this.opts.embedConfig.model, input: text }),
            signal: controller.signal,
          });
          if (!resp.ok) {
            throw new Error(`Embed API error ${resp.status}: ${await resp.text().catch(() => '')}`);
          }
          const data = await resp.json() as any;
          const embedding = data?.data?.[0]?.embedding;
          if (!embedding || !Array.isArray(embedding)) {
            throw new Error(`Embed API returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
          }
          return embedding as number[];
        } finally {
          clearTimeout(timeout);
        }
      },
      dimension: () => 1024,
    };

    // LLM service (for memory system — must match ILLMService interface)
    // ★ 8-10 第三参 sampling：由 MemoryManager 内部 slotify 包装按场景传槽位
    //   （profile.extract / session.summary），undefined → 不传参数
    const llmService = {
      complete: async (systemPrompt: string, userPrompt: string, sampling?: Partial<SamplingSlot>): Promise<string> => {
        const resp = await fetch(`${this.opts.llmConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.opts.llmConfig.apiKey}` },
          body: JSON.stringify({
            model: this.opts.llmConfig.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            ...slotToBody(sampling),
          }),
        });
        if (!resp.ok) {
          throw new Error(`LLM API error ${resp.status}: ${await resp.text().catch(() => '')}`);
        }
        const data = await resp.json() as any;
        return data?.choices?.[0]?.message?.content || '';
      },
    };

    this.memoryManager = new MemoryManager(db, vectorStore as any, embedService as any, llmService as any, this.sampling);

    // Seed persona + worldbook from data files
    await seedPersona(this.memoryManager);
    await seedWorldbook(this.memoryManager);

    // ★ 角色包目录自动加载：{dataDir}/roles/*.json 启动时自动导入
    //   新增角色 = 往 roles/ 放一个 JSON 文件即可
    await this.loadRolePackages();

    // Provider
    this.providerManager = new ProviderManager();
    this.providerManager.registerProvider({
      id: 'default',
      type: 'openai',
      baseUrl: this.opts.llmConfig.baseUrl,
      apiKey: this.opts.llmConfig.apiKey,
      model: this.opts.llmConfig.model,
    });

    // Tools — chat tools always registered, code tools only for desktop
    this.toolRegistry = new ToolRegistry();
    this.registerChatTools(db);
    if (this.opts.features?.codeMode) {
      this.registerCodeTools();
    }

    // Commands
    this.commandRegistry = new CommandRegistry();
    const sessionCmds = createSessionCommands(
      // /new: 保存当前会话记忆后重置上下文
      async (sessionId) => {
        await this.memoryManager.onSessionEnd(sessionId);
        logger.info(`[cmd] /new — session saved: ${sessionId.slice(-20)}`);
      },
      // /reset: 清空上下文，不保存记忆
      async (sessionId) => {
        // 标记会话事件为已处理（跳过记忆提取）
        logger.info(`[cmd] /reset — context cleared: ${sessionId.slice(-20)}`);
      },
      // /stop: 中断标记（实际中断机制待 AgentRunner 支持 AbortController）
      async (sessionId) => {
        logger.info(`[cmd] /stop — requested for: ${sessionId.slice(-20)}`);
      },
    );
    for (const cmd of sessionCmds) {
      this.commandRegistry.register(cmd);
    }
    this.commandRegistry.register(createStatsCommand((sid) => this.memoryManager.getTokenStats(sid) as any));

    // ★ 8-10 输入合并 + 打断（input-coalescing-and-abort）：CoalescerStage 插在
    //   memory-ingest 之后、worldbook 之前——私聊窗口合并 + 新消息打断在飞；
    //   群聊不合并不打断（保持现状）
    const coalescer = new CoalescerStage();

    // Pipeline
    const ctx = createPipelineContext({
      memoryManager: this.memoryManager as any,
      providerManager: this.providerManager as any,
      toolRegistry: this.toolRegistry as any,
      commandRegistry: this.commandRegistry as any,
      sampling: this.sampling,
      coalescer,
    });

    this.scheduler = new PipelineScheduler(ctx, [
      new PIIFilterStage(),
      new MemoryIngestStage(this.memoryManager as any, this.opts.ownerId),
      coalescer,
      new WorldbookStage(),
      new MemoryRetrievalStage(this.memoryManager as any),
      new LLMAgentStage(),
      new RespondStage(),
    ]);

    // EventBus
    this.eventBus = new EventBus();
    coalescer.setEventBus(this.eventBus);

    // Initialize
    await this.scheduler.initialize();
    this.eventBus.dispatch().catch(err => logger.error('EventBus dispatch error:', err));
  }

  async stop(): Promise<void> {
    this.eventBus.stop();
  }

  /** ★ 角色包目录自动加载：{dataDir}/roles/*.json → importRole()
   *  角色包格式见 docs/superpowers/specs/2026-07-31-role-system.md */
  private async loadRolePackages(): Promise<void> {
    try {
      const { readdirSync, readFileSync, existsSync } = await import('fs');
      const { resolve } = await import('path');
      const rolesDir = resolve(this.opts.workspaceDir, '..', 'roles');
      // 兼容两种位置：dataDir/roles 与 workspaceDir/../roles
      const candidates = [
        resolve(this.opts.workspaceDir, '..', 'roles'),
        resolve(this.opts.workspaceDir, 'roles'),
      ];
      const dir = candidates.find(d => existsSync(d));
      if (!dir) return;

      const files = readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const pkg = JSON.parse(readFileSync(resolve(dir, file), 'utf-8'));
          const result = this.memoryManager.importRole(pkg);
          logger.info(`Role package loaded: ${file} → ${result.role} (${result.worldbookCount} worldbook)`);
        } catch (err: any) {
          logger.error(`Failed to load role package ${file}:`, err.message);
        }
      }
    } catch { /* roles dir not available — skip */ }
  }

  // ── Tool registration (public so desktop can call registerCodeTools later) ──

  /** 注册聊天工具：服务端 + 桌面端都启用 */
  registerChatTools(db: any): void {
    this.toolRegistry.register(createWebSearchTool());
    this.toolRegistry.register(createWeatherTool());
    this.toolRegistry.register(createWorldbookTool(db));
    // ★ 8-12 桌面端/CLI 路径无 SQLite 持久化：no-op persist（内存调度不变）
    const noopPersist = { save: () => {}, remove: () => {} };
    this.toolRegistry.register(createReminderTool(async (text: string): Promise<boolean> => {
      logger.info(`Reminder triggered: ${text}`);
      return true; // 仅日志路径视为已处理（无推送通道）
    }, noopPersist));
    this.toolRegistry.register(createListRemindersTool());
    this.toolRegistry.register(createCancelReminderTool(noopPersist));
    // 表情包不再注册为工具 — 改用文案内标记 [表情包:名字]，发送时解析（LLMAgentStage + adapter）
  }

  /** ★ 注册编程工具：仅桌面端调用。
   *  也可在构造后手动调用 `core.registerCodeTools()` 动态追加。 */
  registerCodeTools(): void {
    const features = this.opts.features ?? {};
    if (features.shell !== false) {
      this.toolRegistry.register(createShellExecTool(this.opts.workspaceDir));
    }
    if (features.filesystem !== false) {
      this.toolRegistry.register(createWriteFileTool(this.opts.workspaceDir));
      this.toolRegistry.register(createReadFileTool(this.opts.workspaceDir));
      this.toolRegistry.register(createListFilesTool(this.opts.workspaceDir));
    }
  }
}
