/**
 * 异步唤醒调度器 —— `al:subagent-wake`。
 *
 * ★ 2026-10-19（change: `wake-her-on-task-result`）。
 *
 * 它补的是整条链路缺的**第二个半场**：
 *
 *   结果落库 → 【这里】把她叫起来，跑完整一轮主 Agent → 她决定验收/返工/问人/汇报
 *
 * 做法上只有一条原则：**状态全在库里，进程只是把它往前推一格**。
 *   - 领取（`claimNext`）原子、带超时回收 ⇒ 进程崩了重启还能继续；
 *   - 处理失败按退避重试、次数用尽转 `dead` ⇒ 不会静默消失；
 *   - 同一会话同时只跑一轮 ⇒ 她不会被自己的两句话打断。
 *
 * ⚠️ **它不是**「又发一条通知」。通知是一条一次性补全（没有工具、没有记忆、没有判断）；
 *   这里跑的是 `core.scheduler` 的完整管线 —— 同样的系统提示、同样的工具、同样的频道。
 */

import { MessageEvent, MessageType, type Message, type MessageChain } from '@alysia/core/platform';
import type { AlysiaCore } from '@alysia/core';
import {
  renderSubagentResultInput,
  type SubagentResultPayload,
} from '@alysia/core/memory';
import { logger } from '@alysia/core';

/** 回复目标（只为 QQ 私聊准备；别的会话没有主动通道） */
export interface ReplyTarget {
  /** `qq-official-1` */
  platformName: string;
  /** `private_<openid>` */
  sessionId: string;
  openid: string;
}

/**
 * 从 `unifiedMsgOrigin`（`platform:type:sessionId`）解析回复目标。
 *
 * ⚠️ 只认 `private`：QQ 官方 API 的主动消息是**私聊端点**，
 *   群会话在这里被当私聊发出去过一次（旧 `openidOfSession` 的正则放行了 `group_`）。
 */
export function parseReplyTarget(conversationId: string): ReplyTarget | null {
  const parts = String(conversationId ?? '').split(':');
  if (parts.length < 3) return null;
  const platformName = parts[0] ?? '';
  const messageType = parts[1] ?? '';
  const sessionId = parts[parts.length - 1] ?? '';
  if (!platformName.startsWith('qq')) return null;
  if (messageType !== 'private') return null;
  const m = /^private_([A-Za-z0-9_-]{6,})$/.exec(sessionId);
  return m ? { platformName, sessionId, openid: m[1]! } : null;
}

/** 推送通道（与 `al:push` 同形；测试给假实现） */
export interface WakePushChannel {
  readonly available: boolean;
  sendProactive(openid: string, message: string, opts?: { maxSegments?: number }): Promise<boolean>;
}

export interface SubagentWakeOptions {
  enabled: boolean;
  intervalMs: number;
  turnTimeoutMs: number;
  /** 发送失败时的内联重试次数（只重发消息，不重跑这一轮） */
  sendRetries?: number;
}

