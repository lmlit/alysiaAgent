// src/memory/stores/ProjectTaskEventStore.ts
/**
 * 委托结果**事件 outbox** —— 把「结果已落库」和「已经告诉她」之间的那段路，从内存搬到表里。
 *
 * ★ 2026-10-19（change: `wake-her-on-task-result`）。
 *
 * 起因（真机 + 代码核查）：旧实现是 `/result` 里 `void notifyProjectTaskResult(task)` ——
 *   进程在「任务行已写终态」与「通知发出」之间崩溃，**结果永久丢失**，而且库里没有任何痕迹
 *   能说明"这条结果还没被送达"。同时那条通知只是一次性 `llmService.complete`，
 *   她**没有机会**验收、返工或决定怎么跟用户说 —— 闭环只走了一半。
 *
 * 本表只守三件事（和 `ProjectTaskStore` 的分工一样明确）：
 *   1. **幂等入队**：同一轮同一类型只有一条（`event_id` 主键；重复入队 = 空转）。
 *   2. **原子领取**：`claimNext` 必须在一个事务里「找 → 标 claimed → 返回」，
 *      不许先查后改（两个调度器会同时跑同一轮，给用户发两条）。
 *   3. **可恢复**：领取后进程崩了，`claimed_at` 超时后可被重新领取；
 *      失败按退避重试，次数用尽转 `dead`（**响亮地停**，不静默饿死）。
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { traceZeroRows } from '../../utils/write-trace.js';

/** 事件状态机：pending → claimed → done / failed(退避) / dead(用尽) */
export type ProjectTaskEventStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'dead';

export interface ProjectTaskEvent {
  eventId: string;
  taskId: string;
  projectId: string;
  revision: number;
  /** 事件类型。目前只有 `result`（终态结果）；保留给将来的「需要用户确认」等 */
  kind: string;
  status: ProjectTaskEventStatus;
  /** 结果快照（JSON）—— 调度器据此拼"工具返回"，不用再回查任务表 */
  payload: Record<string, unknown>;
  attempts: number;
  /** 下次可领取时间（ISO）。空串 = 立刻可领 */
  nextAt: string;
  claimedAt: string | null;
  processedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueEventInput {
  /** 幂等键，建议 `<taskId>:r<revision>:<kind>` */
  eventId: string;
  taskId: string;
  projectId: string;
  revision: number;
  kind?: string;
  payload: Record<string, unknown>;
}

export interface ProjectTaskEventStoreOptions {
  /** 领取超时（毫秒）：超过它仍 `claimed` 的事件可被重新领取（进程崩了的恢复入口） */
  claimTimeoutMs?: number;
  /** 最多尝试次数：用尽转 `dead` */
  maxAttempts?: number;
  /** 退避基数（毫秒）：第 n 次失败后等 `base * 2^(n-1)`，上限 `maxBackoffMs` */
  backoffBaseMs?: number;
  maxBackoffMs?: number;
}

export const DEFAULT_EVENT_CLAIM_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_EVENT_MAX_ATTEMPTS = 5;
export const DEFAULT_EVENT_BACKOFF_BASE_MS = 60_000;
export const DEFAULT_EVENT_MAX_BACKOFF_MS = 30 * 60_000;

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    logger.warn(`[ProjectTaskEvent] payload 不是合法 JSON，按空处理：${String(raw).slice(0, 120)}`);
    return {};
  }
}

