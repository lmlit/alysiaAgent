import type { ProviderConfig, ProviderRequest, LLMResponse } from './types.js';

export class OpenAIProvider {
  constructor(public readonly config: ProviderConfig) {}

  async textChat(req: ProviderRequest): Promise<LLMResponse> {
    const messages = this.buildMessages(req);
    const body: Record<string, unknown> = {
      model: req.model || this.config.model,
      messages,
      stream: false,
    };

    if (req.funcTool && req.funcTool.tools.length > 0) {
      body.tools = req.funcTool.toOpenAI();
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[LLM] API error ${response.status}: ${errText.slice(0, 300)}`);
      return { role: 'err', completionText: `API error ${response.status}: ${errText.slice(0, 200)}` };
    }

    const data = await response.json() as any;
    const choice = data.choices?.[0];
    const message = choice?.message;

    return {
      role: 'assistant',
      completionText: message?.content || '',
      toolsCallName: message?.tool_calls?.map((tc: any) => tc.function.name),
      toolsCallArgs: message?.tool_calls?.map((tc: any) => JSON.parse(tc.function.arguments || '{}')),
      toolsCallIds: message?.tool_calls?.map((tc: any) => tc.id),
      usage: data.usage ? {
        input: data.usage.prompt_tokens,
        output: data.usage.completion_tokens,
        total: data.usage.total_tokens,
      } : undefined,
    };
  }

  async *textChatStream(req: ProviderRequest): AsyncGenerator<LLMResponse> {
    const messages = this.buildMessages(req);
    const body: Record<string, unknown> = {
      model: req.model || this.config.model,
      messages,
      stream: true,
    };

    if (req.funcTool && req.funcTool.tools.length > 0) {
      body.tools = req.funcTool.toOpenAI();
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const reader = response.body?.getReader();
    if (!reader) {
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
