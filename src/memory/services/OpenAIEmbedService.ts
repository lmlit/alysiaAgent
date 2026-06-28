// src/memory/services/OpenAIEmbedService.ts
// OpenAI-compatible embedding service. Works with any provider that exposes
// the /v1/embeddings endpoint (OpenAI, DeepSeek, Moonshot, etc.).

import type { ServiceConfig } from './config';

export class OpenAIEmbedService {
  private config: ServiceConfig;
  private _dimension: number;

  constructor(config: ServiceConfig) {
    this.config = config;
    this._dimension = config.embedDimension;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.embedModel,
        input: [text], // OpenAI protocol expects array
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embed API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    const embedding = data.data[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error(`Embed API returned unexpected response: ${JSON.stringify(data)}`);
    }

    // Auto-detect dimension on first call if not explicitly configured
    if (this._dimension !== embedding.length) {
      this._dimension = embedding.length;
    }

    return embedding;
  }

  dimension(): number {
    return this._dimension;
  }
}
