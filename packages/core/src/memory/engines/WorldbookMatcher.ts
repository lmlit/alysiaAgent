import type { WorldbookEntry } from '../types.js';
import { WorldbookStore } from '../stores/WorldbookStore.js';

export class WorldbookMatcher {
  constructor(private store: WorldbookStore) {}

  async match(text: string, mode: 'chat' | 'code', role: string = 'alysia'): Promise<WorldbookEntry[]> {
    const keywords = this.extractKeywords(text);
    if (keywords.length === 0) return [];

    const entries = this.store.matchByKeywords(keywords, mode, role);

    // Record trigger for each matched entry
    for (const entry of entries) {
      this.store.recordTrigger(entry.id);
    }

    return entries;
  }

  private extractKeywords(text: string): string[] {
    // Simple keyword extraction: split by common delimiters, filter short words, deduplicate
    const words = text
      .split(/[\s,，。！？、；：""''（）\(\)\[\]【】\-\+\/\\.]+/)
      .filter(w => w.length >= 2)
      .filter(w => w.length <= 20);

    // Deduplicate case-insensitive, preserving original case
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const w of words) {
      const lower = w.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        unique.push(w);
      }
    }
    return unique;
  }
}
