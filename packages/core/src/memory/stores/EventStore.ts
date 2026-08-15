// src/memory/stores/EventStore.ts
import type Database from 'better-sqlite3';
import type { MemoryEvent, SearchResult } from '../types.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';

export class EventStore {
  constructor(private db: Database.Database, private vectorStore: IVectorStore | null = null) {}

  /** ★ 8-09：事件向量检索（[相关记忆] 捞回超 24h 的对话细节，含回写后的 AI 发言）。
   *  source='chat'——聊天事件（RealtimeProcessor 写入时 source=event.source），
   *  code 模式事件不混入聊天检索 */
  async searchByVector(vector: number[], topK: number): Promise<SearchResult[]> {
    if (!this.vectorStore) return [];
    return this.vectorStore.search(vector, topK, { source: 'chat' });
  }

  /** ★ 8-09：活跃会话列表（since 之后有消息的 session，定期归档用） */
  getActiveSessions(since: Date): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT session_id FROM events WHERE type = 'message' AND created_at >= ? ORDER BY session_id"
    ).all(since.toISOString()) as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }

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
      WHERE archived = 0
      GROUP BY session_id
      ORDER BY last_active DESC
      LIMIT ?
    `).all(limit) as Array<{ session_id: string; count: number; last_active: string }>;
    return rows;
  }

  /** ★ 8-15 会话归档(软删除):标记 archived=1——列表消失,数据保留可恢复 */
  archiveBySession(sessionId: string): void {
    this.db.prepare('UPDATE events SET archived = 1 WHERE session_id = ?').run(sessionId);
  }

  /** ★ 8-15 WebUI 会话历史分页（webui-chat-endpoints）：created_at 游标向下翻页。
   *   before 为 ISO 游标（取比它更早的消息）；省略取最新 limit 条。返回时间倒序（最新在前）。 */
  getMessagesBySession(sessionId: string, limit: number = 50, before?: string): Array<{ role: string; content: string; senderName: string; createdAt?: string }> {
    const rows = before
      ? this.db.prepare(`
        SELECT payload, source, created_at FROM events
        WHERE session_id = ? AND type = 'message' AND created_at < ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(sessionId, before, limit) as Array<{ payload: string; source: string; created_at: string }>
      : this.db.prepare(`
        SELECT payload, source, created_at FROM events
        WHERE session_id = ? AND type = 'message'
        ORDER BY created_at DESC
        LIMIT ?
      `).all(sessionId, limit) as Array<{ payload: string; source: string; created_at: string }>;

    return rows.map(r => {
      const p = JSON.parse(r.payload);
      const role = p.role ?? (p.sender_id ? 'user' : 'assistant');
      return {
        role,
        content: p.content || '',
        senderName: p.sender_name || (role === 'user' ? '用户' : '昔涟'),
        createdAt: r.created_at,
      };
    });
  }

  /** ★ 8-15 WebUI 会话删除:清空该会话全部事件(消息/画像输入源) */
  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
  }

  /** 获取某个会话最近的消息（用于短期上下文） */
  /** 最近消息（短期记忆）。limit 上限；since 可选时间窗口（ISO 字符串比较，created_at 存 ISO）。
   *  返回附带 createdAt（ISO），供亲密度衰减等需要"最后消息时间"的调用方使用。 */
  getRecentBySession(sessionId: string, limit: number = 20, since?: Date): Array<{ role: string; content: string; createdAt?: string }> {
    const rows = since
      ? this.db.prepare(`
        SELECT payload, source, created_at FROM events
        WHERE session_id = ? AND type = 'message' AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(sessionId, since.toISOString(), limit) as Array<{ payload: string; source: string; created_at: string }>
      : this.db.prepare(`
        SELECT payload, source, created_at FROM events
        WHERE session_id = ? AND type = 'message'
        ORDER BY created_at DESC
        LIMIT ?
      `).all(sessionId, limit) as Array<{ payload: string; source: string; created_at: string }>;

    return rows.reverse().map(r => {
      const p = JSON.parse(r.payload);
      // ★ 8-09 修复：content 纯文本（不再拼 `${sender_name}: ` 前缀——openid/默认"用户"
      //   不再泄露进 prompt，Life assistant 回写不再显示成"用户: "）；角色标签由下游组装
      //   （memory-retrieval 用"你/昔涟"短标签）
      const role = p.role ?? (p.sender_id ? 'user' : 'assistant');
      return {
        role,
        content: p.content || '',
        senderName: p.sender_name || (role === 'user' ? '用户' : '昔涟'),
        createdAt: r.created_at,
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
