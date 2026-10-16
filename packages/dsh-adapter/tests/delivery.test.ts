/**
 * 投递与结算契约测试 —— change: `fix-dsh-ingest-and-settlement`
 *
 * 覆盖 KI-24（结算抢跑）、KI-23（身份缺失 fail open）与投递可靠性
 * （分批 / 串行化 / 故障分类 / 不静默丢弃）。契约见
 * `openspec/specs/dsh-adapter/spec.md` §2.5.1。
 *
 * ★ 本文件的 mock ctx 与 `index.test.ts` 的同名 helper 一致（有意各自持有，
 *   避免为一处测试改动去动那个 650 行的既有文件）。
 */
import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

function makeMockCtx() {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  const on = vi.fn((type: string, fn: (...a: unknown[]) => void) => {
    handlers.set(type, fn)
    return () => {}
  })
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = {
    systemPrompt: { section: vi.fn(), context: vi.fn(() => () => {}), variable: vi.fn(() => () => {}) },
    tools: { register: vi.fn(() => () => {}) },
    on,
    effect: vi.fn((cb: () => unknown) => { cb(); return () => {} }),
    logger,
  } as unknown as Context
  const emit = (type: string, ...args: unknown[]): void => {
    const h = handlers.get(type)
    if (!h) throw new Error(`没有注册 ${type} 的 handler`)
    h(...args)
  }
  return { ctx, on, logger, emit }
}

const SESSION = { id: 'sess-abc' }
/** 没有 id 也没有 header.id —— 上游契约破损时的形状 */
const NO_ID_SESSION = { header: {} }

const msg = (seq: number, type: string, text: string) => [
  SESSION,
  { seq, type, time: 1767225600000, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text }] } } },
] as const

const noIdMsg = (seq: number, type: string, text: string) => [
  NO_ID_SESSION,
  { seq, type, time: 1767225600000, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text }] } } },
] as const

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** 记录请求，按端点分类。`hangIngest` 为真时 ingest 响应会一直挂到 `releaseIngest()` */
function stubFetch(opts: { ingestResponse?: (n: number) => unknown; hangIngest?: boolean; throwOnIngest?: boolean } = {}) {
  const calls: Array<{ url: string; body: any }> = []
  let release: (() => void) | null = null
  const original = globalThis.fetch
  globalThis.fetch = (async (u: string, init: any) => {
    const url = String(u)
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null })
    const okJson = (payload: unknown) => ({ ok: true, status: 200, text: async () => '', json: async () => payload })

    if (url.includes('/api/memory/read')) return okJson({ context: '', retrieved: [] })
    if (url.includes('/extract')) return okJson({ ok: true })
    if (url.includes('/api/ingest')) {
      const n = (init?.body ? JSON.parse(init.body).events?.length : 0) ?? 0
      if (opts.throwOnIngest) throw new Error('fetch failed')
      if (opts.hangIngest) await new Promise<void>((r) => { release = r })
      const payload = opts.ingestResponse ? opts.ingestResponse(n) : { ok: true, accepted: n, rejected: [] }
      // 允许自定义状态码（如 400/413 的永久拒收路径）
      const status = (payload as { __status?: number })?.__status
      if (status) return { ok: false, status, text: async () => JSON.stringify(payload), json: async () => payload }
      return okJson(payload)
    }
    return okJson({})
  }) as never

  const pick = (part: string) => calls.filter((c) => c.url.includes(part))
  return {
    calls,
    get ingestCalls() { return pick('/api/ingest') },
    get extractCalls() { return pick('/extract') },
    get readCalls() { return pick('/api/memory/read') },
    releaseIngest: () => { release?.(); release = null },
    restore: () => { globalThis.fetch = original },
  }
}

// ─────────────────────────────────────────────────────────────
// T1 分批：队列上限(500) > 服务端单批上限(200)，整批直发必然 413
// ─────────────────────────────────────────────────────────────

