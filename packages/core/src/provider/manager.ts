import { OpenAIProvider } from './openai.js';
import type { ProviderConfig, ProviderRequest, LLMResponse } from './types.js';

export class ProviderManager {
  private providers: Map<string, OpenAIProvider> = new Map();
  private defaultProviderId: string | null = null;

  registerProvider(config: ProviderConfig): void {
    this.providers.set(config.id, new OpenAIProvider(config));
    if (!this.defaultProviderId) {
      this.defaultProviderId = config.id;
    }
  }

  setDefault(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Provider ${id} not registered`);
    }
    this.defaultProviderId = id;
  }

  getDefault(): OpenAIProvider {
    if (!this.defaultProviderId) {
      throw new Error('No default provider registered');
    }
    return this.providers.get(this.defaultProviderId)!;
  }

  getById(id: string): OpenAIProvider | undefined {
    return this.providers.get(id);
  }

  // Provider fallback: 主 provider 失败时自动切换
  async textChatWithFallback(req: ProviderRequest, fallbackIds: string[] = []): Promise<LLMResponse> {
    const primary = this.getDefault();
    const candidates = [primary, ...fallbackIds.map(id => this.getById(id)).filter(Boolean)];

    for (const provider of candidates) {
      if (!provider) continue;
      const resp = await provider.textChat(req);
      if (resp.role !== 'err') return resp;
      console.warn(`Provider failed, trying next...`);
    }

    return { role: 'err', completionText: 'All providers failed' };
  }
}
