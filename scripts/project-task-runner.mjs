#!/usr/bin/env node
/**
 * 委托任务的**宿主侧 runner** —— 把 alysia 里的任务变成 dsh 真的跑起来。
 *
 * ★ 2026-10-17（change: `add-project-task-delegation`）。
 *
 * ## 为什么需要它（架构上的既成事实）
 *
 *   alysia server 跑在**容器里**，`dsh` 装在**宿主机上**，博客工作区也在宿主机上
 *   ⇒ 服务端**无法** spawn dsh。所以走「**runner 主动轮询认领**」：
 *   出站连接（复用现有 dsh→server 的方向）、不动容器、不动镜像、工作区天然在宿主上。
 *
 * ## 用法
 *
 *   # 先拿到 token 与凭据（与 dsh-web.service 同一份来源）
 *   set -a; . /root/.dsh-web.env; set +a
 *   export ALYSIA_WEBUI_TOKEN="$(sed -n 's/^ALYSIA_WEBUI_TOKEN=//p' /root/alysia/.env | head -1)"
 *   node project-task-runner.mjs --project alysia-blog
 *
 *   常用开关：
 *     --once              只轮询一轮（验收/调试用）
 *     --dry-run           认领但**不执行**，只打印将要跑的命令（不提交结果）
 *     --interval <sec>    轮询间隔（默认 10）
 *     --timeout <sec>     单轮执行上限；**默认按阶段**（见 PHASE_TIMEOUT_SEC），显式给就统一压过
 *     --base <url>        alysia 基址（默认 http://127.0.0.1:6186）
 *
 * ## 契约（与 server 侧对齐，别在这里改口径）
 *
 * - 轮询 `/api/project-tasks/next` 认领；认领响应里**带项目配置**（workspace/profile），
 *   runner 不再读第二份配置。
 * - 结果走 `/api/project-tasks/:id/result`。
 * - **`--session-id` 只在任务已经有 `dshSessionId` 时才带**：
 *   首轮带了会报 `unknown id`；续作不带就等于重新建站（那正是本 change 要避免的）。
 * - ⚠️ **runner 永远不写 `completed`**：那是「**结果被接受**」，属于验收方（用户 / 她），
 *   不是执行方。dsh 这一轮正常结束 ⇒ 写 `needs_review`。
 * - ⚠️ 解析不出来 / 超时 ⇒ 写 `unknown`，**绝不自动重投**
 *   （盲目重投可能把同一份工作做两遍）。只有「压根没认领到」才继续轮询。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── 参数 ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    project: process.env.PROJECT_TASK_PROJECT ?? '',
    base: process.env.ALYSIA_BASE_URL ?? 'http://127.0.0.1:6186',
    token: process.env.ALYSIA_WEBUI_TOKEN ?? '',
    intervalSec: 10,
    /**
     * 单轮执行上限（秒）。
     * ★ 2026-10-18（change: `scope-loop-to-this-round`）：默认改为 **null**（= 按阶段取
     *   `PHASE_TIMEOUT_SEC`），显式 `--timeout N` 才统一压过所有阶段。
     */
    timeoutSec: null,
    once: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i] ?? '';
    else if (a === '--base') out.base = argv[++i] ?? out.base;
    else if (a === '--interval') out.intervalSec = Number(argv[++i] ?? out.intervalSec);
    else if (a === '--timeout') out.timeoutSec = Number(argv[++i] ?? out.timeoutSec);
    else if (a === '--once') out.once = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`未知参数：${a}`); printHelp(); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log(`用法：node project-task-runner.mjs [--project <id>] [--once] [--dry-run]
  --project <id>    可选。**不传 = 服务所有项目**（由服务端挑"还有活的最老的项目"）
                    ★ 2026-10-18：原先必须传，且 runner 是按项目起服务的 ⇒
                      新登记的项目永远没人认领，任务一路 queued 而且是**静默**的。
                    传了则只认领该项目的任务（用于隔离/调试）。
  --base <url>      alysia 基址（默认 http://127.0.0.1:6186）
  --interval <sec>  轮询间隔（默认 10）
  --timeout <sec>   单轮执行上限（默认**按阶段**：intent/review/statement 900s、sketch 2400s、revise 3600s、build 5400s；显式给就统一覆盖）
  --once            只轮询一轮
  --dry-run         认领但不执行、不回传（打印将要跑的命令）
凭据（环境变量）：ALYSIA_WEBUI_TOKEN（调 alysia API）、DEEPSEEK_API_KEY（dsh 跑模型）`);
}

// ── HTTP ───────────────────────────────────────────────────────