describe('T1 分批（复现：整批直发会超过服务端上限）', () => {
  const SERVER_MAX = 200

  it('★ 201 条积压：单次请求不得超过服务端上限', async () => {
    const { ctx, emit } = makeMockCtx()
    const f = stubFetch()
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      for (let i = 0; i < 201; i++) emit('session/event', ...msg(i + 1, 'user/message', `第${i}条`))
      emit('session/event', ...msg(9999, 'turn/end', ''))
      await tick(60)

      const sizes = f.ingestCalls.map((c) => c.body.events.length)
      expect(sizes.length, '201 条应分批发出（当前实现是 1 次直发，故此处会红）').toBeGreaterThan(1)
      expect(Math.max(...sizes), `有请求带了 ${Math.max(...sizes)} 条，超过上限 ${SERVER_MAX}`)
        .toBeLessThanOrEqual(SERVER_MAX)
      expect(sizes.reduce((a, b) => a + b, 0), '一条都不能丢').toBe(201)
    } finally { f.restore() }
  })

  it('★ 500 条积压（= 队列上限）：能排空，且每批不超上限', async () => {
    const { ctx, emit } = makeMockCtx()
    const f = stubFetch()
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      for (let i = 0; i < 500; i++) emit('session/event', ...msg(i + 1, 'user/message', `第${i}条`))
      emit('session/event', ...msg(9999, 'turn/end', ''))
      await tick(80)

      const sizes = f.ingestCalls.map((c) => c.body.events.length)
      expect(Math.max(...sizes)).toBeLessThanOrEqual(SERVER_MAX)
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(500)
    } finally { f.restore() }
  })
})

// ─────────────────────────────────────────────────────────────
// T1 故障分类
// ─────────────────────────────────────────────────────────────

describe('T1 故障分类（复现：4xx 被当可重试 → 同样的输入永远重复同一个 4xx）', () => {
  it('★ 永久拒收（4xx）不进重试队列，且响亮上报', async () => {
    const { ctx, emit, logger } = makeMockCtx()
    const f = stubFetch({ ingestResponse: () => ({ __status: 400, error: 'events 必须是非空数组' }) })
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      emit('session/event', ...msg(1, 'user/message', '会被永久拒收的一条'))
      emit('session/event', ...msg(2, 'turn/end', ''))
      await tick()
      expect(f.ingestCalls).toHaveLength(1)

      // 再触发一次：永久拒收的批次**不该**被重发（旧实现会原样再发一遍）
      emit('session/event', ...msg(3, 'turn/end', ''))
      await tick()
      expect(f.ingestCalls.length, '永久拒收的批次被重发了').toBe(1)

      const warned = logger.warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(warned, '永久拒收必须响亮上报，不能静默').toMatch(/拒收|永久/)
    } finally { f.restore() }
  })

  it('★ 部分成功：已受理的不再重发，被拒的如实上报', async () => {
    const { ctx, emit, logger } = makeMockCtx()
    const f = stubFetch({ ingestResponse: () => ({ ok: true, accepted: 1, rejected: ['dsh-x-2: payload.content 缺失'] }) })
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      emit('session/event', ...msg(1, 'user/message', '合法的一条'))
      emit('session/event', ...msg(2, 'turn/end', ''))
      await tick()
      expect(f.ingestCalls).toHaveLength(1)

      emit('session/event', ...msg(3, 'turn/end', ''))
      await tick()
      expect(f.ingestCalls.length, '已受理的批次不该重发').toBe(1)
      const warned = logger.warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(warned).toContain('payload.content 缺失')
    } finally { f.restore() }
  })
})

// ─────────────────────────────────────────────────────────────
// T2 KI-24 结算等待入库
// ─────────────────────────────────────────────────────────────

