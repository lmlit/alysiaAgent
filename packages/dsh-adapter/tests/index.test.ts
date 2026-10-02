/**
 * 插件注册断言:mock ctx 上验证 5 类注册(section/context/variable/tool/事件)发生。
 * 不依赖 dsh 运行时——只验证 apply() 的注册行为与契约形状。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apply, name, PERSONA_VARIABLE } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

function makeMockCtx() {
  const section = vi.fn(() => () => {})
  const context = vi.fn(() => () => {})
  const variable = vi.fn(() => () => {})
  const register = vi.fn(() => () => {})
  /** 按事件名存 handler —— bridge 的测试要**手动触发**它们 */
  const handlers = new Map<string, (...a: unknown[]) => void>()
  const on = vi.fn((type: string, fn: (...a: unknown[]) => void) => {
    handlers.set(type, fn)
    return () => {}
  })
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const effect = vi.fn((cb: () => unknown) => { cb(); return () => {} })
  const ctx = {
    systemPrompt: { section, context, variable },
    tools: { register },
    on,
    effect,
    logger,
  } as unknown as Context
  /** 触发某个已注册的事件 handler */
  const emit = (type: string, ...args: unknown[]): void => {
    const h = handlers.get(type)
    if (!h) throw new Error(`没有注册 ${type} 的 handler`)
    h(...args)
  }
  return { ctx, section, context, variable, register, on, logger, effect, emit, handlers }
}

/**
 * 拿一个**全新的模块实例**的 apply。
 *
 * ★ 为什么记忆类测试必须这么做：`prewarmCache` / `prewarmInFlight` 是**模块级**的
 *   （那正是「多实例共享一次预热」的实现），会跨测试泄漏——
 *   上一个测试还在飞的预热 promise 会被下一个测试复用，
 *   表现为「本测试一次请求都没发」。用 resetModules 隔离。
 */
async function freshApply(): Promise<typeof apply> {
  vi.resetModules();
  const m = await import('../src/index.ts');
  return m.apply;
}

/** 取 `alysia:memory` context provider 当前会渲染出的文本 */
const ctxText = (ctx: any): string => ctx.systemPrompt.context.mock.calls[0][0].text({});

describe('alysia-adapter 插件', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('导出 cordis 插件名', () => {
    expect(name).toBe('alysia-adapter')
  })

  // ★ 2026-10-01：本插件**不再注册 persona section**。
  //   人设改由 `cordis.patch.yml` 的 preset 声明挂 `@deepseek-ai/dsh-persona`
  //   （原因见 src/index.ts 的注释：section 名在 dsh 0.2 已变，且要同时遮蔽 suffix）。
  //   这条断言是**反向守卫**：防止有人"顺手"把 section 加回来 ——
  //   那会与 dsh-persona 双重注册同一个人设。
  it('★ 不注册 persona section（人设归 @deepseek-ai/dsh-persona）', () => {
    const { ctx, section } = makeMockCtx()
    apply(ctx)
    expect(section).not.toHaveBeenCalled()
  })

  it('apply 注册记忆 context 骨架(alysia:memory)', () => {
    const { ctx, context } = makeMockCtx()
    apply(ctx)
    expect(context).toHaveBeenCalledTimes(1)
    const input = context.mock.calls[0][0]
    expect(input.name).toBe('alysia:memory')
    // 一期 provider 返回空字符串(空 text 不渲染)
    expect(input.text({})).toBe('')
  })

  it('apply 注册生活事件 variable(alysia_life)', () => {
    const { ctx, variable } = makeMockCtx()
    apply(ctx)
    expect(variable).toHaveBeenCalledTimes(1)
    expect(variable.mock.calls[0][0]).toBe('alysia_life')
    expect(variable.mock.calls[0][1]({})).toBeUndefined()
  })

  // ★ 反向守卫：人设变量**必须**由 host 行注册，不能落回 preset 插件。
  //   preset 插件要等 preset 被选中才挂载，与 persona 模板的渲染时序绑在一起
  //   有硬失败风险（未知模板变量 → throw，会话发不出请求）。见 src/persona-variable.ts。
  it('★ 不在 preset 插件里注册 alysia_persona（那是 host 行的职责）', () => {
    const { ctx, variable } = makeMockCtx()
    apply(ctx)
    expect(variable.mock.calls.map(c => c[0])).not.toContain(PERSONA_VARIABLE)
  })

  it('apply 注册 recall_memory 工具(带 output 硬约束)', () => {
    const { ctx, register } = makeMockCtx()
    apply(ctx)
    expect(register).toHaveBeenCalledTimes(1)
    const tool = register.mock.calls[0][0]
    expect(tool.name).toBe('recall_memory')
    expect(tool.output).toBeDefined()
    expect(typeof tool.output.schema).toBe('object')
    expect(typeof tool.output.render).toBe('function')
    expect(typeof tool.execute).toBe('function')
  })

  it('apply 监听 session/event 与 session/disposed', () => {
    const { ctx, on } = makeMockCtx()
    apply(ctx)
    expect(on).toHaveBeenCalledTimes(2)
    expect(on.mock.calls[0][0]).toBe('session/event')
    expect(on.mock.calls[1][0]).toBe('session/disposed')
  })

  it('user/message 事件触发日志(ingest hook 链路可证)', () => {
    const { ctx, logger, on } = makeMockCtx()
    apply(ctx)
    const listener = on.mock.calls[0][1] as (session: unknown, event: { type: string; data: unknown }) => void
    listener(null, { type: 'user/message', data: { content: [{ type: 'text', text: '早上好' }] } })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('session/event user/message'))
  })
})

