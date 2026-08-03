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

  // Truncation: remove oldest turns until under token budget.
  // A "turn" = user message through all assistant/tool messages until the next user (or end).
  // This preserves tool_call ↔ tool_result pairing, which splice(2) would break.
  truncate(maxTokens: number): void {
    let tokenEstimate = this.messages.reduce(
      (sum, m) => sum + m.content.length / 3,
      0,
    );
    while (tokenEstimate > maxTokens && this.messages.length > 2) {
      // Find first non-system message (start of oldest turn)
      const turnStart = this.messages.findIndex(
        (m, i) => i > 0 && m.role !== 'system',
      );
      if (turnStart === -1) break;
      // Find end of this turn: next user message or end of array
      const nextUser = this.messages.findIndex(
        (m, i) => i > turnStart && m.role === 'user',
      );
      const turnEnd = nextUser === -1 ? this.messages.length : nextUser;
      const removed = this.messages.splice(turnStart, turnEnd - turnStart);
      tokenEstimate -= removed.reduce(
        (sum, m) => sum + m.content.length / 3,
        0,
      );
    }
  }

  toOpenAIFormat(): Array<Record<string, unknown>> {
    return this.messages.map(m => {
      const entry: Record<string, unknown> = {
        role: m.role,
      };
      // Assistant with tool_calls: content must be null per OpenAI spec
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        entry.content = null;
        entry.tool_calls = m.toolCalls;
      } else {
        entry.content = m.content || null;
      }
      // Tool messages: must include tool_call_id
      if (m.role === 'tool') {
        entry.tool_call_id = m.toolCallId;
      }
      return entry;
    });
  }
}
