// src/memory/services/config.ts
// OpenAI-compatible API configuration.
// All values can be set via environment variables — switch providers by changing the URL and key.

export interface ServiceConfig {
  baseUrl: string;       // OpenAI-compatible API base URL (e.g. https://api.deepseek.com/v1)
  apiKey: string;
  embedModel: string;    // embedding model name (e.g. text-embedding-3-small, deepseek-embed)
  embedDimension: number; // embedding vector dimension
  chatModel: string;     // chat model name (e.g. gpt-4o-mini, deepseek-chat)
}

export function loadConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  return {
    baseUrl: overrides?.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: overrides?.apiKey || process.env.OPENAI_API_KEY || '',
    embedModel: overrides?.embedModel || process.env.EMBED_MODEL || 'text-embedding-3-small',
    embedDimension: overrides?.embedDimension || Number(process.env.EMBED_DIMENSION) || 1536,
    chatModel: overrides?.chatModel || process.env.CHAT_MODEL || 'gpt-4o-mini',
  };
}
