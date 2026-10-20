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
// ★ 2026-10-20（change: observe-and-hold-context-compaction）
import { decideTruncation } from './truncation-policy.js';
import { isCompactionFailed } from '../memory/compaction-status.js';
import { warnThrottled } from '../utils/write-trace.js';

const DEFAULT_MAX_STEPS = 10;

/** ★ 2026-10-20（put-dropped-turns-back）：攒够多少才压一次（防每步一次 LLM 调用） */
const COMPACT_MIN_TURNS = 4;
const COMPACT_MIN_CHARS = 1200;
/** 摘要硬上限（超了截断）：它是回忆，不是档案 */
const COMPACT_MAX_SUMMARY_CHARS = 800;

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

  /**
   * 按截断策略处理上下文（★ 2026-10-20）。
   *
   * 三种结局见 `truncation-policy.ts`；这里只负责执行 + 留痕。
   * ⚠️ **不截断**只在"摘要压缩失败"时发生，且有硬上限兜底 —— 正常路径零变化。
   */
  private async applyTruncation(ctx: AgentContext, maxTokens: number, sessionId: string): Promise<void> {
    const estimated = ctx.estimateTokens();
    const decision = decideTruncation({
      maxTokens,
      estimatedTokens: estimated,
      compactionFailed: isCompactionFailed(sessionId),
    });

    if (decision.action === 'truncate') {
      // ★ 2026-10-20（put-dropped-turns-back）：接住被丢的轮次，攒批后压成回忆
      const dropped = ctx.truncate(maxTokens);
      ctx.addDropped(dropped);
      if (decision.reason === 'over-hard-ceiling') {
        logger.warn(
          `[AgentRunner] 压缩失败但仍超硬上限（估算 ${Math.round(estimated)} > ${maxTokens * 2}）→ 强制截断` +
          ` session=${sessionId.slice(-12)}`,
        );
      }
      await this.compressDroppedTurns(ctx, sessionId);
      return;
    }

    // hold：保住"还没被摘要覆盖"的对话。限频，否则每步一条会淹掉日志
    warnThrottled(
      'runner-hold-truncate',
      `[AgentRunner] 摘要压缩失败中 → **本轮不截断**（估算 ${Math.round(estimated)} tokens，上限 ${maxTokens}）` +
      ` session=${sessionId.slice(-12)}`,
    );
  }

  /**
   * ★ 2026-10-20（change: `put-dropped-turns-back`）：把攒够的被丢弃轮次压成一段回忆插回头部。
   *
   * 四条约束：
   * ① **攒批**：不足 `COMPACT_MIN_TURNS` 条且不足 `COMPACT_MIN_CHARS` 字 → 再等等
   *    （长会话每步丢 1 条，逐条压会一步一次 LLM 调用）
   * ② **不实现就不做**：hooks 没提供 `summarizeDroppedTurns` ⇒ 保持旧行为（直接丢）
   * ③ **失败不阻塞**：压缩失败只留痕（warn，限频），本轮照常继续
   * ④ **累积摘要**：下次把旧摘要 + 新丢弃合并，而不是不断追加新块
   */
  private async compressDroppedTurns(ctx: AgentContext, sessionId: string): Promise<void> {
    if (!this.hooks.summarizeDroppedTurns) return;
    if (ctx.droppedBufferLength() === 0) return;
    if (ctx.droppedBufferLength() < COMPACT_MIN_TURNS && ctx.droppedBufferChars() < COMPACT_MIN_CHARS) {
      return;
    }

    const turns = ctx.takeDroppedBuffer().map(m => ({ role: m.role, content: m.content }));
    const previousSummary = ctx.getContextSummary();
    const started = Date.now();
    try {
      const text = await this.hooks.summarizeDroppedTurns({ turns, previousSummary });
      const trimmed = String(text ?? '').trim();
      if (!trimmed) {
        warnThrottled(
          'runner-compact-empty',
          `[AgentRunner] 上下文压缩返回空 → 这批轮次未插回（${turns.length} 条，session=${sessionId.slice(-12)}）`,
        );
        return;
      }
      ctx.setContextSummary(trimmed.slice(0, COMPACT_MAX_SUMMARY_CHARS));
      logger.info(
        `[AgentRunner] 上下文压缩：${turns.length} 条轮次 → ${trimmed.length} 字回忆` +
        `${previousSummary ? '（与旧摘要合并）' : ''} (${Date.now() - started}ms) session=${sessionId.slice(-12)}`,
      );
    } catch (err: any) {
      // 压缩失败 = 这批真的丢了。必须留痕（否则"丢了"和"没丢"同形）
      warnThrottled(
        'runner-compact-failed',
        `[AgentRunner] 上下文压缩失败 → ${turns.length} 条轮次**已丢弃**：${err?.message ?? err}`,
      );
    }
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
      // ★ 2026-10-20：改走策略（压缩失败时暂不截断），见 applyTruncation
      const provider = this.providerManager.getDefault();
      const maxTokens = provider?.config?.maxContextTokens || 16000;
      await this.applyTruncation(ctx, maxTokens, sessionId);

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

  /** ★ 8-15 流式出口（llm-streaming-pipeline）：
   *  与 run() 同构（截断/工具循环/打断契约/终检全部对齐），仅文本生成阶段改走
   *  streamWithFallback，文本/reasoning chunk 逐块回调 onChunk。
   *  打断语义与 §6.1.1 一致：signal 检查点 + 终检；aborted 结果永不发送。
   *  主路径（QQ 通道 run()）不受影响。 */
  async runStream(
    prompt: string,
    systemPrompt: string,
    imageUrls: string[] = [],
    sessionId: string = 'default',
    sampling?: Partial<SamplingSlot>,
    signal?: AbortSignal,
    onChunk?: (chunk: { kind: 'text' | 'reasoning'; text: string }) => void,
  ): Promise<{
    chain: MessageChain;
    tokenUsage: { input: number; output: number; total: number };
    images: string[];
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
      if (signal?.aborted) {
        logger.info(`[AgentRunner] aborted by signal (${sessionId.slice(-16)})`);
        return { chain: new MessageChain(), tokenUsage: { input: totalInput, output: totalOutput, total: totalInput + totalOutput }, images: toolImages, aborted: true };
      }
      stepCount++;

      const provider = this.providerManager.getDefault();
      const maxTokens = provider?.config?.maxContextTokens || 16000;
      // ★ 2026-10-20：流式路径与 run() 用**同一条**策略（别让两条链路行为分叉）
      await this.applyTruncation(ctx, maxTokens, sessionId);

      const req = {
        prompt,
        sessionId,
        systemPrompt: '',
        contexts: ctx.toOpenAIFormat() as Array<{ role: string; content: string }>,
        imageUrls: stepCount === 1 ? imageUrls : [],
        funcTool: stepCount < this.maxSteps ? this.toolRegistry.toToolSet() : undefined,
        sampling,
        signal,
      };

      // ── 流式文本生成阶段 ──
      let stepText = '';
      let streamErrText: string | null = null;
      let toolResp: LLMResponse | null = null;

      for await (const chunk of this.providerManager.streamWithFallback(req)) {
        // ★ 8-15 流循环内 signal 检查：打断后立即停止回调（不消费剩余 chunk）
        if (signal?.aborted) {
          logger.info(`[AgentRunner] aborted during stream (${sessionId.slice(-16)})`);
          return { chain: new MessageChain(), tokenUsage: { input: totalInput, output: totalOutput, total: totalInput + totalOutput }, images: toolImages, aborted: true };
        }
        if (chunk.role === 'err') {
          // 打断：fetch 层 abort 的 err → aborted 标记（不把 'Request aborted' 当回复）
          if (signal?.aborted) {
            logger.info(`[AgentRunner] in-flight stream aborted (${sessionId.slice(-16)})`);
            return { chain: new MessageChain(), tokenUsage: { input: totalInput, output: totalOutput, total: totalInput + totalOutput }, images: toolImages, aborted: true };
          }
          // 中途失败：已流文本保留，err 文本作为终止标记
          streamErrText = chunk.completionText;
          break;
        }
        if (chunk.isChunk) {
          if (chunk.usage) {
            totalInput += chunk.usage.input;
            totalOutput += chunk.usage.output;
          }
          if (chunk.reasoningContent) {
            onChunk?.({ kind: 'reasoning', text: chunk.reasoningContent });
          }
          if (chunk.completionText) {
            stepText += chunk.completionText;
            onChunk?.({ kind: 'text', text: chunk.completionText });
          }
        } else if (chunk.toolsCallName && chunk.toolsCallName.length > 0) {
          // 工具调用块（流式响应 [DONE] 后一次性）→ 存下，跳出流循环走工具执行
          toolResp = chunk;
          break;
        }
      }

      if (signal?.aborted) {
        // 终检前置：流循环期间被打断
        logger.info(`[AgentRunner] aborted after stream (${sessionId.slice(-16)})`);
        return { chain: new MessageChain(), tokenUsage: { input: totalInput, output: totalOutput, total: totalInput + totalOutput }, images: toolImages, aborted: true };
      }

      if (streamErrText !== null) {
        // provider 全部失败（首 chunk 前 err）或中途失败：已流文本保留，err 文本标记
        if (!stepText) finalText = streamErrText;
        else finalText = stepText;
        break;
      }

      if (toolResp) {
        // 工具执行（与 run() 相同）
        const toolNames: string[] = toolResp.toolsCallName!;
        const toolArgsList = toolResp.toolsCallArgs ?? [];
        const toolCallIds = toolResp.toolsCallIds ?? [];

        ctx.addMessage({
          role: 'assistant',
          content: stepText || '',
          toolCalls: toolNames.map((name: string, i: number) => ({
            id: toolCallIds[i] ?? `call_${i}`,
            type: 'function' as const,
            function: {
              name,
              arguments: JSON.stringify(toolArgsList[i] ?? {}),
            },
          })),
        });

        for (let i = 0; i < toolNames.length; i++) {
          const name = toolNames[i];
          const args = (toolArgsList[i] ?? {}) as Record<string, unknown>;
          const callId = toolCallIds[i] ?? `call_${i}`;

          await this.hooks.onToolStart?.(null, name, args);

          let result: string;
          try {
            const toolResult = await this.toolRegistry.execute(name, args, sessionId);
            result = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            if (result.startsWith('IMG:')) {
              toolImages.push(result.slice(4));
            }
          } catch (err: any) {
            result = `Error: ${err.message}`;
          }

          await this.hooks.onToolEnd?.(null, name, args, result);

          ctx.addMessage({ role: 'tool', content: result, toolCallId: callId });
        }
        continue; // 工具执行后继续下一轮（流式）
      }

      // 纯文本：完成
      finalText = stepText;
      break;
    }

    // ★ 8-10 竞态终检（与 run() 一致）：流式完成后返回前被打断 → 丢弃
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
