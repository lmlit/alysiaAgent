/**
 * 「她自己注意到的事」的单测（★ 2026-10-19，change: `watch-for-stuck-work` 的设计修正）。
 *
 * 用户原话（第一版做错之后）：
 * > 这个不是推送给我的，是告诉昔涟让她自行决策或者来找我商量的吧，
 * > 不要太多专业名词和上面数字，很奇怪啊。
 *
 * 所以这个文件钉的是**两件容易忘的事**：
 *   1. 内容必须是**人话**：没有任务 id、没有阶段名、没有分钟数、没有状态码
 *   2. 形态是"塞进她的上下文"，不是"发一条消息给用户"
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearSelfNotices,
  getSelfNotices,
  renderSelfNoticeBlock,
  setSelfNotices,
  SELF_NOTICE_TTL_MS,
} from '../src/memory/self-notice.js'
import { evaluateWatchdogFacts, DEFAULT_THRESHOLDS, type WatchdogInput } from '../../server/src/watchdog.js'
import type { ProjectTask } from '../src/memory/index.js'

const NOW = Date.parse('2026-10-19T02:00:00Z')

beforeEach(() => clearSelfNotices())

describe('清单本身', () => {
  it('空清单 ⇒ 提示词块为空串（不留空标题）', () => {
    expect(renderSelfNoticeBlock([])).toBe('')
  })

  it('放进去就能读出来，并按 key 去重（整体替换语义）', () => {
    setSelfNotices([{ key: 'a', text: '甲' }, { key: 'b', text: '乙' }], NOW)
    expect(getSelfNotices(NOW).map(n => n.text)).toEqual(['甲', '乙'])
    setSelfNotices([{ key: 'a', text: '甲改了' }], NOW)
    expect(getSelfNotices(NOW).map(n => n.text)).toEqual(['甲改了'])
  })

  it('放太多只留前 5 条（再多就是噪声、还吃 prompt 预算）', () => {
    setSelfNotices(Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, text: `第${i}件` })), NOW)
    expect(getSelfNotices(NOW)).toHaveLength(5)
  })

  it('★ 过期的自动消失（她一直没理会，就不该永远挂在提示词里）', () => {
    setSelfNotices([{ key: 'a', text: '甲' }], NOW)
    expect(getSelfNotices(NOW + SELF_NOTICE_TTL_MS + 1)).toEqual([])
  })
})

describe('提示词块的措辞', () => {
  it('★ 明写"这些是你自己留意的、不是别人派给你的"，并要求别说工程术语', () => {
    setSelfNotices([{ key: 'a', text: '有一件没做完就断了' }], NOW)
    const block = renderSelfNoticeBlock(getSelfNotices(NOW))
    expect(block).toContain('[你刚注意到的事]')
    expect(block).toContain('有一件没做完就断了')
    expect(block).toContain('不是别人转给你的任务')
    expect(block).toMatch(/别说工程术语/)
  })
})

// ── 判据给出的人话（最容易被"技术洁癖"带跑的地方） ──────────────

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    taskId: 'pt-0123456789abcdef',
    requestKey: 'k',
    projectId: 'alysia-toys',
    originSessionId: '',
    origin: 'delegated',
    kind: 'build',
    goal: '给岛上海边加一只会在潮水退去时留下来的杯子',
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
  bootsLastHour: 1,
  ...over,
})

const plainsOf = (inp: WatchdogInput) =>
  evaluateWatchdogFacts(inp, DEFAULT_THRESHOLDS).map(i => i.plain)

describe('★ 给她看的话里不许出现 id / 阶段 / 分钟数 / 状态码', () => {
  const cases: Array<[string, WatchdogInput]> = [
    ['卡住', base({ tasks: [task()] })],
    ['没做完就断', base({ tasks: [task({ status: 'unknown' })] })],
    ['做失败', base({ tasks: [task({ status: 'failed', lastError: 'boom' })] })],
    ['替她办事的停了', base({ runnerBeatSec: 200 })],
    ['站点打不开', base({ site: { ok: false, status: 503, checkedAt: 'x' } })],
    ['排队', base({ tasks: [task({ taskId: 'pt-q1', status: 'queued' })] })],
    ['反复重启', base({ bootsLastHour: 6 })],
  ]

  it.each(cases)('%s：干净', (_name, inp) => {
    const plains = plainsOf(inp)
    expect(plains.length).toBeGreaterThan(0)
    for (const p of plains) {
      expect(p).not.toMatch(/pt-[0-9a-f]/)          // 任务 id
      expect(p).not.toMatch(/\b(intent|sketch|review|build|revise|statement|publish)\b/) // 阶段名
      expect(p).not.toMatch(/\d+\s*(分钟|秒)/)      // 分钟/秒
      expect(p).not.toMatch(/\bHTTP\b|\b\d{3}\b/)   // 状态码
      expect(p).not.toContain('undici')
    }
  })

  it('排障用的 detail **仍然**保留 id 和数字（日志要能查）', () => {
    const issues = evaluateWatchdogFacts(base({ tasks: [task()] }), DEFAULT_THRESHOLDS)
    expect(issues[0].detail).toContain('pt-0123456789abcdef')
    expect(issues[0].detail).toContain('25 分钟')
    expect(issues[0].plain).not.toContain('pt-')
  })
})
