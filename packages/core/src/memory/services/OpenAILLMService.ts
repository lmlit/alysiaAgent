// src/memory/services/OpenAILLMService.ts
// OpenAI-compatible LLM service. Works with any provider that exposes
// the /v1/chat/completions endpoint (OpenAI, DeepSeek, Moonshot, etc.).
// 用途：E2E 测试（tests/memory/e2e/）构造 MemoryManager 的真实 LLM 服务。

import type { ServiceConfig } from './config.js';
import { DEFAULT_SAMPLING, slotToBody } from '../../provider/sampling.js';
import type { SamplingSlot } from '../../provider/sampling.js';

export class OpenAILLMService {
  private config: ServiceConfig;
  private sampling: Partial<SamplingSlot>;

  constructor(config: ServiceConfig, sampling?: Partial<SamplingSlot>) {
    this.config = config;
    // ★ 8-10 采样参数统一（sampling-config-unify）：默认取 profile.extract 槽
    //   （提取/摘要类任务低温），可显式传其他槽
    this.sampling = { ...DEFAULT_SAMPLING.profile.extract, ...(sampling ?? {}) };
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const response = await fetch(`${this.config.chatBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.chatApiKey}`,
      },
      body: JSON.stringify({
        model: this.config.chatModel,
        messages,
        ...slotToBody(this.sampling),
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