describe('recall_memory 工具（真实接口，change: bridge-memory-read）', () => {
  const signal = () => ({ signal: new AbortController().signal })

  function applyAndGetTool() {
    const { ctx, register } = makeMockCtx()
    apply(ctx)
    return register.mock.calls[0][0]
  }

  /** 让 /api/memory/read 返回指定的召回 */
  function stubRead(retrieved: Array<{ text: string }>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ context: 'ctx', retrieved: retrieved.map((r, i) => ({ id: `m${i}`, score: 0.9, text: r.text, metadata: {} })) }),
    })) as never;
    return () => { globalThis.fetch = original; };
  }

  it('★ execute 打真实接口，把召回文本回给模型', async () => {
    const restore = stubRead([{ text: '用户养了只叫团子的猫' }, { text: '用户是后端工程师' }]);
    try {
      const result = await applyAndGetTool().execute({ query: '猫' }, signal()) as { memories: string[] };
      expect(result.memories).toEqual(['用户养了只叫团子的猫', '用户是后端工程师']);
    } finally { restore(); }
  })

  it('召回为空 → 如实说「没找到」，不编', async () => {
    const restore = stubRead([]);
    try {
      const result = await applyAndGetTool().execute({ query: '不存在的事' }, signal()) as { memories: string[]; note?: string };
      expect(result.memories).toEqual([]);
      expect(result.note).toContain('没找到');
    } finally { restore(); }
  });

  it('★ 服务不可达 → 返回 note 而不是抛（她只是想回忆点事，不该让整轮工具调用失败）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('fetch failed'); }) as never;
    try {
      const result = await applyAndGetTool().execute({ query: 'x' }, signal()) as { memories: string[]; note?: string };
      expect(result.memories).toEqual([]);
      expect(result.note).toContain('不可达');
    } finally { globalThis.fetch = original; }
  });

  it('query 为空 → 直接返回，不打接口', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ context: '', retrieved: [] }) }));
    const original = globalThis.fetch;
    globalThis.fetch = spy as never;
    try {
      const tool = applyAndGetTool();
      // ⚠️ 挂载时的**记忆预热**会打一次 fetch —— 基线要在它之后取
      const before = spy.mock.calls.length;
      const result = await tool.execute({ query: '   ' }, signal()) as { note?: string };
      expect(result.note).toContain('query 为空');
      expect(spy.mock.calls.length, 'execute 不该发请求').toBe(before);
    } finally { globalThis.fetch = original; }
  });

  it('★ 已取消（signal.aborted）→ 不打接口', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ context: '', retrieved: [] }) }));
    const original = globalThis.fetch;
    globalThis.fetch = spy as never;
    try {
      const tool = applyAndGetTool();
      const before = spy.mock.calls.length;   // 同上：基线的基准是预热之后
      const ac = new AbortController(); ac.abort();
      const result = await tool.execute({ query: 'x' }, { signal: ac.signal }) as { note?: string };
      expect(result.note).toContain('取消');
      expect(spy.mock.calls.length, '已取消不该发请求').toBe(before);
    } finally { globalThis.fetch = original; }
  });

  it('render：空记忆输出占位文本，有记忆则逐条列出', () => {
    const tool = applyAndGetTool();
    const empty = tool.output.render({ query: 'x' }, { memories: [], note: 'n/a' });
    expect(empty[0].type).toBe('text');
    expect(empty[0].text).toContain('没有找到相关记忆');

    const some = tool.output.render({ query: 'x' }, { memories: ['A', 'B'] });
    expect(some[0].text).toContain('1. A');
    expect(some[0].text).toContain('2. B');
  });
})

