// src/memory/interfaces/IVectorStore.ts
import type { SearchResult } from '../types';

export interface IVectorStore {
  insert(id: string, vector: number[], text: string, metadata: Record<string, unknown>): Promise<void>;
  search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<SearchResult[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}
