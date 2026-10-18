// src/memory/stores/ProjectTaskStore.ts
/**
 * 委托任务表 —— 聊天侧的她把工程活交给 dsh 执行时的**唯一**状态载体。
 *
 * ★ 2026-10-17（change: `add-project-task-delegation`）。
 *
 * 定位：本 store **不做任何执行**（不 spawn、不读文件、不判断「活干得好不好」）。
 * 它只守四件事，而这四件恰好是最容易出错的地方：
 *
 *   1. **去重**：同一次工具调用的重试只产生一个任务（`request_key` UNIQUE）。
 *      ⚠️ 不用正文哈希 —— 用户改一个字再点一次，仍然是**同一次请求**。
 *   2. **单并发**：同一项目同时最多一个在途任务（第二次提交返回 `busy` + 既有任务）。
 *   3. **原子认领**：`claimNext` 必须在**一个事务**里「找最老的 → 标 running → 返回」，
 *      不许「先查后改」（两个 runner 会认领到同一个任务，同一份工作区被改两遍）。
 *   4. **自愈**：认领后 runner 崩了，任务不能永久卡在 `running`
 *      —— 超时后可被重新认领，次数用尽则**响亮失败**（不是静默饿死）。
 *
 * ⚠️ **终态≠发布**：`completed` 只表示「这一轮的结果被接受」，与是否发布无关
 * （发布能力首版关闭，见 change proposal 决策 6）。
 *
 * ⚠️ **不确定就别猜**：认领方无法确认远端是否执行成功时写 `unknown`，
 * 它**不会**被再次认领（见 `CLAIMABLE`）—— 盲目重投可能把同一份工作做两遍。
 */

import type Database from 'better-sqlite3';
import { traceZeroRows } from '../../utils/write-trace.js';
import { logger } from '../../utils/logger.js';
// ★ 2026-10-18（change: `make-author-iterate`）：「做一件东西」的显式状态机
import {
  initialLoopState,
  type LoopPhase,
  type LoopState,
} from '../project-task-loop.js';

/** 任务状态。终态：`needs_review`（等验收）/ `completed` / `failed` / `unknown` */
export type ProjectTaskStatus =
  /** 待执行（含「续作」——revision 已 +1） */
  | 'queued'
  /** 已被 runner 认领，执行中 */
  | 'running'
  /** 这一轮跑完了，等验收 */
  | 'needs_review'
  /** 本轮结果被接受（**不等于已发布**） */
  | 'completed'
  /** 有明确失败证据（不是网络超时） */
  | 'failed'
  /** **无法确认**远端是否执行成功 —— 不许自动重投 */
  | 'unknown';

/** 可以被认领的状态：只有 `queued`；`running` 仅在超时后被回收（见 `claimNext`） */
const CLAIMABLE: ProjectTaskStatus[] = ['queued'];

/** 在途（占住项目并发位）的状态 */
const IN_FLIGHT: ProjectTaskStatus[] = ['queued', 'running'];

/** 允许追加修改意见（⇒ 新 revision）的状态：不能在「还没跑完」时就插话 */
const REVISABLE: ProjectTaskStatus[] = ['needs_review', 'completed', 'failed', 'unknown'];

/** 认领超时：超过它仍停在 `running` 的任务视为「认领方丢了」 */
export const DEFAULT_CLAIMED_TIMEOUT_MS = 30 * 60_000;

