export interface ProviderConfig {
  id: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxContextTokens?: number;
}

export interface LLMResponse {
  role: 'assistant' | 'err';
  completionText: string;
  reasoningContent?: string;
  toolsCallName?: string[];
  toolsCallArgs?: Record<string, unknown>[];
  toolsCallIds?: string[];
  usage?: {
    input: number;
    output: number;
    total: number;
    /** ★ 2026-10-02（add-llm-budget-observability）：推理模型花在 reasoning 上的 output 份额。
     *  与可见内容**共用同一个 max_tokens 预算** —— 是判定"预算被吃光"的关键数字。
     *  非推理模型 / 老响应不返回该字段 → undefined。 */
    reasoningTokens?: number;
  };
  /** ★ 2026-10-02（add-llm-budget-observability）：`choices[0].finish_reason`。
   *  `'length'` + content 为空 ⇒ max_tokens 预算被推理吃光（本项目已栽三次的机制）。
   *  `'stop'` + content 为空 ⇒ 不是预算问题，另查。 */
  finishReason?: string;
  isChunk?: boolean;
}

export interface ProviderRequest {
  prompt: string;
  sessionId: string;
  systemPrompt?: string;
  contexts?: Array<{ role: string; content: string }>;
  imageUrls?: string[];
  funcTool?: ToolSet;
  model?: string;
  /** ★ 8-09：强制 JSON 输出（OpenAI/DeepSeek response_format: json_object）。
   *  仅用于要求结构化输出的非流式调用（如 Life 事件生成）；要求 prompt 含 "json" 字样，
   *  不与 funcTool 共用。 */
  responseFormat?: 'json';
  /** ★ 8-10：采样参数覆盖（temperature/top_p/presence_penalty/frequency_penalty/max_tokens）。
   *  未传或字段为 undefined → 不传给 API。主 chat 由 runner/llm-agent 从 sampling.chat 填。 */
  sampling?: Partial<SamplingSlot>;
  /** ★ 8-10 打断：外部 AbortSignal（Coalescer 打断在飞请求用）。
   *  与内部 60s timeout 组合；signal 已 aborted 时请求立即中止且 fallback 不切 provider。 */
  signal?: AbortSignal;
}

import type { SamplingSlot } from './sampling.js';

import type { ToolSet } from '../tools/registry.js';
