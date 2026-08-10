import { AgentContext } from './context.js';
import type { AgentHooks } from './hooks.js';
import { NoopAgentHooks } from './hooks.js';
import type { ProviderManager } from '../provider/manager.js';
import type { LLMResponse } from '../provider/types.js';
import type { SamplingSlot } from '../provider/sampling.js';
import type { ToolRegistry } from '../tools/registry.js';
import { MessageChain } from '../platform/chain.js';
import { stripToolCallText } from '../utils/tool-call-strip.js';
import { logger } from '../utils/logger.js';

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
    /** ★ 8-10 主对话采样槽（sampling.chat，config.yml 可配），undefined 字段不传 API */
    sampling?: Partial<SamplingSlot>,
    /** ★ 8-10 打断 signal（Coalescer 新消息打断在飞）：每步检查 + 透传到 fetch */
    signal?: AbortSignal,
  ): Promise<{
    chain: MessageChain;
    tokenUsage: { input: number; output: number; total: number };
    /** 工具发图结果（IMG: 前缀返回值），由调用方附加到回复链 */
    images: string[];
    /** ★ 8-10 被打断标记：true 表示被新消息打断，调用方应丢弃（未发任何内容） */
    aborted?: boolean;
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
      // ★ 8-10 打断检查：signal 已 abort → 立即中止（请求可能还没发出或已被 fetch 层 abort）
      if (signal?.aborted) {
        logger.info(`[AgentRunner] aborted by signal (${sessionId.slice(-16)})`);
        return { chain: new MessageChain(), tokenUsage: { input: totalInput, output: totalOutput, total: totalInput + totalOutput }, images: toolImages, aborted: true };
      }
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
        sampling,
        signal,
      };

      const response: LLMResponse =
        await this.providerManager.textChatWithFallback(req);

      if (response.role === 'err') {
        // ★ 8-10 打断：fetch 层 abort 的 err → 返回 aborted 标记，不把 'Request aborted' 当回复
        if (signal?.aborted) {
          logger.info(`[AgentRunner] in-flight request aborted (${sessionId.slice(-16)})`);
          return { chain: new MessageChain(), tokenUsage: { input: totalInput, output: totalOutput, total: totalInput + totalOutput }, images: toolImages, aborted: true };
        }
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
        // ★ 兜底：模型可能把工具调用以纯文本（伪 XML）写进 content（未走结构化 tool_calls）。
        //   剥离残留标记，避免工具调用文本直接发给用户。
        const raw = response.completionText || '';
        const cleaned = stripToolCallText(raw);
        if (cleaned !== raw) {
          logger.warn(`[AgentRunner] stripped tool-call text from final reply (${raw.length} → ${cleaned.length} chars): ${raw.slice(0, 80).replace(/\n/g, ' ')}`);
        }
        finalText = cleaned;
        break;
      }
    }

    // ★ 8-10 竞态终检（coalescer-abort-race-fix）：fetch 已 resolve 但返回前被打断。
    //   循环开头/err 分支的检查点在 fetch 之前，捕获不到"响应已完整返回后才 abort"
    //   的竞态——此处兜底：被打断的生成结果一律丢弃（返回 aborted，不进入发送），
    //   否则会与合并重发的回复形成双重回复。
    if (signal?.aborted) {
      logger.info(`[AgentRunner] aborted after final response (${sessionId.slice(-16)})`);
      return {
        chain: new MessageChain(),
        tokenUsage: { input: totalInput, output: totalOutput, total: totalInput + totalOutput },
        images: toolImages,
        aborted: true,
      };
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