export interface SubagentWakeDeps {
  core: AlysiaCore;
  push?: WakePushChannel;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/** 从链里取纯文本（表情包标记等由适配器自己处理；这里只要正文） */
function plainTextOf(chain: MessageChain): string {
  let out = '';
  for (const comp of chain.getComponents()) {
    if (comp.type === 'plain') out += (comp as { text?: string }).text ?? '';
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class SubagentWake {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** 同一会话串行：一轮没跑完就不再领（她不打断自己） */
  private busyConversation: string | null = null;
  private lastIdleReason = '';
  private readonly opts: Required<SubagentWakeOptions>;
  private readonly log: NonNullable<SubagentWakeDeps['log']>;

  constructor(
    private deps: SubagentWakeDeps,
    opts: SubagentWakeOptions,
  ) {
    this.opts = {
      enabled: opts.enabled,
      intervalMs: Math.max(1000, opts.intervalMs),
      turnTimeoutMs: Math.max(10_000, opts.turnTimeoutMs),
      sendRetries: opts.sendRetries ?? 2,
    };
    this.log = deps.log ?? logger;
  }

  start(): void {
    if (!this.opts.enabled) {
      this.log.info('[subagent-wake] 未开启（subagentWake.enabled=false）—— 结果只落库，不唤起她');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(err =>
        this.log.warn(`[subagent-wake] tick 异常：${err?.message ?? err}`),
      );
    }, this.opts.intervalMs);
    this.log.info(
      `[subagent-wake] 已启动：每 ${this.opts.intervalMs}ms 看一次队列，单轮超时 ${Math.round(this.opts.turnTimeoutMs / 1000)}s`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 处理一条待投递事件。**返回 `true` = 这一轮真的干活了**（测试/排障用）。
   *
   * 顺序刻意如下（每一步失败都能在库里看见）：
   *  ① 领一条 → 没有就退出（空闲是常态）
   *  ② 版本核对：事件比任务旧 ⇒ 过期，直接 done（**旧结果不许覆盖新需求**）
   *  ③ 目标核对：没有 QQ 私聊目标 ⇒ done + 留痕（不猜目标）
   *  ④ 记进她的记忆（`role:engine`，幂等）—— 她"记得自己做过"
   *  ⑤ 跑完整一轮主 Agent（超时保护）
   *  ⑥ 发出去了 ⇒ 标 `notified_at` + ack；没发出去 ⇒ 退避重试
   */
  async tick(): Promise<boolean> {
    if (!this.opts.enabled) return false;
    if (this.ticking) return false;
    if (this.busyConversation) return false; // 上一条还在跑
    this.ticking = true;
    try {
      const mm = this.deps.core.memoryManager;
      const event = mm.claimNextProjectTaskEvent();
      if (!event) {
        const counts = mm.countProjectTaskEventsByStatus();
        const line = JSON.stringify(counts);
        if (line !== this.lastIdleReason && counts.pending) {
          this.lastIdleReason = line;
          this.log.info(`[subagent-wake] 队列里还有 ${counts.pending} 条没到重试时间（${line}）`);
        }
        return false;
      }

      const payload = event.payload as unknown as SubagentResultPayload;
      const task = mm.getProjectTask(event.taskId);

      // ② 版本核对
      if (!task) {
        mm.finishProjectTaskEvent(event.eventId);
        this.log.warn(`[subagent-wake] ${event.eventId}：任务已不存在 —— 丢弃该事件`);
        return false;
      }
      if (task.revision !== event.revision) {
        mm.finishProjectTaskEvent(event.eventId);
        this.log.info(
          `[subagent-wake] ${event.eventId}：结果属于第 ${event.revision + 1} 轮，任务已在第 ${task.revision + 1} 轮` +
            ' —— 过期结果，不唤起她（旧版本不许覆盖新需求）',
        );
        return false;
      }

      // ③ 目标核对
      const target = parseReplyTarget(payload.conversationId || task.originSessionId);
      if (!target) {
        mm.finishProjectTaskEvent(event.eventId);
        this.log.info(
          `[subagent-wake] ${event.eventId}：会话 "${payload.conversationId}" 不是 QQ 私聊 —— ` +
            '只记进记忆，不主动发消息（不猜目标）',
        );
        return false;
      }
      if (!this.deps.push?.available) {
        mm.finishProjectTaskEvent(event.eventId);
        this.log.info(`[subagent-wake] ${event.eventId}：没有推送通道 —— 只记进记忆`);
        return false;
      }

      // ④ 记忆里的「我这次的执行记录」（幂等：事件 id 固定）
      try {
        await mm.recordProjectTaskResult({
          taskId: task.taskId,
          projectId: task.projectId,
          revision: task.revision,
          status: task.status,
          originSessionId: payload.conversationId || task.originSessionId,
          dshSessionId: task.dshSessionId,
          summary: payload.summary,
          artifacts: payload.artifacts,
          publicUrl: payload.evidence.pageUrl,
        });
      } catch (err: any) {
        // 记不进去不影响唤醒（它只是让"她记得"更完整）
        this.log.warn(`[subagent-wake] ${event.eventId} 结果记回记忆失败：${err?.message ?? err}`);
      }

      // ⑤ 跑一轮
      this.busyConversation = target.sessionId;
      try {
        const text = renderSubagentResultInput(payload);
        const sent = await this.runTurnWithTimeout(target, payload, text, task.taskId);
        if (!sent.ok) {
          // ⑥ 失败：退避重试（重试会重跑这一轮 —— 验收/返工都是幂等的，见契约 92/91）
          mm.failProjectTaskEvent(event.eventId, sent.error ?? '发送失败');
          return true;
        }
        mm.markProjectTaskNotified(task.taskId);
        mm.finishProjectTaskEvent(event.eventId);
        this.log.info(
          `[subagent-wake] ${event.eventId} 已处理完：她说了 ${sent.chars ?? 0} 字 → ${target.sessionId.slice(-12)}`,
        );
        return true;
      } finally {
        this.busyConversation = null;
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 跑**完整**主 Agent 一轮，并把她的回复发出去。
   *
   * ★ 用 `core.scheduler.execute`（不是 `eventBus.put`）：唤醒不是"来了一条用户消息"，
   *   不该经过合并器（那会把它跟用户的真消息合并、互相打断）。
   */
  private async runTurn(
    target: ReplyTarget,
    payload: SubagentResultPayload,
    text: string,
    taskId: string,
  ): Promise<{ ok: boolean; error?: string; chars?: number }> {
    const push = this.deps.push!;
    const message: Message = {
      sessionId: target.sessionId,
      groupId: '',
      // 不是用户：sender 留空（`MemoryIngestStage` 也已被 subagent_result 挡掉）
      sender: { userId: '', nickname: '' },
      messageId: payload.eventId,
      type: MessageType.PRIVATE,
      content: [{ type: 'plain', text }],
      raw: null,
    };

    const event = new MessageEvent({
      messageStr: text,
      messageObj: message,
      platformMeta: {
        name: target.platformName,
        description: 'async wake (project task result)',
        id: target.platformName,
      },
      // ⚠️ 必须与任务发起会话**逐字一致**：记忆、最近对话、召回都按这个 key
      sessionId: target.sessionId,
    });

    event.setExtra('subagent_result', { payload, text });

    let sentOk = false;
    let sendError = '';
    let chars = 0;
    event.send = async (chain: MessageChain) => {
      const plain = plainTextOf(chain).trim();
      if (!plain) {
        sendError = '她这一轮没有产出任何文字';
        return;
      }
      chars = plain.length;
      const retries = this.opts.sendRetries;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          // 这是**她说话**，不是通知 ⇒ 允许自然分段（不传 maxSegments:1）
          if (await push.sendProactive(target.openid, plain)) {
            sentOk = true;
            return;
          }
          sendError = '通道返回 false';
        } catch (err: any) {
          sendError = err?.message ?? String(err);
        }
        if (attempt < retries) await sleep(1000 * (attempt + 1));
      }
      this.log.warn(
        `[subagent-wake] ${payload.taskId} 回复发送失败（已试 ${retries + 1} 次）：${sendError} —— ` +
          '只重试发送/这一轮，**不重跑 coding**',
      );
    };

    try {
      await this.deps.core.scheduler.execute(event);
    } catch (err: any) {
      return { ok: false, error: `管线异常：${err?.message ?? err}` };
    }
    if (!sentOk) return { ok: false, error: sendError || '没有发出任何回复' };
    // taskId 只用于日志；这里保留参数是为了调用点可读
    void taskId;
    return { ok: true, chars };
  }

  private async runTurnWithTimeout(
    target: ReplyTarget,
    payload: SubagentResultPayload,
    text: string,
    taskId: string,
  ): Promise<{ ok: boolean; error?: string; chars?: number }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ ok: boolean; error?: string; chars?: number }>(resolve => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            error: `这一轮超过 ${Math.round(this.opts.turnTimeoutMs / 1000)}s 没跑完`,
          }),
        this.opts.turnTimeoutMs,
      );
    });
    try {
      return await Promise.race([this.runTurn(target, payload, text, taskId), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
