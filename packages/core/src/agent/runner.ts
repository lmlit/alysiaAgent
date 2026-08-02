import { AgentContext } from './context.js';
import type { AgentHooks } from './hooks.js';
import { NoopAgentHooks } from './hooks.js';
import type { ProviderManager } from '../provider/manager.js';
import type { LLMResponse } from '../provider/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { MessageChain } from '../platform/chain.js';

const DEFAULT_MAX_STEPS = 10;

export class AgentRunner {
  private hooks: AgentHooks;
  private maxSteps: number;

  constructor(
    private providerManager: ProviderManager,
    private toolRegistry: ToolRegistry,
    hooks?: AgentHooks,
    maxSteps?: number,
  ) {
    this.hooks = hooks ?? new NoopAgentHooks();
    this.maxSteps = maxSteps ?? DEFAULT_MAX_STEPS;
  }

  async run(
    prompt: string,
    systemPrompt: string,
    imageUrls: string[] = [],
    sessionId: string = 'default',
  ): Promise<{
    chain: MessageChain;
    tokenUsage: { input: number; output: number; total: number };
    /** 工具发图结果（IMG: 前缀返回值），由调用方附加到回复链 */
    images: string[];
  }> {
    const ctx = new AgentContext();
    ctx.addMessage({ role: 'system', content: systemPrompt });

    let totalInput = 0;
    let totalOutput = 0;
    let stepCount = 0;
    let finalText = '';
    const toolImages: string[] = [];

    await this.hooks.onAgentBegin?.(null, ctx.messages);

    while (stepCount < this.maxSteps) {
      stepCount++;

      // Truncate based on default provider's max context tokens
      const provider = this.providerManager.getDefault();
      const maxTokens = provider?.config?.maxContextTokens || 16000;
      ctx.truncate(maxTokens);

      const req = {
        prompt,
        sessionId,
        systemPrompt: '', // already in ctx.messages
        contexts: ctx.toOpenAIFormat() as Array<{ role: string; content: string }>,
        imageUrls: stepCount === 1 ? imageUrls : [],
        funcTool: stepCount < this.maxSteps ? this.toolRegistry.toToolSet() : undefined,
      };

      const response: LLMResponse =
        await this.providerManager.textChatWithFallback(req);

      if (response.role === 'err') {
        finalText = response.completionText;
        break;
      }

      if (response.usage) {
        totalInput += response.usage.input;
        totalOutput += response.usage.output;
      }

      if (
        response.role === 'assistant' &&
        response.toolsCallName &&
        response.toolsCallName.length > 0
      ) {
        const toolNames: string[] = response.toolsCallName;
        const toolArgsList = response.toolsCallArgs ?? [];
        const toolCallIds = response.toolsCallIds ?? [];

        // Record assistant message with tool calls
        ctx.addMessage({
          role: 'assistant',
          content: response.completionText || '',
          toolCalls: toolNames.map((name: string, i: number) => ({
            id: toolCallIds[i] ?? `call_${i}`,
            type: 'function' as const,
            function: {
              name,
              arguments: JSON.stringify(toolArgsList[i] ?? {}),
            },
          })),
        });

        // Execute tools
        for (let i = 0; i < toolNames.length; i++) {
          const name = toolNames[i];
          const args = (toolArgsList[i] ?? {}) as Record<string, unknown>;
          const callId = toolCallIds[i] ?? `call_${i}`;

          await this.hooks.onToolStart?.(null, name, args);

          let result: string;
          try {
            const toolResult = await this.toolRegistry.execute(name, args, sessionId);
            result =
              typeof toolResult === 'string'
                ? toolResult
                : JSON.stringify(toolResult);
            // ★ 工具发图协议：返回值以 IMG: 开头 → 图片路径收集到回复链
            if (result.startsWith('IMG:')) {
              toolImages.push(result.slice(4));
            }
          } catch (err: any) {
            result = `Error: ${err.message}`;
          }

          await this.hooks.onToolEnd?.(null, name, args, result);

          ctx.addMessage({
            role: 'tool',
            content: result,
            toolCallId: callId,
          });
        }
      } else {
        // Plain text response — done
        finalText = response.completionText || '';
        break;
      }
    }

    if (stepCount >= this.maxSteps) {
      finalText = finalText || '(达到最大步数限制)';
    }

    const chain = new MessageChain().message(finalText);
    await this.hooks.onAgentDone?.(null, {
      role: 'assistant',
      completionText: finalText,
    });

    return {
      chain,
      tokenUsage: {
        input: totalInput,
        output: totalOutput,
        total: totalInput + totalOutput,
      },
      images: toolImages,
    };
  }
}
