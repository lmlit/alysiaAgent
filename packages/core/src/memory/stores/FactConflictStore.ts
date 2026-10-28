/**
 * ★ 2026-10-28（change: `resolve-fact-conflicts`）
 *
 * **事实冲突候选队列**。与 `user_profile.facts` 分开存：
 * 旧事实保持 active，新说法只是候选，等用户裁决后再落 facts。
 *
 * 为什么不在 facts JSON 里塞状态：
 *   - 候选需要 `occurrences / asked_at / ask_count` 这类**队列字段**；
 *   - facts 是“当前认知”，候选不是认知，混在一起会让 facts 块/画像重写误读。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';

export type FactConflictStatus = 'pending' | 'kept_old' | 'kept_new' | 'expired';

export interface FactConflictRow {
  id: string;
  session_id: string;
  old_fact_key: string;
  old_fact: string;
  old_source: string;
  old_confidence: number | null;
  new_fact_key: string;
  new_fact: string;
  new_source: string;
  new_confidence: number | null;
  new_category: string;
  evidence: string;
  source_event: string;
  channel: string;
  status: FactConflictStatus;
  occurrences: number;
  created_at: string;
  last_seen_at: string;
  asked_at: string | null;
  ask_count: number;
  resolved_at: string | null;
  resolution: string | null;
}

export interface CreateConflictInput {
  old_fact_key: string;
  old_fact: string;
  old_source: string;
  old_confidence?: number;
  new_fact_key: string;
  new_fact: string;
  new_source: string;
  new_confidence?: number;
  new_category: string;
  evidence?: string;
  source_event?: string;
  channel?: string;
}

export interface ListPendingOptions {
  limit?: number;
  now?: number;
  askCooldownMs?: number;
  maxAsks?: number;
}

const DAY = 86_400_000;
/** 候选最多保留多久（没人回答就让它过期，不再盘问） */
export const FACT_CONFLICT_TTL_MS = 14 * DAY;
/** 两次提问之间的冷却 */
export const FACT_CONFLICT_ASK_COOLDOWN_MS = 24 * 3600_000;
/** 最多问几次（问满后不再催） */
export const FACT_CONFLICT_MAX_ASKS = 2;
/** 同时挂起的候选上限（防止一次提取灌爆队列） */
export const FACT_CONFLICT_MAX_PENDING = 20;
/** 问满后多久自动过期 */
export const FACT_CONFLICT_NAG_GRACE_MS = 3 * DAY;

const nowIso = (ms: number) => new Date(ms).toISOString();

export class FactConflictStore {
  constructor(private db: Database.Database) {}

