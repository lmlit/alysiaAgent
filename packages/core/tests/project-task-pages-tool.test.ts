/**
 * `list_my_pages` / `find_page` 的单测（★ 2026-10-19，change: `let-her-query-what-she-made`）。
 *
 * 为什么这两个工具值得钉：真机证据 —— 她为了"给用户一个网址"**新建了一个任务**
 * （`15:53 核实 island.html 当前真实的对外可访问地址…请自己用 curl 打开验证`）。
 * 查一下就够了，不该再开一个会跑 dsh、会花钱、会写工作区的任务。
 *
 * 钉住的行为：
 *   1. 只读：**不**调 `createProjectTask`（这条最重要）
 *   2. 给完整地址（`/p/` 或 `/w/`），并标出哪个还没上线
 *   3. 没有清单 ⇒ 不注册工具；拿不到 ⇒ 明说，不许编
 *   4. 清单旧了 ⇒ 如实说"几分钟前"，别把旧数据说成现况
 */

import { describe, it, expect } from 'vitest'
import { createProjectTaskTools } from '../src/tools/project-tasks.js'
import type { ProjectTaskHost } from '../src/tools/project-tasks.js'

const HOST = {
  createProjectTask: () => {
    throw new Error('查询工具**不许**建任务')
  },
  getProjectTask: () => null,
  addProjectTaskRevision: () => null,
} as unknown as ProjectTaskHost

const PAGES = {
  generatedAt: '2026-10-19T01:30:00',
  receivedAt: new Date().toISOString(),
  pages: [
    { projectId: 'alysia-toys', file: 'island.html', title: '海岛的一天', url: 'https://hub.test/p/alysia-toys/island.html', published: true, updatedAt: '2026-10-18T23:26:00' },
    { projectId: 'alysia-toys', file: 'draft.html', title: '还没上线的', url: 'https://hub.test/w/alysia-toys/draft.html', published: false, updatedAt: '2026-10-19T00:10:00' },
    { projectId: 'alysia-blog', file: 'essay-lamp.html', title: '等一盏灯亮起来', url: 'https://hub.test/p/alysia-blog/essay-lamp.html', published: true, updatedAt: '2026-10-18T18:24:00' },
  ],
}

const make = (pages: unknown = PAGES) =>
  createProjectTaskTools(HOST, { projectIds: ['alysia-toys'], pages: () => pages as never })
const byName = (tools: ReturnType<typeof make>, name: string) => tools.find(t => t.name === name)!

describe('工具注册（能力开关）', () => {
  it('有清单 ⇒ 注册两个查询工具，且它们排在三个任务工具之后', () => {
    const names = make().map(t => t.name)
    expect(names).toEqual([
      'start_project_task', 'get_project_task', 'continue_project_task', 'list_my_pages', 'find_page',
    ])
  })

  it('没有清单来源 ⇒ 不注册（不给假能力）', () => {
    const names = createProjectTaskTools(HOST, { projectIds: ['alysia-toys'] }).map(t => t.name)
    expect(names).not.toContain('list_my_pages')
    expect(names).not.toContain('find_page')
  })

  it('没有登记项目 ⇒ 一个工具都没有（沿用既有开关语义）', () => {
    expect(createProjectTaskTools(HOST, { projectIds: [], pages: () => PAGES as never })).toEqual([])
  })
})

describe('list_my_pages', () => {
  it('★ 列出全部，给完整地址，并标出哪页还没上线', async () => {
    const out = String(await byName(make(), 'list_my_pages').handler({}))
    expect(out).toContain('你做过 3 个页面')
    expect(out).toContain('https://hub.test/p/alysia-toys/island.html')
    expect(out).toContain('（预览）')
    expect(out).toContain('https://hub.test/w/alysia-toys/draft.html')
  })

  it('★ 明确告诉她"别为了一个网址去新建任务"', async () => {
    const out = String(await byName(make(), 'list_my_pages').handler({}))
    expect(out).toMatch(/不要.*新建任务/)
  })

  it('按项目过滤 + limit 截断并说明还有多少', async () => {
    const one = String(await byName(make(), 'list_my_pages').handler({ projectId: 'alysia-blog' }))
    expect(one).toContain('1 个页面')
    expect(one).not.toContain('island.html')

    const cut = String(await byName(make(), 'list_my_pages').handler({ limit: 1 }))
    expect(cut).toContain('还有 2 个')
  })

  it('★ 读不到清单 ⇒ 明说，不编（并给出替代路径）', async () => {
    const out = String(await byName(make(null), 'list_my_pages').handler({}))
    expect(out).toContain('读不到')
    expect(out).toContain('get_project_task')
  })

  it('★ 清单旧了 ⇒ 说明是几分钟前的（别把旧数据当现况）', async () => {
    const old = { ...PAGES, receivedAt: new Date(Date.now() - 7 * 60_000).toISOString() }
    const out = String(await byName(make(old), 'list_my_pages').handler({}))
    expect(out).toContain('7 分钟前')
  })
})

describe('find_page', () => {
  it('按中文标题 / 文件名 / 项目都能找到', async () => {
    const find = byName(make(), 'find_page')
    expect(String(await find.handler({ query: '海岛' }))).toContain('island.html')
    expect(String(await find.handler({ query: 'essay-lamp' }))).toContain('等一盏灯')
    expect(String(await find.handler({ query: 'alysia-blog' }))).toContain('essay-lamp.html')
  })

  it('找不到 ⇒ 明说"真没有才是要做新的"（别让她直接去建任务）', async () => {
    const out = String(await byName(make(), 'find_page').handler({ query: '不存在的东西' }))
    expect(out).toContain('没找到')
    expect(out).toContain('真没有才是要做新的')
  })

  it('空 query ⇒ 拒绝', async () => {
    expect(String(await byName(make(), 'find_page').handler({ query: '  ' }))).toContain('拒绝')
  })
})

describe('★ 只读：两个工具都不许建任务', () => {
  it('HOST.createProjectTask 抛错，但查询完全正常（证明没走创建路径）', async () => {
    const tools = make()
    const a = await byName(tools, 'list_my_pages').handler({})
    const b = await byName(tools, 'find_page').handler({ query: '海岛' })
    expect(String(a)).toContain('你做过')
    expect(String(b)).toContain('海岛')
  })
})
