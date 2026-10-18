/**
 * 看门狗的单测（★ 2026-10-19，change: `watch-for-stuck-work`，A2 档）。
 *
 * 用户原话：「他会自己触发看看卡住的进度吗」。
 * 这个文件钉的是"它凭什么觉得自己知道出事了"—— 每一条判据都必须是**系统读数**，
 * 而且**不许误报**（爱喊狼来了的看门狗会让用户直接静音她，比没有更糟）。
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_THRESHOLDS,
  WatchdogService,
  evaluateWatchdogFacts,
  planWatchdogNotifications,
  type WatchdogInput,
} from '../src/watchdog.js'
import type { ProjectTask } from '@alysia/core'

const NOW = Date.parse('2026-10-19T02:00:00Z')

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    taskId: 'pt-0123456789abcdef',
    requestKey: 'k',
    projectId: 'alysia-toys',
    originSessionId: '',
    origin: 'delegated',
    kind: 'build',
    goal: '做一个海岛场景',
    acceptanceCriteria: '',
    dshSessionId: null,
    status: 'running',
    revision: 0,
    result: null,
    artifacts: null,
    attempts: 1,
    lastError: null,
    createdAt: new Date(NOW - 60 * 60000).toISOString(),
    updatedAt: new Date(NOW - 25 * 60000).toISOString(),
    phase: 'build',
    loopState: { rounds: 1, visits: {}, revisions: 0 },
    ...over,
  } as ProjectTask
}

const base = (over: Partial<WatchdogInput> = {}): WatchdogInput => ({
  nowMs: NOW,
  tasks: [],
  counts: {},
  runnerBeatSec: 10,
  site: { ok: true, status: 200, checkedAt: new Date(NOW).toISOString() },
  uptimeSec: 7200,
  ...over,
})

const keys = (inp: WatchdogInput) => evaluateWatchdogFacts(inp, DEFAULT_THRESHOLDS).map(i => i.key)

describe('判据：什么都不该报的时候', () => {
  it('一切正常 ⇒ 零条（不误报）', () => {
    expect(keys(base({ tasks: [task({ status: 'needs_review', updatedAt: new Date(NOW).toISOString() })] }))).toEqual([])
  })

  it('刚跑完一轮的 running 任务（5 分钟）⇒ 不算卡住', () => {
    const t = task({ updatedAt: new Date(NOW - 5 * 60000).toISOString() })
    expect(keys(base({ tasks: [t] }))).toEqual([])
  })

  it('心跳 10 秒 ⇒ 不报 runner', () => {
    expect(keys(base())).toEqual([])
  })
})

describe('判据①：卡住 / 没人开工', () => {
  it('running 25 分钟没动 ⇒ 报 stuck（error 级）', () => {
    const issues = evaluateWatchdogFacts(base({ tasks: [task()] }), DEFAULT_THRESHOLDS)
    expect(issues).toHaveLength(1)
    expect(issues[0].key).toBe(`stuck:${task().taskId}`)
    expect(issues[0].level).toBe('error')
    expect(issues[0].detail).toContain('25 分钟')
  })

  it('queued 25 分钟 ⇒ 报"一直没人开工"（warn 级，因为更可能是 runner 没接活）', () => {
    const issues = evaluateWatchdogFacts(base({ tasks: [task({ status: 'queued' })] }), DEFAULT_THRESHOLDS)
    expect(issues[0].level).toBe('warn')
    expect(issues[0].title).toContain('没人开工')
  })

  it('终态任务再久也不报（needs_review 不是卡住）', () => {
    expect(keys(base({ tasks: [task({ status: 'needs_review', updatedAt: new Date(NOW - 999 * 60000).toISOString() })] }))).toEqual([])
  })
})

describe('判据②：失败/未知', () => {
  it('unknown ⇒ 每轮都列出来（抑制是 service 的职责，不在这里）', () => {
    const t = task({ status: 'unknown', lastError: 'undici 崩了' })
    const first = evaluateWatchdogFacts(base({ tasks: [t] }), DEFAULT_THRESHOLDS)
    expect(first.map(i => i.key)).toEqual([`failed:${t.taskId}`])
    expect(first[0].detail).toContain('undici 崩了')

    // ⚠️ 第二轮**仍然列出**：早先在 evaluator 里按"报过就不再报"跳过，
    //    会让问题从列表消失 ⇒ 被当成"恢复" ⇒ 给用户发一条假的"好了"（真机踩过）。
    const again = evaluateWatchdogFacts(base({ tasks: [t] }), DEFAULT_THRESHOLDS)
    expect(again.map(i => i.key)).toEqual([`failed:${t.taskId}`])
  })
})

describe('判据③：runner 心跳断了', () => {
  it('120 秒没心跳 ⇒ 报（error）', () => {
    const issues = evaluateWatchdogFacts(base({ runnerBeatSec: 120 }), DEFAULT_THRESHOLDS)
    expect(issues.map(i => i.key)).toEqual(['runner-hole'])
    expect(issues[0].detail).toContain('120 秒')
  })

  it('★ 从没收到过心跳（null）⇒ 不报"它挂了"（不知道 ≠ 挂了）', () => {
    expect(keys(base({ runnerBeatSec: null }))).toEqual([])
  })
})

describe('判据④：站点打不开', () => {
  it('503 ⇒ 报 site-down', () => {
    const issues = evaluateWatchdogFacts(
      base({ site: { ok: false, status: 503, checkedAt: '2026-10-19T01:59:00Z' } }),
      DEFAULT_THRESHOLDS,
    )
    expect(issues.map(i => i.key)).toEqual(['site-down'])
    expect(issues[0].detail).toContain('503')
  })

  it('没探过（null）⇒ 不报（没读数 ≠ 坏了）', () => {
    expect(keys(base({ site: null }))).toEqual([])
  })
})

describe('判据⑤：排队堆积', () => {
  const queued = (mins: number) => task({ taskId: `pt-q${mins}`, status: 'queued', updatedAt: new Date(NOW - mins * 60000).toISOString() })

  it('3 件排队 ⇒ 报堆积', () => {
    const issues = evaluateWatchdogFacts(base({ tasks: [queued(5), queued(6), queued(7)] }), DEFAULT_THRESHOLDS)
    expect(issues.map(i => i.key)).toContain('queue-backlog')
  })

  it('1 件但等了 40 分钟 ⇒ 也报', () => {
    expect(keys(base({ tasks: [queued(40)] }))).toContain('queue-backlog')
  })

  it('1 件只等了 5 分钟 ⇒ 不报', () => {
    expect(keys(base({ tasks: [queued(5)] }))).toEqual([])
  })
})

describe('判据⑥：崩溃循环（一小时内重启 ≥3 次）', () => {
  it('重启 3 次 ⇒ 报', () => {
    expect(keys(base({ bootsLastHour: 3 }))).toContain('fresh-restart')
  })
  it('★ 只部署了一次（重启 1 次）⇒ 不报 —— 否则每次部署都发假警报', () => {
    expect(keys(base({ bootsLastHour: 1 }))).toEqual([])
  })
  it('跑了两小时且只启动一次 ⇒ 不报', () => {
    expect(keys(base({ uptimeSec: 7200, bootsLastHour: 1 }))).toEqual([])
  })
})

describe('冷却与恢复', () => {
  const issue = { key: 'site-down' as const, level: 'error' as const, title: 't', detail: 'd' }

  it('★ 同一问题 30 分钟内只说一次（不刷屏）', () => {
    const first = planWatchdogNotifications({
      issues: [issue], nowMs: NOW, lastNotified: new Map(), cooldownMs: 30 * 60000,
      disappeared: [], recoveredAlready: new Set(),
    })
    expect(first.fresh).toHaveLength(1)

    const again = planWatchdogNotifications({
      issues: [issue], nowMs: NOW + 60_000, lastNotified: new Map([['site-down', NOW]]),
      cooldownMs: 30 * 60000, disappeared: [], recoveredAlready: new Set(),
    })
    expect(again.fresh).toEqual([])
  })

  it('冷却过了 ⇒ 再说一次（还坏着就得说）', () => {
    const later = planWatchdogNotifications({
      issues: [issue], nowMs: NOW + 31 * 60000, lastNotified: new Map([['site-down', NOW]]),
      cooldownMs: 30 * 60000, disappeared: [], recoveredAlready: new Set(),
    })
    expect(later.fresh).toHaveLength(1)
  })

  it('★ 恢复了要发一次"好了"（否则用户以为一直坏着）', () => {
    const plan = planWatchdogNotifications({
      issues: [], nowMs: NOW, lastNotified: new Map([['site-down', NOW - 60_000]]),
      cooldownMs: 30 * 60000,
      disappeared: [{ key: 'site-down', title: '站点打不开' }],
      recoveredAlready: new Set(),
    })
    expect(plan.recovered).toEqual([{ key: 'site-down', title: '站点打不开' }])
  })

  it('恢复只发一次（别每轮都说"好了"）', () => {
    const plan = planWatchdogNotifications({
      issues: [], nowMs: NOW, lastNotified: new Map([['site-down', NOW - 60_000]]),
      cooldownMs: 30 * 60000,
      disappeared: [{ key: 'site-down', title: '站点打不开' }],
      recoveredAlready: new Set(['site-down']),
    })
    expect(plan.recovered).toEqual([])
  })
})

describe('WatchdogService：定时器与去重状态', () => {
  function makeService(gather: () => WatchdogInput) {
    const sent: Array<{ fresh: unknown[]; recovered: unknown[] }> = []
    const svc = new WatchdogService({
      intervalSec: 60,
      cooldownMs: 30 * 60000,
      thresholds: DEFAULT_THRESHOLDS,
      gather,
      notify: async (fresh, recovered) => { sent.push({ fresh, recovered }) },
      log: () => {},
    })
    return { svc, sent }
  }

  it('★ 只读：runOnce 只读 gather 的结果，不改任何东西（gather 是唯一入口）', async () => {
    let calls = 0
    const { svc } = makeService(() => { calls++; return base({ site: { ok: false, status: 500, checkedAt: '' } }) })
    await svc.runOnce()
    expect(calls).toBe(1)
    expect(svc.snapshot().notified).toEqual(['site-down'])
  })

  it('★ 同一个问题连跑两轮 ⇒ 只发一次', async () => {
    const { svc, sent } = makeService(() => base({ site: { ok: false, status: 500, checkedAt: '' } }))
    await svc.runOnce()
    await svc.runOnce()
    expect(sent).toHaveLength(1)
  })

  it('★ 问题消失后跑一轮 ⇒ 发一次恢复', async () => {
    let broken = true
    const { svc, sent } = makeService(() => base({ site: broken ? { ok: false, status: 500, checkedAt: '' } : { ok: true, status: 200, checkedAt: '' } }))
    await svc.runOnce()
    broken = false
    await svc.runOnce()
    expect(sent).toHaveLength(2)
    expect((sent[1].recovered as Array<{ key: string }>)[0].key).toBe('site-down')
  })

  it('notify 抛错不会让下一轮停摆', async () => {
    let n = 0
    const svc = new WatchdogService({
      intervalSec: 60, cooldownMs: 0, thresholds: DEFAULT_THRESHOLDS,
      gather: () => base({ site: { ok: false, status: 500, checkedAt: '' } }),
      notify: async () => { n++; throw new Error('push down') },
      log: () => {},
    })
    await expect(svc.runOnce()).rejects.toThrow('push down')
    // 下一轮照样能跑（running 标志已复位）
    await expect(svc.runOnce()).rejects.toThrow('push down')
    expect(n).toBe(2)
  })
})

describe('★ 第一轮不报"刚重启"（否则每次部署都发假警报）', () => {
  it('uptime 很小时，第一轮不报 fresh-restart；第二轮还小才报', async () => {
    const sent: unknown[] = []
    const svc = new WatchdogService({
      intervalSec: 60,
      cooldownMs: 0,
      thresholds: DEFAULT_THRESHOLDS,
      gather: () => base({ bootsLastHour: 3 }),
      notify: async (fresh) => { sent.push(fresh) },
      log: () => {},
    })
    const r1 = await svc.runOnce()
    expect(r1.fresh).toEqual([])
    const r2 = await svc.runOnce()
    expect(r2.fresh.map(i => i.key)).toEqual(['fresh-restart'])
  })
})
describe('★ 跨重启不重复通知（真机踩过：一小时发了 4 条）', () => {
  it('上一轮的状态能恢复：同一个问题重启后不再说', async () => {
    const persisted = {
      lastNotified: { 'site-down': NOW - 60_000 },
      prev: { 'site-down': '站点打不开' },
      recovered: [],
    }
    const sent: unknown[] = []
    const svc = new WatchdogService({
      intervalSec: 60,
      cooldownMs: 30 * 60000,
      thresholds: DEFAULT_THRESHOLDS,
      gather: () => base({ site: { ok: false, status: 500, checkedAt: '' } }),
      notify: async (fresh) => { sent.push(fresh) },
      log: () => {},
      loadState: () => persisted,
    })
    await svc.runOnce()
    expect(sent).toEqual([])
  })

  it('★ 重启后的第一轮不发"恢复"（那时 prev 是过期的，会假报好消息）', async () => {
    const persisted = {
      lastNotified: { 'site-down': NOW - 60_000 },
      prev: { 'site-down': '站点打不开' },
      recovered: [],
    }
    const sent: Array<{ fresh: unknown[]; recovered: unknown[] }> = []
    const svc = new WatchdogService({
      intervalSec: 60,
      cooldownMs: 30 * 60000,
      thresholds: DEFAULT_THRESHOLDS,
      gather: () => base({ site: { ok: true, status: 200, checkedAt: '' } }),
      notify: async (fresh, recovered) => { sent.push({ fresh, recovered }) },
      log: () => {},
      loadState: () => persisted,
    })
    // 第一轮：不发恢复 —— 上一轮的状态是**过期的**，分不清"修好了"还是"刚重启"
    await svc.runOnce()
    expect(sent).toEqual([])
    // 第二轮：上一轮已干净、prev 已重建 ⇒ 也不会冒出"恢复"（宁可不报，也不发假好消息）
    await svc.runOnce()
    expect(sent).toEqual([])
  })

  it('状态在每轮结束后落盘（下一轮/下次启动能接着用）', async () => {
    const saved: Array<{ lastNotified: Record<string, number> }> = []
    const svc = new WatchdogService({
      intervalSec: 60,
      cooldownMs: 30 * 60000,
      thresholds: DEFAULT_THRESHOLDS,
      gather: () => base({ site: { ok: false, status: 500, checkedAt: '' } }),
      notify: async () => {},
      log: () => {},
      saveState: (st) => { saved.push(st as { lastNotified: Record<string, number> }) },
    })
    await svc.runOnce()
    expect(saved).toHaveLength(1)
    expect(Object.keys(saved[0].lastNotified)).toContain('site-down')
  })

  it('★ failed 类用更长冷却（默认 6 小时），不会半小时念一次', async () => {
    const t = task({ status: 'unknown', updatedAt: new Date().toISOString() })
    const sent: Array<Array<{ key: string }>> = []
    const svc = new WatchdogService({
      intervalSec: 60,
      cooldownMs: 0,
      failedCooldownMs: 6 * 60 * 60 * 1000,
      thresholds: DEFAULT_THRESHOLDS,
      gather: () => base({ tasks: [t] }),
      notify: async (fresh) => { sent.push(fresh as Array<{ key: string }>) },
      log: () => {},
    })
    await svc.runOnce()
    await svc.runOnce()
    expect(sent).toHaveLength(1)
  })
})