// src/memory/stores/KnowledgeStore.ts
import type Database from 'better-sqlite3';
import type { KnowledgeDoc, SearchResult } from '../types';
import type { IVectorStore } from '../interfaces/IVectorStore';

export class KnowledgeStore {
  constructor(private db: Database.Database, private vectorStore: IVectorStore | null) {}

  async insert(doc: KnowledgeDoc): Promise<void> {
    this.db.prepare(`
      INSERT INTO knowledge_docs (id, title, source, file_path, content_hash, chunk_count, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(doc.id, doc.title, doc.source, doc.file_path, doc.content_hash, doc.chunk_count, doc.status, doc.created_at, doc.updated_at);
  }

  getById(id: string): KnowledgeDoc | null {
    const row = this.db.prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToDoc(row);
  }

  getByHash(hash: string): KnowledgeDoc | null {
    const row = this.db.prepare('SELECT * FROM knowledge_docs WHERE content_hash = ?').get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToDoc(row);
  }

  listActive(): KnowledgeDoc[] {
    const rows = this.db.prepare("SELECT * FROM knowledge_docs WHERE status = 'active' ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map(r => this.rowToDoc(r));
  }

  archive(id: string): void {
    this.db.prepare("UPDATE knowledge_docs SET status = 'archived', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  async searchByVector(vector: number[], topK: number): Promise<SearchResult[]> {
    if (!this.vectorStore) return [];
    return this.vectorStore.search(vector, topK);
  }

  private rowToDoc(row: Record<string, unknown>): KnowledgeDoc {
    return {
      id: row.id as string,
      title: row.title as string,
      source: row.source as string,
      file_path: row.file_path as string | null,
      content_hash: row.content_hash as string,
      chunk_count: row.chunk_count as number,
      status: row.status as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
