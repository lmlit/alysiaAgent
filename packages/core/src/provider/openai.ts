import { logger } from '../utils/logger.js';
import type { ProviderConfig, ProviderRequest, LLMResponse } from './types.js';

export class OpenAIProvider {
  constructor(public readonly config: ProviderConfig) {}

  async textChat(req: ProviderRequest): Promise<LLMResponse> {
    const messages = this.buildMessages(req);
    const model = req.model || this.config.model;
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    // ★ 8-09：强制 JSON 输出（DeepSeek json_object 模式）——要求 prompt 含 "json" 字样；
    //   与 funcTool 互斥（json mode 与 function calling 共用有兼容风险）
    if (req.responseFormat === 'json' && !req.funcTool) {
      body.response_format = { type: 'json_object' };
    }

    if (req.funcTool && req.funcTool.tools.length > 0) {
      body.tools = req.funcTool.toOpenAI();
      body.tool_choice = 'auto';
    }

    // ★ 8-10 采样参数：场景槽位（sampling.ts 统一配置），undefined 字段不传
    if (req.sampling) {
      for (const [k, v] of Object.entries(req.sampling)) {
        if (v !== undefined) (body as Record<string, unknown>)[k] = v;
      }
    }

    // ★ 8-09 输入日志（debug 级，ALYSIA_DEBUG=1 时打印）——排查 prompt 组装/注入问题用。
    //   不截断：prompt 排障需要看完整组装（含工具定义/最近对话），日志文件侧已有轮转
    logger.debug(`[LLM] request: ${JSON.stringify(messages)}`);

    const controller = new AbortController();
    // ★ 8-10 打断：外部 signal（Coalescer 新消息打断在飞）→ 同一 controller 透传 fetch
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const start = Date.now();

    // ★ 8-12 超时修复（llm-request-timeout-race）：60s 超时改用 Promise.race——
    //   AbortController 无法中断 undici fetch 的 DNS/连接建立阶段（libuv getaddrinfo
    //   提交线程池后不可取消），网络故障（DNS 无响应）时 abort 传不到底层，请求会挂到
    //   DNS 系统超时（线上实测 566s）而非 60s。race 保证准时返回 timed out；
    //   底层挂起的 fetch 最终失败用 .catch(() => {}) 吞掉（防 unhandledRejection）。
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(
        () => reject(Object.assign(new Error('LLM request timed out (60s)'), { name: 'AbortError' as const })),
        60_000,
      );
    });

    try {
      const fetchPromise = fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // 防 unhandledRejection：race 已返回（超时/外部 abort）后，挂起的底层请求
      // 最终失败时其 rejection 必须被消费
      fetchPromise.catch(() => {});
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      if (!response.ok) {
        const errText = await response.text();
        logger.error(`[LLM] API error ${response.status}: ${errText.slice(0, 300)} (${Date.now() - start}ms)`);
        return { role: 'err', completionText: `API error ${response.status}: ${errText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const choice = data.choices?.[0];
      const message = choice?.message;
      const usage = data.usage ? {
        input: data.usage.prompt_tokens,
        output: data.usage.completion_tokens,
        total: data.usage.total_tokens,
      } : undefined;

      // ★ 成功调用日志：耗时 + tokens + 回复/工具调用摘要
      const toolNames = message?.tool_calls?.map((tc: any) => tc.function?.name).filter(Boolean) ?? [];
      logger.info(
        `[LLM] ${model} → ${toolNames.length ? `tool_call: ${toolNames.join(',')}` : (message?.content || '').slice(0, 80).replace(/\n/g, ' ')}` +
        ` tokens=${usage ? `${usage.input}+${usage.output}=${usage.total}` : '?'} (${Date.now() - start}ms)`
      );

      return {
        role: 'assistant',
        completionText: message?.content || '',
        toolsCallName: toolNames,
        toolsCallArgs: message?.tool_calls?.map((tc: any) => {
          try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; }
        }),
        toolsCallIds: message?.tool_calls?.map((tc: any) => tc.id),
        usage,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // ★ 8-10 区分外部打断 vs 超时：打断的请求 token usage ≈ 0（验 abort 真到 fetch 的锚点）
        if (req.signal?.aborted) {
          logger.info(`[LLM] ${model} aborted by signal (${Date.now() - start}ms)`);
          return { role: 'err', completionText: 'Request aborted' };
        }
        // ★ 8-12 race 超时（或 AbortController 路径的 timeout）：统一 60s 语义
        logger.error(`[LLM] ${model} timed out after 60s`);
        return { role: 'err', completionText: 'Request timed out (60s)' };
      }
      logger.error(`[LLM] ${model} request error: ${err.message} (${Date.now() - start}ms)`);
      return { role: 'err', completionText: `Request error: ${err.message}` };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  /** ★ 8-15 流式输出（llm-streaming-pipeline）：与 textChat 对等能力补齐——
   *  sampling 槽位注入、60s 超时 race（fetch 阶段 + 读循环阶段共用 deadline）、
   *  外部 signal 打断（AbortController 透传）、reasoning_content 透传。
   *  工具调用仍在 [DONE] 后一次性 yield（流式不改变工具循环语义）。 */
  async *textChatStream(req: ProviderRequest): AsyncGenerator<LLMResponse> {
    const messages = this.buildMessages(req);
    const model = req.model || this.config.model;
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };

    if (req.funcTool && req.funcTool.tools.length > 0) {
      body.tools = req.funcTool.toOpenAI();
      body.tool_choice = 'auto';
    }

    // ★ 8-15 sampling 槽位注入（与 textChat 同逻辑，undefined 字段不传）
    if (req.sampling) {
      for (const [k, v] of Object.entries(req.sampling)) {
        if (v !== undefined) (body as Record<string, unknown>)[k] = v;
      }
    }

    logger.debug(`[LLM stream] request: ${JSON.stringify(messages)}`);

    const controller = new AbortController();
    // ★ 8-15 外部打断：signal → 同一 controller 透传 fetch（读循环随之抛 AbortError）
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const start = Date.now();

    // ★ 8-15 60s 超时 race（同 llm-request-timeout-race 模式）：fetch 阶段与
    //   流读取阶段共用 deadline——DNS/连接层挂起（abort 传不到）与中途断流都准时超时。
    const deadline = Date.now() + 60_000;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutErr = () => Object.assign(new Error('LLM stream timed out (60s)'), { name: 'AbortError' as const });
    const clearTimer = () => { if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; } };
    const raceTimeout = async <T>(p: Promise<T>): Promise<T> => {
      clearTimer();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutErr();
      return Promise.race([p, new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(timeoutErr()), remaining);
      })]);
    };

    try {
      const fetchPromise = fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // 防 unhandledRejection：race 已返回后，挂起 fetch 最终失败时 rejection 必须被消费
      fetchPromise.catch(() => {});
      const response = await raceTimeout(fetchPromise) as Response;

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        logger.error(`[LLM stream] API error ${response.status}: ${errText.slice(0, 300)} (${Date.now() - start}ms)`);
        yield { role: 'err', completionText: `API error ${response.status}` };
        return;
      }

      logger.info(`[LLM stream] ${model} start (${Date.now() - start}ms to headers)`);
      const reader = response.body?.getReader();
      if (!reader) {
        logger.error(`[LLM stream] ${model}: no response body`);
        yield { role: 'err', completionText: 'No response body' };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const toolCallsAccumulator: Map<number, { name: string; args: string }> = new Map();

      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await raceTimeout(reader.read());
        } finally {
          clearTimer();
        }
        const { done, value } = result;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            // ★ 8-15 reasoning_content 透传（DeepSeek 思考过程独立字段，调用方决定展示）
            if (delta?.reasoning_content) {
              yield { role: 'assistant', completionText: '', reasoningContent: delta.reasoning_content, isChunk: true };
            }
            if (delta?.content) {
              yield { role: 'assistant', completionText: delta.content, isChunk: true };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsAccumulator.has(idx)) {
                  toolCallsAccumulator.set(idx, { name: tc.function?.name || '', args: '' });
                }
                const acc = toolCallsAccumulator.get(idx)!;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
              }
            }
            // ★ 8-15 usage 透传（DeepSeek 流式末块带 usage）——块顺序在文本之后，runner 累积
            if (parsed.usage) {
              yield {
                role: 'assistant',
                completionText: '',
                isChunk: true,
                usage: {
                  input: parsed.usage.prompt_tokens,
                  output: parsed.usage.completion_tokens,
                  total: parsed.usage.total_tokens,
                },
              };
            }
          } catch { /* skip malformed chunks */ }
        }
      }

      // Emit final tool calls if any
      const toolNames: string[] = [];
      const toolArgs: Record<string, unknown>[] = [];
      const toolIds: string[] = [];
      for (const [idx, acc] of toolCallsAccumulator) {
        toolNames.push(acc.name);
        toolIds.push(`call_${idx}`);
        try {
          toolArgs.push(JSON.parse(acc.args));
        } catch {
          toolArgs.push({});
        }
      }
      if (toolNames.length > 0) {
        yield {
          role: 'assistant',
          completionText: '',
          toolsCallName: toolNames,
          toolsCallArgs: toolArgs,
          toolsCallIds: toolIds,
        };
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        if (req.signal?.aborted) {
          // 外部打断：与 textChat 同锚点（日志可验证打断真到 fetch）
          logger.info(`[LLM stream] ${model} aborted by signal (${Date.now() - start}ms)`);
          yield { role: 'err', completionText: 'Request aborted' };
        } else {
          // race 超时（fetch 挂起或中途断流）
          logger.error(`[LLM stream] ${model} timed out after 60s`);
          yield { role: 'err', completionText: 'Request timed out (60s)' };
        }
      } else {
        logger.error(`[LLM stream] ${model} request error: ${err.message} (${Date.now() - start}ms)`);
        yield { role: 'err', completionText: `Request error: ${err.message}` };
      }
    } finally {
      clearTimer();
    }
  }

  private buildMessages(req: ProviderRequest): Array<{ role: string; content: string | object }> {
    const messages: Array<{ role: string; content: string | object }> = [];

    if (req.systemPrompt) {
      messages.push({ role: 'system', content: req.systemPrompt });
    }

    if (req.contexts) {
      // Pass contexts through directly — they may carry tool_call_id, tool_calls, etc.
      messages.push(...req.contexts);
    }

    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: req.prompt },
    ];

    if (req.imageUrls) {
      for (const url of req.imageUrls) {
        userContent.push({ type: 'image_url', image_url: { url } });
      }
    }

    messages.push({
      role: 'user',
      content: req.imageUrls ? userContent : req.prompt,
    });

    return messages;
  }
}
