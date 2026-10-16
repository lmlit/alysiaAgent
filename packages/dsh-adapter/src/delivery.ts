/**
 * 回传投递队列 —— change: `fix-dsh-ingest-and-settlement`
 *
 * ★ 为什么单独成模块（不是一个函数）：它有三条**各自可测**的契约
 *   （分批 / 串行化 / 故障分类），塞在 `installBridge` 的闭包里就测不到边界，
 *   而这个模块存在的理由正是那些边界。
 *
 * 契约见 `openspec/specs/dsh-adapter/spec.md` §2.5.1（原 change
 * `fix-dsh-ingest-and-settlement` 已归档到 `openspec/archive/2026-10-16-…`）：
 *   契约 1 分批、契约 2 串行化、契约 3 故障分类、契约 4 不静默丢弃。
 *
 * ★ 它**不产生** id、也**不判断**身份 —— 那是调用方的职责（契约 7）。
 */
import type { IngestEvent, IngestOutcome } from './alysia-client.ts';

/**
 * 服务端单批上限。**必须与 `packages/server/src/ingest.ts` 的 `MAX_INGEST_BATCH` 一致**。
 *
 * ⚠️ 两份字面量不能共享常量（插件不能依赖 server 包），靠两边测试钉住同一个数字——
 *    与 `DSH_SESSION_PREFIX` 是同一套手法。漂移的后果不是静默：超过上限会吃 413，
 *    而 413 在这里按**永久拒收**处理并**响亮上报**（契约 3）。
 */
export const SERVER_MAX_INGEST_BATCH = 200;

/** 待回传队列上限。长期不可用时丢**最旧**的，不无限涨内存 */
export const DEFAULT_MAX_PENDING = 500;

/** 每丢弃多少条补报一次（避免超限后逐条刷屏，又不至于只剩第一句） */
const DROP_WARN_EVERY = 50;

/** 卡死状态下每多少次排空补报一次（状态告警要能持续可见，又不能每轮刷屏） */
const STUCK_RENOTIFY_EVERY = 20;

export interface DeliveryLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

export interface DeliveryOptions {
  /** 发送一批（**必须**是永不抛的；抛了也会被兜住成「可重试」） */
  send: (events: IngestEvent[]) => Promise<IngestOutcome>;
  logger: DeliveryLogger;
  /** 单批上限，默认 `SERVER_MAX_INGEST_BATCH` */
  maxBatch?: number;
  /** 队列上限，默认 `DEFAULT_MAX_PENDING` */
  maxPending?: number;
}

export interface DrainResult {
  /** 队列是否**真的空了**（含本次排空期间新入队的）。`false` ⇒ 有事件没送出去 */
  drained: boolean;
  /** 未送出去的条数（`drained` 为 `true` 时为 0） */
  remaining: number;
}

export interface DeliveryStats {
  /** 当前待发条数 */
  queued: number;
  /** 服务端已受理的条数 */
  accepted: number;
  /** `ok` 响应里被**逐条**拒收的条数 */
  rejectedEvents: number;
  /** 被**整批永久拒收**（4xx）而丢弃的条数 */
  permanentlyRejected: number;
  /** 超过队列上限而丢弃最旧的条数 */
  dropped: number;
  /** 排空次数 */
  passes: number;
  /** 最近一次可重试失败的原因 */
  lastFailure?: string;
}

/**
 * 待回传队列。
 *
 * **串行化（契约 2）**：`drain()` 把新的排空挂到**在途 promise 链**的尾部并返回它，
 * 所以调用方 await 到的不是「当时手里的那批」，而是「**包含在途批次在内的整条链**」。
 * 这是 KI-24 的根因修复：原实现在 `flush()` 开头就 `const batch = pending; pending = []`，
 * 在途批次对后来的调用方**不可见** ⇒ `session/disposed` 看到空队列立刻返回，
 * 紧接着就去结算了（那时消息还没入库）。
 */
export class IngestDelivery {
  private pending: IngestEvent[] = [];
  /** 在途链。**永不 reject**（`runPass` 自己兜住一切） */
  private flight: Promise<DrainResult> = Promise.resolve({ drained: true, remaining: 0 });

  private accepted = 0;
  private rejectedEvents = 0;
  private permanentlyRejected = 0;
  private dropped = 0;
  private passes = 0;
  private lastFailure: string | undefined;

  /** 是否处于「回传受阻」状态；配 `stuckPasses` 做状态告警的进入/补报 */
  private stuck = false;
  private stuckPasses = 0;

  /** 是否正在「超上限丢弃」状态（用于只在**进入**该状态时报一次） */
  private dropping = false;
  /** 已汇报过的丢弃总数（避免恢复时重复汇报） */
  private droppedReported = 0;

  constructor(private readonly opts: DeliveryOptions) {}

  get queued(): number {
    return this.pending.length;
  }

  stats(): DeliveryStats {
    return {
      queued: this.pending.length,
      accepted: this.accepted,
      rejectedEvents: this.rejectedEvents,
      permanentlyRejected: this.permanentlyRejected,
      dropped: this.dropped,
      passes: this.passes,
      lastFailure: this.lastFailure,
    };
  }

