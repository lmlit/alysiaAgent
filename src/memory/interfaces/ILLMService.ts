// src/memory/interfaces/ILLMService.ts

export interface ILLMService {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}
