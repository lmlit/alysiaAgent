// src/memory/stores/ConversationStore.ts
import type Database from 'better-sqlite3';
import type { Conversation, SearchResult } from '../types.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';

export class ConversationStore {
  constructor(private db: Database.Database, private vectorStore: IVectorStore | null) {}

  async insert(conv: Conversation, vector?: number[]): Promise<void> {
    // ★ 8-28 character_perspective 列（memory-character-perspective）
    // ★ 9-25 summary_status 列（fix-session-summary-silent-failure）：'ok' | 'failed'
    this.db.prepare(`
      INSERT INTO conversations (id, session_id, summary, participants, topics, key_decisions, message_count, started_at, ended_at, embedding_id, character_perspective, summary_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conv.id, conv.session_id, conv.summary, conv.participants, conv.topics, conv.key_decisions, conv.message_count, conv.started_at, conv.ended_at, conv.embedding_id, conv.character_perspective ?? '', conv.summary_status ?? 'ok');

    if (vector && this.vectorStore) {
      await this.vectorStore.insert(conv.id, vector, conv.summary, {
        source: 'conversation',
        topics: conv.topics,
        session_id: conv.session_id,
        // ★ 8-12 旋钮接线：会话结束时间供 recency 衰减（存量向量无此字段 → 不衰减）
        updated_at: conv.ended_at,
      });
    }
  }

  /**
   * ★ 9-25 fix-session-summary-silent-failure：捞出摘要生成失败的行，供 cron 补处理。
   * `summary_status` 缺省视为 'ok'（列是后加的，老行由 DEFAULT 填 'ok'）。
   */
  getFailed(limit = 20): Conversation[] {
    const rows = this.db.prepare(
      `SELECT * FROM conversations WHERE summary_status = 'failed' ORDER BY ended_at ASC LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToConv(r));
  }

  /**
   * ★ 9-25：补处理成功后**就地更新**失败行（避免为同一窗口再插一条）。
   * 只有摘要相关字段变化；message_count / 时间 / 事件关联保持不动。
   */
  async updateSummaryResult(
    id: string,
    data: {
      summary: string;
      participants: string;
      topics: string;
      key_decisions: string;
      character_perspective: string;
    },
    vector?: number[],
  ): Promise<void> {
    this.db.prepare(`
      UPDATE conversations
         SET summary = ?, participants = ?, topics = ?, key_decisions = ?,
             character_perspective = ?, summary_status = 'ok'
       WHERE id = ?
    `).run(data.summary, data.participants, data.topics, data.key_decisions, data.character_perspective, id);

    if (vector && this.vectorStore) {
      const row = this.db.prepare('SELECT session_id, ended_at FROM conversations WHERE id = ?').get(id) as
        | { session_id: string; ended_at: string | null }
        | undefined;
      if (row) {
        await this.vectorStore.insert(id, vector, data.summary, {
          source: 'conversation',
          topics: data.topics,
          session_id: row.session_id,
          updated_at: row.ended_at,
        });
      }
    }
  }

  /** ★ 9-25：补处理时要还原失败行的窗口起点 → 取该会话中更早的最近一条摘要的 ended_at */
  getPreviousEndedAt(sessionId: string, before: string): string | null {
    const row = this.db.prepare(
      `SELECT ended_at FROM conversations
        WHERE session_id = ? AND ended_at IS NOT NULL AND ended_at < ?
        ORDER BY ended_at DESC LIMIT 1`
    ).get(sessionId, before) as { ended_at: string } | undefined;
    return row?.ended_at ?? null;
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

  /** ★ 8-15 WebUI 会话删除:清空该会话摘要 */
  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM conversations WHERE session_id = ?').run(sessionId);
  }

  /** ★ 8-09：session 最新摘要（定期归档的 since 锚点） */
  getLatestBySession(sessionId: string): Conversation | null {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1'
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.rowToConv(row) : null;
  }

  /** ★ 8-09 会话隔离：sessionId 可选——private 会话只取 private 摘要，group 只取同群。
   *  不传则保持旧行为（全库最近）。
   *  ★ 8-29 修复（cr-p0-session-isolation）：完整 sessionId 精确匹配。
   *  旧实现 group 分支 `LIKE '平台:group:%'` 会捞同平台所有群的摘要、private 分支
   *  `LIKE '%:private:%'` 跨平台混入——群 A 的聊天内容会注入群 B 的 prompt。 */
  getRecent(limit: number, sessionId?: string): Conversation[] {
    // ★ 9-25 fix-session-summary-silent-failure：失败的摘要（summary 为空）**不进 prompt**——
    //   注入空字符串轻则浪费 token，重则让模型以为"这段对话没内容"。
    //   NULL 兼容：该列是后加的，理论上老行为 'ok'，但显式判 NULL 更稳。
    const notFailed = `(summary_status IS NULL OR summary_status != 'failed')`;
    let rows: Record<string, unknown>[];
    if (!sessionId) {
      rows = this.db.prepare(`SELECT * FROM conversations WHERE ${notFailed} ORDER BY started_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare(`SELECT * FROM conversations WHERE session_id = ? AND ${notFailed} ORDER BY started_at DESC LIMIT ?`)
        .all(sessionId, limit) as Record<string, unknown>[];
    }
    return rows.map(r => this.rowToConv(r));
  }

  async searchByVector(vector: number[], topK: number): Promise<SearchResult[]> {
    if (!this.vectorStore) return [];
    return this.vectorStore.search(vector, topK, { source: 'conversation' });
  }

  searchByText(query: string, limit: number): SearchResult[] {
    // ★ 9-25：排除失败行（summary 为空，匹配无意义且会带回空结果）
    const rows = this.db.prepare(
      `SELECT id, summary, topics, session_id FROM conversations
        WHERE summary LIKE ? AND (summary_status IS NULL OR summary_status != 'failed')
        ORDER BY started_at DESC LIMIT ?`
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
      summary_status: (row.summary_status as 'ok' | 'failed') ?? 'ok',
    };
  }
}