  /** 入队。超过上限丢**最旧**的，且**必须留痕**（契约 4） */
  enqueue(event: IngestEvent): void {
    this.pending.push(event);
    const max = this.opts.maxPending ?? DEFAULT_MAX_PENDING;
    if (this.pending.length <= max) {
      this.dropping = false;
      return;
    }

    const over = this.pending.length - max;
    const before = this.dropped;
    this.pending.splice(0, over);
    this.dropped += over;

    // ★ 这是**状态**告警，不是逐次请求的失败告警 ——
    //   所以它走本模块自己的 logger，**不受** `AlysiaClient` 失败降噪的影响。
    //   进入「正在丢弃」状态时报一次；此后每 DROP_WARN_EVERY 条补报一次。
    //   ⚠️ 中途未报的那些条数会在**下次成功排空**时由 `noteHealthy` 汇报真实总数——
    //      否则最后一条日志会**少报**（读者会以为只丢了一条）。
    const crossedBoundary = Math.floor(this.dropped / DROP_WARN_EVERY) > Math.floor(before / DROP_WARN_EVERY);
    if (!this.dropping || crossedBoundary) {
      this.opts.logger.warn(
        `[alysia-adapter] 回传队列超过上限 ${max}，丢弃最旧 ${over} 条` +
          `（累计丢弃 ${this.dropped}，待发 ${this.pending.length}）`,
      );
    }
    this.dropping = true;
  }

  /**
   * 排空队列，返回一条**覆盖在途批次**的 promise（契约 2）。
   *
   * 调用方 await 它 ⇒ 此刻该队列里所有已入队事件都拿到了服务端确认（或被明确拒收）。
   */
  drain(): Promise<DrainResult> {
    const next = this.flight.then(
      () => this.runPass(),
      () => this.runPass(),
    );
    this.flight = next;
    return next;
  }

  private async runPass(): Promise<DrainResult> {
    this.passes++;
    if (this.pending.length === 0) {
      this.noteHealthy();
      return { drained: true, remaining: 0 };
    }

    const maxBatch = this.opts.maxBatch ?? SERVER_MAX_INGEST_BATCH;
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, maxBatch);

      let outcome: IngestOutcome;
      try {
        outcome = await this.opts.send(batch);
      } catch (err) {
        // `send` 的契约是永不抛；真抛了也不能让队列卡死或让 dsh 崩
        outcome = { kind: 'unreachable', reason: `send 抛出：${(err as Error)?.message ?? String(err)}` };
      }

      if (outcome.kind === 'unreachable') {
        // 可重试：**留在队列里**，等下次触发（不丢）
        this.noteStuck(outcome.reason);
        return { drained: false, remaining: this.pending.length };
      }

      // ok 与 permanent 都不重发（permanent 正是旧实现无限重试的那一类）
      this.pending.splice(0, batch.length);

      if (outcome.kind === 'permanent') {
        this.permanentlyRejected += batch.length;
        this.opts.logger.warn(
          `[alysia-adapter] 回传被**永久拒收**，丢弃 ${batch.length} 条且不重试：${outcome.reason}` +
            `（累计 ${this.permanentlyRejected}）`,
        );
        // 不 `return`：一个批次被拒不该阻塞其余合法事件（契约 3）
        continue;
      }

      this.accepted += outcome.accepted;
      if (outcome.rejected.length > 0) {
        this.rejectedEvents += outcome.rejected.length;
        this.opts.logger.warn(
          `[alysia-adapter] 回传 ${outcome.accepted} 条，${outcome.rejected.length} 条被拒：` +
            `${outcome.rejected.slice(0, 2).join(' | ')}`,
        );
      }
    }

    this.noteHealthy();
    return { drained: true, remaining: 0 };
  }

  /** 进入/停留在「受阻」状态时的告警（进入时报一次，之后每 STUCK_RENOTIFY_EVERY 次补报） */
  private noteStuck(reason: string): void {
    this.lastFailure = reason;
    this.stuckPasses = this.stuck ? this.stuckPasses + 1 : 1;
    const shouldReport = !this.stuck || this.stuckPasses % STUCK_RENOTIFY_EVERY === 0;
    this.stuck = true;
    if (!shouldReport) return;
    this.opts.logger.warn(
      `[alysia-adapter] 回传受阻，${this.pending.length} 条暂存待下次触发重试：${reason}` +
        `（累计丢弃 ${this.dropped}）`,
    );
  }

  private noteHealthy(): void {
    if (this.stuck) {
      this.stuck = false;
      this.stuckPasses = 0;
      this.opts.logger.info(`[alysia-adapter] 回传已恢复（累计受理 ${this.accepted} 条）`);
    }
    // ★ 把「丢弃」的**真实总数**在链路恢复可用时补报一次。
    //   中途那些没逐条打出来的丢弃，否则会让最后一条日志**少报**。
    if (this.dropped > this.droppedReported) {
      this.droppedReported = this.dropped;
      this.opts.logger.warn(
        `[alysia-adapter] 回传队列累计丢弃 ${this.dropped} 条（受理 ${this.accepted} 条，永久拒收 ${this.permanentlyRejected} 条）`,
      );
    }
  }
}
