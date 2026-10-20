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
  /** ★ 2026-10-20：被截断丢弃、但还没压成摘要的轮次（攒批，防每步一次 LLM 调用） */
  private droppedBuffer: AgentMessage[] = [];
  /** ★ 2026-10-20：累积的上下文摘要原文（增量合并用） */
  private contextSummaryText?: string;
  /** ★ 2026-10-20：插在头部的那条摘要消息（要能原地替换） */
  private summaryMessage?: AgentMessage;

  constructor(maxTurns = 20) {
    this.maxTurns = maxTurns;
  }

  addMessage(msg: AgentMessage): void {
    this.messages.push(msg);
  }

  /**
   * 粗略 token 估算（**这是估的，不是数的**）。
   *
   * ⚠️ 已知不准：`length / 3` 对中文口径偏宽 —— 中文 1 字约 0.6~1 token，
   * 除以 3 等于把 1000 字算成 333 token，**低估 2~3 倍**。
   * 之所以没急着改：真正触发的上界被 `usage.input`（API 返回的真实值，
   * 见 `CONTEXT_COMPACT_TRIGGER_TOKENS`）兜着，这里只做"别让它无限长"的粗判。
   * 要改必须连带改 `truncate()` 的判据，且要有实测分布支撑（别拍脑袋）。
   */
  estimateTokens(): number {
    return this.messages.reduce((sum, m) => sum + m.content.length / 3, 0);
  }

  // Truncation: remove oldest turns until under token budget.
  // A "turn" = user message through all assistant/tool messages until the next user (or end).
  // This preserves tool_call ↔ tool_result pairing, which splice(2) would break.
  //
  // ★ 2026-10-20（change: `put-dropped-turns-back`）：**返回被丢掉的 turn**。
  //   以前返回 void —— 丢掉的内容连个句柄都没有，所以"压成摘要塞回去"根本无从谈起。
  //   返回它才能让调用方决定：直接丢，还是先压成一段再插回头部。
  truncate(maxTokens: number): AgentMessage[] {
    let tokenEstimate = this.estimateTokens();
    const dropped: AgentMessage[] = [];
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
      dropped.push(...removed);
      tokenEstimate -= removed.reduce(
        (sum, m) => sum + m.content.length / 3,
        0,
      );
    }
    return dropped;
  }

  /**
   * ★ 2026-10-20：把一条消息插到 **system 之后、其余内容之前**。
   *
   * 用途：压缩摘要在语义上属于"更早的对话"，必须排在现有对话**前面**，
   * 但不能插在 system prompt 之前（system 必须是第一条）。
   */
  insertAfterSystem(msg: AgentMessage): void {
    // 找最后一条 system（前导 system 可能不止一条）
    let idx = 0;
    while (idx < this.messages.length && this.messages[idx].role === 'system') idx++;
    this.messages.splice(idx, 0, msg);
  }

  /** 取第一条非 system 消息的下标（没有则 -1） */
  private firstNonSystemIndex(): number {
    return this.messages.findIndex(m => m.role !== 'system');
  }

  /**
   * ★ 2026-10-20：**取走**并清空"待压缩的已丢弃轮次"缓冲。
   *
   * 为什么要缓冲：长会话里每步可能只丢 1 个 turn，若每次都调一次 LLM 压缩，
   * 一步一次调用（还未必有新信息）。攒到阈值再压，调用次数降一个量级。
   */
  takeDroppedBuffer(): AgentMessage[] {
    const buf = this.droppedBuffer;
    this.droppedBuffer = [];
    return buf;
  }

  /** 把本步丢弃的轮次并入缓冲（由 truncation 流程调用） */
  addDropped(messages: AgentMessage[]): void {
    if (messages.length === 0) return;
    this.droppedBuffer.push(...messages);
  }

  /** 缓冲的字符数（判断"攒够了没有"；不依赖 token 估算） */
  droppedBufferChars(): number {
    return this.droppedBuffer.reduce((sum, m) => sum + m.content.length, 0);
  }

  /** 缓冲里的消息数 */
  droppedBufferLength(): number {
    return this.droppedBuffer.length;
  }

  /**
   * 写入/更新"更早的对话（已压缩）"块（★ 2026-10-20）。
   *
   * 语义：这是**累积**摘要 —— 下次压缩会把旧摘要 + 新丢弃一起再压一遍，
   * 所以这里总是**替换**同一条消息，而不是不断追加（否则上下文会被摘要自己撑爆）。
   */
  setContextSummary(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.contextSummaryText = trimmed;
    const content = `## 更早的对话（已压缩）\n${trimmed}\n（这段是压缩后的回忆，细节可能有出入；需要精确信息就问一句）`;
    if (this.summaryMessage) {
      this.summaryMessage.content = content;
      return;
    }
    this.summaryMessage = { role: 'system', content };
    this.insertAfterSystem(this.summaryMessage);
  }

  /** 当前累积摘要（增量合并时要带给压缩器） */
  getContextSummary(): string | undefined {
    return this.contextSummaryText;
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
