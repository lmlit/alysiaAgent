/**
 * ★ 8-15 WebUI 聊天端点（webui-chat-endpoints）
 *
 * 消息进现有 pipeline（记忆/人格/生活全链路）——与 QQ 通道完全同构：
 * MessageEvent → eventBus.put → Coalescer 合并/打断 → LLM → 回写。
 * 会话命名 webui:private:<uuid>，与 QQ/Telegram 完全隔离。
 *
 * 端点：
 *   POST /api/chat/prompt          — 非流式：完整回复
 *   POST /api/chat/stream          — SSE 流式：chunk/done/aborted 帧
 *   GET  /api/sessions/:id/messages — 历史分页（limit + before 游标，时间倒序）
 *   GET  /api/chat/pending          — 会话是否有在途生成
 */
import type { AlysiaCore } from '@alysia/core';
import { MessageEvent, MessageType } from '@alysia/core/platform';
import type { MessageChain } from '@alysia/core/platform';
import { logger } from '@alysia/core';

const REPLY_TIMEOUT_MS = 90_000;

interface ChatBody { text: string; sessionId?: string; }

function collectPlain(chain: MessageChain): string {
  let t = '';
  for (const comp of chain) {
    if ((comp as any).type === 'plain') t += (comp as any).text ?? '';
  }
  return t;
}

/** ★ 会话 id 统一清洗:剥掉全部 webui:private: 前缀(历史 bug 曾累积多重前缀,
 *   前端 localStorage 也可能存了带前缀的 id)——unifiedMsgOrigin 只由
 *   MessageSession.toString 拼一层 */
function cleanSid(id: string): string {
  return String(id ?? '').replace(/^(webui:private:)+/, '');
}

function makeWebuiEvent(core: AlysiaCore, sessionId: string, text: string): MessageEvent {
  const now = new Date().toISOString();
  const message = {
    sessionId,
    groupId: '',
    sender: { userId: 'webui', nickname: '你' },
    messageId: `webui-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    type: MessageType.PRIVATE,
    content: [{ type: 'plain', text }],
    raw: undefined,
  };
  // sessionId 传裸 ID：unifiedMsgOrigin = MessageSession.toString() = "webui:private:<id>"（与 QQ adapter 同模式）
  const event = new MessageEvent({
    messageStr: text,
    messageObj: message as any,
    platformMeta: { id: 'webui', name: 'WebUI', description: 'WebUI 聊天' },
    sessionId,
  });
  return event;
}

export function registerChatRoutes(app: any, core: AlysiaCore): void {
  // ── 非流式 prompt：send 回调收集完整回复 ──
  app.post('/api/chat/prompt', async (req: any, reply: any) => {
    const { text, sessionId } = (req.body ?? {}) as ChatBody;
    if (!text?.trim()) return reply.code(400).send({ ok: false, error: 'text 为空' });
    const sid = cleanSid(sessionId ?? '') || `sess-${Date.now()}`;
    const origin = `webui:private:${sid}`;

    const result = await new Promise<{ ok: boolean; reply?: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        logger.error(`[Chat] prompt timeout (${origin.slice(-16)})`);
        resolve({ ok: false, error: '回复超时 (90s)' });
      }, REPLY_TIMEOUT_MS);

      const event = makeWebuiEvent(core, sid, text);
      event.send = async (chain: MessageChain) => {
        clearTimeout(timer);
        const replyText = collectPlain(chain);
        if (!replyText.trim()) {
          resolve({ ok: false, error: '空回复（可能被打断）' });
        } else {
          resolve({ ok: true, reply: replyText });
        }
      };
      core.eventBus.put(event);
    });

    return { ok: result.ok, sessionId: sid, reply: result.reply, error: result.error };
  });

  // ── SSE 流式：on_chunk 逐块帧 + on_done 收尾（aborted 帧防挂起）──
  app.post('/api/chat/stream', async (req: any, reply: any) => {
    const { text, sessionId } = (req.body ?? {}) as ChatBody;
    if (!text?.trim()) return reply.code(400).send({ ok: false, error: 'text 为空' });
    const sid = cleanSid(sessionId ?? '') || `sess-${Date.now()}`;
    const origin = `webui:private:${sid}`;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let ended = false;
    const send = (obj: Record<string, unknown>) => {
      if (ended) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      res.end();
    };

    const timer = setTimeout(() => {
      logger.error(`[Chat] stream timeout (${origin.slice(-16)})`);
      send({ type: 'error', message: '回复超时 (90s)' });
      end();
    }, REPLY_TIMEOUT_MS);

    send({ type: 'connected', sessionId: sid });

    const event = makeWebuiEvent(core, sid, text);
    // send 回调只收集；收尾统一走 on_done（llm-agent 包装 send 后触发 done(chain)）
    let replyText = '';
    event.send = async (chain: MessageChain) => {
      replyText = collectPlain(chain);
    };
    event.setExtra('on_chunk', (chunk) => {
      send({ type: 'chunk', kind: chunk.kind, text: chunk.text });
    });
    event.setExtra('on_done', (chain) => {
      clearTimeout(timer);
      if (chain) {
        if (!replyText) replyText = collectPlain(chain);
        send({ type: 'done', reply: replyText });
      } else {
        send({ type: 'aborted', message: '回复被打断（可能已被合并）' });
      }
      end();
    });
    core.eventBus.put(event);
  });

  // ── 历史分页：created_at 游标向下翻页，时间倒序（最新在前）──
  app.get('/api/sessions/:id/messages', async (req: any) => {
    const { id } = req.params as { id: string };
    const { limit, before } = req.query as { limit?: string; before?: string };
    const origin = `webui:private:${cleanSid(id)}`;
    const messages = core.memoryManager.getSessionMessages(
      origin,
      Math.min(Number(limit) || 50, 200),
      before || undefined,
    );
    return { ok: true, sessionId: cleanSid(id), messages, hasMore: messages.length >= (Number(limit) || 50) };
  });

  // ── 在途生成检查（页面刷新恢复"回复中"状态）──
  app.get('/api/chat/pending', async (req: any) => {
    const { sessionId } = req.query as { sessionId?: string };
    if (!sessionId) return { ok: true, inFlight: false };
    const origin = `webui:private:${cleanSid(sessionId)}`;
    return { ok: true, inFlight: core.isGenerating(origin) };
  });
}
