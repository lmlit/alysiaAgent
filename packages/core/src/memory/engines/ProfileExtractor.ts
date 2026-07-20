import type { MemoryEvent, ProfileFact } from '../types';
import type { ILLMService } from '../interfaces/ILLMService';

export class ProfileExtractor {
  constructor(private llm: ILLMService) {}

  async extract(events: MemoryEvent[]): Promise<ProfileFact[]> {
    // Filter by importance threshold as specified in design: only process events with importance > 0.4
    const significantEvents = events.filter(e => e.importance > 0.4);
    const userMessages = significantEvents
      .filter(e => e.type === 'message')
      .map(e => `[${e.payload.role}]: ${e.payload.content}`)
      .join('\n');

    if (!userMessages.trim()) return [];

    try {
      const response = await this.llm.complete(
        '你是一个用户画像提取器。提取关于用户的事实，每条附置信度(0-1)和原文证据。不确定则不提取。返回JSON: {"facts": [{"fact": "...", "confidence": 0.8, "evidence": "..."}]}',
        userMessages
      );
      const parsed = JSON.parse(response);
      return (parsed.facts || []).map((f: { fact: string; confidence: number; evidence: string }, i: number) => ({
        fact: f.fact,
        confidence: f.confidence,
        evidence: f.evidence,
        source_event: events[0]?.id || 'unknown',
        updated_at: new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  }

  mergeFacts(newFacts: ProfileFact[], existing: ProfileFact[]): ProfileFact[] {
    const merged = new Map<string, ProfileFact>();

    // Index existing facts by simplified key
    for (const f of existing) {
      const key = this.normalizeKey(f.fact);
      const current = merged.get(key);
      if (!current || f.confidence > current.confidence) {
        merged.set(key, f);
      }
    }

    // Merge new facts
    for (const f of newFacts) {
      const key = this.normalizeKey(f.fact);
      const current = merged.get(key);
      if (!current || f.confidence > current.confidence) {
        merged.set(key, f);
      }
    }

    return Array.from(merged.values());
  }

  private normalizeKey(fact: string): string {
    // Remove common stop words and generic role descriptors to create a simplified comparison key
    return fact
      .replace(/[的得了吗呢是个了]/g, '')
      .replace(/[职业开发工程师前端后端架构设计运营产品]/g, '')
      .replace(/[\s，,。！？]/g, '')
      .slice(0, 20)
      .toLowerCase();
  }
}
