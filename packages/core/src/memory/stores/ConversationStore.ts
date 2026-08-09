// src/memory/stores/ConversationStore.ts
import type Database from 'better-sqlite3';
import type { Conversation, SearchResult } from '../types.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';

export class ConversationStore {
  constructor(private db: Database.Database, private vectorStore: IVectorStore | null) {}

  async insert(conv: Conversation, vector?: number[]): Promise<void> {
    this.db.prepare(`
      INSERT INTO conversations (id, session_id, summary, participants, topics, key_decisions, message_count, started_at, ended_at, embedding_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conv.id, conv.session_id, conv.summary, conv.participants, conv.topics, conv.key_decisions, conv.message_count, conv.started_at, conv.ended_at, conv.embedding_id);

    if (vector && this.vectorStore) {
      await this.vectorStore.insert(conv.id, vector, conv.summary, {
        source: 'conversation',
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

  /** ★ 8-09：session 最新摘要（定期归档的 since 锚点） */
  getLatestBySession(sessionId: string): Conversation | null {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1'
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.rowToConv(row) : null;
  }

  /** ★ 8-09 会话隔离：sessionId 可选——private 会话只取 private 摘要，group 只取同群。
   *  不传则保持旧行为（全库最近）。 */
  getRecent(limit: number, sessionId?: string): Conversation[] {
    let rows: Record<string, unknown>[];
    if (!sessionId) {
      rows = this.db.prepare('SELECT * FROM conversations ORDER BY started_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    } else if (sessionId.includes(':group:')) {
      rows = this.db.prepare('SELECT * FROM conversations WHERE session_id LIKE ? ORDER BY started_at DESC LIMIT ?')
        .all(`${sessionId.split(':group:')[0]}:group:%`, limit) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare("SELECT * FROM conversations WHERE session_id LIKE '%:private:%' ORDER BY started_at DESC LIMIT ?")
        .all(limit) as Record<string, unknown>[];
    }
    return rows.map(r => this.rowToConv(r));
  }

  async searchByVector(vector: number[], topK: number): Promise<SearchResult[]> {
    if (!this.vectorStore) return [];
    return this.vectorStore.search(vector, topK, { source: 'conversation' });
  }

  searchByText(query: string, limit: number): SearchResult[] {
    const rows = this.db.prepare(
      'SELECT id, summary, topics, session_id FROM conversations WHERE summary LIKE ? ORDER BY started_at DESC LIMIT ?'
    ).all(`%${query}%`, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      score: 0.5,
      text: r.summary as string,
      metadata: { topics: r.topics, session_id: r.session_id },
    }));
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
