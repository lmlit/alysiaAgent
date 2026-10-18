/**
 * `publish_page` 工具的单测（★ 2026-10-19，change: `give-her-a-publish-tool`）。
 *
 * 这个工具是"上线"的**唯一正路**，所以它的判据要钉死：
 *   - 路径必须工作区内、非隐藏、扩展名白名单、不许来自 `public/`
 *   - **自动带上页面引用的相对资源**（只发 html 会得到一个"裸页面"）
 *   - `ALYSIA_ALLOW_PUBLISH=0` ⇒ 直接拒绝（她自己发起的任务不许上线）
 *
 * ⚠️ 只测**纯函数与拒绝路径**：真正复制文件 + HTTP 自证那一段需要真工作区，
 *    在真机验收里做（见 change 的 tasks.md）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planPublish, PUBLISHABLE_EXT, createPublishPageTool } from '../src/publish-page.ts'

let ws = ''

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'publish-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('planPublish：哪些能上线', () => {
  it('页面本身 + 它引用的 css/js 一起带上（这才是"能打开的页面"）', () => {
    writeFileSync(join(ws, 'island.html'), '<link rel="stylesheet" href="style.css"><script src="vendor/three.min.js"></script>')
    writeFileSync(join(ws, 'style.css'), 'body{}')
    mkdirSync(join(ws, 'vendor'))
    writeFileSync(join(ws, 'vendor', 'three.min.js'), '//x')

    const plan = planPublish(ws, ['island.html'])
    expect(plan.ok).toEqual(['island.html', 'style.css', 'vendor/three.min.js'])
    expect(plan.rejected).toEqual([])
  })

  it('外链 / 绝对路径 / data: 不用发布（也不算错）', () => {
    writeFileSync(
      join(ws, 'a.html'),
      '<a href="https://example.com">x</a><img src="data:image/png;base64,AA"><script src="/abs.js"></script>',
    )
    const plan = planPublish(ws, ['a.html'])
    expect(plan.ok).toEqual(['a.html'])
  })

  it('★ 笔记、元信息、脚本、隐藏文件、缓存一律拒（并且要说原因）', () => {
    writeFileSync(join(ws, 'NOTES.md'), '# 笔记')
    writeFileSync(join(ws, 'AGENTS.md'), '# 说明')
    writeFileSync(join(ws, '.alysia-project.json'), '{}')
    writeFileSync(join(ws, 'publish.sh'), 'exit 0')
    mkdirSync(join(ws, '.tmp'))
    writeFileSync(join(ws, '.tmp', 'x.html'), '<p>cache')
    const plan = planPublish(ws, ['NOTES.md', 'AGENTS.md', '.alysia-project.json', 'publish.sh', '.tmp/x.html'])
    expect(plan.ok).toEqual([])
    expect(plan.rejected).toHaveLength(5)
    for (const r of plan.rejected) expect(r.reason.length).toBeGreaterThan(4)
  })

  it('★ 不许从 public/ 里取值再发布一次（那是发布产物，不是源）', () => {
    mkdirSync(join(ws, 'public'))
    writeFileSync(join(ws, 'public', 'x.html'), '<p>x')
    const plan = planPublish(ws, ['public/x.html'])
    expect(plan.ok).toEqual([])
    expect(plan.rejected[0].reason).toContain('public')
  })

  it('★ 越界路径（../）拒绝', () => {
    const plan = planPublish(ws, ['../escape.html'])
    expect(plan.ok).toEqual([])
    expect(plan.rejected[0].reason).toContain('工作区内')
  })

  it('不存在的文件 ⇒ 拒，且原因是"不存在"', () => {
    const plan = planPublish(ws, ['nope.html'])
    expect(plan.ok).toEqual([])
    expect(plan.rejected[0].reason).toContain('不存在')
  })

  it('扩展名白名单覆盖 html/css/js/图片/字体（与 /w/ 预览通道同口径）', () => {
    for (const ext of ['.html', '.css', '.js', '.mjs', '.svg', '.png', '.webp', '.woff2']) {
      expect(PUBLISHABLE_EXT.has(ext), ext).toBe(true)
    }
    expect(PUBLISHABLE_EXT.has('.md')).toBe(false)
    expect(PUBLISHABLE_EXT.has('.json')).toBe(false)
    expect(PUBLISHABLE_EXT.has('.sh')).toBe(false)
  })
})

describe('execute：来源闸门与拒绝', () => {
  const tool = () => createPublishPageTool({ workspace: ws })

  it('★★ ALYSIA_ALLOW_PUBLISH=0 ⇒ 拒绝（她自己发起的任务不许上线）', async () => {
    const old = process.env.ALYSIA_ALLOW_PUBLISH
    process.env.ALYSIA_ALLOW_PUBLISH = '0'
    try {
      writeFileSync(join(ws, 'a.html'), '<p>a')
      const out = (await tool().execute({ files: ['a.html'] }, { signal: new AbortController().signal })) as {
        published: unknown[]
        refused?: string
      }
      expect(out.published).toEqual([])
      expect(out.refused).toContain('不允许上线')
    } finally {
      if (old === undefined) delete process.env.ALYSIA_ALLOW_PUBLISH
      else process.env.ALYSIA_ALLOW_PUBLISH = old
    }
  })

  it('files 为空 ⇒ 拒绝（不许"发布全部"这种危险默认）', async () => {
    const out = (await tool().execute({ files: [] }, { signal: new AbortController().signal })) as {
      refused?: string
    }
    expect(out.refused).toContain('files')
  })

  it('全部被拒 ⇒ 说清没有一个通过（不是静默成功）', async () => {
    writeFileSync(join(ws, 'NOTES.md'), '# x')
    const out = (await tool().execute({ files: ['NOTES.md'] }, { signal: new AbortController().signal })) as {
      published: unknown[]
      note?: string
    }
    expect(out.published).toEqual([])
    expect(out.note).toContain('没有一个')
  })
})
