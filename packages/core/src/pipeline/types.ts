import type { MemoryManager } from '../memory/MemoryManager.js';
import type { SearchResult, WorldbookEntry } from '../memory/types.js';
import type { MessageChain } from '../platform/chain.js';

// ── Stage 间数据契约 ──────────────────────────────────

/**
 * Pipeline Stage 间传递的数据契约。
 * 每个 key 对应一个 Stage 产出的数据，供下游 Stage 消费。
 * 新增 key 必须在此接口声明，否则 setExtra/getExtra 编译报错。
 */
export interface PipelineExtras {
  /** MemoryRetrievalStage → LLMAgentStage: 拼接好的 System Prompt */
  memory_context: string;
  /** MemoryRetrievalStage → LLMAgentStage: 向量搜索结果 */
  search_results: SearchResult[];
  /** MemoryRetrievalStage → LLMAgentStage: Worldbook 触发条目 */
  worldbook_triggers: WorldbookEntry[];
  /** LLMAgentStage → RespondStage: Agent 生成的回复 */
  response_chain: MessageChain;
  /** LLMAgentStage (POST) → stats: Token 用量快照 */
  _token_usage: { input: number; output: number; total: number };
  /** CLI ad-hoc → LLMAgentStage: 跨轮次对话历史 */
  conversation_history: Array<{ role: string; content: string }>;
  /** ★ 8-10 Coalescer: 合并事件标记（原始消息已各自 ingest，pipeline 侧跳过） */
  coalesced: boolean;
  /** ★ 8-10 Coalescer: 图片描述预热 Promise（adapter fire-and-forget 挂载，flush 时 await 拼接） */
  pending_image_descs: Array<Promise<string | null>>;
}

// ── Stage / PipelineContext ───────────────────────────

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
  /** ★ 8-10 采样参数统一配置（DEFAULT_SAMPLING + config.yml 深合并后） */
  sampling?: SamplingConfig;
  /** ★ 8-10 输入合并器（CoalescerStage）：llm-agent 经它取打断 signal */
  coalescer?: CoalescerStage;
}

// 前向声明 (避免循环依赖)
import type { MessageEvent } from '../platform/event.js';
import type { ProviderManager } from '../provider/manager.js';
import type { SamplingConfig } from '../provider/sampling.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CoalescerStage } from './stages/coalescer.js';
// Local config type for pipeline initialization
interface AlysiaConfig {
  bot: { name: string; ownerId: string };
  llm: {
    primary: { baseUrl: string; apiKey: string; model: string };
    embedding: { baseUrl: string; apiKey: string; model: string };
  };
  server: { port: number };
}