describe('T2 KI-24 结算等待入库（复现：回传在飞时 disposed 抢跑结算）', () => {
  it('★ 回传未确认落库前，不许发结算请求', async () => {
    const { ctx, emit } = makeMockCtx()
    const f = stubFetch({ hangIngest: true })
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      emit('session/event', ...msg(1, 'user/message', '最后一轮'))
      emit('session/event', ...msg(2, 'turn/end', ''))
      await tick()
      expect(f.ingestCalls, '先确认回传真的发出去了').toHaveLength(1)

      emit('session/disposed', SESSION)
      await tick()
      expect(f.extractCalls, '回传还在飞就结算了 —— 这一轮会永久进不了摘要').toHaveLength(0)

      f.releaseIngest()
      await tick(60)
      expect(f.extractCalls, '回传确认后应当结算').toHaveLength(1)
    } finally { f.restore() }
  })

  it('★ 回传失败时**不**宣布结算完成（也不无条件继续提取）', async () => {
    const { ctx, emit, logger } = makeMockCtx()
    const f = stubFetch({ throwOnIngest: true })
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      emit('session/event', ...msg(1, 'user/message', '没送出去的一条'))
      emit('session/disposed', SESSION)
      await tick(60)

      // 旧实现：flush 失败也照样 extract ⇒ 迟到事件永久落在窗口之外，
      // 而摘要是 summary_status='ok'，补处理不会捡。
      expect(f.extractCalls, '回传失败却宣布结算完成').toHaveLength(0)
      const warned = logger.warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(warned, '回传失败后必须留下明确痕迹').toMatch(/挂起|未完成/)
      expect(warned, '要把会话写进日志，否则不知道是谁没结算').toContain('dsh:sess-abc')
    } finally { f.restore() }
  })

  it('★ 结算失败有再次入口：回传恢复后自动补做（不依赖「下一次刚好有消息」）', async () => {
    const { ctx, emit } = makeMockCtx()
    let failing = true
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (u: string, init: any) => {
      const url = String(u)
      calls.push(url)
      if (url.includes('/api/memory/read')) {
        return { ok: true, status: 200, text: async () => '', json: async () => ({ context: '', retrieved: [] }) }
      }
      if (url.includes('/api/ingest') && failing) throw new Error('fetch failed')
      if (url.includes('/extract') && failing) return { ok: false, status: 503, text: async () => 'down', json: async () => ({}) }
      return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true, accepted: init?.body ? JSON.parse(init.body).events.length : 0, rejected: [] }) }
    }) as never
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      emit('session/event', ...msg(1, 'user/message', '会挂起的一条'))
      emit('session/disposed', SESSION)
      await tick(60)
      expect(
        calls.filter((u) => u.includes('/extract')).length,
        '回传没成功就**根本不该尝试**结算（契约 5）——更不该宣布完成',
      ).toBe(0)

      // alysia 恢复 → 下一次 turn/end 触发排空成功，并**补做**挂起的结算
      failing = false
      emit('session/event', ...msg(2, 'user/message', '恢复后的一条'))
      emit('session/event', ...msg(3, 'turn/end', ''))
      await tick(80)
      expect(
        calls.filter((u) => u.includes('/extract')).length,
        '挂起的结算没有被补做（再次结算入口失效）',
      ).toBe(1)
    } finally { globalThis.fetch = original }
  })
})

// ─────────────────────────────────────────────────────────────
// T3 KI-23 身份缺失 fail closed
// ─────────────────────────────────────────────────────────────

describe('T3 KI-23 身份缺失（复现：多个会话挤进 dsh:unknown）', () => {
  it('★ 取不到会话 id 时不回传、不结算', async () => {
    const { ctx, emit } = makeMockCtx()
    const f = stubFetch()
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      emit('session/event', ...noIdMsg(1, 'user/message', '身份不明的一条'))
      emit('session/event', ...noIdMsg(2, 'turn/end', ''))
      emit('session/disposed', NO_ID_SESSION)
      await tick(40)

      expect(f.ingestCalls.map((c) => c.body.events[0].session_id), '写进了公共 unknown 桶')
        .not.toContain('dsh:unknown')
      expect(f.ingestCalls).toHaveLength(0)
      expect(f.extractCalls, '身份不明不该触发结算').toHaveLength(0)
    } finally { f.restore() }
  })

  it('★ 诊断限频：坏上游不许把日志刷爆', async () => {
    const { ctx, emit, logger } = makeMockCtx()
    const f = stubFetch()
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      for (let i = 0; i < 50; i++) emit('session/event', ...noIdMsg(i + 1, 'user/message', `无 id 的第${i}条`))
      await tick(40)
      const hits = logger.warn.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((s: string) => /会话 id|no session id|身份/.test(s))
      expect(hits.length, `50 条无 id 事件打了 ${hits.length} 行 warn`).toBeLessThanOrEqual(2)
      expect(hits.length, '至少要喊一次，不能静默').toBeGreaterThan(0)
    } finally { f.restore() }
  })

  it('有 id 的会话照常回传（限频逻辑不误伤正常路径）', async () => {
    const { ctx, emit } = makeMockCtx()
    const f = stubFetch()
    try {
      apply(ctx, { alysiaBaseUrl: 'http://127.0.0.1:1' })
      emit('session/event', ...msg(1, 'user/message', '正常的'))
      emit('session/event', ...msg(2, 'turn/end', ''))
      await tick()
      expect(f.ingestCalls).toHaveLength(1)
      expect(f.ingestCalls[0].body.events[0].session_id).toBe('dsh:sess-abc')
    } finally { f.restore() }
  })
})