// ─────────────────────────────────────────────────────────────
// 记忆回传通道（change: connect-dsh-alysia-bridge）
// ─────────────────────────────────────────────────────────────

/** 用一个假 session 对象触发（真实形状：Session 实例，自带 id getter） */
const SESSION = { id: 'sess-abc' }

/**
 * ★ 事件形状**按 dsh 源码实测**（不是猜的）：
 *   `session.append('assistant/message', { turn, step, message: createAssistantMessage(...) })`
 *   → 文本在 **`data.message.content`**，块为 `{type:'text', text}`。
 *   （曾经误写成 `data.content`，后果是每条都取到空串 → 回传静默变成「一条都没发」。）
 */
const msg = (seq: number, type: string, text: string) => [
  SESSION,
  { seq, type, time: 1767225600000, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text }] } } },
] as const

/**
 * 记录 fetch 调用并返回指定的结果。
 *
 * ★ 按端点分类返回：挂载时**记忆预热**会打 `/api/memory/read`，
 *   若不分流，它会混进回传断言里（「回传了几条」变成「回传+预热共几次」）。
 */
function stubFetch(result: unknown = { ok: true, accepted: 99, rejected: [] }) {
  const calls: Array<{ url: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string, init: any) => {
    const url = String(u);
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    // 记忆检索走不同响应形状（{context, retrieved}）
    const payload = url.includes('/api/memory/read') ? { context: '', retrieved: [] } : result;
    return { ok: true, status: 200, json: async () => payload, text: async () => '' };
  }) as never;
  const pick = (part: string) => calls.filter(c => c.url.includes(part));
  return {
    calls,
    /** 只看回传（排除预热/刷新的 memory/read） */
    get ingestCalls() { return pick('/api/ingest'); },
    get readCalls() { return pick('/api/memory/read'); },
    restore: () => { globalThis.fetch = original; },
  };
}

describe('记忆回传 / 累积与时机', () => {
  it('★ turn/end 才回传（批量，不是每条一发）', async () => {
    const { ctx, emit } = makeMockCtx();
    const f = stubFetch({ ok: true, accepted: 2, rejected: [] });
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', ...msg(1, 'user/message', '你好'));
      emit('session/event', ...msg(2, 'assistant/message', '嗯，我在。'));
      expect(f.ingestCalls).toHaveLength(0); // 还没到 turn/end，一条都没发
      emit('session/event', ...msg(3, 'turn/end', ''));
      await new Promise(r => setTimeout(r, 20));
      expect(f.ingestCalls).toHaveLength(1);
      expect(f.ingestCalls[0].body.events).toHaveLength(2);
    } finally { f.restore(); }
  });

  it('★ 事件形状符合 server 契约（session 前缀 / role / 去重键）', async () => {
    const { ctx, emit } = makeMockCtx();
    const f = stubFetch();
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', ...msg(7, 'user/message', '  有点空格  '));
      emit('session/event', ...msg(8, 'turn/end', ''));
      await new Promise(r => setTimeout(r, 20));
      const e = f.ingestCalls[0].body.events[0];
      expect(e.session_id).toBe('dsh:sess-abc');   // 前缀 = 来源标记 + 安全边界
      // ★ 'code' 而非 'chat'：EventSource 已有 'code'，且 RealtimeProcessor 按它
      //   分流世界书 scope（标错会让 chat-scope 条目在编程对话里误触发）
      expect(e.source).toBe('code');
      expect(e.type).toBe('message');
      expect(e.payload).toEqual({ role: 'user', content: '有点空格' }); // 已 trim
      expect(e.id).toBe('dsh-sess-abc-7');         // 去重键 = 会话+seq（重传不产生两条）
      expect(Number.isNaN(Date.parse(e.created_at))).toBe(false);
    } finally { f.restore(); }
  });

  it('空消息不入队（图片/工具结果那种没有文本块的）', async () => {
    const { ctx, emit } = makeMockCtx();
    const f = stubFetch();
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', SESSION, { seq: 1, type: 'user/message', time: 1, data: { content: [{ type: 'image' }] } });
      emit('session/event', ...msg(2, 'turn/end', ''));
      await new Promise(r => setTimeout(r, 20));
      expect(f.ingestCalls).toHaveLength(0); // 空批次不发请求
    } finally { f.restore(); }
  });

  it('★ session/disposed → 先发尾巴，再触发结算', async () => {
    const { ctx, emit } = makeMockCtx();
    const f = stubFetch({ ok: true, accepted: 1, rejected: [] });
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', ...msg(1, 'user/message', '没走 turn/end 就关了'));
      emit('session/disposed', SESSION);
      await new Promise(r => setTimeout(r, 30));
      const urls = f.calls.map(c => c.url);
      expect(urls.some(u => u.includes('/api/ingest'))).toBe(true);
      // 结算复用 server 现成的 extract（= sessionEndProcessor.process()）
      expect(urls.some(u => u.includes('/api/sessions/dsh%3Asess-abc/extract'))).toBe(true);
      // 顺序：先回传，后结算（尾巴没进去就结算，那段话就丢了）
      expect(urls.findIndex(u => u.includes('ingest')))
        .toBeLessThan(urls.findIndex(u => u.includes('extract')));
    } finally { f.restore(); }
  });
});

