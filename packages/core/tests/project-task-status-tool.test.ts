/**
 * `check_server_status` 的单测（★ 2026-10-19，change: `let-her-query-what-she-made`，A1 档）。
 *
 * 背景（用户原话）：「他会自己触发看看卡住的进度吗」——
 * 答案是**不会自动**（要 A2 看门狗），但**被问到时**她必须能一眼看全。
 * 这个工具就是那一"眼"：只读、看得全、说清哪件事可能卡住。
 *
 * 钉住的行为：
 *   1. 只**看**：不调任何写接口
 *   2. 「可能卡住」的判据：running/queued 且 ≥20 分钟没动
 *   3. runner 心跳：90 秒内算活，超了说"几分钟没动静"（这是"她挂了"的唯一可靠信号）
 *   4. 没有 provider ⇒ 不注册；provider 返回 null ⇒ 明说拿不到
 */

import { describe, it, expect } from 'vitest'
import { createProjectTaskTools } from '../src/tools/project-tasks.js'
import type { ProjectTaskHost, ServerStatusProvider } from '../src/tools/project-tasks.js'

function task(over: Record<string, unknown> = {}) {
  return {
    taskId: 'pt-0123456789abcdef',
    requestKey: 'k',
    projectId: 'alysia-toys',
    originSessionId: '',
    origin: 'delegated' as const,
    kind: 'build' as const,
    goal: '做一个海岛场景',
    acceptanceCriteria: '',
    dshSessionId: null,
    status: 'running' as const,
    revision: 0,
    result: null,
    artifacts: null,
    attempts: 1,
    lastError: null,
    createdAt: new Date(Date.now() - 60 * 60000).toISOString(),
    updatedAt: new Date(Date.now() - 25 * 60000).toISOString(),
    phase: 'build' as const,
    loopState: { rounds: 1, visits: {}, revisions: 0 },
    ...over,
  }
}

const HOST = {
  createProjectTask: () => {
    throw new Error('看板**不许**建任务')
  },
  getProjectTask: () => null,
  addProjectTaskRevision: () => null,
  listRecentProjectTasks: () => [task()],
  countProjectTasksByStatus: () => ({ running: 1, queued: 2, needs_review: 3 }),
} as unknown as ProjectTaskHost

const STATUS: ServerStatusProvider = () => ({
  uptimeSec: 3600,
  hostPagesReceivedAt: new Date(Date.now() - 20_000).toISOString(),
  pagesCount: 13,
  logTail: [{ level: 'ERROR', at: '2026-10-19 01:20:00', message: 'runner 认领失败（HTTP 500）' }],
})

const make = (status?: ServerStatusProvider | null) =>
  createProjectTaskTools(HOST, {
    projectIds: ['alysia-toys'],
    ...(status === null ? {} : { serverStatus: status ?? STATUS }),
  })
const tool = (t: ReturnType<typeof make>) => t.find(x => x.name === 'check_server_status')!

describe('注册开关', () => {
  it('没有 provider ⇒ 不注册', () => {
    expect(make(null).map(t => t.name)).not.toContain('check_server_status')
  })
  it('有 provider ⇒ 注册，且排在查询工具之后', () => {
    const names = createProjectTaskTools(HOST, { projectIds: ['x'], pages: () => null, serverStatus: STATUS }).map(t => t.name)
    expect(names[names.length - 1]).toBe('check_server_status')
  })
})

describe('check_server_status', () => {
  it('服务 uptime 用人话说', async () => {
    const out = String(await tool(make()).handler({}))
    expect(out).toContain('已运行 60 分钟')
  })

  it('★ runner 20 秒前推过 ⇒ 说"在"；超过 90 秒 ⇒ 说"几分钟没动静"', async () => {
    const fresh = String(await tool(make()).handler({}))
    expect(fresh).toContain('在（20 秒前刚推过清单）')

    const stale: ServerStatusProvider = () => ({ ...STATUS()!, hostPagesReceivedAt: new Date(Date.now() - 300_000).toISOString() })
    const out = String(await tool(make(stale)).handler({}))
    expect(out).toContain('5 分钟没动静')
  })

  it('任务各状态计数 + 只列非零项', async () => {
    const out = String(await tool(make()).handler({}))
    expect(out).toContain('running 1')
    expect(out).toContain('needs_review 3')
    expect(out).not.toContain('failed 0')
  })

  it('★ running 且 25 分钟没动 ⇒ 标"可能卡住"（这正是用户问的那件事）', async () => {
    const out = String(await tool(make()).handler({}))
    expect(out).toContain('可能卡住')
    expect(out).toContain('25 分钟前')
  })

  it('刚跑完一轮的任务不标卡住', async () => {
    const host = { ...HOST, listRecentProjectTasks: () => [task({ status: 'needs_review', updatedAt: new Date().toISOString() })] } as unknown as ProjectTaskHost
    const tools = createProjectTaskTools(host, { projectIds: ['x'], serverStatus: STATUS })
    expect(String(await tools.find(t => t.name === 'check_server_status')!.handler({}))).not.toContain('可能卡住')
  })

  it('带出最近的告警（截断），并明说"只读、不会自己重启"', async () => {
    const out = String(await tool(make()).handler({}))
    expect(out).toContain('runner 认领失败')
    expect(out).toContain('只读快照')
  })

  it('拿不到快照 ⇒ 如实说（不编一个健康）', async () => {
    const tools = createProjectTaskTools(HOST, { projectIds: ['x'], serverStatus: () => null })
    const out = String(await tools.find(t => t.name === 'check_server_status')!.handler({}))
    expect(out).toContain('拿不到状态快照')
  })

  it('★ 只读：HOST.createProjectTask 抛错，看板照样能出', async () => {
    expect(String(await tool(make()).handler({}))).toContain('**任务**')
  })
})
