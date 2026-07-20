import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { AgentRunner } from '../../agent/runner.js';
import { MessageChain } from '../../platform/chain.js';

// In-memory token stats store — keyed by unifiedMsgOrigin
const sessionStats: Map<
  string,
  { recordCount: number; totalInput: number; totalOutput: number; totalTokens: number }
> = new Map();

export function getSessionStats(
  sessionId: string,
): { recordCount: number; totalInput: number; totalOutput: number; totalTokens: number } {
  return (
    sessionStats.get(sessionId) ?? {
      recordCount: 0,
      totalInput: 0,
      totalOutput: 0,
      totalTokens: 0,
    }
  );
}

/**
 * LLMAgentStage — the core onion-model stage.
 *
 * PRE:  intercepts commands via CommandRegistry, otherwise runs AgentRunner
 *       (system prompt from memory_context, image URL extraction)
 * YIELD:→ RespondStage sends the response
 * POST: records token usage into the in-memory sessionStats store
 */
export class LLMAgentStage implements Stage {
  private runner!: AgentRunner;
  private ctx!: PipelineContext;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
    this.runner = new AgentRunner(ctx.providerManager, ctx.toolRegistry);
  }

  async *process(event: MessageEvent): AsyncGenerator<void> {
    // ===== PRE: Check commands =====
    const cmdResult = await this.ctx.commandRegistry?.execute(
      event,
      event.messageStr,
    );
    if (cmdResult) {
      event.setExtra('response_chain', new MessageChain().message(cmdResult));
      yield; // → RespondStage
      return;
    }

    // ===== PRE: LLM call =====
    const systemPrompt =
      (event.getExtra<string>('memory_context') || '') +
      '\n你叫昔涟，是一个温柔、善解人意的 AI 伴侣。';

    // Extract image URLs from message components
    const imageUrls: string[] = [];
    for (const comp of event.getMessages()) {
      if (comp.type === 'image') {
        imageUrls.push((comp as { url?: string; file?: string }).url || '');
      }
    }

    const result = await this.runner.run(
      event.messageStr,
      systemPrompt,
      imageUrls.filter(Boolean),
      event.unifiedMsgOrigin,
    );

    event.setExtra('response_chain', result.chain);

    // Stash token usage so POST can read it after yield
    event.setExtra('_token_usage', result.tokenUsage);

    // ===== YIELD: Let RespondStage send the response =====
    yield;

    // ===== POST: Token stats recording =====
    const usage = event.getExtra<{
      input: number;
      output: number;
      total: number;
    }>('_token_usage');
    if (usage) {
      const umo = event.unifiedMsgOrigin;
      const existing = sessionStats.get(umo) ?? {
        recordCount: 0,
        totalInput: 0,
        totalOutput: 0,
        totalTokens: 0,
      };
      existing.recordCount += 1;
      existing.totalInput += usage.input;
      existing.totalOutput += usage.output;
      existing.totalTokens += usage.total;
      sessionStats.set(umo, existing);
    }
  }
}
