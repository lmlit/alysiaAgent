// src/memory/services/OpenAILLMService.ts
// OpenAI-compatible LLM service. Works with any provider that exposes
// the /v1/chat/completions endpoint (OpenAI, DeepSeek, Moonshot, etc.).

import type { ServiceConfig } from './config';

export class OpenAILLMService {
  private config: ServiceConfig;

  constructor(config: ServiceConfig) {
    this.config = config;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.chatModel,
        messages,
        temperature: 0.3, // Lower temperature for extraction/summary tasks
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error(`LLM API returned empty response: ${JSON.stringify(data)}`);
    }

    return content;
  }
}
