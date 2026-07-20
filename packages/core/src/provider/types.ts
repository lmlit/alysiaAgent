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
}

import type { ToolSet } from '../tools/registry.js';