/** 最大认领次数：用尽即 `failed`（宁可响亮失败，也不无限重投） */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface ProjectTask {
  taskId: string;
  requestKey: string;
  projectId: string;
  originSessionId: string;
  /**
   * 谁发起的：
   * - `user`：用户直接要求
   * - `delegated`：**她**在聊天里决定交出去（`start_project_task`）
   * - `self`：**她自己**发起的（生活/闲置活动，★ 2026-10-18 `let-her-start-her-own-projects`）
   */
  origin: 'user' | 'delegated' | 'self';
  goal: string;
  acceptanceCriteria: string;
  /** `null` = 还没有工程会话（首次执行前）——此时**不许**带 `--session-id` */
  dshSessionId: string | null;
  status: ProjectTaskStatus;
  revision: number;
  /** 上一轮结果（JSON）；续作前**不清**，好让调用方还能看到上一轮 */
  result: unknown | null;
  artifacts: unknown[] | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * ★ 2026-10-18（change: `make-author-iterate`）：「做一件东西」的**当前阶段**。
   * 老库迁移来的行默认 `intent`。
   */
  phase: LoopPhase;
  /** 累积状态（rounds / visits / revisions） */
  loopState: LoopState;
}

/** 建任务的结果 —— **判别式**，不压成布尔：三种情形调用方要说不同的话 */
export type CreateOutcome =
  /** 新建成功 */
  | { kind: 'created'; task: ProjectTask }
  /** 同一个 `requestKey` 已经建过（重试）—— 返回既有任务，不重复创建 */
  | { kind: 'deduped'; task: ProjectTask }
  /** 同项目已有在途任务 —— 返回**既有任务**（决策 3：返回已有任务或明确忙碌） */
  | { kind: 'busy'; task: ProjectTask };

export interface CreateInput {
  projectId: string;
  requestKey: string;
  goal: string;
  acceptanceCriteria?: string;
  originSessionId?: string;
  origin?: 'user' | 'delegated' | 'self';
}

/** runner 回传的结果 */
export interface SubmitResultInput {
  status: Extract<ProjectTaskStatus, 'needs_review' | 'completed' | 'failed' | 'unknown'>;
  dshSessionId?: string;
  result?: unknown;
  artifacts?: unknown[];
  error?: string;
}

export interface ProjectTaskStoreOptions {
  /** 认领超时（毫秒）；`0` = 关闭回收（测试用） */
  claimedTimeoutMs?: number;
  /** 最大认领次数 */
  maxAttempts?: number;
}

/** 行 → 领域对象（JSON 列在这里解，别让调用方看见字符串） */
function rowToTask(r: Record<string, unknown>): ProjectTask {
  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string' || v === '') return null;
    try {
      return JSON.parse(v);
    } catch {
      // ⚠️ 解析失败**不许吞成 null 就当没有** —— 留痕，否则「结果丢了」与「还没结果」同形
      logger.warn(`[ProjectTask] 列内容不是合法 JSON，按「无」处理：${String(v).slice(0, 120)}`);
      return null;
    }
  };
  return {
    taskId: String(r.task_id),
    requestKey: String(r.request_key),
    projectId: String(r.project_id),
    originSessionId: String(r.origin_session_id ?? ''),
    origin: (r.origin === 'delegated' || r.origin === 'self' ? r.origin : 'user'),
    goal: String(r.goal),
    acceptanceCriteria: String(r.acceptance_criteria ?? ''),
    dshSessionId: typeof r.dsh_session_id === 'string' && r.dsh_session_id !== '' ? r.dsh_session_id : null,
    status: String(r.status) as ProjectTaskStatus,
    revision: Number(r.revision ?? 0),
    result: parse(r.result),
    artifacts: (parse(r.artifacts) as unknown[] | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    lastError: typeof r.last_error === 'string' && r.last_error !== '' ? r.last_error : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    // ★ 阶段：老行没有这两列的值时给安全默认（`intent` + 空状态）
    phase: (typeof r.phase === 'string' && r.phase !== '' ? r.phase : 'intent') as LoopPhase,
    loopState:
      (parse(r.loop_state) as LoopState | null) ?? initialLoopState(),
  };
}

