// src/memory/stores/PersonaStore.ts
import type Database from 'better-sqlite3';
import type { Persona } from '../types';

export class PersonaStore {
  constructor(private db: Database.Database) {}

  get(): Persona {
    return this.db.prepare('SELECT * FROM persona WHERE id = 1').get() as Persona;
  }

  updateTone(tone: string): void {
    this.db.prepare('UPDATE persona SET tone = ?, updated_at = ? WHERE id = 1')
      .run(tone, new Date().toISOString());
  }

  updateSpeechStyle(style: string): void {
    this.db.prepare('UPDATE persona SET speech_style = ?, updated_at = ? WHERE id = 1')
      .run(style, new Date().toISOString());
  }

  updateEmotionalRange(range: string): void {
    this.db.prepare('UPDATE persona SET emotional_range = ?, updated_at = ? WHERE id = 1')
      .run(range, new Date().toISOString());
  }

  addAdaptationHint(hint: object): void {
    const current = this.getAdaptationHints();
    current.push(hint);
    this.db.prepare('UPDATE persona SET adaptation_hints = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(current), new Date().toISOString());
  }

  getAdaptationHints(): object[] {
    const row = this.db.prepare('SELECT adaptation_hints FROM persona WHERE id = 1').get() as { adaptation_hints: string };
    return JSON.parse(row.adaptation_hints);
  }

  setName(name: string): void {
    this.db.prepare('UPDATE persona SET name = ?, updated_at = ? WHERE id = 1')
      .run(name, new Date().toISOString());
  }
}
