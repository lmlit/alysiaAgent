/**
 * `IngestDelivery` 队列单测 —— 契约 1/2/3/4 的边界。
 *
 * ★ 为什么这些必须在**模块级**测而不是端到端：它们是队列自己的不变量
 *   （在途可见性、上限丢弃、卡死告警的补报节奏），端到端只能看到
 *   「最后发出去了没有」，看不到「有没有重复发」「告警还在不在」。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  IngestDelivery,
  SERVER_MAX_INGEST_BATCH,
  DEFAULT_MAX_PENDING,
} from '../src/delivery.ts'
import type { IngestEvent, IngestOutcome } from '../src/alysia-client.ts'

const ev = (id: string): IngestEvent => ({
  id,
  session_id: 'dsh:s',
  source: 'code',
  type: 'message',
  payload: { role: 'user', content: id },
  created_at: '2026-10-16T00:00:00.000Z',
})

const quiet = () => ({ info: vi.fn(), warn: vi.fn() })
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

const ok = (n: number): IngestOutcome => ({ kind: 'ok', accepted: n, rejected: [] })

describe('IngestDelivery — 契约 1 分批', () => {
  it('★ 与服务端上限对齐：默认单批就是 200（漂移由两端测试钉住）', () => {
    expect(SERVER_MAX_INGEST_BATCH).toBe(200)
  })

  it('★ 201 条 → 分成 [200, 1]，一条不丢', async () => {
    const sent: number[] = []
    const logger = quiet()
    const d = new IngestDelivery({
      logger,
      send: async (b) => { sent.push(b.length); return ok(b.length) },
    })
    for (let i = 0; i < 201; i++) d.enqueue(ev(`e${i}`))

    const r = await d.drain()
    expect(r).toEqual({ drained: true, remaining: 0 })
    expect(sent).toEqual([200, 1])
    expect(d.stats().accepted).toBe(201)
  })

  it('★ 500 条（= 队列上限）→ 每批都不超上限，且能排空', async () => {
    const sent: number[] = []
    const d = new IngestDelivery({ logger: quiet(), send: async (b) => { sent.push(b.length); return ok(b.length) } })
    for (let i = 0; i < DEFAULT_MAX_PENDING; i++) d.enqueue(ev(`e${i}`))

    await d.drain()
    expect(Math.max(...sent)).toBeLessThanOrEqual(SERVER_MAX_INGEST_BATCH)
    expect(sent.reduce((a, b) => a + b, 0)).toBe(500)
    expect(d.queued).toBe(0)
  })
})

describe('IngestDelivery — 契约 2 串行化（KI-24 的根）', () => {
  it('★ 在途批次对后来者可见：drain() 返回的链覆盖在途那批', async () => {
    const sent: string[] = []
    let release: (() => void) | null = null
    let blockFirst = true
    const d = new IngestDelivery({
      logger: quiet(),
      send: async (b) => {
        sent.push(...b.map((e) => e.id))
        if (blockFirst) {
          blockFirst = false
          await new Promise<void>((r) => { release = r })   // 模拟「响应还没回来」
        }
        return ok(b.length)
      },
    })

    d.enqueue(ev('1'))
    const p1 = d.drain()
    await tick()
    expect(sent, '第一批已发出但未确认').toEqual(['1'])

    // 第一批还在飞时入队并再次触发（真实场景：turn/end 在飞时 session/disposed）
    d.enqueue(ev('2'))
    const p2 = d.drain()

    release!()
    const r2 = await p2
    // ★ 这条是 KI-24 的队列级不变量：await 到 drain() = 「连在途那批也已确认」
    expect(r2).toEqual({ drained: true, remaining: 0 })
    expect(sent).toEqual(['1', '2'])            // 都发了
    expect(d.queued).toBe(0)
    await p1
  })

  it('空队列 drain 不发请求（但仍是可 await 的链）', async () => {
    const send = vi.fn(async (b: IngestEvent[]) => ok(b.length))
    const d = new IngestDelivery({ logger: quiet(), send })
    await expect(d.drain()).resolves.toEqual({ drained: true, remaining: 0 })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('IngestDelivery — 契约 3 故障分类', () => {
  it('★ 可重试失败：批次**留在**队列等下次（不丢）', async () => {
    const d = new IngestDelivery({
      logger: quiet(),
      send: async () => ({ kind: 'unreachable', reason: 'ECONNREFUSED' }),
    })
    d.enqueue(ev('1'))
    const r = await d.drain()
    expect(r).toEqual({ drained: false, remaining: 1 })
    expect(d.queued).toBe(1)
  })

  it('★ 永久拒收：丢弃该批但**继续**排空其余（不阻塞合法事件）', async () => {
    const sentBatches: string[][] = []
    const logger = quiet()
    const d = new IngestDelivery({
      logger,
      maxBatch: 2,
      send: async (b) => {
        sentBatches.push(b.map((e) => e.id))
        return sentBatches.length === 1
          ? { kind: 'permanent', reason: 'HTTP 413: 单批最多 200 条' }
          : ok(b.length)
      },
    })
    for (const id of ['1', '2', '3', '4']) d.enqueue(ev(id))

    const r = await d.drain()
    expect(sentBatches).toEqual([['1', '2'], ['3', '4']])
    expect(r.drained).toBe(true)
    expect(d.stats().permanentlyRejected).toBe(2)
    expect(d.stats().accepted).toBe(2)
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/永久拒收/)
  })

  it('★ 永久拒收后**不再**重发同一批（旧实现会无限重复同一个 4xx）', async () => {
    const send = vi.fn(async () => ({ kind: 'permanent', reason: 'HTTP 400' }) as IngestOutcome)
    const d = new IngestDelivery({ logger: quiet(), send })
    d.enqueue(ev('1'))

    await d.drain()
    await d.drain()
    await d.drain()
    expect(send, '永久拒收的批次被重发').toHaveBeenCalledTimes(1)
    expect(d.queued).toBe(0)
  })

  it('`send` 违约抛出 → 兜成「可重试」，不炸队列、不卡死', async () => {
    const d = new IngestDelivery({
      logger: quiet(),
      send: async () => { throw new Error('不该抛的 send') },
    })
    d.enqueue(ev('1'))
    const r = await d.drain()
    expect(r).toEqual({ drained: false, remaining: 1 })
    expect(d.stats().lastFailure).toContain('不该抛的 send')
  })
})

describe('IngestDelivery — 契约 4 不静默丢弃', () => {
  it('★ 超上限丢最旧，且**必须留痕**', async () => {
    const logger = quiet()
    const d = new IngestDelivery({ logger, maxPending: 3, send: async (b) => ok(b.length) })
    for (const id of ['1', '2', '3', '4', '5']) d.enqueue(ev(id))

    expect(d.stats().dropped).toBe(2)
    expect(d.queued).toBe(3)
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warned).toMatch(/丢弃最旧/)
    expect(warned).toContain('累计丢弃 1')
  })

  it('★ 丢弃的**真实总数**会在下次成功排空时补报（否则最后一条日志少报）', async () => {
    // 逐条打会刷屏，所以只在进入丢弃状态时报一次；但那条日志停在「累计丢弃 1」，
    // 若不作补报，读者会以为只丢了 1 条 —— 而实际丢了 2 条。
    const logger = quiet()
    const d = new IngestDelivery({ logger, maxPending: 3, send: async (b) => ok(b.length) })
    for (const id of ['1', '2', '3', '4', '5']) d.enqueue(ev(id))
    await d.drain()

    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warned, '补报里必须出现真实总数 2').toMatch(/累计丢弃 2 条/)
  })

  it('★ 卡死告警**不受**失败降噪影响，且持续可见（进入时 + 每 20 次补报）', async () => {
    // 背景：`AlysiaClient.noteFailure` 连续失败 3 次后就闭嘴。队列**永久卡死**属
    // **状态**告警，不能跟着一起静默 —— 那正是本项目反复栽的「静默掩盖」。
    const logger = quiet()
    const d = new IngestDelivery({
      logger,
      send: async () => ({ kind: 'unreachable', reason: 'fetch failed' }),
    })
    d.enqueue(ev('1'))

    for (let i = 0; i < 21; i++) await d.drain()

    const stuckWarns = logger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('回传受阻'))
    expect(stuckWarns.length, '21 次卡死排空只应报 2 次（进入 + 第 20 次补报）').toBe(2)
  })

  it('恢复后打一行 info（卡死结束要可观测）', async () => {
    const logger = quiet()
    let fail = true
    const d = new IngestDelivery({
      logger,
      send: async (b) => (fail ? { kind: 'unreachable', reason: 'down' } : ok(b.length)),
    })
    d.enqueue(ev('1'))
    await d.drain()
    fail = false
    await d.drain()
    expect(logger.info.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/回传已恢复/)
  })

  it('stats() 如实反映各类计数（诊断入口）', async () => {
    const d = new IngestDelivery({
      logger: quiet(),
      send: async (b) => ({ kind: 'ok', accepted: b.length - 1, rejected: ['x: 坏'] }),
    })
    d.enqueue(ev('1'))
    d.enqueue(ev('2'))
    await d.drain()
    expect(d.stats()).toMatchObject({ queued: 0, accepted: 1, rejectedEvents: 1, passes: 1 })
  })
})
