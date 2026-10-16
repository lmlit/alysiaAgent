// src/memory/stores/EventStore.ts
import type Database from 'better-sqlite3';
import type { MemoryEvent, SearchResult } from '../types.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import { traceZeroRows } from '../../utils/write-trace.js';
import { logger } from '../../utils/logger.js';

/** ★ 2026-10-16 KI-12：payload 在库里是 JSON **字符串**，键序取决于写库时的对象插入序。
 *  ⚠️ 注意 `JSON.stringify(JSON.parse(raw))` **不排序**——它保留原串键序，因此
 *  「同一对象、键序不同」仍会被判成"内容不同"（假冲突）。这里**递归按键名排序**
 *  做规范化，数组保持原序（顺序对数组是有意义的）。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

/** payload 归一化字符串；脏数据（非 JSON）退回原串 —— 宁可判成"不同"（走冲突分支，不覆盖），
 *  也不吞掉这次比较 */
function normalizePayload(raw: string): string {
  try {
    return JSON.stringify(canonicalize(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

/** 冲突日志里给一段可判别的 payload 摘要（避免整条长消息刷屏） */
function preview(raw: string, max = 120): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

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
    const payload = JSON.stringify(event.payload);

    // ★ 2026-10-16 KI-12（change: fix-store-write-trace）：Event Log 按定义是**不可变**的。
    //
    // 旧实现 `INSERT OR REPLACE` 的列单**不含 `archived`**（而它是 `DEFAULT 0`），于是
    // 同 id 重投（QQ 重连 / dsh 重传）会**静默**：
    //   - 复活软删除的会话（archived 回落 0）
    //   - 把已摘要事件的 processed 归 0 → **再摘要 + 再画像提取**（重复学习副作用）
    //   - 清掉 LLM 打的 importance
    //   - 改写 created_at（可能把事件挪出摘要窗口）
    //
    // 现在先 SELECT 判存在与内容，再三分：**幂等空转 / 响亮冲突 / 真插入**。
    //
    // 并发：本项目是**单进程 + WAL**，better-sqlite3 是同步 API，SELECT 与 INSERT 之间
    // 不会被事件循环交叠，一次 SELECT 足够，无需事务。即便真有并发写者，主键也会让
    // 第二个 INSERT 抛 SQLITE_CONSTRAINT（**响亮失败**），不会回到静默覆盖。
    const existing = this.db
      .prepare('SELECT payload, session_id FROM events WHERE id = ?')
      .get(event.id) as { payload: string; session_id: string } | undefined;

    if (existing) {
      // ① 同 id 同内容 → 幂等空转：**任何列都不许改**（archived/processed/importance/created_at）
      if (normalizePayload(existing.payload) === normalizePayload(payload)) return;

      // ② 同 id 不同内容 → **不覆盖**，保留原有事件，响亮报冲突
      //    ★ 用 warn 不用 debug：debug 被 ALYSIA_DEBUG 门控，产线不输出
      logger.warn(
        `[EventStore] 事件 id 冲突：同 id 不同内容，保留原事件（id=${event.id}, session=${event.session_id}）` +
        ` — 原 payload=${preview(existing.payload)} / 新 payload=${preview(payload)}` +
        (existing.session_id === event.session_id ? '' : `；原 session=${existing.session_id}`),
      );
      return;
    }

    // ③ 新 id → 正常插入（列单与旧实现一致；archived 走表默认 0，这是对的）
    // ★ 8-28 perspective 列（memory-character-perspective）
    this.db.prepare(`
      INSERT INTO events (id, session_id, source, type, payload, importance, created_at, processed, perspective)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.session_id,
      event.source,
      event.type,
      payload,
      event.importance,
      event.created_at,
      event.processed,
      event.perspective ?? 'interaction'
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
    const r = this.db.prepare(
      'UPDATE events SET processed = processed | ? WHERE id = ?'
    ).run(flag, id);
    traceZeroRows('EventStore.markProcessed', r.changes);
  }

  /** ★ 9-25 wire-importance-signal：回填重要性（SessionEnd 的 LLM 顺带打分）。
   *  与 markProcessed 一样走 UPDATE，不重写整行（避免覆盖其他字段）。 */
  updateImportance(id: string, importance: number): void {
    const r = this.db.prepare('UPDATE events SET importance = ? WHERE id = ?')
      .run(Math.min(1, Math.max(0, importance)), id);
    traceZeroRows('EventStore.updateImportance', r.changes);
  }

  /**
   * 取该会话的事件：**最近的** N 条（可按时间窗过滤），按时间**升序**返回。
   *
   * ★ 9-26 fix-session-event-window-truncation：原实现是
   *   `ORDER BY created_at ASC LIMIT 1000` —— **取的是最旧的 1000 条**，
   *   而调用方要的是"最近的会话内容"。后果：主会话积累到 1436 条事件后，
   *   `since`（上条摘要时间）之后的事件**一条都取不到** → 归档管道空转 18 小时、
   *   0 条新摘要，而日志还报 `archived 1/1`（看起来正常）。
   *
   *   窗口过滤**下推到 SQL**：原实现是"取 1000 条再在内存里 filter"，
   *   于是能不能取到窗口内的数据**取决于窗口外有多老**——这正是故障成因。
   *
   *   先 DESC 取最近 N 条、再在外层 ASC 排回来，保证对话拼接顺序正确。
   *
   * ★ 2026-10-16 fix-summary-window-late-events：**`since` 改为开区间**（`>`），
   *   `until` 仍是闭区间（`<=`）——即窗口语义 **`(since, until]`**。
   *
   *   为什么必须改：摘要行的 `ended_at` 已改为**数据边界**
   *   （= 窗口内最新事件的 `created_at`，见 `SessionEndProcessor` 与
   *   `memory-system` §5.4.1 **契约 4**），而下一窗口的锚点就是它。
   *   若 `since` 仍是闭区间，**边界那条事件会被相邻两次摘要各摘一遍**
   *   （重复画像提取、重复计数）。
   *
   *   9-26 的注释当时就把这件事标成「另一个语义决策，会改变摘要窗口边界」并**刻意推迟**——
   *   `ended_at` 数据边界化正是触发它的条件。`(since, until]` 是**一致**的游标语义：
   *   `since` = 最后一条**已**处理的事件，下一窗口从它**之后**开始。
   */
  getBySession(
    sessionId: string,
    opts?: { limit?: number; since?: Date; until?: Date },
  ): MemoryEvent[] {
    const limit = opts?.limit ?? 1000;
    // ★ 9-26：`until` 用于**历史回填**——窗口是 (since, until]。
    //   两端都必须下推到 SQL：若只约束 since，长会话里 `until` 之后的近期事件会占满
    //   LIMIT，把老窗口挤出去（与 fix-session-event-window-truncation 同源的坑）。
    const conds = ['session_id = ?'];
    const params: unknown[] = [sessionId];
    if (opts?.since) { conds.push('created_at > ?'); params.push(opts.since.toISOString()); }
    if (opts?.until) { conds.push('created_at <= ?'); params.push(opts.until.toISOString()); }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM events WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?)
         ORDER BY created_at ASC`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToEvent(r));
  }

  /**
   * ★ 2026-10-16（change: `fix-summary-anchor-floor`，KI-26）：该会话**最早**一条事件的
   * `created_at`（一条都没有则 `null`）。
   *
   * 用途：给「**从未摘要过**」的会话定摘要窗口下界 ——
   * 那种会话应当**从头摘**，而不是从「现在 − 24h」开始（见 `MemoryManager.summaryAnchor`）。
   *
   * ⚠️ 取**全部**事件类型的最小值（不只 `message`）：这里只需要一个"最早"，
   * 放宽只会让窗口更靠前、更完整，不会漏掉谁都该摘的消息。
   */
  getEarliestCreatedAt(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT MIN(created_at) AS t FROM events WHERE session_id = ?')
      .get(sessionId) as { t: string | null } | undefined;
    return row?.t ?? null;
  }

  countBySession(sessionId: string): number {    const row = this.db.prepare(
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
    const r = this.db.prepare('UPDATE events SET archived = 1 WHERE session_id = ?').run(sessionId);
    traceZeroRows('EventStore.archiveBySession', r.changes);
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
    const r = this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    traceZeroRows('EventStore.deleteBySession', r.changes);
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
