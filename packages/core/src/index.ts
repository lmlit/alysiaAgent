import { MemoryManager } from './memory/MemoryManager.js';
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
import { LLMAgentStage, getSessionStats } from './pipeline/stages/llm-agent.js';
import { RespondStage } from './pipeline/stages/respond.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createReminderTool, createListRemindersTool, createCancelReminderTool } from './tools/reminder.js';
import { createSessionCommands } from './commands/session.js';
import { createStatsCommand } from './commands/stats.js';
import { AgentRunner } from './agent/runner.js';

export interface AlysiaCoreOptions {
  dbPath: string;
  ownerId: string;
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
}

export class AlysiaCore {
  memoryManager!: MemoryManager;
  providerManager!: ProviderManager;
  toolRegistry!: ToolRegistry;
  commandRegistry!: CommandRegistry;
  eventBus!: EventBus;
  scheduler!: PipelineScheduler;

  constructor(private opts: AlysiaCoreOptions) {
    // Intentionally async-free constructor — all heavy init happens in start()
  }

  registerPlatform(name: string, scheduler?: PipelineScheduler): void {
    this.eventBus.registerScheduler(name, scheduler ?? this.scheduler);
  }

  async start(): Promise<void> {
    // Database (lazy init)
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(this.opts.dbPath);
    db.pragma('journal_mode = WAL');

    // Vector store (lazy init)
    let vectorStore = null;
    try {
      const lancedb = await import('vectordb');
      vectorStore = null; // LanceDB path — init on demand
    } catch { /* LanceDB not available */ }

    // Embed service
    const embedService = {
      embed: async (text: string) => {
        const resp = await fetch(`${this.opts.embedConfig.baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.opts.embedConfig.apiKey}` },
          body: JSON.stringify({ model: this.opts.embedConfig.model, input: text }),
        });
        const data = await resp.json() as any;
        return data.data[0].embedding as number[];
      },
    };

    // LLM service (for memory system)
    const llmService = {
      chat: async (messages: Array<{ role: string; content: string }>) => {
        const resp = await fetch(`${this.opts.llmConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.opts.llmConfig.apiKey}` },
          body: JSON.stringify({ model: this.opts.llmConfig.model, messages }),
        });
        const data = await resp.json() as any;
        return { content: data.choices[0].message.content };
      },
    };

    this.memoryManager = new MemoryManager(db, vectorStore as any, embedService as any, llmService as any);

    // Provider
    this.providerManager = new ProviderManager();
    this.providerManager.registerProvider({
      id: 'default',
      type: 'openai',
      baseUrl: this.opts.llmConfig.baseUrl,
      apiKey: this.opts.llmConfig.apiKey,
      model: this.opts.llmConfig.model,
    });

    // Tools
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.register(createWebSearchTool());
    this.toolRegistry.register(createReminderTool(async (text) => {
      console.log(`[Reminder] ${text}`);
    }));
    this.toolRegistry.register(createListRemindersTool());
    this.toolRegistry.register(createCancelReminderTool());

    // Commands
    this.commandRegistry = new CommandRegistry();
    const sessionCmds = createSessionCommands(
      async (sessionId) => { return 'new-session-id'; },
      async (_sessionId) => {},
    );
    for (const cmd of sessionCmds) {
      this.commandRegistry.register(cmd);
    }
    this.commandRegistry.register(createStatsCommand(getSessionStats));

    // Pipeline
    const ctx = createPipelineContext({
      memoryManager: this.memoryManager as any,
      providerManager: this.providerManager as any,
      toolRegistry: this.toolRegistry as any,
      commandRegistry: this.commandRegistry as any,
    });

    this.scheduler = new PipelineScheduler(ctx, [
      new PIIFilterStage(),
      new MemoryIngestStage(this.memoryManager as any, this.opts.ownerId),
      new WorldbookStage(),
      new MemoryRetrievalStage(this.memoryManager as any),
      new LLMAgentStage(),
      new RespondStage(),
    ]);

    // EventBus
    this.eventBus = new EventBus();

    // Initialize
    await this.scheduler.initialize();
    this.eventBus.dispatch(); // fire and forget
  }

  async stop(): Promise<void> {
    this.eventBus.stop();
  }
}