describe('记忆回传 / ★ alysia 不可达时 dsh 不受影响', () => {
  it('回传失败不抛（会话照常跑）', async () => {
    const { ctx, emit } = makeMockCtx();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('fetch failed'); }) as never;
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      expect(() => {
        emit('session/event', ...msg(1, 'user/message', 'hi'));
        emit('session/event', ...msg(2, 'turn/end', ''));
        emit('session/disposed', SESSION);
      }).not.toThrow();
      await new Promise(r => setTimeout(r, 30));
    } finally { globalThis.fetch = original; }
  });

  it('失败后事件暂存，下次成功时补发（容忍 alysia 短暂重启）', async () => {
    const { ctx, emit } = makeMockCtx();
    let fail = true;
    const calls: any[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: any) => {
      if (fail) throw new Error('fetch failed');
      calls.push(init?.body ? JSON.parse(init.body) : null);
      return { ok: true, json: async () => ({ ok: true, accepted: 1, rejected: [] }) };
    }) as never;
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', ...msg(1, 'user/message', '离线期间说的'));
      emit('session/event', ...msg(2, 'turn/end', ''));
      await new Promise(r => setTimeout(r, 20));
      expect(calls).toHaveLength(0);           // 第一次失败

      fail = false;
      emit('session/event', ...msg(3, 'user/message', '恢复后说的'));
      emit('session/event', ...msg(4, 'turn/end', ''));
      await new Promise(r => setTimeout(r, 20));
      const sent = calls.filter((b: any) => b?.events)[0].events.map((e: any) => e.payload.content);
      expect(sent).toContain('离线期间说的');  // 补发了
      expect(sent).toContain('恢复后说的');
    } finally { globalThis.fetch = original; }
  });

  it('bridge=false 时不注册任何会话钩子（完全不碰网络）', () => {
    const { ctx, on } = makeMockCtx();
    apply(ctx, { bridge: false });
    expect(on).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// ★ 子 agent 会话过滤（change: exclude-subagent-sessions-from-bridge）
// ─────────────────────────────────────────────────────────────

/**
 * 子 agent 会话的假 session —— **按 dsh 源码的真实形状**：
 * 子会话有自己的 `header.id`（裸 randomUUID），且 `header.origin === 'subagent'`
 * （dsh `packages/core/session/src/types.ts:85`，持久化字段，resume 后也在）。
 */
const SUBAGENT_ID = '3f2a1b4c-9d0e-4f11-8a22-bb33cc44dd55'
const SUBAGENT_SESSION = {
  id: SUBAGENT_ID,
  header: { id: SUBAGENT_ID, origin: 'subagent' },
}

/** 子会话的事件形状与主会话相同，只是 session 不同 */
const subMsg = (seq: number, type: string, text: string) => [
  SUBAGENT_SESSION,
  { seq, type, time: 1767225600000, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text }] } } },
] as const

