import type { ToolDefinition } from './registry.js';
import { logger } from '../utils/logger.js';

// In-memory reminder store + ★ 8-12 SQLite 持久化（reminder-sqlite-persistence）：
// 内存数组负责调度（timer），persist 回调负责落库——容器重启后 restoreReminders
// 从库恢复（未过期重挂 timer，已过期立即补发），提醒不丢。
// ★ 8-08 修复：notifyFn 返回 boolean（true=已处理）；失败（throw 或返回 false）5min 后重试一次，
//   再失败丢弃并 warn——推送失败不再静默丢提醒。
interface Reminder {
  id: string;
  text: string;
  triggerAt: Date;
  timer: ReturnType<typeof setTimeout> | null;
  sessionId: string;
  retryCount: number;
}
const reminders: Reminder[] = [];

/** 持久化回调（由 bootstrap 用 MemoryManager 方法实现；测试可用内存 fake） */
export interface ReminderPersist {
  save(id: string, r: { text: string; triggerAt: Date; sessionId?: string; retryCount?: number }): void;
  remove(id: string): void;
}

/** Node setTimeout delay 上限：超过 2^31-1ms（≈24.8 天）会立即触发 */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** 推送失败重试延迟 */
const RETRY_DELAY_MS = 5 * 60_000;
/** 推送失败重试上限（初始触发 + 1 次重试） */
const MAX_RETRIES = 1;

/** 触发一次提醒：从数组移除 → persist.remove → notifyFn → 失败按预算重试。
 *  可重入（定时器回调与重试共用）。 */
async function fire(
  notifyFn: (text: string, sessionId?: string) => Promise<boolean>,
  persist: ReminderPersist,
  id: string,
): Promise<void> {
  const idx = reminders.findIndex(r => r.id === id);
  if (idx < 0) return; // 已被取消/已处理
  const [removed] = reminders.splice(idx, 1);
  persist.remove(id); // ★ 8-12 触发即消费（落库删除）

  let ok = false;
  try {
    ok = await notifyFn(removed.text, removed.sessionId);
  } catch (err: any) {
    logger.warn(`[Reminder] ${removed.id} notify threw: ${err?.message ?? err}`);
  }

  if (!ok && removed.retryCount < MAX_RETRIES) {
    removed.retryCount += 1;
    removed.triggerAt = new Date(Date.now() + RETRY_DELAY_MS);
    removed.timer = setTimeout(() => { void fire(notifyFn, persist, removed.id); }, RETRY_DELAY_MS);
    reminders.push(removed);
    persist.save(removed.id, removed); // ★ 8-12 重试也持久化（retry_count 落库）
    logger.info(`[Reminder] ${removed.id} notify failed, retry ${removed.retryCount}/${MAX_RETRIES} in 5min`);
    return;
  }
  if (!ok) {
    logger.warn(`[Reminder] ${removed.id} dropped after ${removed.retryCount + 1} attempts`);
  }
}

/** 挂一个 timer（set/cancel/恢复共用）；id 跨重启唯一（时间戳+序号） */
function armTimer(notifyFn: (text: string, sessionId?: string) => Promise<boolean>, persist: ReminderPersist, r: Reminder): void {
  const delay = r.triggerAt.getTime() - Date.now();
  if (delay <= 0) {
    // 已过期（启动恢复场景）：立即补发——用户设了提醒，意图明确，补发不丢。
    // ★ 必须先入数组：fire 依赖 findIndex 查找（否则静默跳过）
    reminders.push(r);
    void fire(notifyFn, persist, r.id);
    return;
  }
  r.timer = setTimeout(() => { void fire(notifyFn, persist, r.id); }, delay);
  reminders.push(r);
}

let idSeq = 0;

