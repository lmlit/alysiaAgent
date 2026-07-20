import type { CommandDefinition } from './registry.js';

export function createSessionCommands(
  onNew: (sessionId: string) => Promise<string>,
  onReset: (sessionId: string) => Promise<void>,
): CommandDefinition[] {
  return [
    {
      name: 'new',
      description: '创建新对话',
      handler: async (event) => {
        const cid = await onNew(event.unifiedMsgOrigin);
        return `Switched to new session: ${cid.slice(0, 4)}`;
      },
    },
    {
      name: 'reset',
      description: '重置当前对话',
      handler: async (event) => {
        await onReset(event.unifiedMsgOrigin);
        return 'Session reset.';
      },
    },
  ];
}