describe('★ 子 agent 会话过滤（2026-10-02）', () => {
  it('子会话的消息不入队、不回传（user/assistant/turn-end 全跳过）', async () => {
    // 为什么：preset standing mount 被父子 agent 共享，scoped 监听**会**收到子会话事件。
    // 子会话内容是执行过程（任务书/工具输出/审计报告），回传会污染人格与画像。
    const { ctx, emit } = makeMockCtx();
    const f = stubFetch();
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', ...subMsg(1, 'user/message', '子 agent 的任务书'));
      emit('session/event', ...subMsg(2, 'assistant/message', '子 agent 的过程输出'));
      emit('session/event', ...subMsg(3, 'turn/end', ''));
      await new Promise(r => setTimeout(r, 20));
      expect(f.ingestCalls).toHaveLength(0);
    } finally { f.restore(); }
  });

  it('★ 子会话 disposed → 既不回传也不结算（不生成摘要/画像/人格提取）', async () => {
    const { ctx, emit } = makeMockCtx();
    const f = stubFetch();
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', ...subMsg(1, 'user/message', 'x'));
      emit('session/disposed', SUBAGENT_SESSION);
      await new Promise(r => setTimeout(r, 30));
      expect(f.ingestCalls).toHaveLength(0);
      expect(f.calls.some(c => c.url.includes('/extract')), '子会话不该触发结算').toBe(false);
    } finally { f.restore(); }
  });

  it('★ 跳过可观测：子会话首次出现打一行 info，同一会话只提示一次', () => {
    // 静默丢弃会让「子 agent 没进来」和「回传坏了」在日志里长得一样。
    const { ctx, emit, logger } = makeMockCtx();
    const f = stubFetch();
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', ...subMsg(1, 'user/message', 'a'));
      emit('session/event', ...subMsg(2, 'user/message', 'b'));
      emit('session/disposed', SUBAGENT_SESSION);
      const hits = logger.info.mock.calls.filter((c: unknown[]) => String(c[0]).includes('跳过子 agent 会话'));
      expect(hits, '每个子会话应恰好提示一次').toHaveLength(1);
      expect(String(hits[0][0])).toContain('origin=subagent');
    } finally { f.restore(); }
  });

  it('★ 子会话不影响同实例的主会话：主会话照常回传', async () => {
    // 一个插件实例可能同时服务主/子会话（standing mount 共享）——过滤必须逐会话生效。
    const { ctx, emit } = makeMockCtx();
    const f = stubFetch({ ok: true, accepted: 1, rejected: [] });
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      emit('session/event', ...subMsg(1, 'user/message', '子 agent 的'));
      emit('session/event', ...msg(1, 'user/message', '主会话的'));
      emit('session/event', ...msg(2, 'turn/end', ''));
      await new Promise(r => setTimeout(r, 20));
      expect(f.ingestCalls).toHaveLength(1);
      expect(f.ingestCalls[0].body.events.map((e: { payload: { content: string } }) => e.payload.content))
        .toEqual(['主会话的']);
    } finally { f.restore(); }
  });
});

// ─────────────────────────────────────────────────────────────
// 记忆读通道（change: bridge-memory-read）
// ─────────────────────────────────────────────────────────────

