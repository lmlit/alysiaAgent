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

  // ---- Safety rule #1: 24h stale regression ----

  it('should regress stale params toward 0 after 24h', () => {
    // Apply initial adjustment
    adapter.apply({ param: 'tone.formality', delta: -0.08, reason: 'initial' });
    let persona = store.get();
    let tone = JSON.parse(persona.tone);
    expect(tone.formality).toBeCloseTo(-0.08);

    // Simulate 25h passing
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
    (adapter as any).lastAdjustmentTime.set('tone.formality', staleTime);

    // Apply a different param — triggers regressIfStale first
    adapter.apply({ param: 'tone.warmth', delta: 0.05, reason: 'other' });

    // formality regressed 0.05 toward 0: -0.08 + 0.05 = -0.03
    persona = store.get();
    tone = JSON.parse(persona.tone);
    expect(tone.formality).toBeCloseTo(-0.03);
  });

  it('should not regress params adjusted within 24h', () => {
    adapter.apply({ param: 'tone.formality', delta: -0.08, reason: 'initial' });
    let persona = store.get();
    let tone = JSON.parse(persona.tone);
    expect(tone.formality).toBeCloseTo(-0.08);

    // Apply another param immediately (within 24h)
    adapter.apply({ param: 'tone.warmth', delta: 0.05, reason: 'other' });

    // formality should be unchanged (not stale)
    persona = store.get();
    tone = JSON.parse(persona.tone);
    expect(tone.formality).toBeCloseTo(-0.08);
  });

  it('should not overshoot zero during regression', () => {
    // Set a small value that would overshoot if we naively subtracted 0.05
    adapter.apply({ param: 'tone.formality', delta: -0.02, reason: 'tiny' });
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
    (adapter as any).lastAdjustmentTime.set('tone.formality', staleTime);

    adapter.apply({ param: 'tone.warmth', delta: 0.05, reason: 'other' });

    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(0); // exactly 0, not -0.03 or positive
  });

  // ---- Safety rule #2: Explicit directive bypass ----

  it('should bypass delta clamp when explicit flag is set', () => {
    // Delta of -0.5 exceeds MAX_DELTA (0.1), but explicit bypasses clamp
    adapter.apply({ param: 'tone.formality', delta: -0.5, reason: 'explicit', explicit: true });
    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(-0.5); // full delta applied, only [-1,1] clamp applies
  });

  it('should bypass cooldown when explicit flag is set', () => {
    // First adjustment starts cooldown
    adapter.apply({ param: 'tone.formality', delta: -0.08, reason: 'first' });
    // Second adjustment (same param) bypasses cooldown when explicit
    const result = adapter.apply({ param: 'tone.formality', delta: -0.05, reason: 'explicit', explicit: true });
    expect(result).toBe(true);
    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBeCloseTo(-0.13); // both applied
  });

  it('should bypass limits via options.bypassLimits', () => {
    const result = adapter.apply(
      { param: 'tone.formality', delta: -0.5, reason: 'explicit' },
      { bypassLimits: true },
    );
    expect(result).toBe(true);
    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(-0.5);
  });

  it('should still clamp explicit adjustments to [-1, 1]', () => {
    adapter.apply({ param: 'tone.formality', delta: -5, reason: 'way too much', explicit: true });
    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(-1);
  });

  it('should not reset cooldown timer on explicit bypass', () => {
    // Normal apply (sets cooldown timer)
    adapter.apply({ param: 'tone.formality', delta: -0.08, reason: 'normal' });
    // Explicit bypass (should NOT reset timer)
    adapter.apply({ param: 'tone.formality', delta: 0.05, reason: 'explicit', explicit: true });
    // Next normal apply should still be in cooldown (original timer untouched)
    const result = adapter.apply({ param: 'tone.formality', delta: -0.03, reason: 'should be blocked' });
    expect(result).toBe(false);
  });

  it('should detect explicit patterns in processSignal', async () => {
    const event = makeEvent('不要叫我老师，叫我小明');
    const adjustment = await adapter.processSignal(event);
    expect(adjustment).not.toBeNull();
    expect(adjustment!.explicit).toBe(true);
  });

  it('should not flag regular signals as explicit', async () => {
    const event = makeEvent('你说话太正式了，放松一点');
    const adjustment = await adapter.processSignal(event);
    expect(adjustment).not.toBeNull();
    expect(adjustment!.explicit).toBeUndefined();
  });

  it('should process explicit signal and apply with bypass', async () => {
    const event = makeEvent('不要叫我老师，叫我小明');
    const adjustment = await adapter.processSignal(event);
    expect(adjustment).not.toBeNull();

    // Apply once (normal)
    const r1 = adapter.apply(adjustment!);
    expect(r1).toBe(true);

    // Apply again immediately — should still succeed because explicit bypasses cooldown
    const r2 = adapter.apply(adjustment!);
    expect(r2).toBe(true);
  });
});
