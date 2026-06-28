// src/memory/stores/ProfileStore.ts
import type Database from 'better-sqlite3';
import type { UserProfile, ProfileFact } from '../types';

export class ProfileStore {
  constructor(private db: Database.Database) {}

  private ensureRow(): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)
    `).run(new Date().toISOString());
  }

  get(): UserProfile {
    this.ensureRow();
    return this.db.prepare('SELECT * FROM user_profile WHERE id = 1').get() as UserProfile;
  }

  updateBasics(basics: string): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET basics = ?, updated_at = ? WHERE id = 1')
      .run(basics, new Date().toISOString());
  }

  updatePreferences(prefs: string): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET preferences = ?, updated_at = ? WHERE id = 1')
      .run(prefs, new Date().toISOString());
  }

  addFacts(newFacts: ProfileFact[]): void {
    this.ensureRow();
    const current = this.getFacts();
    const updated = [...current, ...newFacts];
    this.replaceFacts(updated);
  }

  getFacts(): ProfileFact[] {
    this.ensureRow();
    const row = this.db.prepare('SELECT facts FROM user_profile WHERE id = 1').get() as { facts: string };
    return JSON.parse(row.facts);
  }

  replaceFacts(facts: ProfileFact[]): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET facts = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(facts), new Date().toISOString());
  }

  setUpdated(): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET updated_at = ? WHERE id = 1')
      .run(new Date().toISOString());
  }
}