describe('记忆 context / 缓存与预热', () => {
  /** 记忆接口返回指定 context；记录每次查询 */
  function stubMemory(contexts: string[]) {
    const queries: string[] = [];
    const original = globalThis.fetch;
    let i = 0;
    globalThis.fetch = (async (_u: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      queries.push(body.query ?? '');
      const ctx = contexts[Math.min(i++, contexts.length - 1)] ?? '';
      return { ok: true, status: 200, text: async () => '', json: async () => ({ context: ctx, retrieved: [] }) };
    }) as never;
    return { queries, restore: () => { globalThis.fetch = original; } };
  }

  it('★ 挂载时预热一次（query 为空）—— 第一轮就有记忆，而不是第二轮才想起你是谁', async () => {
    const f = stubMemory(['【关于你】用户是后端工程师']);
    try {
      const { ctx } = makeMockCtx();
      (await freshApply())(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1', prewarmReuseMs: 0 });
      await new Promise(r => setTimeout(r, 20));
      expect(f.queries[0]).toBe('');                                   // 预热：空 query
      expect(ctxText(ctx)).toContain('用户是后端工程师');               // 第一轮就能拿到
    } finally { f.restore(); }
  });

  it('★ 用户消息到达后用**原话**刷新（话题相关），provider 给到新值', async () => {
    const f = stubMemory(['预热内容', '【相关记忆】团子是一只橘猫']);
    try {
      const { ctx, emit } = makeMockCtx();
      (await freshApply())(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1', prewarmReuseMs: 0 });
      await new Promise(r => setTimeout(r, 20));
      expect(ctxText(ctx)).toContain('预热内容');   // 尾部还有一句 recall_memory 引导

      emit('session/event', SESSION, { seq: 1, type: 'user/message', time: 1, data: { message: { content: [{ type: 'text', text: '我家猫最近怎么样' }] } } });
      await new Promise(r => setTimeout(r, 20));
      expect(f.queries[1]).toBe('我家猫最近怎么样');                     // 用原话当 query
      expect(ctxText(ctx)).toContain('团子是一只橘猫');                  // provider 拿到新值
    } finally { f.restore(); }
  });

  it('★ 刷新失败保留旧值（provider 同步返回，宁可旧不可空/抛）', async () => {
    const original = globalThis.fetch;
    let fail = false;
    globalThis.fetch = (async () => {
      if (fail) throw new Error('fetch failed');
      return { ok: true, json: async () => ({ context: '好使时的内容', retrieved: [] }) };
    }) as never;
    try {
      const { ctx, emit } = makeMockCtx();
      (await freshApply())(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1', prewarmReuseMs: 0 });
      await new Promise(r => setTimeout(r, 20));
      expect(ctxText(ctx)).toContain('好使时的内容');

      fail = true;
      emit('session/event', SESSION, { seq: 1, type: 'user/message', time: 1, data: { message: { content: [{ type: 'text', text: 'x' }] } } });
      await new Promise(r => setTimeout(r, 20));
      expect(ctxText(ctx), '失败不该清空缓存').toContain('好使时的内容');
    } finally { globalThis.fetch = original; }
  });

  it('bridge=false 时不预热、不刷新（只留 recall_memory 工具）', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ context: 'x', retrieved: [] }) }));
    const original = globalThis.fetch;
    globalThis.fetch = spy as never;
    try {
      const { ctx } = makeMockCtx();
      (await freshApply())(ctx, { bridge: false });
      await new Promise(r => setTimeout(r, 20));
      expect(spy).not.toHaveBeenCalled();
      expect(ctxText(ctx)).toBe('');
    } finally { globalThis.fetch = original; }
  });
});

