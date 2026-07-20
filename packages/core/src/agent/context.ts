export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export class AgentContext {
  messages: AgentMessage[] = [];
  maxTurns: number;

  constructor(maxTurns = 20) {
    this.maxTurns = maxTurns;
  }

  addMessage(msg: AgentMessage): void {
    this.messages.push(msg);
  }

  // Simple truncation: keep system prompt + last N turns
  truncate(maxTokens: number): void {
    let tokenEstimate = this.messages.reduce(
      (sum, m) => sum + m.content.length / 3,
      0,
    );
    while (tokenEstimate > maxTokens && this.messages.length > 2) {
      // Remove oldest non-system message
      const idx = this.messages.findIndex(
        (m, i) => i > 0 && m.role !== 'system',
      );
      if (idx === -1) break;
      const removed = this.messages.splice(idx, 2); // Remove user+assistant pair
      tokenEstimate -= removed.reduce(
        (sum, m) => sum + m.content.length / 3,
        0,
      );
    }
  }

  toOpenAIFormat(): Array<{
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: unknown;
  }> {
    return this.messages.map(m => ({
      role: m.role,
      content: m.content,
      tool_call_id: m.toolCallId,
      tool_calls: m.toolCalls,
    }));
  }
}
