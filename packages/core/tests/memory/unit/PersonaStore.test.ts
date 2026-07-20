// tests/memory/unit/PersonaStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { initializeDatabase } from '../../../src/memory/database';

describe('PersonaStore', () => {
  let db: Database.Database;
  let store: PersonaStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new PersonaStore(db);
    // Seed with default row
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at) VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}', '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}', '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
  });

  afterEach(() => db.close());

  it('should return default persona on first read', () => {
    const persona = store.get();
    expect(persona.name).toBe('昔涟');
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(0);
  });

  it('should update tone', () => {
    store.updateTone('{"formality":-0.5,"warmth":0.8,"humor":0.3,"directness":0.1}');
    const parsed = JSON.parse(store.get().tone);
    expect(parsed.formality).toBe(-0.5);
    expect(parsed.warmth).toBe(0.8);
  });

  it('should update speech style', () => {
    store.updateSpeechStyle('{"sentence_length":0.5,"emoji_usage":0.8,"code_heavy":-0.3}');
    const parsed = JSON.parse(store.get().speech_style);
    expect(parsed.emoji_usage).toBe(0.8);
  });

  it('should update emotional range', () => {
    store.updateEmotionalRange('{"expressiveness":0.7,"empathy":0.5,"playfulness":0.4}');
    const parsed = JSON.parse(store.get().emotional_range);
    expect(parsed.expressiveness).toBe(0.7);
  });

  it('should add and retrieve adaptation hints', () => {
    store.addAdaptationHint({
      trigger: 'user_said_too_formal',
      adjustment: { 'tone.formality': -0.15 },
      evidence: 'evt-1',
      applied_at: new Date().toISOString(),
    });
    const hints = store.getAdaptationHints();
    expect(hints).toHaveLength(1);
    expect(hints[0].trigger).toBe('user_said_too_formal');
  });

  it('should update name', () => {
    store.setName('小明');
    expect(store.get().name).toBe('小明');
  });
});
