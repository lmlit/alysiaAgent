// src/memory/services/config.ts
// OpenAI-compatible API configuration.
// Supports dual-provider: chat + embed can use different base URLs/keys/models.

export interface ServiceConfig {
  // Chat / LLM
  chatBaseUrl: string;
  chatApiKey: string;
  chatModel: string;
  // Embedding
  embedBaseUrl: string;
  embedApiKey: string;
  embedModel: string;
  embedDimension: number;
}

/** Load chat config — defaults to OPENAI_BASE_URL/OPENAI_API_KEY, falls back to EMBED_* if not set */
export function loadChatConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  const full = loadConfig(overrides);
  return full;
}

/** Load embed config — uses EMBED_BASE_URL/EMBED_API_KEY if set, otherwise falls back to chat provider */
export function loadEmbedConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  const full = loadConfig(overrides);
  return full;
}

export function loadConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  return {
    chatBaseUrl: overrides?.chatBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    chatApiKey: overrides?.chatApiKey || process.env.OPENAI_API_KEY || '',
    chatModel: overrides?.chatModel || process.env.CHAT_MODEL || 'gpt-4o-mini',
    embedBaseUrl: overrides?.embedBaseUrl || process.env.EMBED_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    embedApiKey: overrides?.embedApiKey || process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY || '',
    embedModel: overrides?.embedModel || process.env.EMBED_MODEL || 'text-embedding-3-small',
    embedDimension: overrides?.embedDimension || Number(process.env.EMBED_DIMENSION) || 1536,
  };
}
