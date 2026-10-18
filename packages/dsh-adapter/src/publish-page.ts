/**
 * `publish_page` 工具 —— **她"上线"的唯一正路**（★ 2026-10-19，change: `give-her-a-publish-tool`）。
 *
 * ## 为什么要有它
 *
 * 在此之前，"上线"= 她往 `public/` 里 `cp`，我们靠**路径白名单事后没收**来管。真机代价：
 * sketch 轮她写了整页 ⇒ 988 / 53 个文件被搬走；我漏配 `AGENTS.md` ⇒ 她的说明书被搬走；
 * 她按任务要求把页面发布进 `public/` ⇒ **整站 7 个文件被搬走，站点断了一分钟**。
 *
 * 用户的原话把这层想通了：「我们可以创建一些**越权工具**？作为白名单给他用？」
 * ⇒ 白名单从**路径**换成**能力**：工作区随便写，"上线"只有一条明确、可验证、有证据的路。
 *
 * ## 它做什么
 *
 * `{ files: string[], home?: string }`
 *   1. 校验每个路径（工作区内、非隐藏、扩展名白名单、不许来自 `public/`）
 *   2. **自动带上页面引用的相对资源**（`style.css` / `vendor/three.min.js` …）——
 *      只发 html 会得到一个"能打开但是裸的"页面
 *   3. 复制进 `public/`；`home` 指定的那一页同时写成 `public/index.html`（站点门牌）
 *   4. **自己 HTTP 验一遍**（本机预览服务），把 200 与最终地址带回给她
 *
 * ## 边界（写在代码里，不靠劝）
 *
 * - `ALYSIA_ALLOW_PUBLISH=0` ⇒ **直接拒绝**（她自己发起的任务默认不许上线）；
 *   runner 从认领响应里拿到这个开关透传进来（见 `scripts/project-task-runner.mjs`）。
 * - 工具**不是沙箱**：它管不住"她直接 cp"。真实边界是 dsh 的 bwrap（只能写工作区）。
 *   工具的价值是给一条正路 + 留下证据，而不是事后惩罚。
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ContentBlock, ToolDefinition } from './types.ts'

/** 能上线的扩展名（与 `preview-serve.py` 的 `/w/` 白名单同口径） */
export const PUBLISHABLE_EXT = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg',
  '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.mp3', '.ogg', '.wav',
])

/** 永远不许发布的路径段（笔记、元信息、脚本、缓存、隔离区） */
const DENY_SEGMENTS = new Set(['.tmp', '.phases', '.git', 'node_modules', 'public'])

/**
 * 从 cwd 往上找一个带 `.alysia-project.json` 的目录当工作区；找不到就用 cwd。
 * （runner 用 `cwd = 工作区` 起 dsh，所以正常情况第一跳就命中。）
 */
export function findWorkspace(cwd: string = process.cwd()): string {
  let dir = resolve(cwd)
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, '.alysia-project.json'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return resolve(cwd)
}

export interface PublishPlan {
  /** 可以发布的工作区相对路径（含自动带上的资源），已去重、已排序 */
  ok: string[]
  /** 被拒的（路径 + 原因），要原样告诉她 —— 不许静默 */
  rejected: Array<{ path: string; reason: string }>
}

/** 页面里写死的相对引用（`src=` / `href=`），用来把她要的资源一起带上 */
const REF_RE = /(?:src|href)\s*=\s*"([^"]+)"/gi

/**
 * 纯函数：算出**要发布哪些文件**（不碰磁盘以外的任何东西，便于单测）。
 *
 * @param workspace 工作区绝对路径
 * @param files     她要发的文件（工作区相对路径）
 * @param readFile  读文件（测试可注入）
 */
