import type { MessageEvent } from '../platform/event.js';
import type { LLMResponse } from '../provider/types.js';

export interface AgentHooks {
  onAgentBegin?(event: MessageEvent | null, messages: Array<{ role: string; content: string }>): Promise<void>;
  onAgentDone?(event: MessageEvent | null, response: LLMResponse): Promise<void>;
  onToolStart?(event: MessageEvent | null, toolName: string, args: Record<string, unknown>): Promise<void>;
  onToolEnd?(event: MessageEvent | null, toolName: string, args: Record<string, unknown>, result: unknown): Promise<void>;
  /**
   * ★ 2026-10-20（change: `put-dropped-turns-back`）：把**被截断丢弃的对话**压成一段回忆。
   *
   * 返回非空字符串 ⇒ 会被插入上下文头部（system 之后）作为「更早的对话（已压缩）」；
   * 返回空串 / 抛错 / 不实现 ⇒ 保持旧行为（直接丢弃）。
   *
   * ⚠️ 实现方负责"用哪个 LLM、什么温度"。core 不持有 LLM 客户端，这是有意的分层。
   */
  summarizeDroppedTurns?(input: {
    turns: Array<{ role: string; content: string }>;
    /** 上次压缩留下的累积摘要（有则走"合并"口径，避免摘要各自为政） */
    previousSummary?: string;
  }): Promise<string>;
}

export class NoopAgentHooks implements AgentHooks {
  async onAgentBegin() {}
  async onAgentDone() {}
  async onToolStart() {}
  async onToolEnd() {}
}