/** ★ 8-12 启动恢复：从持久化加载全部待触发提醒 → 未过期重挂 timer，已过期立即补发 */
export function restoreReminders(
  notifyFn: (text: string, sessionId?: string) => Promise<boolean>,
  persist: ReminderPersist,
  pending: Array<{ id: string; text: string; triggerAt: Date; sessionId: string; retryCount: number }>,
): void {
  for (const p of pending) {
    armTimer(notifyFn, persist, {
      id: p.id,
      text: p.text,
      triggerAt: p.triggerAt,
      timer: null,
      sessionId: p.sessionId,
      retryCount: p.retryCount,
    });
    logger.info(`[Reminder] restored ${p.id} (trigger ${p.triggerAt.toLocaleString()}, ${p.triggerAt.getTime() <= Date.now() ? 'overdue → firing now' : 'rescheduled'})`);
  }
  if (pending.length > 0) logger.info(`[Reminder] restored ${pending.length} reminder(s) from store`);
}

/** notifyFn 第二参数：设置提醒时的会话 ID（用于主动推送给设置者）。
 *  返回 true = 已处理（含"非私聊只打日志"路径），false = 推送失败需重试。 */
export function createReminderTool(
  notifyFn: (text: string, sessionId?: string) => Promise<boolean>,
  persist: ReminderPersist,
): ToolDefinition {
  return {
    name: 'set_reminder',
    description: '设置定时提醒。time 格式如 "30min"、"1h"、"2026-07-21 14:00"',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: '提醒时间："30min" / "1h" / "2026-07-21 14:00"' },
        text: { type: 'string', description: '提醒内容' },
      },
      required: ['time', 'text'],
    },
    handler: async (args, sessionId) => {
      const timeStr = args.time as string;
      const text = args.text as string;
      let triggerAt: Date;

      if (timeStr.endsWith('min')) {
        const mins = parseInt(timeStr);
        triggerAt = new Date(Date.now() + mins * 60_000);
      } else if (timeStr.endsWith('h')) {
        const hours = parseInt(timeStr);
        triggerAt = new Date(Date.now() + hours * 3_600_000);
      } else {
        triggerAt = new Date(timeStr);
      }

      if (isNaN(triggerAt.getTime())) {
        return 'Error: Invalid time format. Use "30min", "2h", or "2026-07-21 14:00".';
      }

      const id = `reminder-${Date.now()}-${idSeq++}`;
      const delay = triggerAt.getTime() - Date.now();

      if (delay <= 0) {
        return 'Error: Reminder time must be in the future.';
      }
      // ★ 8-08 修复：Node setTimeout 超 2^31-1ms 会立即触发——显式拒绝长提醒
      if (delay > MAX_TIMEOUT_MS) {
        return 'Error: Reminder too far in the future (max ~24 days).';
      }

      const reminder: Reminder = { id, text, triggerAt, timer: null, sessionId: sessionId || '', retryCount: 0 };
      armTimer(notifyFn, persist, reminder);
      persist.save(id, reminder); // ★ 8-12 落库（重启后恢复）
      return `Reminder set: "${text}" at ${triggerAt.toLocaleString()}.`;
    },
  };
}

export function createListRemindersTool(): ToolDefinition {
  return {
    name: 'list_reminders',
    description: '列出所有活跃的提醒',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      if (reminders.length === 0) return 'No active reminders.';
      // ★ 不返回提醒内容，防止 LLM 提前泄露。只在到时提醒时通过 notifyFn 发送。
      return reminders
        .map(r => `[${r.id}] 将在 ${r.triggerAt.toLocaleString()} 触发（内容仅到时可见）`)
        .join('\n');
    },
  };
}

export function createCancelReminderTool(persist: ReminderPersist): ToolDefinition {
  return {
    name: 'cancel_reminder',
    description: '取消一个提醒',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Reminder ID (use list_reminders to see)' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = args.id as string;
      const idx = reminders.findIndex(r => r.id === id);
      if (idx < 0) return `Error: Reminder with ID ${id} not found.`;
      const removed = reminders.splice(idx, 1)[0];
      if (removed.timer) clearTimeout(removed.timer);
      persist.remove(id); // ★ 8-12 取消也落库
      return `Cancelled reminder: "${removed.text}"`;
    },
  };
}