  /**
   * 写入一条候选；同一对 (old_key,new_key) 已 pending 时只累加 occurrences。
   * 返回 id 与是否新建。
   */
  create(input: CreateConflictInput, now: number = Date.now()): { id: string; created: boolean } {
    const existing = this.db.prepare(
      `SELECT id FROM fact_conflicts WHERE status='pending' AND old_fact_key=? AND new_fact_key=?`,
    ).get(input.old_fact_key, input.new_fact_key) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE fact_conflicts
        SET occurrences = occurrences + 1,
            last_seen_at = ?,
            new_confidence = MAX(COALESCE(new_confidence, 0), ?),
            evidence = CASE WHEN length(?) > length(evidence) THEN ? ELSE evidence END
        WHERE id = ?
      `).run(
        nowIso(now), input.new_confidence ?? 0,
        input.evidence ?? '', input.evidence ?? '',
        existing.id,
      );
      return { id: existing.id, created: false };
    }

    this.enforceCap(now);

    const id = `fc-${randomUUID()}`;
    // session_id 从来源事件反查（ProfileStore 不持有 session 维度）
    const ev = input.source_event
      ? this.db.prepare('SELECT session_id FROM events WHERE id=?').get(input.source_event) as { session_id: string } | undefined
      : undefined;

    this.db.prepare(`
      INSERT INTO fact_conflicts (
        id, session_id,
        old_fact_key, old_fact, old_source, old_confidence,
        new_fact_key, new_fact, new_source, new_confidence, new_category,
        evidence, source_event, channel,
        status, occurrences, created_at, last_seen_at, asked_at, ask_count,
        resolved_at, resolution
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,0,NULL,NULL)
    `).run(
      id, ev?.session_id ?? '',
      input.old_fact_key, input.old_fact, input.old_source, input.old_confidence ?? null,
      input.new_fact_key, input.new_fact, input.new_source, input.new_confidence ?? null,
      input.new_category, input.evidence ?? '', input.source_event ?? '', input.channel ?? '',
      'pending', 1, nowIso(now), nowIso(now),
    );

    logger.info(
      `[Conflict] queued ${id.slice(0, 12)} old="${input.old_fact.slice(0, 30)}" ` +
      `new="${input.new_fact.slice(0, 30)}" (${input.new_source})`,
    );
    return { id, created: true };
  }

  /** 超过上限时把最旧的 pending 标过期（可见，不静默丢） */
  private enforceCap(now: number): void {
    const { c } = this.db.prepare(`SELECT COUNT(*) c FROM fact_conflicts WHERE status='pending'`).get() as { c: number };
    if (c < FACT_CONFLICT_MAX_PENDING) return;
    const overflow = c - FACT_CONFLICT_MAX_PENDING + 1;
    const rows = this.db.prepare(
      `SELECT id FROM fact_conflicts WHERE status='pending' ORDER BY created_at ASC LIMIT ?`,
    ).all(overflow) as Array<{ id: string }>;
    for (const r of rows) {
      this.db.prepare(
        `UPDATE fact_conflicts SET status='expired', resolved_at=?, resolution='overflow' WHERE id=? AND status='pending'`,
      ).run(nowIso(now), r.id);
    }
    if (rows.length > 0) {
      logger.warn(`[Conflict] pending 超过 ${FACT_CONFLICT_MAX_PENDING}，过期最旧 ${rows.length} 条（overflow）`);
    }
  }

  /** 过期清理：14 天未裁决，或问满 2 次后再等 3 天。 */
  expire(now: number = Date.now()): number {
    const r = this.db.prepare(`
      UPDATE fact_conflicts
      SET status='expired', resolved_at=?, resolution='ttl'
      WHERE status='pending' AND (
        created_at < ? OR
        (ask_count >= ? AND asked_at IS NOT NULL AND asked_at < ?)
      )
    `).run(
      nowIso(now),
      nowIso(now - FACT_CONFLICT_TTL_MS),
      FACT_CONFLICT_MAX_ASKS,
      nowIso(now - FACT_CONFLICT_NAG_GRACE_MS),
    );
    return r.changes;
  }

  /**
   * 可供 prompt 使用的候选：只取 pending、未问满、且过了冷却的；
   * 优先 occurrences 高的（同一冲突反复出现 = 更值得问）。
   */
  listPending(opts: ListPendingOptions = {}): FactConflictRow[] {
    const now = opts.now ?? Date.now();
    this.expire(now);
    const limit = Math.max(1, Math.min(50, opts.limit ?? 1));
    const maxAsks = opts.maxAsks ?? FACT_CONFLICT_MAX_ASKS;
    const cooldown = opts.askCooldownMs ?? FACT_CONFLICT_ASK_COOLDOWN_MS;
    return this.db.prepare(`
      SELECT * FROM fact_conflicts
      WHERE status='pending'
        AND ask_count < ?
        AND (asked_at IS NULL OR asked_at <= ?)
      ORDER BY occurrences DESC, created_at ASC
      LIMIT ?
    `).all(maxAsks, nowIso(now - cooldown), limit) as FactConflictRow[];
  }

  get(id: string): FactConflictRow | null {
    return (this.db.prepare('SELECT * FROM fact_conflicts WHERE id=?').get(id) as FactConflictRow | undefined) ?? null;
  }

  /** 真正注入 prompt 后调用：累加提问次数与时间。 */
  markAsked(ids: string[], now: number = Date.now()): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE fact_conflicts SET ask_count = ask_count + 1, asked_at = ? WHERE id = ? AND status='pending'`,
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(nowIso(now), id);
    });
    tx();
  }

  /**
   * 旧事实被**用户明确陈述**取代时，清理挂在它上面的候选：
   * - 候选新说法 == 用户新说法 → 视为已被用户确认（kept_new）；
   * - 其它候选（用户说了第三个值）→ 问题已失效（expired/old_superseded），不再问。
   * 不删除历史，只改状态。
   */
  closeForSupersededOld(oldKey: string, newKey: string | null, now: number = Date.now()): number {
    const rows = this.db.prepare(
      `SELECT id, new_fact_key FROM fact_conflicts WHERE status='pending' AND old_fact_key=?`,
    ).all(oldKey) as Array<{ id: string; new_fact_key: string }>;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        if (newKey && row.new_fact_key === newKey) {
          this.resolve(row.id, 'new', now);
        } else {
          this.db.prepare(
            `UPDATE fact_conflicts SET status='expired', resolution='old_superseded', resolved_at=?
             WHERE id=? AND status='pending'`,
          ).run(nowIso(now), row.id);
        }
      }
    });
    tx();
    if (rows.length > 0) {
      logger.info(`[Conflict] 旧事实被用户取代，清理 ${rows.length} 条候选 (old=${oldKey.slice(0, 30)})`);
    }
    return rows.length;
  }

  /** 只改冲突行；facts 的裁决由 ProfileStore 在同一事务里做。 */
  resolve(id: string, keep: 'old' | 'new', now: number = Date.now()): boolean {
    const status: FactConflictStatus = keep === 'new' ? 'kept_new' : 'kept_old';
    const r = this.db.prepare(
      `UPDATE fact_conflicts
       SET status=?, resolution=?, resolved_at=?
       WHERE id=? AND status='pending'`,
    ).run(status, keep === 'new' ? 'kept_new' : 'kept_old', nowIso(now), id);
    return r.changes > 0;
  }

  stats(): Record<FactConflictStatus, number> {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) c FROM fact_conflicts GROUP BY status',
    ).all() as Array<{ status: FactConflictStatus; c: number }>;
    const out: Record<FactConflictStatus, number> = { pending: 0, kept_old: 0, kept_new: 0, expired: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }
}