function rowToEvent(r: Record<string, unknown>): ProjectTaskEvent {
  return {
    eventId: String(r.event_id),
    taskId: String(r.task_id),
    projectId: String(r.project_id),
    revision: Number(r.revision ?? 0),
    kind: String(r.kind ?? 'result'),
    status: String(r.status ?? 'pending') as ProjectTaskEventStatus,
    payload: parsePayload(r.payload),
    attempts: Number(r.attempts ?? 0),
    nextAt: String(r.next_at ?? ''),
    claimedAt: typeof r.claimed_at === 'string' && r.claimed_at !== '' ? r.claimed_at : null,
    processedAt: typeof r.processed_at === 'string' && r.processed_at !== '' ? r.processed_at : null,
    lastError: typeof r.last_error === 'string' && r.last_error !== '' ? r.last_error : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * **在给定事务/连接里**插一行事件。抽成函数是为了让 `ProjectTaskStore.submitResult`
 * 能把「写终态」和「入队」放进**同一个事务**（跨 store 调用不能靠各自的事务）。
 *
 * @returns `true` = 新插入；`false` = 同 event_id 已存在（幂等空转）
 */
export function insertEventRow(
  db: Database.Database,
  input: EnqueueEventInput,
  now: Date = new Date(),
): boolean {
  const ts = now.toISOString();
  const info = db.prepare(
    `INSERT OR IGNORE INTO project_task_events
       (event_id, task_id, project_id, revision, kind, status, payload, attempts, next_at,
        claimed_at, processed_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, '', NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.eventId,
    input.taskId,
    input.projectId,
    input.revision,
    input.kind ?? 'result',
    JSON.stringify(input.payload ?? {}),
    ts,
    ts,
  );
  return info.changes > 0;
}

export class ProjectTaskEventStore {
  private readonly claimTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;

  constructor(private db: Database.Database, opts: ProjectTaskEventStoreOptions = {}) {
    this.claimTimeoutMs = opts.claimTimeoutMs ?? DEFAULT_EVENT_CLAIM_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_EVENT_MAX_ATTEMPTS;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_EVENT_BACKOFF_BASE_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_EVENT_MAX_BACKOFF_MS;
  }

  get(eventId: string): ProjectTaskEvent | null {
    const r = this.db.prepare('SELECT * FROM project_task_events WHERE event_id = ?').get(eventId);
    return r ? rowToEvent(r as Record<string, unknown>) : null;
  }

  /** 入队（幂等）。已存在同一 `event_id` ⇒ 返回 `created:false`，不覆盖既有状态 */
  enqueue(input: EnqueueEventInput, now = new Date()): { created: boolean; event: ProjectTaskEvent | null } {
    const created = this.db.transaction(() => insertEventRow(this.db, input, now))();
    if (created) {
      logger.info(`[ProjectTaskEvent] 入队 ${input.eventId}（${input.projectId} r${input.revision}）`);
    } else {
      logger.info(`[ProjectTaskEvent] ${input.eventId} 已在队列里 —— 不重复入队`);
    }
    return { created, event: this.get(input.eventId) };
  }

  /**
   * **原子**领取一条待处理事件。
   *
   * 一个事务里做三件事：
   *   ① 超时仍 `claimed` 的事件：`attempts` 用尽 ⇒ `dead`（响亮），否则退回 `pending`；
   *   ② 取最老的 `pending`（`next_at` 已到或为空）；
   *   ③ 标 `claimed`、`attempts + 1`、返回。
   *
   * @returns 没有可领的事件时 `null`（空闲是常态）
   */
  claimNext(now = new Date()): ProjectTaskEvent | null {
    const ts = now.toISOString();
    const staleBefore = new Date(now.getTime() - this.claimTimeoutMs).toISOString();

    const tx = this.db.transaction((): ProjectTaskEvent | null => {
      if (this.claimTimeoutMs > 0) {
        const stale = this.db.prepare(
          `SELECT event_id, attempts FROM project_task_events
            WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`,
        ).all(staleBefore) as Array<{ event_id: string; attempts: number }>;
        for (const s of stale) {
          if (s.attempts >= this.maxAttempts) {
            this.db.prepare(
              `UPDATE project_task_events
                  SET status = 'dead', last_error = ?, updated_at = ?
                WHERE event_id = ? AND status = 'claimed'`,
            ).run(`领取超时且已重试 ${s.attempts} 次（≥ ${this.maxAttempts}）——不再投递`, ts, s.event_id);
            logger.warn(`[ProjectTaskEvent] ${s.event_id} 领取超时且重试用尽 → dead`);
          } else {
            this.db.prepare(
              `UPDATE project_task_events
                  SET status = 'pending', claimed_at = NULL, next_at = '', updated_at = ?
                WHERE event_id = ? AND status = 'claimed'`,
            ).run(ts, s.event_id);
            logger.warn(`[ProjectTaskEvent] ${s.event_id} 领取方失联（超时）—— 退回 pending 重新投递`);
          }
        }
      }

      const candidate = this.db.prepare(
        `SELECT event_id FROM project_task_events
          WHERE status = 'pending' AND (next_at = '' OR next_at <= ?)
          ORDER BY created_at ASC LIMIT 1`,
      ).get(ts) as { event_id: string } | undefined;
      if (!candidate) return null;

      const info = this.db.prepare(
        `UPDATE project_task_events
            SET status = 'claimed', claimed_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE event_id = ? AND status = 'pending'`,
      ).run(ts, ts, candidate.event_id);
      if (info.changes === 0) {
        logger.warn(`[ProjectTaskEvent] ${candidate.event_id} 领取时状态已变（changes=0）——本次不领`);
        return null;
      }
      const row = this.db.prepare('SELECT * FROM project_task_events WHERE event_id = ?').get(candidate.event_id);
      return row ? rowToEvent(row as Record<string, unknown>) : null;
    });

    return tx();
  }

  /** 处理完成（ack）。只允许从 `claimed` 落，防重复 ack 覆盖 */
  finish(eventId: string, now = new Date()): boolean {
    const ts = now.toISOString();
    const info = this.db.prepare(
      `UPDATE project_task_events
          SET status = 'done', processed_at = ?, last_error = NULL, updated_at = ?
        WHERE event_id = ? AND status = 'claimed'`,
    ).run(ts, ts, eventId);
    if (info.changes === 0) {
      traceZeroRows('ProjectTaskEventStore.finish', 0, eventId);
      logger.warn(`[ProjectTaskEvent] ${eventId} ack 被忽略（不在 claimed —— 可能已处理过）`);
      return false;
    }
    return true;
  }

  /**
   * 处理失败：`attempts` 用尽 ⇒ `dead`，否则 `pending` + 指数退避。
   *
   * ⚠️ 退避是**必须**的：失败多半是 QQ 发不出去或模型超时，
   *   立刻重试只会把同样的事在几秒内重复烧一遍钱。
   */
  fail(eventId: string, error: string, now = new Date()): ProjectTaskEvent | null {
    const cur = this.get(eventId);
    if (!cur) return null;
    const ts = now.toISOString();
    const attempts = cur.attempts;
    if (attempts >= this.maxAttempts) {
      this.db.prepare(
        `UPDATE project_task_events
            SET status = 'dead', last_error = ?, updated_at = ?
          WHERE event_id = ?`,
      ).run(error.slice(0, 500), ts, eventId);
      logger.warn(`[ProjectTaskEvent] ${eventId} 投递失败 ${attempts} 次 → dead：${error.slice(0, 120)}`);
      return this.get(eventId);
    }
    const wait = Math.min(this.backoffBaseMs * 2 ** Math.max(0, attempts - 1), this.maxBackoffMs);
    const nextAt = new Date(now.getTime() + wait).toISOString();
    this.db.prepare(
      `UPDATE project_task_events
          SET status = 'pending', next_at = ?, claimed_at = NULL, last_error = ?, updated_at = ?
        WHERE event_id = ?`,
    ).run(nextAt, error.slice(0, 500), ts, eventId);
    logger.warn(
      `[ProjectTaskEvent] ${eventId} 投递失败（第 ${attempts} 次）—— ${Math.round(wait / 1000)}s 后重试：` +
        error.slice(0, 120),
    );
    return this.get(eventId);
  }

  /** 各状态计数（看板 / 排障用） */
  countByStatus(): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) AS n FROM project_task_events GROUP BY status',
    ).all() as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.status)] = Number(r.n) || 0;
    return out;
  }

  /** 某任务的全部事件（排障：这一轮到底投递到哪一步了） */
  listByTask(taskId: string): ProjectTaskEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM project_task_events WHERE task_id = ? ORDER BY created_at ASC',
    ).all(taskId) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }
}
