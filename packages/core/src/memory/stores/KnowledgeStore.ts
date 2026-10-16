// src/memory/stores/KnowledgeStore.ts
import type Database from 'better-sqlite3';
import type { KnowledgeDoc, SearchResult } from '../types.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import { traceZeroRows } from '../../utils/write-trace.js';

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
    const r = this.db.prepare("UPDATE knowledge_docs SET status = 'archived', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    traceZeroRows('KnowledgeStore.archive', r.changes);
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

  /**
   * ★ 2026-10-16（change: `fix-store-write-trace`，KI-13）：
   * 文档元数据与**全部 chunk 在同一个事务里**写入，`chunk_count` 用**实到块数**。
   *
   * 旧实现是「先 `insert(doc)` 声明 `chunk_count = chunks.length`、`status='active'`，
   * 再在**事务外**循环 `insertChunk`」。中途失败会留下一颗
   * 「**完全正常的活跃文档**」外壳：status 正常、`chunk_count` 是高位的承诺值、
   * 实际只有前几个 chunk —— **零日志、永不自愈**；
   * 而重试会被 `getByHash` 命中这颗残行 → 返回**从未兑现的块数**并宣布「已导入 N 块」。
   *
   * 事务保证「要么全都有、要么什么都没有」，于是残行**不可能存在**（原子性即契约）。
   * 向量写入**不在**事务内（它是另一条链路、且失败不阻塞文本检索，见 KI-15）。
   *
   * @returns 实到的 chunk 数（= 事务里真正 INSERT 成功的条数）
   */
  insertDocWithChunks(doc: KnowledgeDoc, chunks: string[]): number {
    const now = new Date().toISOString();
    const tx = this.db.transaction((): number => {
      this.db.prepare(`
        INSERT INTO knowledge_docs (id, title, source, file_path, content_hash, chunk_count, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(doc.id, doc.title, doc.source, doc.file_path, doc.content_hash, 0, doc.status, doc.created_at, doc.updated_at);

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO knowledge_chunks (id, doc_id, chunk_index, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      let inserted = 0;
      for (let i = 0; i < chunks.length; i++) {
        stmt.run(`chunk_${doc.id}_${i}`, doc.id, i, chunks[i], now);
        inserted++;
      }
      // ★ 用**实到块数**回填 —— 不许留下"先声明、后未必兑现"的块数
      this.db.prepare('UPDATE knowledge_docs SET chunk_count = ? WHERE id = ?').run(inserted, doc.id);
      return inserted;
    });
    return tx();
  }

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
    const rChunks = this.db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(id);
    traceZeroRows('KnowledgeStore.deleteDoc.chunks', rChunks.changes);
    const rDocs = this.db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(id);
    traceZeroRows('KnowledgeStore.deleteDoc.docs', rDocs.changes);
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
