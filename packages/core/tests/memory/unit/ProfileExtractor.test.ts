import { describe, it, expect } from 'vitest';
import { ProfileExtractor } from '../../../src/memory/engines/ProfileExtractor';
import type { ProfileFact, MemoryEvent } from '../../../src/memory/types';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';

const mockLLM: ILLMService = {
  complete: async () => JSON.stringify({
    facts: [
      { fact: '用户是后端工程师', confidence: 0.9, evidence: '我做后端做了5年了' },
    ],
  }),
};

describe('ProfileExtractor', () => {
  const extractor = new ProfileExtractor(mockLLM);

  const makeEvent = (content: string): MemoryEvent => ({
    id: 'evt-1',
    session_id: 'sess-1',
    source: 'chat' as const,
    type: 'message' as const,
    payload: { role: 'user', content },
    importance: 0.6,
    created_at: new Date().toISOString(),
    processed: 0,
  });

  it('should extract facts from events', async () => {
    const events = [makeEvent('我做后端做了5年了')];
    const facts = await extractor.extract(events);
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('用户是后端工程师');
    expect(facts[0].confidence).toBe(0.9);
  });

  it('should merge facts, keeping higher confidence on conflict (v2: supersede + audit trail)', () => {
    const existing: ProfileFact[] = [
      { fact: '用户是前端工程师', confidence: 0.5, evidence: 'old', source_event: 'e1', updated_at: '', source: 'inferred', valid_from: '', valid_until: null, status: 'active' },
    ];
    const newFacts: ProfileFact[] = [
      { fact: '用户是后端工程师', confidence: 0.9, evidence: 'new', source_event: 'e2', updated_at: '', source: 'inferred', valid_from: '', valid_until: null, status: 'active' },
    ];
    const merged = extractor.mergeFacts(newFacts, existing);
    // v2: 旧条 superseded + 新条 active = 2
    expect(merged).toHaveLength(2);
    const activeFacts = merged.filter(f => f.status === 'active');
    expect(activeFacts).toHaveLength(1);
    expect(activeFacts[0].fact).toBe('用户是后端工程师');
  });

  it('should add new facts without conflict', () => {
    const existing: ProfileFact[] = [
      { fact: '用户是工程师', confidence: 0.8, evidence: 'old', source_event: 'e1', updated_at: '' },
    ];
    const newFacts: ProfileFact[] = [
      { fact: '用户喜欢 Rust', confidence: 0.7, evidence: 'new', source_event: 'e2', updated_at: '' },
    ];
    const merged = extractor.mergeFacts(newFacts, existing);
    expect(merged).toHaveLength(2);
  });

  it('should deduplicate semantically identical facts (v2: supersede + audit trail)', () => {
    const existing: ProfileFact[] = [
      { fact: '用户职业是后端开发', confidence: 0.8, evidence: 'old', source_event: 'e1', updated_at: '', source: 'inferred', valid_from: '', valid_until: null, status: 'active' },
    ];
    const newFacts: ProfileFact[] = [
      { fact: '用户是后端工程师', confidence: 0.9, evidence: 'new', source_event: 'e2', updated_at: '', source: 'inferred', valid_from: '', valid_until: null, status: 'active' },
    ];
    const merged = extractor.mergeFacts(newFacts, existing);
    // v2: 旧条 superseded + 新条 active = 2
    expect(merged).toHaveLength(2);
    const activeFacts = merged.filter(f => f.status === 'active');
    expect(activeFacts).toHaveLength(1);
    expect(activeFacts[0].confidence).toBe(0.9);
  });

  it('should return empty for events with no extractable info', async () => {
    const mockEmptyLLM: ILLMService = {
      complete: async () => JSON.stringify({ facts: [] }),
    };
    const emptyExtractor = new ProfileExtractor(mockEmptyLLM);
    const events = [makeEvent('好的')];
    const facts = await emptyExtractor.extract(events);
    expect(facts).toHaveLength(0);
  });
});
