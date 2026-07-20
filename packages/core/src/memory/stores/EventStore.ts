// src/memory/stores/EventStore.ts
import type Database from 'better-sqlite3';
import type { MemoryEvent } from '../types';

export class EventStore {
  constructor(private db: Database.Database) {}

  insert(event: MemoryEvent): void {
    this.db.prepare(`
      INSERT INTO events (id, session_id, source, type, payload, importance, created_at, processed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.session_id,
      event.source,
      event.type,
      JSON.stringify(event.payload),
      event.importance,
      event.created_at,
      event.processed
    );
  }

  getById(id: string): MemoryEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEvent(row);
  }

  getUnprocessed(limit: number): MemoryEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE processed = 0 ORDER BY created_at ASC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToEvent(r));
  }

  markProcessed(id: string, flag: number): void {
    this.db.prepare(
      'UPDATE events SET processed = processed | ? WHERE id = ?'
    ).run(flag, id);
  }

  getBySession(sessionId: string): MemoryEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(r => this.rowToEvent(r));
  }

  countBySession(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM events WHERE session_id = ?'
    ).get(sessionId) as { count: number };
    return row.count;
  }

  private rowToEvent(row: Record<string, unknown>): MemoryEvent {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      source: row.source as MemoryEvent['source'],
      type: row.type as MemoryEvent['type'],
      payload: JSON.parse(row.payload as string),
      importance: row.importance as number,
      created_at: row.created_at as string,
      processed: row.processed as number,
    };
  }
}