export class ProjectTaskStore {
  private readonly claimedTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private db: Database.Database, opts: ProjectTaskStoreOptions = {}) {
    this.claimedTimeoutMs = opts.claimedTimeoutMs ?? DEFAULT_CLAIMED_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  // ── 读 ──────────────────────────────────────────────────────

  get(taskId: string): ProjectTask | null {
    const r = this.db.prepare('SELECT * FROM project_tasks WHERE task_id = ?').get(taskId);
    return r ? rowToTask(r as Record<string, unknown>) : null;
  }

  /** 按项目列最近的任务（新的在前）——给「这个项目在忙什么」这类查询用 */
  listByProject(projectId: string, limit = 20): ProjectTask[] {
    const rows = this.db.prepare(
      'SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(projectId, limit);
    return (rows as Record<string, unknown>[]).map(rowToTask);
  }

  // ── 写 ──────────────────────────────────────────────────────

  /**
   * 建任务。三种结果见 {@link CreateOutcome}。
   *
   * ⚠️ 顺序很重要：**先查 requestKey 去重，再看在途冲突**。
   * 反过来的话，同一请求的第二次调用会被判成 `busy`（而不是 `deduped`），
   * 调用方就会以为「这是一次新的、被拒绝的提交」。
   */
  create(input: CreateInput, now = new Date()): CreateOutcome {
    const ts = now.toISOString();
    const existingByKey = this.db
      .prepare('SELECT * FROM project_tasks WHERE request_key = ?')
      .get(input.requestKey);
    if (existingByKey) {
      return { kind: 'deduped', task: rowToTask(existingByKey as Record<string, unknown>) };
    }

    const inFlight = this.db.prepare(
      `SELECT * FROM project_tasks WHERE project_id = ? AND status IN (${IN_FLIGHT.map(() => '?').join(',')})
       ORDER BY created_at DESC LIMIT 1`,
    ).get(input.projectId, ...IN_FLIGHT);
    if (inFlight) {
      return { kind: 'busy', task: rowToTask(inFlight as Record<string, unknown>) };
    }

    const task: ProjectTask = {
      taskId: `pt-${crypto.randomUUID()}`,
      requestKey: input.requestKey,
      projectId: input.projectId,
      originSessionId: input.originSessionId ?? '',
      origin: input.origin ?? 'user',
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria ?? '',
      dshSessionId: null,
      status: 'queued',
      revision: 0,
      result: null,
      artifacts: null,
      attempts: 0,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
      // ★ 一切从这里开始：先写意图，再画草图（见 `project-task-loop.ts`）
      phase: 'intent',
      loopState: initialLoopState(),
    };

    this.db.prepare(
      `INSERT INTO project_tasks
         (task_id, request_key, project_id, origin_session_id, origin, goal, acceptance_criteria,
          dsh_session_id, status, revision, result, artifacts, attempts, last_error, created_at, updated_at,
          phase, loop_state)
        VALUES (@taskId, @requestKey, @projectId, @originSessionId, @origin, @goal, @acceptanceCriteria,
                NULL, @status, @revision, NULL, NULL, @attempts, NULL, @createdAt, @updatedAt,
                @phase, @loopStateJson)`,
    ).run({
      ...(task as unknown as Record<string, unknown>),
      // JSON 列单独给：领域对象里是 `loopState`，SQL 里是 `loop_state`
      loopStateJson: JSON.stringify(task.loopState),
    });

    return { kind: 'created', task };
  }

  /**
   * 推进「做一件东西」的状态机（★ change: `make-author-iterate`）。
   *
   * 只由服务端在**收集到文件事实之后**调用；`phase`/`loop_state` 是唯一写入口径。
   */
  setLoop(
    taskId: string,
    phase: LoopPhase,
    loopState: LoopState,
    now = new Date(),
  ): ProjectTask | null {
    const ts = now.toISOString();
    this.db
      .prepare(
        `UPDATE project_tasks SET phase = ?, loop_state = ?, updated_at = ? WHERE task_id = ?`,
      )
      .run(phase, JSON.stringify(loopState), ts, taskId);
    return this.get(taskId);
  }

  /**
   * **原子**认领该项目最老的可执行任务。
   *
   * 一个事务里做三件事：
   *   ① 把超时仍 `running` 的任务捞出来：认领次数用尽 ⇒ 标 `failed`（响亮）；
   *      否则留在 `running`（下面那条 `updated_at < ?` 让它可以被重新认领）；
   *   ② 找最老的 `queued`（或可回收的 `running`）；
   *   ③ 标 `running`、`attempts + 1`、返回。
   *
   * @returns 没有可认领的任务时返回 `null`（**不是**错误：runner 空转是常态）
   */
  /**
   * 最老的、还有活可干的项目 id（没有则 `null`）。
   *
   * ★ 2026-10-18（真机撞出来的）：runner 原先**按项目**起服务（`--project alysia-blog`），
   *   于是新登记的项目**永远没人认领**——任务一路 `queued` 到天荒地老，而且是**静默**的。
   *   改成「一个 runner 服务所有项目」后，认领方不再指定项目，由服务端决定：
   *   先问这里「谁有最老的活」，再去 `claimNext(那个项目)`（认领本身仍是原子的）。
   *
   * 取"最老"而不是"第一个项目"，是为了**不饿死**后登记的项目。
   */
  /**
   * 某个来源、某个时间点之后发起了几个任务。
   * ★ 2026-10-18（`let-her-start-her-own-projects`）：用来数"今天她自己做了几个"。
   */
  countByOriginSince(origin: 'user' | 'delegated' | 'self', sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM project_tasks WHERE origin = ? AND created_at >= ?`,
      )
      .get(origin, sinceIso) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 某个来源最近一次任务的创建时间（没有则 `null`） */
  latestCreatedAtByOrigin(origin: 'user' | 'delegated' | 'self'): string | null {
    const row = this.db
      .prepare(
        `SELECT created_at FROM project_tasks WHERE origin = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(origin) as { created_at?: string } | undefined;
    return row?.created_at ?? null;
  }

  /** 是否有排队/在跑的任务（跨项目）—— 自发起前要确认没有堆叠 */
  hasActiveTask(): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM project_tasks WHERE status IN ('queued','running') LIMIT 1`)
      .get() as { x?: number } | undefined;
    return row?.x === 1;
  }

  nextQueuedProject(): string | null {    const row = this.db
      .prepare(
        `SELECT project_id FROM project_tasks
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as { project_id?: string } | undefined;
    return row?.project_id ?? null;
  }

  claimNext(projectId: string, now = new Date()): ProjectTask | null {
    const ts = now.toISOString();
    const staleBefore = new Date(now.getTime() - this.claimedTimeoutMs).toISOString();

    const tx = this.db.transaction((): ProjectTask | null => {
      if (this.claimedTimeoutMs > 0) {
        // ① 用尽重试的僵尸任务 → 失败（留痕由下面的 warn 负责）
        const zombies = this.db.prepare(
          `SELECT task_id, attempts FROM project_tasks
            WHERE project_id = ? AND status = 'running' AND updated_at < ?`,
        ).all(projectId, staleBefore) as Array<{ task_id: string; attempts: number }>;
        for (const z of zombies) {
          if (z.attempts >= this.maxAttempts) {
            const info = this.db.prepare(
              `UPDATE project_tasks SET status = 'failed', last_error = ?, updated_at = ?
                WHERE task_id = ? AND status = 'running'`,
            ).run(`认领超时且已重试 ${z.attempts} 次（≥ ${this.maxAttempts}）——不再重投`, ts, z.task_id);
            traceZeroRows('ProjectTaskStore.zombieFail', info.changes, z.task_id);
            logger.warn(`[ProjectTask] ${z.task_id} 认领超时且重试用尽 → failed（不再重投）`);
          }
        }
      }

      // ② 找最老的候选
      const candidate = this.db.prepare(
        `SELECT task_id FROM project_tasks
          WHERE project_id = ?
            AND (status IN (${CLAIMABLE.map(() => '?').join(',')})
                 ${this.claimedTimeoutMs > 0 ? "OR (status = 'running' AND updated_at < ?)" : ''})
          ORDER BY created_at ASC LIMIT 1`,
      ).get(
        projectId,
        ...CLAIMABLE,
        ...(this.claimedTimeoutMs > 0 ? [staleBefore] : []),
      ) as { task_id: string } | undefined;
      if (!candidate) return null;

      // ③ 标记认领。⚠️ 条件里再带上「状态仍是可认领」——事务内也不会错，但这是**防御**
      //    （同一个 store 在别的进程里被使用时，这一步能挡住双重认领）
      const info = this.db.prepare(
        `UPDATE project_tasks SET status = 'running', attempts = attempts + 1, updated_at = ?
          WHERE task_id = ?
            AND (status IN (${CLAIMABLE.map(() => '?').join(',')})
                 ${this.claimedTimeoutMs > 0 ? "OR (status = 'running' AND updated_at < ?)" : ''})`,
      ).run(
        ts,
        candidate.task_id,
        ...CLAIMABLE,
        ...(this.claimedTimeoutMs > 0 ? [staleBefore] : []),
      );
      if (info.changes === 0) {
        // 认领被别人抢先（理论上事务内不会；真发生就是契约被破坏，要响亮）
        logger.warn(`[ProjectTask] ${candidate.task_id} 认领时状态已变（changes=0）——本次不认领`);
        return null;
      }

      const row = this.db.prepare('SELECT * FROM project_tasks WHERE task_id = ?').get(candidate.task_id);
      return row ? rowToTask(row as Record<string, unknown>) : null;
    });

    return tx();
  }

  /**
   * runner 回传结果。**只允许从 `running` 回传**：
   * 迟到的回传（任务已被回收并重新认领）不许覆盖当前那一轮的状态。
   */
  submitResult(taskId: string, input: SubmitResultInput, now = new Date()): ProjectTask | null {
    const ts = now.toISOString();
    const info = this.db.prepare(
      `UPDATE project_tasks
          SET status = ?, dsh_session_id = COALESCE(?, dsh_session_id),
              result = COALESCE(?, result), artifacts = COALESCE(?, artifacts),
              last_error = ?, updated_at = ?
        WHERE task_id = ? AND status = 'running'`,
    ).run(
      input.status,
      input.dshSessionId ?? null,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.artifacts === undefined ? null : JSON.stringify(input.artifacts),
      input.error ?? null,
      ts,
      taskId,
    );

    if (info.changes === 0) {
      traceZeroRows('ProjectTaskStore.submitResult', 0, taskId);
      logger.warn(
        `[ProjectTask] ${taskId} 的回传被忽略（它不在 running —— 可能是迟到的回传，或已被回收重认领）`,
      );
      return null;
    }
    return this.get(taskId);
  }

  /**
   * 追加修改意见 ⇒ **新 revision**、回到 `queued`。
   *
   * ⚠️ **沿用 `dsh_session_id`**：第二轮必须续作同一个工程会话（不然等于重新建站）。
   * ⚠️ `revision` 只增不减；`result` **不清**（调用方还能看到上一轮结果）。
   */
  addRevision(taskId: string, feedback: string, now = new Date()): ProjectTask | null {
    const ts = now.toISOString();
    const cur = this.get(taskId);
    if (!cur) return null;
    if (!REVISABLE.includes(cur.status)) {
      logger.warn(`[ProjectTask] ${taskId} 当前状态 ${cur.status} 不接受修改意见（还在途）`);
      return null;
    }
    const info = this.db.prepare(
      `UPDATE project_tasks
          SET status = 'queued', revision = revision + 1, goal = ?, last_error = NULL, updated_at = ?
        WHERE task_id = ? AND status = ?`,
    ).run(feedback, ts, taskId, cur.status);
    if (info.changes === 0) {
      traceZeroRows('ProjectTaskStore.addRevision', 0, taskId);
      return null;
    }
    return this.get(taskId);
  }
}
