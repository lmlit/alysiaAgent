import type { ToolDefinition } from './registry.js';
import { logger } from '../utils/logger.js';

// In-memory reminder store (重启丢失，MVP 够用；待办：SQLite 持久化)
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
let nextId = 1;

/** Node setTimeout delay 上限：超过 2^31-1ms（≈24.8 天）会立即触发 */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** 推送失败重试延迟 */
const RETRY_DELAY_MS = 5 * 60_000;
/** 推送失败重试上限（初始触发 + 1 次重试） */
const MAX_RETRIES = 1;

/** 触发一次提醒：从数组移除 → notifyFn → 失败按预算重试。
 *  可重入（定时器回调与重试共用）。 */
async function fire(notifyFn: (text: string, sessionId?: string) => Promise<boolean>, id: string): Promise<void> {
  const idx = reminders.findIndex(r => r.id === id);
  if (idx < 0) return; // 已被取消/已处理
  const [removed] = reminders.splice(idx, 1);

  let ok = false;
  try {
    ok = await notifyFn(removed.text, removed.sessionId);
  } catch (err: any) {
    logger.warn(`[Reminder] ${removed.id} notify threw: ${err?.message ?? err}`);
  }

  if (!ok && removed.retryCount < MAX_RETRIES) {
    removed.retryCount += 1;
    removed.triggerAt = new Date(Date.now() + RETRY_DELAY_MS);
    removed.timer = setTimeout(() => { void fire(notifyFn, removed.id); }, RETRY_DELAY_MS);
    reminders.push(removed);
    logger.info(`[Reminder] ${removed.id} notify failed, retry ${removed.retryCount}/${MAX_RETRIES} in 5min`);
    return;
  }
  if (!ok) {
    logger.warn(`[Reminder] ${removed.id} dropped after ${removed.retryCount + 1} attempts`);
  }
}

/** notifyFn 第二参数：设置提醒时的会话 ID（用于主动推送给设置者）。
 *  返回 true = 已处理（含"非私聊只打日志"路径），false = 推送失败需重试。 */
export function createReminderTool(notifyFn: (text: string, sessionId?: string) => Promise<boolean>): ToolDefinition {
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

      const id = String(nextId++);
      const delay = triggerAt.getTime() - Date.now();

      if (delay <= 0) {
        return 'Error: Reminder time must be in the future.';
      }
      // ★ 8-08 修复：Node setTimeout 超 2^31-1ms 会立即触发——显式拒绝长提醒
      if (delay > MAX_TIMEOUT_MS) {
        return 'Error: Reminder too far in the future (max ~24 days).';
      }

      const timer = setTimeout(() => { void fire(notifyFn, id); }, delay);

      reminders.push({ id, text, triggerAt, timer, sessionId: sessionId || '', retryCount: 0 });
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

export function createCancelReminderTool(): ToolDefinition {
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
      return `Cancelled reminder: "${removed.text}"`;
    },
  };
}
