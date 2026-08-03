// src/memory/stores/LanceDBStore.ts
// Concrete IVectorStore backed by LanceDB (embedded vector database).
// On initialization failure, the caller should discard this instance —
// MemoryManager will fall back to SQLite text search automatically.

import type { IVectorStore } from '../interfaces/IVectorStore.js';
import type { SearchResult } from '../types.js';
import { logger } from '../../utils/logger.js';

/** Escape a string value for use in LanceDB SQL predicate (double-quote escaping). */
function esc(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

/** Safe JSON parse with default. */
function safeJsonParse(s: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * LanceDB-backed vector store.
 *
 * Table schema (auto-inferred from initial row):
 *   id           — string (primary identifier)
 *   vector       — fixed_size_list<float>[dimension]
 *   text         — string (original text)
 *   source       — string ('event' | 'conversation' | 'knowledge')
 *   metadata_json — string (JSON-serialized metadata)
 */
export class LanceDBStore implements IVectorStore {
  private db: any = null;
  private table: any = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private dbPath: string,
    private tableName: string = 'vectors',
    private dimension: number = 1024,
  ) {}

  /** One-shot async init. Idempotent — subsequent calls return the same promise. */
  async initialize(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    const lancedb = await import('@lancedb/lancedb');
    this.db = await lancedb.connect(this.dbPath);

    // Open existing table or create a new one with auto-inferred schema
    try {
      this.table = await this.db.openTable(this.tableName);
      logger.info(`[LanceDB] opened table "${this.tableName}" at ${this.dbPath}`);
    } catch {
      // Table doesn't exist — create with a placeholder row to infer schema
      const emptyVector = new Array(this.dimension).fill(0);
      this.table = await this.db.createTable(this.tableName, [{
        id: '__init__',
        vector: emptyVector,
        text: '',
        source: 'event',
        metadata_json: '{}',
      }]);
      // Remove placeholder row
      await this.table.delete('id = "__init__"');
      logger.info(`[LanceDB] created table "${this.tableName}" (dim=${this.dimension}) at ${this.dbPath}`);
    }

    this.ready = true;
  }

  /** Ensure the store is ready, returning false if LanceDB is unavailable. */
  private async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    try {
      await this.initialize();
      return this.ready;
    } catch (err: any) {
      logger.warn(`[LanceDB] not available: ${err.message}`);
      return false;
    }
  }

  // ── IVectorStore ────────────────────────────────────────

  async insert(id: string, vector: number[], text: string, metadata: Record<string, unknown>): Promise<void> {
    if (!(await this.ensureReady())) return;
    try {
      // Upsert: delete any existing row with same id, then add
      const safeId = id.replace(/"/g, '""');
      try { await this.table.delete(`id = "${safeId}"`); } catch { /* ok if not found */ }
      await this.table.add([{
        id,
        vector,
        text,
        source: (metadata.source as string) || 'event',
        metadata_json: JSON.stringify(metadata),
      }]);
    } catch (err: any) {
      logger.warn(`[LanceDB] insert failed (id=${id.slice(0, 30)}): ${err.message}`);
    }
  }

  async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<SearchResult[]> {
    if (!(await this.ensureReady())) return [];
    try {
      let query = this.table.vectorSearch(vector).limit(topK);

      // Apply optional source filter (e.g. { source: 'knowledge' })
      if (filter?.source && typeof filter.source === 'string') {
        query = query.where(`source = ${esc(filter.source)}`);
      }

      const rows = await query.toArray() as Array<Record<string, unknown>>;
      return rows
        .filter(r => r.id !== '__init__')
        .map(r => ({
          id: r.id as string,
          // _distance: L2 distance (lower = more similar). Map to 0-1 score.
          score: r._distance != null ? Math.max(0, 1 - (r._distance as number)) : 0.5,
          text: r.text as string,
          metadata: safeJsonParse(r.metadata_json as string | undefined, {}),
        }));
    } catch (err: any) {
      logger.warn(`[LanceDB] search failed: ${err.message}`);
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    if (!(await this.ensureReady())) return;
    try {
      const safeId = id.replace(/"/g, '""');
      await this.table.delete(`id = "${safeId}"`);
    } catch (err: any) {
      logger.warn(`[LanceDB] delete failed (id=${id.slice(0, 30)}): ${err.message}`);
    }
  }

  async count(): Promise<number> {
    if (!(await this.ensureReady())) return 0;
    try {
      return await this.table.countRows() as number;
    } catch {
      return 0;
    }
  }
}
