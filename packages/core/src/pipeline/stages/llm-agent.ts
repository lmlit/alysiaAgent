import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { MessageType } from '../../platform/types.js';
import { AgentRunner } from '../../agent/runner.js';
import { MessageChain } from '../../platform/chain.js';
import { logger } from '../../utils/logger.js';

/**
 * LLMAgentStage — the core onion-model stage.
 *
 * PRE:  intercepts commands via CommandRegistry, otherwise runs AgentRunner
 *       (system prompt from memory_context, image URL extraction)
 * YIELD:→ RespondStage sends the response
 * POST: records token usage via MemoryManager.recordTokenUsage()
 */
export class LLMAgentStage implements Stage {
  private runner!: AgentRunner;
  private ctx!: PipelineContext;

  async initialize(ctx: PipelineContext): Promise<void> {
    this.ctx = ctx;
    this.runner = new AgentRunner(ctx.providerManager, ctx.toolRegistry);
  }

  async *process(event: MessageEvent): AsyncGenerator<void> {
    // ===== PRE: Check commands =====
    const cmdResult = await this.ctx.commandRegistry?.execute(
      event,
      event.messageStr,
    );
    if (cmdResult) {
      event.setExtra('response_chain', new MessageChain().message(cmdResult));
      yield; // → RespondStage
      return;
    }

    // ===== PRE: 空 @ 检测（统一模板，所有 adapter 无需各自处理）=====
    // 群聊中 @bot 但没有任何文字内容 → 简短友好回应
    // 注意：不要手动加 @前缀 — QQ/Telegram 被动回复 API 会自动 @ 发起人，
    // 手动加会导致群里显示两次 @。
    if (
      event.getMessageType() === MessageType.GROUP &&
      !event.messageStr.trim()
    ) {
      event.setExtra('response_chain', new MessageChain().message(
        '嗯？怎么啦～（叫我有什么事吗？）'
      ));
      yield;
      return;
    }

    // ===== PRE: LLM call =====
    // Build system prompt: 激活角色的 system_prompt（v3 角色系统，替代读 md 文件）
    const memoryContext = event.getExtra('memory_context') || '';
    const activeRolePrompt = this.ctx.memoryManager.getActiveSystemPrompt();
    // Use compact persona to save context space (worldbook is 66 entries = ~15k chars!)
    const compactPersona = activeRolePrompt.split('\n---\n').slice(0, 4).join('\n---\n');
    let systemPrompt = [
      compactPersona,
      memoryContext ? '\n---\n## 当前记忆\n' + memoryContext : '',
    ].filter(Boolean).join('\n');

    // ★ 注入当前本地时间，让 LLM 能回答"今天几号"、感知早晚、判断时效
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const timeStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${weekdays[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    systemPrompt += `\n\n[当前时间] ${timeStr}`;

    // 工具调用纪律：禁止把工具调用以文本形式写进回复（模型偶发行为，双层防护）
    systemPrompt += '\n\n[工具调用] 需要实时信息时通过系统提供的工具调用机制发起。严禁在回复文本中书写任何工具调用 XML 标签（tool_calls / invoke），工具调用标签只会由系统生成，出现在回复文本里的此类标签将被系统剥离。';

    // Inject recent conversation history into system prompt
    const history = event.getExtra('conversation_history') || [];
    if (history.length > 0) {
      const recentHistory = history.slice(-10).map(h =>
        `${h.role === 'user' ? '伙伴' : '昔涟'}: ${h.content}`
      ).join('\n');
      systemPrompt += `\n\n## 最近对话\n${recentHistory}\n\n请基于以上对话历史继续交流。`;
    }

    // 群聊 system_reminder: 明确当前说话人，避免混淆多人对话
    if (event.getMessageType() === MessageType.GROUP) {
      const currentSpeaker = event.getSenderName() || '未知用户';
      systemPrompt += `\n\n[群聊提醒]\n当前说话人: "${currentSpeaker}"。请只回复这个人，不要回复之前其他人的问题。如果对方只是 @你 没有说具体的事，简短友好地回应即可，不要翻旧账。`;
    }

    // ★ 表情包协议：模型在文案中插入 [表情包:名字] 标记，发送时解析发图。
    //   仅私聊注入 — QQ 官方 API 群聊被动媒体消息不可用（40011000），群聊不发图。
    if (event.getMessageType() === MessageType.PRIVATE) {
      const stickers = this.ctx.memoryManager.listStickers();
      if (stickers.length > 0) {
        systemPrompt += `\n\n[表情包使用]\n你可以用表情包回应情绪（开心/难过/撒娇/困了等），在回复文案中插入标记: [表情包:名字]\n可用表情包: ${stickers.map(s => s.name).join('、')}\n示例: "晚安好梦哦 [表情包:睡觉]"\n约束: 每次回复最多插入一个表情包标记，情绪平淡时不要插入。`;
      }
    }

    // Extract image URLs from message components
    const imageUrls: string[] = [];
    for (const comp of event.getMessages()) {
      if (comp.type === 'image') {
        imageUrls.push((comp as { url?: string; file?: string }).url || '');
      }
    }

    const start = Date.now();
    const result = await this.runner.run(
      event.messageStr,
      systemPrompt,
      imageUrls.filter(Boolean),
      event.unifiedMsgOrigin,
    );

    // ★ 回复完成日志：能看到 bot 实际回了什么（含表情包标记）
    const replyText = result.chain.getComponents()
      .filter(c => c.type === 'plain')
      .map(c => (c as { text?: string }).text ?? '')
      .join(' ');
    logger.info(`[LLMAgent] ← ${event.messageStr.slice(0, 60).replace(/\n/g, ' ')}`);
    logger.info(`[LLMAgent] → ${replyText.slice(0, 120).replace(/\n/g, ' ')} (${Date.now() - start}ms)`);

    event.setExtra('response_chain', result.chain);

    // Stash token usage so POST can read it after yield
    event.setExtra('_token_usage', result.tokenUsage);

    // ===== YIELD: Let RespondStage send the response =====
    yield;

    // ===== POST: Token stats recording (delegated to MemoryManager) =====
    const usage = event.getExtra('_token_usage');
    if (usage) {
      this.ctx.memoryManager.recordTokenUsage(event.unifiedMsgOrigin, usage);

      // 上下文超过阈值 → 触发记忆压缩
      if (usage.input > 8_000) {
        this.ctx.memoryManager.onSessionEnd(event.unifiedMsgOrigin).catch(err =>
          logger.error('LLMAgent onSessionEnd failed:', err)
        );
      }
    }
  }
}
