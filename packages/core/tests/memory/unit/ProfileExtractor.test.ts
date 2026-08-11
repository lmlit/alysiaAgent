import { describe, it, expect } from 'vitest';
import { ProfileExtractor } from '../../../src/memory/engines/ProfileExtractor';
import type { ProfileFact, MemoryEvent } from '../../../src/memory/types';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';

const mockLLM: ILLMService = {
  complete: async () => JSON.stringify({
    facts: [
      { fact: '用户是后端工程师', confidence: 0.9, evidence: '我做后端做了5年了', directly_stated: true },
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

  it('directly_stated=true → source=user（用户亲口说的事实，显示"[你说过]"）', async () => {
    const events = [makeEvent('我做后端做了5年了')];
    const facts = await extractor.extract(events);
    expect(facts[0].source).toBe('user');
  });

  it('directly_stated 缺失/false → source=inferred（推断事实，标注"待确认"）', async () => {
    const mockInferredLLM: ILLMService = {
      complete: async () => JSON.stringify({
        facts: [
          { fact: '用户可能喜欢甜食', confidence: 0.6, evidence: '用户点了奶茶', directly_stated: false },
          { fact: '用户最近在忙', confidence: 0.5, evidence: '用户说很忙', directly_stated: true },
        ],
      }),
    };
    const extractor2 = new ProfileExtractor(mockInferredLLM);
    const facts = await extractor2.extract([makeEvent('用户点了奶茶')]);
    expect(facts[0].source).toBe('inferred');
    expect(facts[1].source).toBe('user');
  });

  it('user 来源的事实不可被 inferred 覆盖（mergeFacts 保护）', () => {
    const existing: ProfileFact[] = [
      { fact: '用户周末不上班', confidence: 0.9, evidence: '今天周末不上班', source_event: 'e1', updated_at: '', source: 'user', valid_from: '', valid_until: null, status: 'active' },
    ];
    const newFacts: ProfileFact[] = [
      { fact: '用户周末不上班', confidence: 0.5, evidence: 'x', source_event: 'e2', updated_at: '', source: 'inferred', valid_from: '', valid_until: null, status: 'active' },
    ];
    const merged = extractor.mergeFacts(newFacts, existing);
    const active = merged.filter(f => f.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].source).toBe('user');
    expect(active[0].confidence).toBe(0.9);
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

  // ★ 8-12 时效性分类（profile-transient-expiry）：transient=true → 48h 自动过期
  it('transient=true → valid_until 设为 48h 后（时效事实自动过期）', async () => {
    const mockTransientLLM: ILLMService = {
      complete: async () => JSON.stringify({
        facts: [
          { fact: '用户午餐吃了香菜拌牛肉', confidence: 1, evidence: '我午餐吃了香菜拌牛肉', directly_stated: true, transient: true },
        ],
      }),
    };
    const extractor2 = new ProfileExtractor(mockTransientLLM);
    const facts = await extractor2.extract([makeEvent('我午餐吃了香菜拌牛肉')]);
    expect(facts).toHaveLength(1);
    expect(facts[0].valid_until).not.toBeNull();
    const ttl = new Date(facts[0].valid_until!).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(47 * 3600 * 1000);
    expect(ttl).toBeLessThanOrEqual(48 * 3600 * 1000);
  });

  it('transient=false/缺失 → valid_until=null（稳定属性永久有效）', async () => {
    const mockStableLLM: ILLMService = {
      complete: async () => JSON.stringify({
        facts: [
          { fact: '用户目前所在城市是长沙', confidence: 1, evidence: '我在长沙', directly_stated: true, transient: false },
          { fact: '用户玩星穹铁道', confidence: 0.9, evidence: '我在玩', directly_stated: true }, // 缺失 → 按稳定处理
        ],
      }),
    };
    const extractor2 = new ProfileExtractor(mockStableLLM);
    const facts = await extractor2.extract([makeEvent('我在长沙')]);
    expect(facts).toHaveLength(2);
    expect(facts[0].valid_until).toBeNull();
    expect(facts[1].valid_until).toBeNull();
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
