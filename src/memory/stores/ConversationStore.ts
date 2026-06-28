// src/memory/stores/ConversationStore.ts
import type Database from 'better-sqlite3';
import type { Conversation, SearchResult } from '../types';
import type { IVectorStore } from '../interfaces/IVectorStore';

export class ConversationStore {
  constructor(private db: Database.Database, private vectorStore: IVectorStore | null) {}

  async insert(conv: Conversation, vector?: number[]): Promise<void> {
    this.db.prepare(`
      INSERT INTO conversations (id, session_id, summary, participants, topics, key_decisions, message_count, started_at, ended_at, embedding_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conv.id, conv.session_id, conv.summary, conv.participants, conv.topics, conv.key_decisions, conv.message_count, conv.started_at, conv.ended_at, conv.embedding_id);

    if (vector && this.vectorStore) {
      await this.vectorStore.insert(conv.id, vector, conv.summary, {
        topics: conv.topics,
        session_id: conv.session_id,
      });
    }
  }

  getById(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToConv(row);
  }

  getBySession(sessionId: string): Conversation[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY started_at DESC'
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(r => this.rowToConv(r));
  }

  getRecent(limit: number): Conversation[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversations ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToConv(r));
  }

  async searchByVector(vector: number[], topK: number): Promise<SearchResult[]> {
    if (!this.vectorStore) return [];
    return this.vectorStore.search(vector, topK);
  }

  private rowToConv(row: Record<string, unknown>): Conversation {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      summary: row.summary as string,
      participants: row.participants as string,
      topics: row.topics as string,
      key_decisions: row.key_decisions as string,
      message_count: row.message_count as number,
      started_at: row.started_at as string,
      ended_at: row.ended_at as string | null,
      embedding_id: row.embedding_id as string | null,
    };
  }
}
