// ★ 8-15 WebUI 聊天端点（webui-chat-endpoints）——chat/prompt + stream SSE + messages + pending
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerChatRoutes } from '../src/webui/chat.js';
import { MessageChain } from '@alysia/core/platform';

/** mock core：eventBus.put 捕获 MessageEvent，测试侧驱动 send/on_chunk/on_done */
function makeCore(overrides: Record<string, any> = {}) {
  const putHandlers: Array<(event: any) => void> = [];
  const core = {
    eventBus: {
      put: vi.fn().mockImplementation((event: any) => {
        putHandlers.forEach(h => h(event));
      }),
    },
    memoryManager: {
      getSessionMessages: vi.fn().mockReturnValue([
        { role: 'user', content: '你好', senderName: '你', createdAt: '2026-08-15T00:00:00' },
        { role: 'assistant', content: '你好呀', senderName: '昔涟', createdAt: '2026-08-15T00:00:01' },
      ]),
    },
    isGenerating: vi.fn().mockReturnValue(true),
    ...overrides,
  };
  return { core, putHandlers };
}

async function buildApp(core: any) {
  const app = Fastify();
  registerChatRoutes(app, core);
  await app.ready();
  return app;
}

describe('WebUI chat endpoints', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POST /api/chat/prompt：注入 pipeline，send 收集完整回复', async () => {
    const { core, putHandlers } = makeCore();
    putHandlers.push((event) => {
      event.send(new MessageChain().message('昔涟的回复'));
    });
    const app = await buildApp(core);

    const res = await app.inject({ method: 'POST', url: '/api/chat/prompt', payload: { text: '你好', sessionId: 'sess-1' } });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.reply).toBe('昔涟的回复');
    expect(body.sessionId).toBe('sess-1');
    // 消息确实进了 pipeline（unifiedMsgOrigin = webui:private:<uuid>）
    expect(core.eventBus.put).toHaveBeenCalledTimes(1);
    const event = core.eventBus.put.mock.calls[0][0];
    expect(event.unifiedMsgOrigin).toBe('webui:private:sess-1');
    expect(event.messageStr).toBe('你好');
  });

  it('POST /api/chat/prompt：text 为空 → 400', async () => {
    const { core } = makeCore();
    const app = await buildApp(core);
    const res = await app.inject({ method: 'POST', url: '/api/chat/prompt', payload: { text: '  ' } });
    expect(res.statusCode).toBe(400);
    expect(core.eventBus.put).not.toHaveBeenCalled();
  });

  it('POST /api/chat/prompt：空回复 → ok:false', async () => {
    const { core, putHandlers } = makeCore();
    putHandlers.push((event) => { event.send(new MessageChain()); }); // 空 chain
    const app = await buildApp(core);
    const res = await app.inject({ method: 'POST', url: '/api/chat/prompt', payload: { text: 'hi' } });
    expect(res.json().ok).toBe(false);
  });

  it('POST /api/chat/stream：SSE 帧顺序（connected → chunk → done），on_done 关闭', async () => {
    const { core, putHandlers } = makeCore();
    putHandlers.push((event) => {
      // 模拟 pipeline 流式：先 chunk 再 send(chain)，send 后触发 on_done（llm-agent 包装语义）
      event.getExtra('on_chunk')({ kind: 'reasoning', text: '想了一下' });
      event.getExtra('on_chunk')({ kind: 'text', text: '你好' });
      event.send(new MessageChain().message('你好呀')).then(() => {
        event.getExtra('on_done')(new MessageChain().message('你好呀'));
      });
    });
    const app = await buildApp(core);

    const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { text: 'hi', sessionId: 's1' } });
    const frames = res.body.toString().split('\n\n').filter(Boolean).map(f => JSON.parse(f.replace(/^data: /, '')));
    expect(frames[0].type).toBe('connected');
    expect(frames[1]).toEqual({ type: 'chunk', kind: 'reasoning', text: '想了一下' });
    expect(frames[2]).toEqual({ type: 'chunk', kind: 'text', text: '你好' });
    expect(frames[3].type).toBe('done');
    expect(frames[3].reply).toBe('你好呀');
  });

  it('POST /api/chat/stream：aborted → on_done(null) → aborted 帧', async () => {
    const { core, putHandlers } = makeCore();
    putHandlers.push((event) => {
      event.getExtra('on_done')(null); // 打断路径
    });
    const app = await buildApp(core);
    const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { text: 'hi', sessionId: 's1' } });
    const frames = res.body.toString().split('\n\n').filter(Boolean).map(f => JSON.parse(f.replace(/^data: /, '')));
    expect(frames[1].type).toBe('aborted');
  });

  it('GET /api/sessions/:id/messages：游标分页透传', async () => {
    const { core } = makeCore();
    const app = await buildApp(core);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/messages?limit=20&before=2026-08-15T00:00:00' });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(core.memoryManager.getSessionMessages).toHaveBeenCalledWith(
      'webui:private:s1', 20, '2026-08-15T00:00:00',
    );
  });

  it('GET /api/chat/pending：返回在途状态', async () => {
    const { core } = makeCore();
    const app = await buildApp(core);
    const res = await app.inject({ method: 'GET', url: '/api/chat/pending?sessionId=s1' });
    expect(res.json()).toEqual({ ok: true, inFlight: true });
    expect(core.isGenerating).toHaveBeenCalledWith('webui:private:s1');
  });
});
