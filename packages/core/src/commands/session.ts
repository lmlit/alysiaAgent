import type { CommandDefinition } from './registry.js';

export function createSessionCommands(
  onNew: (sessionId: string) => Promise<void>,
  onReset: (sessionId: string) => Promise<void>,
  /**
   * ★ 2026-10-20（change: make-stop-really-stop；KI-7）：改成可以**如实回话**。
   *
   * 原来它返回 `void`，于是 `/stop` 无论有没有在飞，都硬回「已停止当前操作。」——
   * 那正是本 change 要消灭的形态：**看起来生效了，其实什么都没发生**。
   * 现在回调自己给文案（`aborted` / `nothing in flight` 两种），返回 `void` 才回落到默认句。
   */
  onStop: (sessionId: string) => Promise<string | void>,
): CommandDefinition[] {
  return [
    {
      name: 'new',
      description: '保存记忆并开始新对话',
      handler: async (event) => {
        await onNew(event.unifiedMsgOrigin);
        return '会话记忆已保存，开始新对话 ✨';
      },
    },
    {
      name: 'reset',
      description: '重置当前对话（不保存记忆）',
      handler: async (event) => {
        await onReset(event.unifiedMsgOrigin);
        return '当前对话已重置。';
      },
    },
    {
      name: 'stop',
      description: '停止当前回复生成',
      aliases: ['cancel', 'halt'],
      handler: async (event) => {
        const note = await onStop(event.unifiedMsgOrigin);
        return note || '已停止当前操作。';
      },
    },
  ];
}
