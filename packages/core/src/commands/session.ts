import type { CommandDefinition } from './registry.js';

export function createSessionCommands(
  onNew: (sessionId: string) => Promise<void>,
  onReset: (sessionId: string) => Promise<void>,
  onStop: (sessionId: string) => Promise<void>,
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
        await onStop(event.unifiedMsgOrigin);
        return '已停止当前操作。';
      },
    },
  ];
}
