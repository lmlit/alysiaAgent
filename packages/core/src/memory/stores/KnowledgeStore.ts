// src/memory/stores/KnowledgeStore.ts
import type Database from 'better-sqlite3';
import type { KnowledgeDoc, SearchResult } from '../types.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';

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
    return this.vectorStore.search(vector, topK, { source: 'knowledge' });
  }

  searchByText(query: string, limit: number): SearchResult[] {
    const rows = this.db.prepare(
      'SELECT id, title, source, status FROM knowledge_docs WHERE (title LIKE ? OR content_hash LIKE ?) AND status = \'active\' ORDER BY created_at DESC LIMIT ?'
    ).all(`%${query}%`, `%${query}%`, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      score: 0.5,
      text: r.title as string,
      metadata: { source: r.source, status: r.status },
    }));
  }

  /** ★ 全文检索：搜索 chunk 内容（替代只搜标题） */
  searchChunksByText(query: string, limit: number): SearchResult[] {
    const rows = this.db.prepare(`
      SELECT c.doc_id, c.content, c.chunk_index, d.title, d.source
      FROM knowledge_chunks c
      JOIN knowledge_docs d ON d.id = c.doc_id
      WHERE c.content LIKE ? AND d.status = 'active'
      ORDER BY c.chunk_index ASC
      LIMIT ?
    `).all(`%${query}%`, limit) as Array<{
      doc_id: string; content: string; chunk_index: number; title: string; source: string;
    }>;
    return rows.map(r => ({
      id: r.doc_id,
      score: 0.6, // LIKE 匹配给固定分（低于向量命中）
      text: `[${r.title}] ${r.content.trim()}`,
      metadata: { source: r.source, docId: r.doc_id, chunk_index: r.chunk_index },
    }));
  }

  // ── ★ 知识库导入支持 ──────────────────────────────

  insertChunk(chunk: { id: string; doc_id: string; chunk_index: number; content: string }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO knowledge_chunks (id, doc_id, chunk_index, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(chunk.id, chunk.doc_id, chunk.chunk_index, chunk.content, new Date().toISOString());
  }

  getChunksByDoc(docId: string): Array<{ chunk_index: number; content: string }> {
    const rows = this.db.prepare(
      'SELECT chunk_index, content FROM knowledge_chunks WHERE doc_id = ? ORDER BY chunk_index ASC'
    ).all(docId) as Array<{ chunk_index: number; content: string }>;
    return rows;
  }

  deleteDoc(id: string): void {
    this.db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(id);
    this.db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(id);
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