export function planPublish(
  workspace: string,
  files: string[],
  readFile: (abs: string) => string = (p) => readFileSync(p, 'utf8'),
): PublishPlan {
  const ws = resolve(workspace)
  const ok = new Set<string>()
  const rejected: Array<{ path: string; reason: string }> = []

  const guard = (raw: string): string | null => {
    const p = String(raw ?? '').trim()
    if (!p) return null
    if (/^[a-z]+:\/\//i.test(p) || p.startsWith('data:')) {
      rejected.push({ path: p, reason: '外链/内联资源不用发布' })
      return null
    }
    const abs = resolve(ws, p)
    const rel = relative(ws, abs)
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
      rejected.push({ path: p, reason: '不在工作区内' })
      return null
    }
    const segs = rel.split(sep)
    if (segs.some((s) => s.startsWith('.'))) {
      rejected.push({ path: p, reason: '隐藏文件/目录不许发布（笔记、缓存、元信息都在这类里）' })
      return null
    }
    if (segs.some((s) => DENY_SEGMENTS.has(s))) {
      rejected.push({ path: p, reason: `不许从 ${segs.find((s) => DENY_SEGMENTS.has(s))}/ 里取值发布` })
      return null
    }
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    if (!rel.includes('.') || !PUBLISHABLE_EXT.has(ext)) {
      rejected.push({ path: p, reason: `扩展名不在白名单（${[...PUBLISHABLE_EXT].join(' ')}）` })
      return null
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      rejected.push({ path: p, reason: '文件不存在' })
      return null
    }
    return rel.split(sep).join('/')
  }

  for (const f of files) {
    const rel = guard(f)
    if (!rel) continue
    ok.add(rel)
    // 只对 html 展开引用
    if (!/\.html?$/i.test(rel)) continue
    let text = ''
    try {
      text = readFile(resolve(ws, rel))
    } catch {
      continue
    }
    const baseDir = dirname(resolve(ws, rel))
    for (const m of text.matchAll(REF_RE)) {
      const ref = m[1].split('?')[0].split('#')[0]
      if (!ref || /^[a-z]+:\/\//i.test(ref) || ref.startsWith('/') || ref.startsWith('data:')) continue
      const abs = resolve(baseDir, ref)
      const r = relative(ws, abs)
      if (!r || r.startsWith('..')) continue
      const narrowed = guard(r.split(sep).join('/'))
      if (narrowed) ok.add(narrowed)
    }
  }

  return { ok: [...ok].sort(), rejected }
}

/** 项目元信息（`projectId` / `publicUrl`） */
function metaOf(workspace: string): { projectId: string; publicUrl: string } {
  try {
    const meta = JSON.parse(readFileSync(join(workspace, '.alysia-project.json'), 'utf8')) as {
      projectId?: unknown
      publicUrl?: unknown
    }
    return {
      projectId: typeof meta.projectId === 'string' ? meta.projectId : '',
      publicUrl: typeof meta.publicUrl === 'string' ? meta.publicUrl : '',
    }
  } catch {
    return { projectId: '', publicUrl: '' }
  }
}

/**
 * **给用户看的**地址 —— 必须是对外地址（`publicUrl`，形如 `http://<公网>:3389/p/<id>/`）。
 *
 * ⚠️ 2026-10-19 真机踩到：第一版这里返回的是 `http://127.0.0.1:3389/...`，
 * 她原样贴给用户 ⇒ 用户点开是**自己电脑上的回环地址**，必然打不开。
 * 回环只能用于**本机自证**，绝不能出现在给用户的话里。
 */
function publicBase(workspace: string): string {
  const { projectId, publicUrl } = metaOf(workspace)
  if (publicUrl) return publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`
  return `http://127.0.0.1:3389/p/${encodeURIComponent(projectId)}/`
}

/** **自证用**的回环地址（服务器上 3389 + `/p/<id>/` 只读地对外，回环也能取到） */
function verifyBase(workspace: string): string {
  return `http://127.0.0.1:3389/p/${encodeURIComponent(metaOf(workspace).projectId)}/`
}

