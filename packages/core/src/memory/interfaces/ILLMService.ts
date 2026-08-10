// src/memory/interfaces/ILLMService.ts
import type { SamplingSlot } from '../../provider/sampling.js';

export interface ILLMService {
  /**
   * 记忆系统通用 LLM 调用。
   * ★ 8-10 第三参 sampling：调用方按场景传采样槽位（undefined 字段不传给 API）。
   */
  complete(systemPrompt: string, userPrompt: string, sampling?: Partial<SamplingSlot>): Promise<string>;
}
