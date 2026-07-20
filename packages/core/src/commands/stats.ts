import type { CommandDefinition } from './registry.js';

export function createStatsCommand(
  getStats: (sessionId: string) => { recordCount: number; totalInput: number; totalOutput: number; totalTokens: number },
): CommandDefinition {
  return {
    name: 'stats',
    description: '查看当前会话 Token 用量',
    handler: async (event) => {
      const stats = getStats(event.unifiedMsgOrigin);
      if (stats.recordCount === 0) return 'No stats available for this session.';
      return [
        'Session Token Usage',
        `Total:    ${stats.totalTokens.toLocaleString()}`,
        `Input:    ${stats.totalInput.toLocaleString()}`,
        `Output:   ${stats.totalOutput.toLocaleString()}`,
        `Requests: ${stats.recordCount}`,
      ].join('\n');
    },
  };
}
