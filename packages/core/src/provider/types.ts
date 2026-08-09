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
  };
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
}

import type { ToolSet } from '../tools/registry.js';