export function createPublishPageTool(opts: { workspace?: string } = {}): ToolDefinition {
  return {
    name: 'publish_page',
    description:
      '把工作区里的页面**发布上线**（复制进 public/），并自己访问一遍确认真的打得开。'
      + '这是"上线"的唯一正路：直接往 public/ 里 cp 不算发布，也不会被当成发布。'
      + '如果页面还引用了 style.css / vendor/xxx.js 这类相对资源，**不用你列**，会一起带上。'
      + '参数 files 是你要上线的页面（工作区相对路径，如 island.html）；'
      + 'home 可选：把哪一页设成这个站点的首页（会同时写成 public/index.html）。',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '要上线的文件（工作区相对路径）。通常只要给页面本身，引用的资源会自动带上。',
        },
        home: {
          type: 'string',
          description: '可选：作为站点首页的那一页（会写成 public/index.html）。',
        },
      },
      required: ['files'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          published: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                url: { type: 'string' },
                status: { type: 'number' },
              },
              required: ['file', 'url'],
            },
          },
          homeUrl: { type: 'string' },
          rejected: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, reason: { type: 'string' } },
              required: ['path', 'reason'],
            },
          },
          refused: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['published'],
      },
      render(_args: unknown, value: unknown): ContentBlock[] {
        const v = value as {
          published?: Array<{ file: string; url: string; status?: number }>
          homeUrl?: string
          rejected?: Array<{ path: string; reason: string }>
          refused?: string
          note?: string
        }
        if (v.refused) return [{ type: 'text', text: `没有发布：${v.refused}` }]
        const lines: string[] = []
        for (const p of v.published ?? []) {
          // ★ 真机上她抱怨过"✅ 后面没写 (200)"——状态码要显式打出来，否则她还得自己去 curl
          const mark = p.status === 200 ? '✅ 200' : p.status ? `⚠️ ${p.status}` : '⚠️ 未验'
          lines.push(`${mark}  ${p.file} → ${p.url}`)
        }
        if (v.homeUrl) lines.push(`站点首页 → ${v.homeUrl}`)
        if (v.rejected?.length) {
          lines.push('', '这些没发：')
          for (const r of v.rejected) lines.push(`- ${r.path}：${r.reason}`)
        }
        if (v.note) lines.push('', v.note)
        return [{ type: 'text', text: lines.join('\n') || '（没有可发布的文件）' }]
      },
    },
    async execute(args: unknown): Promise<unknown> {
      // ★ 来源闸门：她自发起做的任务默认**不许上线**（契约 62）
      if (process.env.ALYSIA_ALLOW_PUBLISH === '0') {
        return {
          published: [],
          refused: '这次不允许上线（这个任务是**你自己发起的**，上线要等对话里的人点头）。'
            + '页面已经留在工作区了，可以给人看预览地址。',
        }
      }

      const workspace = opts.workspace ?? findWorkspace()
      const a = args as { files?: unknown; home?: unknown }
      const files = Array.isArray(a?.files)
        ? a.files.filter((x): x is string => typeof x === 'string')
        : []
      if (files.length === 0) {
        return { published: [], refused: 'files 是空的 —— 至少给一个要上线的页面。' }
      }

      const plan = planPublish(workspace, files)
      if (plan.ok.length === 0) {
        return { published: [], rejected: plan.rejected, note: '没有一个文件通过校验。' }
      }

      const pub = join(workspace, 'public')
      mkdirSync(pub, { recursive: true })
      for (const rel of plan.ok) {
        const to = join(pub, rel)
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(join(workspace, rel), to)
      }

      /**
       * ★ 留痕：记一笔"这些文件是**通过工具**发出去的"。
       *
       * 为什么需要：runner 轮末会发现 `public/` 变了，而它分不清
       *   「她用了 publish_page」（正路）与「她直接 cp」（绕过）。
       * 没有这个标记，回执会把正路也写成"绕过工具直接动了 public/" —— 那是**冤枉她**。
       * 文件放工作区里、以 `.` 开头（不进 `public/`、不在 `/w/` 白名单里、不会被发布）。
       */
      try {
        appendFileSync(
          join(workspace, '.alysia-publish-log.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), files: plan.ok }) + '\n',
        )
      } catch {
        /* 记账失败不该让发布失败 */
      }

      // 站点门牌：home 指定的那一页同时写成 index.html
      let homeUrl: string | undefined
      const home = typeof a?.home === 'string' ? a.home.trim() : ''
      if (home) {
        const hp = planPublish(workspace, [home])
        if (hp.ok.length > 0) {
          copyFileSync(join(workspace, hp.ok[0]), join(pub, 'index.html'))
          homeUrl = publicBase(workspace)
        }
      }

      // ★ 自证：发布"成功"的判据是**能打开**，不是"我复制过去了"
      //   ⚠️ 自证走**回环**（本机预览服务），但给用户/给她的地址是**对外地址** ——
      //   两者绝不能混（第一版就把回环地址贴给了用户）。
      const shown = publicBase(workspace)
      const check = verifyBase(workspace)
      /**
       * ★ 2026-10-19 真机崩溃修复：**必须把响应体读掉**。
       *
       * 只取 `res.status` 不消费 body ⇒ undici（Node 内置 fetch）在 socket 结束时
       * `assert(!this.paused)` 失败 ⇒ **整个 dsh 进程 fatal uncaught exception**，
       * 退出码 1、没有 turn_end ⇒ runner 判 `unknown`，她在对话里只说了半句就断。
       * （真机复现：`dsh: fatal uncaught exception: AssertionError … Parser.finish (undici)`。）
       */
      const probe = async (url: string): Promise<number | undefined> => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
          try {
            await res.arrayBuffer() // 读掉 body（否则 undici 会在断开时崩）
          } catch {
            /* 读失败不影响状态码 */
          }
          return res.status
        } catch {
          return undefined // 预览服务没起 / 网络不通：如实标"未验"，不谎报成功
        }
      }

      const published: Array<{ file: string; url: string; status?: number }> = []
      for (const rel of plan.ok) {
        const url = `${shown}${rel}`
        published.push({ file: rel, url, status: await probe(`${check}${rel}`) })
      }
      if (homeUrl && published.length > 0) {
        const st = await probe(check)
        if (st !== 200) homeUrl = `${homeUrl}（访问返回 ${st ?? '未验'}）`
      }

      const unverified = published.filter((p) => p.status === undefined).length
      return {
        published,
        ...(homeUrl ? { homeUrl } : {}),
        ...(plan.rejected.length ? { rejected: plan.rejected } : {}),
        ...(unverified > 0
          ? { note: `有 ${unverified} 个文件没能验证（本机预览服务可能没起）—— 地址照给，但别声称"已确认能打开"。` }
          : {}),
      }
    },
  }
}
