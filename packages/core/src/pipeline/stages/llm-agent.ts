import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import { MessageType } from '../../platform/types.js';
import { AgentRunner } from '../../agent/runner.js';
import { MessageChain } from '../../platform/chain.js';
import { logger } from '../../utils/logger.js';

// ★ 8-28 意图标记协议（ai-life-intent-system）：LLM 在回复末尾加 [intent:类型|内容|延迟小时数]，
//   POST 阶段解析存 ai_life_intents + 从回复剥离（用户不可见）。与 [表情包:xxx] 同模式。
export const INTENT_REGEX = /\[intent:(delayed-reply|promise)\|([^|\]]+)\|(\d+)\]/g;

/** 解析意图标记：返回剥离后的文本 + 意图列表（纯函数，便于单测） */
export function parseIntentMarks(text: string): {
  text: string;
  intents: Array<{ type: 'delayed-reply' | 'promise'; content: string; hours: number }>;
} {
  const intents: Array<{ type: 'delayed-reply' | 'promise'; content: string; hours: number }> = [];
  for (const m of text.matchAll(INTENT_REGEX)) {
    intents.push({
      type: m[1] as 'delayed-reply' | 'promise',
      content: String(m[2]).trim().slice(0, 200),
      hours: Math.max(1, Math.min(72, parseInt(m[3], 10) || 1)),
    });
  }
  // 剥离标记后压缩残留多空格（"先答应你 [intent:...] 回头" → "先答应你 回头"）
  return { text: text.replace(INTENT_REGEX, '').replace(/ {2,}/g, ' ').trim(), intents };
}

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

    // ★ 8-28 意图协议（ai-life-intent-system）：想延迟回复或承诺时在回复末尾加标记，
    //   POST 阶段解析存 ai_life_intents + 剥离（用户不可见）——"想想再答复/明天给你看"
    if (event.getMessageType() === MessageType.PRIVATE) {
      systemPrompt += '\n\n[意图使用]\n如果你想延迟回复（"让我想想，晚点告诉你"）或做出承诺（"明天给你看…"），' +
        '在回复末尾加标记: [intent:类型|内容|延迟小时数]。类型: delayed-reply（想想再答复）| promise（承诺到期兑现）。' +
        '内容: 简短描述你要做的事。延迟小时数: 1-72 的整数。标记会被系统自动剥离，用户看不到。' +
        '只在真的想延迟或承诺时加，不要每条都加。';
    }

    // ★ 表情包协议：模型在文案中插入 [表情包:名字] 标记，发送时解析发图。
    //   仅私聊注入 — QQ 官方 API 群聊被动媒体消息不可用（40011000），群聊不发图。
    if (event.getMessageType() === MessageType.PRIVATE) {
      const stickers = this.ctx.memoryManager.listStickers();
      if (stickers.length > 0) {
        systemPrompt += `\n\n[表情包使用]\n你可以用表情包回应情绪（开心/难过/撒娇/困了等），在回复文案中插入标记: [表情包:名字]\n★ 必须使用半角方括号和冒号（[表情包:名字]），禁止全角（［表情包：名字］）——全角标记无法被解析\n可用表情包: ${stickers.map(s => s.name).join('、')}\n示例: "晚安好梦哦 [表情包:睡觉]"\n约束: 每次回复最多插入一个表情包标记，情绪平淡时不要插入。`;
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
    // ★ 8-10 打断：从 Coalescer 的 AbortRegistry 取当前 signal（新消息到达即 abort）
    const abortCtrl = this.ctx.coalescer?.getAbortRegistry().getOrCreate(event.unifiedMsgOrigin);
    // ★ 8-15 WebUI 流式分支（webui-chat-endpoints）：on_chunk 挂载 → runStream
    const onChunk = event.getExtra('on_chunk');
    const result = onChunk
      ? await this.runner.runStream(
          event.messageStr,
          systemPrompt,
          imageUrls.filter(Boolean),
          event.unifiedMsgOrigin,
          this.ctx.sampling?.chat,
          abortCtrl?.signal,
          onChunk,
        )
      : await this.runner.run(
          event.messageStr,
          systemPrompt,
          imageUrls.filter(Boolean),
          event.unifiedMsgOrigin,
          // ★ 8-10 主对话采样槽（她的"嗓子"），sampling.chat 可配
          this.ctx.sampling?.chat,
          abortCtrl?.signal,
        );

    // ★ 8-15 结束通知 helper：正常 = send 回调内触发（见 RespondStage 调用点之后）；
    //   打断分支直接触发 null（不经过 RespondStage，SSE 端点必须知道生成已丢弃）
    const done = (chain: MessageChain | null) => { event.getExtra('on_done')?.(chain); };

    // ★ 8-10 打断：生成被新消息中断 → 丢弃（未发任何内容），不设置回复、不回写记忆；
    //   通知 Coalescer 即时 flush 累计消息（合并重发）
    if (result.aborted) {
      logger.info(`[LLMAgent] generation aborted (${event.unifiedMsgOrigin.slice(-16)}), response discarded`);
      done(null);
      this.ctx.coalescer?.onGenerationAborted(event.unifiedMsgOrigin, event);
      return;
    }

    // ★ 8-10 竞态双保险（coalescer-abort-race-fix）：runner 返回正常（fetch 已 resolve）
    //   但 controller 已被新消息 abort → 结果同样丢弃，触发合并重发。
    //   语义：被打断就丢弃，合并只合并请求（输入），不合并返回结果——杜绝双重回复。
    if (abortCtrl?.signal.aborted) {
      logger.info(`[LLMAgent] aborted after completion (${event.unifiedMsgOrigin.slice(-16)}), response discarded`);
      done(null);
      this.ctx.coalescer?.onGenerationAborted(event.unifiedMsgOrigin, event);
      return;
    }

    // ★ 回复完成日志：能看到 bot 实际回了什么（含表情包标记）
    const replyText = result.chain.getComponents()
      .filter(c => c.type === 'plain')
      .map(c => (c as { text?: string }).text ?? '')
      .join(' ');
    logger.info(`[LLMAgent] ← ${event.messageStr.slice(0, 60).replace(/\n/g, ' ')}`);
    logger.info(`[LLMAgent] → ${replyText.slice(0, 120).replace(/\n/g, ' ')} (${Date.now() - start}ms)`);

    // ★ 8-28 意图解析（ai-life-intent-system）：POST 阶段解析 [intent:类型|内容|延迟小时数] 标记——
    //   延迟回复/承诺是角色隐式意愿（不走工具调用），与 [表情包:xxx] 同模式；解析后从回复剥离（用户不可见）
    try {
      const parsed = parseIntentMarks(replyText);
      for (const intent of parsed.intents) {
        this.ctx.memoryManager.saveIntent({
          type: intent.type,
          content: intent.content,
          triggerAt: Date.now() + intent.hours * 3_600_000,
          source: 'dialogue',
          sessionId: event.unifiedMsgOrigin,
        });
        logger.info(`[Intent] dialogue+ [${intent.type}] ${intent.content.slice(0, 30)} +${intent.hours}h`);
      }
      if (parsed.text !== replyText) {
        // 剥离标记（用户不可见）——修改 chain 的 plain 组件文本
        for (const comp of result.chain.getComponents()) {
          if (comp.type === 'plain' && (comp as { text?: string }).text) {
            const c = comp as { text?: string };
            const cleaned = (c.text ?? '').replace(INTENT_REGEX, '').trim();
            if (cleaned !== c.text) c.text = cleaned;
          }
        }
      }
    } catch (err: any) {
      logger.warn(`[LLMAgent] intent parse failed: ${err.message}`);
    }

    event.setExtra('response_chain', result.chain);

    // ★ 8-15 on_done 挂载：RespondStage 调 event.send(chain) 时触发（正常结束通知）
    if (event.getExtra('on_done')) {
      const baseSend = event.send.bind(event);
      event.send = async (chain: MessageChain) => {
        await baseSend(chain);
        done(chain);
      };
    }

    // ★ 8-10 请求正常完成，释放 abort controller（防注册表泄漏；不 abort）
    this.ctx.coalescer?.getAbortRegistry().release(event.unifiedMsgOrigin);

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

    // ★ 8-09 输出回写：assistant 回复 ingest 进 EventLog——bot 记得自己说过什么，
    //   [最近对话] 输入输出成对（复用 Life writeback 模式；失败不阻塞主流程）
    if (replyText.trim()) {
      this.ctx.memoryManager.ingest({
        id: `agent-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        session_id: event.unifiedMsgOrigin,
        source: 'chat',
        type: 'message',
        payload: { content: replyText.trim(), role: 'assistant' },
        importance: 0.3,
        created_at: new Date().toISOString(),
        processed: 0,
      }).catch(err => logger.error('LLMAgent writeback failed:', err));
    }
  }
}
