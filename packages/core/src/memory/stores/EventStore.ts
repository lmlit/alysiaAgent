// src/memory/stores/EventStore.ts
import type Database from 'better-sqlite3';
import type { MemoryEvent } from '../types.js';

export class EventStore {
  constructor(private db: Database.Database) {}

  insert(event: MemoryEvent): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO events (id, session_id, source, type, payload, importance, created_at, processed)
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

  getBySession(sessionId: string, limit?: number): MemoryEvent[] {
    const query = limit
      ? 'SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC LIMIT 1000';
    const params: unknown[] = limit ? [sessionId, limit] : [sessionId];
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToEvent(r));
  }

  countBySession(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM events WHERE session_id = ?'
    ).get(sessionId) as { count: number };
    return row.count;
  }

  /** 会话列表：按最近活跃排序，返回会话 ID + 消息数 + 最后活跃时间 */
  listSessions(limit: number = 20): Array<{ session_id: string; count: number; last_active: string }> {
    const rows = this.db.prepare(`
      SELECT session_id, COUNT(*) as count, MAX(created_at) as last_active
      FROM events
      GROUP BY session_id
      ORDER BY last_active DESC
      LIMIT ?
    `).all(limit) as Array<{ session_id: string; count: number; last_active: string }>;
    return rows;
  }

  /** 获取某个会话最近的消息（用于短期上下文） */
  getRecentBySession(sessionId: string, limit: number = 20): Array<{ role: string; content: string }> {
    const rows = this.db.prepare(`
      SELECT payload, source FROM events
      WHERE session_id = ? AND type = 'message'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit) as Array<{ payload: string; source: string }>;

    return rows.reverse().map(r => {
      const p = JSON.parse(r.payload);
      const senderName = p.sender_name || '用户';
      const content = p.content || '';
      return {
        role: p.sender_id ? 'user' : 'assistant',
        content: `${senderName}: ${content}`,
      };
    });
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