describe('记忆预热 / ★ 多实例共享（2026-10-02 修复）', () => {
  it('同进程挂 N 个实例 → 预热只发一次请求', async () => {
    // 桌面端启动会**恢复多个会话**，每个会话挂一个插件实例。
    // 实测一次启动打了 **9 次** /api/memory/read（9 次 HTTP + 9 次 embedding）。
    // 预热用空 query，结果与会话无关 → 一个进程共享一次就够。
    const queries: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: any) => {
      queries.push(init?.body ? JSON.parse(init.body).query ?? '' : '');
      return { ok: true, status: 200, text: async () => '', json: async () => ({ context: '共享的预热结果', retrieved: [] }) };
    }) as never;
    try {
      const before = queries.length;
      const mount = await freshApply();      // 同一个模块实例 → 共享预热缓存
      const contexts: any[] = [];
      for (let i = 0; i < 5; i++) {
        const { ctx } = makeMockCtx();
        mount(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });   // 用默认 30s 窗口
        contexts.push(ctx);
      }
      await new Promise(r => setTimeout(r, 40));

      const newEmptyQueries = queries.slice(before).filter(q => q === '');
      expect(newEmptyQueries.length, `5 个实例打了 ${newEmptyQueries.length} 次预热（应为 0 或 1）`).toBeLessThanOrEqual(1);

      // 每个实例都拿到了结果（共享的是**数据**，不是实例状态）
      for (const ctx of contexts) expect(ctxText(ctx)).toContain('共享的预热结果');
    } finally { globalThis.fetch = original; }
  });

  it('★ 去重是**两层**：并发去重（in-flight）+ 窗口缓存', async () => {
    // 这个区分很重要，写错了会以为「窗口没用」或「窗口是永久缓存」：
    //   ① **in-flight 去重**：同一 tick 内的多个挂载，第一个的请求还在飞，
    //      后几个直接复用同一个 promise —— **窗口设 0 也一样只发一次**。
    //      启动那一波（9 个实例几乎同时挂载）就是被这一层消掉的。
    //   ② **窗口缓存**：挂载之间**隔了足够久**（首个请求已完成）才起作用，
    //      避免几分钟内新挂载的实例又去拉一遍。
    const queries: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: any) => {
      queries.push(init?.body ? JSON.parse(init.body).query ?? '' : '');
      return { ok: true, status: 200, text: async () => '', json: async () => ({ context: 'x', retrieved: [] }) };
    }) as never;
    try {
      const mount = await freshApply();
      const empty = () => queries.filter(q => q === '').length;

      // ① 同一 tick 挂 3 个 → in-flight 去重 → 只 1 次（与窗口无关）
      const before = empty();
      for (let i = 0; i < 3; i++) mount(makeMockCtx().ctx, { alysiaBaseUrl: 'http://127.0.0.1:1', prewarmReuseMs: 0 });
      await new Promise(r => setTimeout(r, 40));
      expect(empty() - before, '同一 tick 的多个挂载应被 in-flight 去重').toBe(1);

      // ② 隔开时间、窗口设 0 → 第二次挂载确实重新拉（窗口不是永久缓存）
      const before2 = empty();
      mount(makeMockCtx().ctx, { alysiaBaseUrl: 'http://127.0.0.1:1', prewarmReuseMs: 0 });
      await new Promise(r => setTimeout(r, 40));
      expect(empty() - before2, '窗口=0 时应重新拉').toBe(1);

      // ③ 同样隔开时间、但用默认 30s 窗口 → 复用缓存，不再发请求
      const before3 = empty();
      mount(makeMockCtx().ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' });
      await new Promise(r => setTimeout(r, 40));
      expect(empty() - before3, '窗口内应复用缓存').toBe(0);
    } finally { globalThis.fetch = original; }
  });
});

describe('★ recall_memory 的主动引导（2026-10-02）', () => {
  /** 记忆接口返回指定 context（本 describe 专用；另一个同名 stub 在别的块里） */
  function stubMemory(contexts: string[]) {
    let i = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ context: contexts[Math.min(i++, contexts.length - 1)] ?? '', retrieved: [] }),
    })) as never;
    return { restore: () => { globalThis.fetch = original; } };
  }

  it('记忆 context 末尾带「可以主动查」的提示', async () => {
    // 为什么加在 context 而不是只改工具描述：**这段文本是她每轮真正看到的**，
    // 而工具描述躺在工具目录里、不主动提示就去不到。
    const f = stubMemory(['【关于你】用户是后端工程师']);
    try {
      const { ctx } = makeMockCtx();
      (await freshApply())(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1', prewarmReuseMs: 0 });
      await new Promise(r => setTimeout(r, 20));
      const text = ctxText(ctx);
      expect(text).toContain('用户是后端工程师');      // 原文还在
      expect(text, '缺了引导提示').toContain('recall_memory');
      expect(text).toMatch(/以上是自动带上的记忆概览/);
    } finally { f.restore(); }
  });

  it('★ context 为空时**不加**提示（alysia 没起，提示她去查等于白跑一趟）', async () => {
    const f = stubMemory(['']);   // 服务返回空 context
    try {
      const { ctx } = makeMockCtx();
      (await freshApply())(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1', prewarmReuseMs: 0 });
      await new Promise(r => setTimeout(r, 20));
      expect(ctxText(ctx)).toBe('');
    } finally { f.restore(); }
  });

  it('工具描述是**主动引导**（不是「何时可以调」的被动说明）', () => {
    const { ctx, register } = makeMockCtx();
    apply(ctx);
    const desc = (register.mock.calls[0][0] as { description: string }).description;
    expect(desc).toContain('主动查');
    expect(desc, '要讲清自动带上的只是概览').toMatch(/概览/);
    expect(desc, '要点名触发场景').toContain('你还记得吗');
  });
});
