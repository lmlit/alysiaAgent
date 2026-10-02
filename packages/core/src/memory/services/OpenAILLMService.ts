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

  /**
   * ★ 2026-10-01 fix-profile-extract-empty-response：
   *   **第三参 `sampling` 原先被静默丢弃**——本方法此前只声明两个形参，
   *   而 `ILLMService` 契约（`interfaces/ILLMService.ts` 白纸黑字）要求
   *   `(sys, usr, sampling?)`。TS 允许「少形参」赋给「多形参」签名，
   *   所以违约不报错，代价是 `MemoryManager` 的 `slotify` 按场景传进来的槽位
   *   **全部失效**，所有调用（摘要 / 事实提取 / 深度画像 / 人格调整）
   *   都吃构造函数里那一份默认槽。
   *
   *   后果实例：`CronProcessor.deepProfile`（要纯文本）被套上默认槽的
   *   `response_format: 'json_object'` → API 400（它的 prompt 里没有 "json"）。
   *
   *   语义取**替换**而非合并——与构造函数注释「可显式传其他槽」一致；
   *   合并会让调用方**无法摆脱**默认槽的字段（例如去掉 json_object）。
   */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    sampling?: Partial<SamplingSlot>,
  ): Promise<string> {
    const slot = sampling ?? this.sampling;
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
        ...slotToBody(slot),
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
