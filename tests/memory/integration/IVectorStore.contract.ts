// IVectorStore Contract Test
// Run against any IVectorStore implementation via the factory pattern.
// Includes an in-memory mock for standalone execution.
import { describe, it, expect, beforeEach } from 'vitest';
import type { IVectorStore } from '../../../src/memory/interfaces/IVectorStore';
import type { SearchResult } from '../../../src/memory/types';

// ── In-memory implementation of IVectorStore ─────────────────────────────────

class InMemoryVectorStore implements IVectorStore {
  private store = new Map<string, { vector: number[]; text: string; metadata: Record<string, unknown> }>();

  async insert(id: string, vector: number[], text: string, metadata: Record<string, unknown>): Promise<void> {
    this.store.set(id, { vector, text, metadata });
  }

  async search(vector: number[], topK: number, _filter?: Record<string, unknown>): Promise<SearchResult[]> {
    const entries = Array.from(this.store.entries());
    const scored = entries
      .map(([id, entry]) => ({
        id,
        score: cosineSimilarity(vector, entry.vector),
        text: entry.text,
        metadata: entry.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored;
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async count(): Promise<number> {
    return this.store.size;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

// ── Exported contract runner ─────────────────────────────────────────────────

export function runVectorStoreContract(factory: () => Promise<IVectorStore>): void {
  describe('IVectorStore Contract', () => {
    let store: IVectorStore;

    beforeEach(async () => {
      store = await factory();
    });

    it('should start with count 0', async () => {
      expect(await store.count()).toBe(0);
    });

    it('should insert and count', async () => {
      await store.insert('id-1', [1, 2, 3], 'test text', { key: 'value' });
      expect(await store.count()).toBe(1);
    });

    it('should search and return scored results in correct order', async () => {
      await store.insert('a', [1, 0, 0], 'apple', {});
      await store.insert('b', [0, 1, 0], 'banana', {});
      await store.insert('c', [0.9, 0.1, 0], 'apple-like', {});

      const results = await store.search([1, 0, 0], 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(2);
      expect(results[0].score).toBeGreaterThan(results[1]?.score ?? 0);
      expect(results[0].id).toBe('a'); // most similar to [1,0,0]
    });

    it('should delete by id', async () => {
      await store.insert('id-1', [1, 2, 3], 'test', {});
      await store.delete('id-1');
      expect(await store.count()).toBe(0);
    });

    it('should handle upsert (insert same id twice)', async () => {
      await store.insert('id-1', [1, 2, 3], 'first', {});
      await store.insert('id-1', [4, 5, 6], 'second', {});
      expect(await store.count()).toBe(1);
    });
  });
}

// ── Standalone run (contract vs in-memory store) ─────────────────────────────

runVectorStoreContract(async () => new InMemoryVectorStore());
