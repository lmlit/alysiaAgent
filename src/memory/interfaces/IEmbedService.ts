// src/memory/interfaces/IEmbedService.ts

export interface IEmbedService {
  embed(text: string): Promise<number[]>;
  dimension(): number;
}
