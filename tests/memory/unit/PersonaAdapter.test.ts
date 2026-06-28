// tests/memory/unit/PersonaAdapter.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { PersonaAdapter } from '../../../src/memory/engines/PersonaAdapter';
import { initializeDatabase } from '../../../src/memory/database';
import type { MemoryEvent } from '../../../src/memory/types';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';

const mockLLM: ILLMService = {
  complete: async (_system: string, _user: string) => JSON.stringify({
    adjustments: [{ param: 'tone.formality', delta: -0.08, reason: '用户觉得太正式了' }],
  }),
};

describe('PersonaAdapter', () => {
  let db: Database.Database;
  let store: PersonaStore;
  let adapter: PersonaAdapter;

  const makeEvent = (content: string): MemoryEvent => ({
    id: 'evt-1',
    session_id: 'sess-1',
    source: 'chat' as const,
    type: 'message' as const,
    payload: { role: 'user', content },
    importance: 0.5,
    created_at: new Date().toISOString(),
    processed: 0,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    // Seed with default persona row
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at) VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}', '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}', '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
    store = new PersonaStore(db);
    adapter = new PersonaAdapter(store, mockLLM);
  });

  afterEach(() => db.close());

  it('should process signal and return adjustment', async () => {
    const event = makeEvent('你说话太正式了，放松一点');
    const adjustment = await adapter.processSignal(event);
    expect(adjustment).not.toBeNull();
    expect(adjustment!.param).toBe('tone.formality');
    expect(Math.abs(adjustment!.delta)).toBeLessThanOrEqual(0.1);
  });

  it('should apply adjustment within bounds', () => {
    const result = adapter.apply({ param: 'tone.formality', delta: -0.08, reason: 'test' });
    expect(result).toBe(true);

    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(-0.08);
  });

  it('should clamp delta to +/-0.1', () => {
    const result = adapter.apply({ param: 'tone.formality', delta: -0.5, reason: 'too much' });
    // Should be clamped, so applied delta is only -0.1
    expect(result).toBe(true);
    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(-0.1);
  });

  it('should enforce cooldown on same dimension', () => {
    adapter.apply({ param: 'tone.formality', delta: -0.05, reason: 'first' });
    const result = adapter.apply({ param: 'tone.formality', delta: -0.05, reason: 'second' });
    // Second should be rejected due to cooldown
    expect(result).toBe(false);
  });

  it('should clamp values to [-1, 1] range', () => {
    for (let i = 0; i < 10; i++) {
      // Bypass cooldown via internal flag for test only
      (adapter as any).lastAdjustmentTime = new Map();
      adapter.apply({ param: 'tone.formality', delta: -0.1, reason: `step ${i}` });
    }
    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBeGreaterThanOrEqual(-1);
  });
});
