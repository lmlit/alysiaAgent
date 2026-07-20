import type { MessageEvent } from '../platform/event.js';
import type { LLMResponse } from '../provider/types.js';

export interface AgentHooks {
  onAgentBegin?(event: MessageEvent, messages: Array<{ role: string; content: string }>): Promise<void>;
  onAgentDone?(event: MessageEvent, response: LLMResponse): Promise<void>;
  onToolStart?(event: MessageEvent, toolName: string, args: Record<string, unknown>): Promise<void>;
  onToolEnd?(event: MessageEvent, toolName: string, args: Record<string, unknown>, result: unknown): Promise<void>;
}

export class NoopAgentHooks implements AgentHooks {
  async onAgentBegin() {}
  async onAgentDone() {}
  async onToolStart() {}
  async onToolEnd() {}
}
