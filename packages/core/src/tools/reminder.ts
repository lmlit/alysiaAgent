import type { ToolDefinition } from './registry.js';

// In-memory reminder store (重启丢失，MVP 够用)
const reminders: Array<{ id: string; text: string; triggerAt: Date; notify: () => void }> = [];
let nextId = 1;

export function createReminderTool(notifyFn: (text: string) => Promise<void>): ToolDefinition {
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
    handler: async (args) => {
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

      const timer = setTimeout(async () => {
        await notifyFn(`Reminder: ${text}`);
        const idx = reminders.findIndex(r => r.id === id);
        if (idx >= 0) reminders.splice(idx, 1);
      }, delay);

      reminders.push({ id, text, triggerAt, notify: () => { clearTimeout(timer); } });
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
      return reminders
        .map(r => `[${r.id}] ${r.text} — ${r.triggerAt.toLocaleString()}`)
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
      return `Cancelled reminder: "${removed.text}"`;
    },
  };
}
