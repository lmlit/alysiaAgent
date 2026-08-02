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

    if (req.funcTool && req.funcTool.tools.length > 0) {
      body.tools = req.funcTool.toOpenAI();
      body.tool_choice = 'auto';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const start = Date.now();

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

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
        logger.error(`[LLM] ${model} timed out after 60s`);
        return { role: 'err', completionText: 'Request timed out (60s)' };
      }
      logger.error(`[LLM] ${model} request error: ${err.message} (${Date.now() - start}ms)`);
      return { role: 'err', completionText: `Request error: ${err.message}` };
    } finally {
      clearTimeout(timeout);
    }
  }

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

    const start = Date.now();
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

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
      const { done, value } = await reader.read();
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