async function api(cfg, method, path, body) {
  const res = await fetch(`${cfg.base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 就留着原文 */ }
  return { status: res.status, ok: res.ok, json, text };
}

// ── 拼命令（★ 纯函数，便于单测/预演）─────────────────────────────

/**
 * 把任务拼成 dsh 命令行。
 *
 * ⚠️ **任务正文要写在位置参数里**，不写临时文件：dsh 的 headless 位置参数就是任务文本。
 * ⚠️ 验收标准附在正文后面（它同样是给执行体看的约束），而不是只留在服务端。
 */
export function buildTaskText(task) {
  const lines = [task.goal];
  if (task.revision > 0) {
    lines.push('', `（这是第 ${task.revision} 轮修改，请在**同一个工程会话**里继续，不要重新搭。）`);
  }
  if (task.acceptanceCriteria) {
    lines.push('', `验收标准：${task.acceptanceCriteria}`);
  }
  return lines.join('\n');
}

export function buildDshArgs(task, profile) {
  const args = ['--profile', profile, '--json'];
  // ★ 只有已经有过工程会话时才带 —— 首轮带了会报 unknown id
  if (task.dshSessionId) args.push('--session-id', task.dshSessionId);
  args.push(buildTaskText(task));
  return args;
}

// ── 回执地址：本轮产出的**那个页面**（★ 纯函数）────────────────

/**
 * `/p/<id>/` → `/w/<id>/`（基站的**只读预览通道**）。
 *
 * ★ 2026-10-18（change: `fix-receipt-link-to-produced-page`）：
 *   契约 38 要求回执带"她刚做的那个页面"，但 `allowPublish` 默认 false ⇒
 *   多数轮次产物**没进 `public/`**，`/p/<id>/<文件>` 会是 404。
 *   于是同一份工作区另开一条只读通道 `/w/<id>/`（扩展名白名单，见 `preview-serve.py`），
 *   让"还没上线"的页面也点得开 —— 而不是靠自动发布绕过 allowPublish（违反契约 62/72）。
 *
 * ⚠️ 约定优于配置：`/p/` 与 `/w/` 是同一个基站的两个前缀（`preview-hub.py` 同时生成），
 *   不在 config 里再加一个 `previewUrl` —— 那要让 `loadConfig()` 多映射一个字段，
 *   而"新配置段静默丢弃"这个坑本仓踩过两次。
 *
 * @returns 预览前缀（形如 `http://host:3389/w/<id>/`）；publicUrl 形状不认识 ⇒ 原样返回
 */
export function previewBase(publicUrl) {
  const u = typeof publicUrl === 'string' ? publicUrl.trim() : '';
  if (!u) return '';
  const m = /^(.*)\/p\/([^/]+)\/?$/.exec(u);
  return m ? `${m[1]}/w/${m[2]}/` : u;
}

/**
 * 本轮产出的页面（工作区**根目录**的 `*.html`，`mtime ≥ sinceMs`，最新优先）。
 *
 * 判据为什么是 mtime 而不是"她说的"：契约 68 —— 判据取文件事实，不取自述。
 * 为什么不递归 `drafts/`：草稿是过程物，不是"她做出来的那个页面"（阶段白名单同口径）。
 *
 * @param {string} workspace 工作区绝对路径
 * @param {number} sinceMs   本轮开始时刻（ms）
 * @param {(rel: string) => boolean} isPublished 该页面是否已在 `public/` 里
 * @param {(rel: string) => number} mtimeOf      取 mtime（便于单测注入）
 * @returns {Array<{ path: string, published: boolean }>} 新 → 旧
 */
export function artifactPages(workspace, sinceMs, isPublished, mtimeOf) {
  const out = [];
  let names = [];
  try {
    names = readdirSync(workspace);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/\.html$/i.test(name)) continue;
    const rel = name;
    let mt;
    try {
      mt = mtimeOf ? mtimeOf(rel) : statSync(join(workspace, rel)).mtimeMs;
    } catch {
      continue;
    }
    if (!Number.isFinite(mt) || mt + 1 < sinceMs) continue; // +1：容 1ms 精度抖动
    let published = false;
    try {
      published = Boolean(isPublished(rel));
    } catch {
      published = false;
    }
    out.push({ path: rel, published });
  }
  out.sort((a, b) => {
    // 最新优先；`index.html` 在并列时让位（它是项目门牌的落点，不是"这一件的名字"）
    if (a.path === 'index.html' && b.path !== 'index.html') return 1;
    if (b.path === 'index.html' && a.path !== 'index.html') return -1;
    return 0;
  });
  return out;
}

/**
 * 页面 → 可点开的地址（已发布走 `/p/`，没发布走 `/w/` 预览；`index.html` = 目录本身）。
 */
export function pageUrl(publicUrl, page) {
  const base = typeof publicUrl === 'string' ? publicUrl.trim() : '';
  const rel = typeof page?.path === 'string' ? page.path : '';
  if (!base || !rel) return base;
  if (/^index\.html$/i.test(rel)) return base;
  const dir = base.endsWith('/') ? base : `${base}/`;
  return `${(page.published ? dir : previewBase(base)) + rel}`;
}

// ── 解析 dsh 的 `--json` 事件流（★ 纯函数）──────────────────────

/**
 * 从 NDJSON 事件流里取终态。
 *
 * 事件形状（实测）：
 *   {"type":"session","sessionId":"session-…","cwd":"…"}
 *   {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
 *   {"type":"final","text":"…"}
 *
 * @returns {{ sessionId: string|null, reason: string|null, finalText: string, badLines: number }}
 */
export function parseRunEvents(ndjson) {
  let sessionId = null;
  let reason = null;
  let finalText = '';
  let badLines = 0;
  for (const raw of String(ndjson).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { badLines++; continue; }
    if (ev?.type === 'session' && typeof ev.sessionId === 'string') sessionId = ev.sessionId;
    if (ev?.type === 'status' && ev.phase === 'turn_end' && typeof ev.reason?.kind === 'string') reason = ev.reason.kind;
    if (ev?.type === 'final' && typeof ev.text === 'string') finalText = ev.text;
  }
  return { sessionId, reason, finalText, badLines };
}

/**
 * 终态映射 —— **runner 永远不写 `completed`**。
 *
 * - dsh 正常结束（`completed`）⇒ `needs_review`：这一轮跑完了，但**产品验收**是另一件事。
 * - `error` ⇒ `failed`（dsh 给了明确失败证据）。
 * - 其它/拿不到 reason ⇒ `unknown`：**无法确认**，不许自动重投。
 */
export function mapOutcome({ reason, timedOut }) {
  if (timedOut) return { status: 'unknown', error: '执行超时——无法确认远端是否已完成，不自动重投' };
  if (reason === 'completed') return { status: 'needs_review' };
  if (reason === 'error') return { status: 'failed', error: 'dsh 报错结束（看 result.raw 的 stderr）' };
  return { status: 'unknown', error: `无法确认执行结果（turn_end.reason=${reason ?? '缺失'}）` };
}

// ── 执行 ───────────────────────────────────────────────────────

function runDsh({ workspace, profile, task, timeoutSec, allowPublish }) {
  return new Promise((resolve) => {
    const args = buildDshArgs(task, profile);
    const child = spawn('dsh', args, {
      cwd: workspace,
      // ★ 2026-10-19（change: `give-her-a-publish-tool`）：把"这次允不允许上线"
      //   透传给她手上的 `publish_page` 工具（`ALYSIA_ALLOW_PUBLISH=0` ⇒ 工具直接拒绝）。
      //   来源：服务端在**认领响应**里按任务来源判好（自发起 = 由配置决定；用户委托 = 允许）。
      env: { ...process.env, ALYSIA_ALLOW_PUBLISH: allowPublish === false ? '0' : '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // ★ 2026-10-18（change: `scope-loop-to-this-round`）：起**独立进程组**，
      //   超时时整组杀。dsh 会拉起 bwrap/chromium（她自己截图用的），
      //   只杀父进程会留下孤儿 chrome 吃内存（实测一次 13 个进程、几百 MB）。
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');   // 负号 = 整个进程组
      } catch {
        child.kill('SIGKILL');                  // 兜底（组已经不存在等）
      }
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\nspawn failed: ${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ── 主循环 ─────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 上一次"暂停认领"的日志内容 —— 避免每轮刷同一行 */
let lastPauseLine = '';

/**
 * 认领请求的 URL。
 *
 * ★ 2026-10-18：`project` 为空 ⇒ **不带查询参数** ⇒ 服务端挑"还有活的最老的项目"。
 *   起因：runner 按项目起服务时，新登记的项目永远没人认领（任务静默排队）。
 */
export function nextUrl(project) {
  return project
    ? `/api/project-tasks/next?projectId=${encodeURIComponent(project)}`
    : '/api/project-tasks/next';
}

/**
 * 从**工作区文件**读出状态机需要的事实（★ change: `make-author-iterate`）。
 *
 * ★ 为什么在 runner 这边算：只有它能读宿主上的工作区。
 *   但**判据在服务端**（纯函数 `advanceLoop`）—— 执行端不能自己宣布"我改好了"。
 *
 * ★★ 2026-10-18（change: `scope-loop-to-this-round`）：**只报"这一轮动过的"**。
 *
 * 真机事故：同一工作区做第二个任务时，上一轮留下的 `drafts/a,b,c.html` 与
 * `shots/draft-*.png` 还在 ⇒ sketch 闸门「6 个草图都有截图」直接放行，
 * 于是**这一轮什么都没做也能推进**；`NOTES.md` 的「自评」「选的」同理。
 *
 * @param {string} workspace 工作区绝对路径
 * @param {number} [sinceMs] 本轮开始时刻（ms）。给了 ⇒ 只算 `mtime ≥ sinceMs` 的文件；
 *                           不给 ⇒ 老行为（全工作区，仅供单测/兼容）
 */
export function collectFacts(workspace, sinceMs) {
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  const list = (dir, re) => {
    try {
      return readdirSync(dir)
        .filter((f) => re.test(f))
        .filter((f) => {
          if (!Number.isFinite(sinceMs)) return true;
          const st = stat(join(dir, f));
          // +1：容 1ms 精度抖动（她可能在开工同一毫秒里落第一个文件）
          return st ? st.mtimeMs + 1 >= sinceMs : false;
        })
        .sort();
    } catch {
      return [];
    }
  };
  const stat = (p) => {
    try {
      return statSync(p);
    } catch {
      return null;
    }
  };

  const notesStat = stat(join(workspace, 'NOTES.md'));
  const notes = read(join(workspace, 'NOTES.md'));
  const drafts = list(join(workspace, 'drafts'), /\.html$/i);
  const shots = list(join(workspace, 'shots'), /\.(png|jpe?g|webp)$/i);

  const builtPages = [];
  try {
    for (const f of readdirSync(workspace)) {
      if (!/\.html$/i.test(f)) continue;
      const st = stat(join(workspace, f));
      if (!st) continue;
      // 同样只认本轮动过的（否则上一轮的页面会让 build 闸门直接放行）
      if (Number.isFinite(sinceMs) && st.mtimeMs + 1 < sinceMs) continue;
      builtPages.push({ file: f, mtime: st.mtimeMs });
    }
  } catch {
    /* 工作区都读不到就只能报空 */
  }
  builtPages.sort((a, b) => b.mtime - a.mtime);

  // 已发布：public/ 里出现了某个"做出来的页面"的同名文件
  const publishedNames = list(join(workspace, 'public'), /\.html$/i);
  const published = builtPages.some((p) => publishedNames.includes(p.file));

  return {
    notes,
    drafts,
    shots,
    builtPages,
    published,
    // ★ 这一轮的笔记动过没有（`advanceLoop` 用它挡"上一轮的自评"）
    notesMtime: notesStat ? notesStat.mtimeMs : 0,
    ...(Number.isFinite(sinceMs) ? { sinceMs } : {}),
  };
}

/**
 * ⚠️ 2026-10-19（change: `give-her-a-publish-tool`）：**阶段写路径白名单已删除。**
 *
 * 它原本做的事是"轮末把阶段外写的文件搬进 `.phases/violations/`"。真机三次代价：
 * 988 / 53 个文件被搬走、`AGENTS.md` 被搬走（那一轮她没有 workspace instructions）、
 * 她按任务要求发布进 `public/` 导致**整站被搬走、站点断了一分钟**。
 *
 * 结论：路径白名单不是能力边界（她本来就能 `cp`；真边界是 dsh 的 bwrap），
 * 它唯一有效的作用是把她的成果弄坏。⇒ 改成两件事：
 *   ① 工作区随便写，**不搬任何文件**（`inspectPhaseWrites` 只记账）
 *   ② "上线"走能力工具 `publish_page`（`packages/dsh-adapter/src/publish-page.ts`）
 */

/**
 * 每个阶段自己的执行上限（秒）。
 *
 * ★ 2026-10-18（change: `scope-loop-to-this-round`）：原来全阶段共用 1800s，
 * 而 build 要 npm 下 three.js + 反复截图 ⇒ **实测 1801s 被 SIGKILL** ⇒ `unknown`（不自动重投）
 * ⇒ 任务卡死，用户重开又从 `intent` 走一遍六阶段。这不是"执行端不听话"，是**给了必然不够的预算**。
 * ⚠️ `--timeout` 显式传入时仍然统一覆盖（排障/演示要能压短）。
 */
export const PHASE_TIMEOUT_SEC = {
  intent: 900,
  review: 900,
  statement: 900,
  sketch: 2400,
  revise: 3600,
  publish: 1200,
  build: 5400,
};

export function timeoutForPhase(phase, forced) {
  if (Number.isFinite(forced) && forced > 0) return forced; // --timeout 显式压过一切
  return PHASE_TIMEOUT_SEC[phase] ?? 1800;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.phases',
  'dist',
  '.cache',
  // ★ `.tmp/` 是**工具缓存**（npm-cache、chrome 日志、她的临时脚本）。
  //   不进快照 ⇒ 不会被判"阶段外写入"，也不会每轮刷出上千条噪音（实测 988 条）。
  '.tmp',
]);

/** 快照：相对路径 → `size:mtime`（只判"变没变"，不做内容校验） */
export function snapshotTree(workspace, rel = '') {
  const out = {};
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(join(workspace, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(childRel);
      } else if (e.isFile()) {
        try {
          const st = statSync(join(workspace, childRel));
          out[childRel] = `${st.size}:${Math.round(st.mtimeMs)}`;
        } catch {
          /* 读不到就算了 */
        }
      }
    }
  };
  walk(rel);
  return out;
}

/**
 * 读她通过 `publish_page` **工具**发出去的文件（本轮的）。
 *
 * ★ 2026-10-19：工具会往 `<工作区>/.alysia-publish-log.jsonl` 追加 `{at, files}`。
 * 没有这个标记，回执会把"走正路"也写成"绕过工具直接动了 public/" —— 那是冤枉她。
 *
 * @returns `Set<string>`：本轮（`sinceMs` 之后）由工具发布的 `public/` 相对路径
 */
export function readPublishLog(workspace, sinceMs = 0) {
  const out = new Set();
  let text = '';
  try {
    text = readFileSync(join(workspace, '.alysia-publish-log.jsonl'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    const at = Date.parse(String(ev?.at ?? ''));
    if (!Number.isFinite(at) || at + 1000 < sinceMs) continue;
    for (const f of Array.isArray(ev?.files) ? ev.files : []) {
      if (typeof f === 'string' && f) out.add(`public/${f}`);
    }
  }
  return out;
}

/**
 * 阶段结束后的**记账**（★ 2026-10-19，change: `give-her-a-publish-tool` 重写）。
 *
 * 原名 `rollbackOutOfPhase`：把"阶段外写入"**移出**工作区（`.phases/violations/`，不删）。
 * 那个机制真机上把她的东西搬走过三次：
 *   ① sketch 轮她写了整页 ⇒ 988 / 53 个文件被搬走（含 63 张她拍的截图）
 *   ② 我的枚举式白名单漏了 `AGENTS.md`，又在轮次中间改它 ⇒ 她的说明书被搬走，那一轮没有 workspace instructions
 *   ③ 她按任务要求**把页面发布进 `public/`** ⇒ **整站 7 个文件被搬走，站点断了一分钟**
 *
 * 结论：路径白名单不是能力边界（她本来就能 `cp` 进 `public/`；真边界是 dsh 的 bwrap 沙箱），
 * 它唯一有效的作用是**把她的成果弄坏**。⇒ 现在**只记账、不搬文件**：
 * 唯一值得记的是「`public/` 在非 publish 阶段被动过、且**不是**通过 `publish_page`」——
 * 那才是"绕过正路直接上线"的痕迹。
 *
 * @param explained 经由工具发布的文件（`readPublishLog` 的结果）—— 从账单里排除，别冤枉她
 * @returns `{ violations: string[], moved: [] }`（`moved` 恒空，保留字段避免改回执渲染）
 */
export function inspectPhaseWrites(workspace, before, phase, round, explained = new Set()) {
  const after = snapshotTree(workspace);
  const violations = [];
  void round;

  const touchedPublic = (rel) => /^public\//.test(rel);
  if (phase !== 'publish') {
    for (const rel of Object.keys(after)) {
      if (!touchedPublic(rel) || explained.has(rel)) continue;
      if (before[rel] === undefined) violations.push(`新增 ${rel}`);
      else if (before[rel] !== after[rel]) violations.push(`改动 ${rel}`);
    }
    for (const rel of Object.keys(before)) {
      if (touchedPublic(rel) && !(rel in after) && !explained.has(rel)) violations.push(`删除 ${rel}`);
    }
  }
  return { violations, moved: [] };
}

/** 从 NOTES.md 里取某个 `## 小节` 的正文（与服务端同规则，逐行扫） */
export function extractSection(notes, heading) {
  const want = new RegExp(`^##\\s*${heading}\\s*$`);
  const out = [];
  let inside = false;
  for (const line of String(notes ?? '').split(/\r?\n/)) {
    if (want.test(line)) {
      inside = true;
      continue;
    }
    if (/^##\s/.test(line)) {
      if (inside) break;
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * 一次**阶段推进**：把"这一轮只做这一件事"拼进任务正文。
 *
 * 阶段指令由服务端下发（`nextPrompt`），runner 不在本地抄一份 —— 单一来源。
 */
export function buildPhaseTask(task, prompt) {
  const base = buildTaskText(task);
  if (!prompt) return base;
  return `${base}\n\n=== 这一轮只做这一件事（做完就停，别抢后面的步骤） ===\n${prompt}`;
}

async function tick(cfg, log) {
  // ★ 不传 --project ⇒ 不带查询参数 ⇒ 服务端挑"还有活的最老的项目"（一个 runner 服务所有项目）
  const url = nextUrl(cfg.project);
  const claimed = await api(cfg, 'GET', url);
  if (!claimed.ok) {
    log(`认领失败（HTTP ${claimed.status}）：${claimed.json?.error ?? claimed.text?.slice(0, 200)}`);
    return { didWork: false };
  }
  const claimedBody = claimed.json ?? {};
  const { task, project, paused, allowPublish } = claimedBody;
  let nextPrompt = claimedBody.nextPrompt ?? '';

  // ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）：
  //   高峰时段（北京时间工作日 9-12 / 14-18）服务端**不认领**。
  //   这不是错误，是省钱：DeepSeek 的价按执行时间算，排队不花钱。
  //   ⚠️ 别每轮都刷同一行日志（15s 一条会淹没真正的问题）——只在"说法变了"时打。
  if (paused) {
    const line = `⏸ 暂停认领（高峰时段）：${paused.message}`;
    if (line !== lastPauseLine) {
      log(line);
      lastPauseLine = line;
    }
    return { didWork: false };
  }

  if (!task) return { didWork: false };   // 空闲是常态
  lastPauseLine = '';                     // 恢复执行时清掉，下次暂停还能再报一次

  log(`认领到 ${task.taskId}（revision ${task.revision}，第 ${task.attempts} 次）`);
  /**
   * ★ 2026-10-19（change: `let-tasks-declare-their-kind`）：
   *   `action`（发布 / 核实 / 改一处）是**做一件事**，不套六阶段循环 —— 单轮跑完就交。
   *   起因：真机上"只发布 island.html"被套上 intent/sketch/…，在 `intent` **空转 7 轮**
   *   （闸门要「## 意图」，目标却写"别改文件"），连着 5 次发布成功却被反复打回。
   */
  const singleShot = task.kind === 'action';
  if (singleShot) {
    log('  类型：action（单轮任务 —— 做完就交，不套六阶段）');
    // ★ 防御：单轮任务**绝不**拼阶段指令。服务端已经不下发（`nextPrompt` 空），
    //   这里再挡一次 —— 真机踩过：让她"发布"，她照着 intent 指令跑去写「## 意图」了。
    nextPrompt = '';
  } else {
    log(`  阶段：${task.phase ?? '(无)'}${nextPrompt ? '（按阶段推进）' : '（一次性任务）'}`);
  }
  log(`  工作区：${project.workspace}`);

  if (cfg.dryRun) {
    log('  --dry-run：不执行、不回传');
    return { didWork: true };
  }

  // ── 阶段循环（★ 2026-10-18：一次成型不合格，要来回）────────────────────
  /**
   * ★ 2026-10-18（change: `fix-receipt-link-to-produced-page`）：回传时要知道
   *   「本轮从什么时候开始」才能判"哪个页面是这一轮做出来的"。
   *   放进模块级变量是为了不改 5 处 `submit()` 调用点 —— runner 一次只跑一个任务
   *   （单并发，契约 5），所以没有并发歧义。
   */
  runContext = { workspace: project.workspace, publicUrl: project.publicUrl, sinceMs: Date.now() };

  const maxRounds = cfg.loopMaxRounds ?? 8;
  let phasePrompt = nextPrompt ?? '';
  let currentPhase = task.phase ?? 'intent';
  let sessionId = null;
  let finalText = '';
  let lastDetail = '';
  let rounds = 0;
  const violationsSeen = [];

  for (;;) {
    rounds += 1;
    const runTask = { ...task, goal: task.goal };
    const dshArgs = buildDshArgs(task, project.profile);
    log(`  [第 ${rounds} 轮] 阶段 ${currentPhase} · dsh ${dshArgs.slice(0, -1).join(' ')} <task>`);

    // 阶段前快照：用来拦"阶段外写入"
    const beforeSnapshot = snapshotTree(project.workspace);

    const started = Date.now();
    const run = await runDsh({
      workspace: project.workspace,
      profile: project.profile,
      task: { ...runTask, goal: buildPhaseTask(task, phasePrompt) },
      timeoutSec: timeoutForPhase(currentPhase, cfg.timeoutSec),
      // 服务端按**任务来源**判好的（自发起=配置决定；用户委托=允许），透传给 publish_page
      allowPublish: allowPublish !== false,
    });
    const parsed = parseRunEvents(run.stdout);
    const outcome = mapOutcome({ reason: parsed.reason, timedOut: run.timedOut });
    const secs = Math.round((Date.now() - started) / 1000);
    sessionId = parsed.sessionId ?? sessionId;
    finalText = parsed.finalText || finalText;
    log(
      `    退出码 ${run.code}，用时 ${secs}s，reason=${parsed.reason ?? '（缺失）'}` +
        (parsed.badLines ? `，NDJSON 坏行 ${parsed.badLines}` : ''),
    );

    // ★ 记账（**不搬文件**）：非 publish 阶段动了 `public/` 就记一笔；
    //   经由 `publish_page` 发出去的那部分**不算**（别冤枉她走正路）
    const toolPublished = readPublishLog(project.workspace, started);
    const rb = inspectPhaseWrites(project.workspace, beforeSnapshot, currentPhase, rounds, toolPublished);
    if (rb.violations.length > 0) {
      const line = `直接动了 public/ ${rb.violations.length} 处（没搬走；正常该用 publish_page 工具）：${rb.violations.join('、')}`;
      violationsSeen.push(`第 ${rounds} 轮（${currentPhase}）：${rb.violations.join('；')}`);
      log(`    ⚠️ ${line}`);
    }

    // 执行端明确报错/超时 ⇒ 不再推进阶段，直接回传（让服务端决定）
    if (outcome.status !== 'needs_review') {
      log(`    执行端不正常（${outcome.status}）—— 停止推进`);
      return await submit(cfg, log, task, {
        status: outcome.status,
        sessionId,
        finalText,
        secs,
        exitCode: run.code,
        error: outcome.error,
        violations: violationsSeen,
      });
    }

    // ★ 单轮任务（`kind: 'action'`）：跑完一轮就交，**不进阶段闸门**
    //   她做完那件事就算完成；不再要求她写「## 意图」/草图（那是"做新东西"的仪式）
    if (singleShot) {
      log('    单轮任务完成 —— 直接回传（不判阶段）');
      return await submit(cfg, log, task, {
        status: 'needs_review',
        sessionId,
        finalText,
        secs,
        exitCode: run.code,
        loopNote: '单轮任务（action）：做完就交，不套六阶段',
        violations: violationsSeen,
        selfStatement: extractSection(collectFacts(project.workspace, runContext?.sinceMs).notes, '哪里像我'),
      });
    }

    // 收集事实 → 让服务端判能不能进下一阶段
    // ★ 只报**这一轮**动过的（`runContext.sinceMs`）：上一轮的 drafts / 自评不再算数
    const facts = collectFacts(project.workspace, runContext?.sinceMs);
    const adv = await api(cfg, 'POST', `/api/project-tasks/${task.taskId}/advance`, { facts });
    if (!adv.ok) {
      log(`    推进失败（HTTP ${adv.status}）：${adv.json?.error ?? adv.text?.slice(0, 160)}`);
      return await submit(cfg, log, task, {
        status: 'unknown',
        sessionId,
        finalText,
        secs,
        exitCode: run.code,
        error: `状态机推进失败：${adv.json?.error ?? adv.status}`,
        violations: violationsSeen,
        selfStatement: extractSection(facts.notes, '哪里像我'),
      });
    }
    const decision = adv.json.decision;
    lastDetail = decision.detail;
    log(`    阶段 → ${decision.next}${decision.done ? `（完成：${decision.outcome}）` : ''} · ${decision.detail}`);

    const selfStatement = extractSection(facts.notes, '哪里像我');
    if (decision.done) {
      return await submit(cfg, log, task, {
        status: 'needs_review',
        sessionId,
        finalText,
        secs,
        exitCode: run.code,
        loopNote: `循环完成（${rounds} 轮）：${decision.detail}`,
        violations: violationsSeen,
        selfStatement,
      });
    }
    if (rounds >= maxRounds) {
      log(`    轮次到顶（${maxRounds}）—— 交给人`);
      return await submit(cfg, log, task, {
        status: 'needs_review',
        sessionId,
        finalText,
        secs,
        exitCode: run.code,
        loopNote: `轮次到顶（${maxRounds} 轮）：${lastDetail}`,
        violations: violationsSeen,
        selfStatement,
      });
    }
    phasePrompt = decision.prompt ?? '';
    currentPhase = decision.next;
  }
}

/** 回传时用到的"本轮上下文"（工作区 / 项目地址 / 起始时刻）；由 `tick()` 在认领后设置 */
let runContext = null;

/** 回传统一入口（把阶段信息拼进 final，回执里能看见过程） */
async function submit(cfg, log, task, o) {
  const notes = [];
  if (o.loopNote) notes.push(`[过程] ${o.loopNote}`);
  if (o.violations?.length) {
    // ★ 2026-10-19：不再"移出"，只是如实记一笔（文件一个都没动）
    notes.push(`[绕过 publish_page 直接动了 public/] ${o.violations.join(' / ')}（文件没动，已保留）`);
  }
  const final = [o.finalText ?? '', notes.length ? `\n\n${notes.join('\n')}` : ''].join('').slice(0, 4000);

  /**
   * ★ 2026-10-18（change: `fix-receipt-link-to-produced-page`）：把**本轮做出来的页面**
   * 随结果一起回传 —— 服务端在容器里，**看不见宿主工作区**，"哪个是本轮产物"只有这里能判。
   *
   * ⚠️ 地址在这一侧拼（runner 从认领响应里拿到的 `publicUrl`，不是模型给的），
   *   服务端只做**前缀合法性校验**后采用。这样"没发布 ⇒ 走 /w/ 预览"这条规则
   *   不需要容器知道 `public/<文件>` 在不在。
   */
  const artifacts = [];
  if (runContext?.workspace) {
    try {
      const pages = artifactPages(
        runContext.workspace,
        runContext.sinceMs ?? 0,
        rel => existsSync(join(runContext.workspace, 'public', rel)),
      );
      for (const p of pages.slice(0, 5)) {
        artifacts.push({ path: p.path, published: p.published, url: pageUrl(runContext.publicUrl, p) });
      }
      if (artifacts.length > 0) {
        log(`  本轮产物页面：${artifacts.map(a => `${a.path}${a.published ? '' : '（未发布·预览）'}`).join('、')}`);
        log(`  回执地址：${artifacts[0].url}`);
      }
    } catch (err) {
      log(`  ⚠️ 产物页面探测失败（不影响回传）：${err?.message ?? err}`);
    }
  }

  const res = await api(cfg, 'POST', `/api/project-tasks/${task.taskId}/result`, {
    status: o.status,
    dshSessionId: o.sessionId ?? undefined,
    result: {
      final,
      ranSeconds: o.secs,
      exitCode: o.exitCode,
      ...(o.selfStatement ? { selfStatement: o.selfStatement.slice(0, 600) } : {}),
    },
    artifacts,
    error: o.error,
  });
  if (!res.ok) {
    log(`  !! 回传失败（HTTP ${res.status}）：${res.json?.error ?? res.text?.slice(0, 200)}` +
        ` —— 任务保持 running，等超时回收`);
  } else {
    log(`  已回传：${res.json?.task?.status}`);
  }
  return { didWork: true };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

  // ★ 2026-10-18：`--project` 不再是必填。不传 = 服务所有项目（服务端挑"还有活的最老的项目"）。
  //   起因：按项目起服务时，新登记的项目永远没人认领（任务静默排队，实测 580 秒才发现）。
  if (!cfg.token) { console.error('缺 ALYSIA_WEBUI_TOKEN —— 服务器上 alysia 的 /api/* 强制鉴权'); process.exit(2); }
  if (!process.env.DEEPSEEK_API_KEY) {
    // ⚠️ 只警告不退出：dry-run 与调试时不需要模型凭据
    log('警告：环境里没有 DEEPSEEK_API_KEY —— 真跑任务会 MISSING_CREDENTIAL（见 /root/.dsh-web.env）');
  }

  log(`runner 启动：project=${cfg.project || '(全部登记项目)'} base=${cfg.base} interval=${cfg.intervalSec}s ` +
      `timeout=${cfg.timeoutSec ? `${cfg.timeoutSec}s（统一覆盖）` : '按阶段（intent/review/statement 900s · sketch 2400s · revise 3600s · build 5400s）'}` +
      `${cfg.dryRun ? ' [dry-run]' : ''}`);

  for (;;) {
    try {
      const { didWork } = await tick(cfg, log);
      if (cfg.once) { log(didWork ? '一轮完成（有任务）' : '一轮完成（空闲）'); return; }
      if (!didWork) await sleep(cfg.intervalSec * 1000);
    } catch (err) {
      // 轮询本身出错不该让 runner 死掉（网络抖动是常态）；但必须留痕
      log(`轮询异常：${err?.message ?? err}（${cfg.intervalSec}s 后重试）`);
      if (cfg.once) process.exit(1);
      await sleep(cfg.intervalSec * 1000);
    }
  }
}

// 被 import 时（测试）不要跑主循环
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
