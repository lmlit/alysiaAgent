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
 *     --timeout <sec>     单个任务的执行上限（默认 1800）
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

// ── 参数 ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    project: process.env.PROJECT_TASK_PROJECT ?? '',
    base: process.env.ALYSIA_BASE_URL ?? 'http://127.0.0.1:6186',
    token: process.env.ALYSIA_WEBUI_TOKEN ?? '',
    intervalSec: 10,
    timeoutSec: 1800,
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
  console.log(`用法：node project-task-runner.mjs --project <id> [--once] [--dry-run]
  --project <id>    必须是 alysia config.yml 里 projects 登记过的 id
  --base <url>      alysia 基址（默认 http://127.0.0.1:6186）
  --interval <sec>  轮询间隔（默认 10）
  --timeout <sec>   单任务执行上限（默认 1800）
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

function runDsh({ workspace, profile, task, timeoutSec }) {
  return new Promise((resolve) => {
    const args = buildDshArgs(task, profile);
    const child = spawn('dsh', args, {
      cwd: workspace,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
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

async function tick(cfg, log) {
  const claimed = await api(cfg, 'GET', `/api/project-tasks/next?projectId=${encodeURIComponent(cfg.project)}`);
  if (!claimed.ok) {
    log(`认领失败（HTTP ${claimed.status}）：${claimed.json?.error ?? claimed.text?.slice(0, 200)}`);
    return { didWork: false };
  }
  const { task, project } = claimed.json ?? {};
  if (!task) return { didWork: false };   // 空闲是常态

  log(`认领到 ${task.taskId}（revision ${task.revision}，第 ${task.attempts} 次）`);
  const dshArgs = buildDshArgs(task, project.profile);
  log(`  将执行：dsh ${dshArgs.slice(0, -1).join(' ')} <task>`);
  log(`  工作区：${project.workspace}`);

  if (cfg.dryRun) {
    log('  --dry-run：不执行、不回传');
    return { didWork: true };
  }

  const started = Date.now();
  const run = await runDsh({
    workspace: project.workspace, profile: project.profile, task, timeoutSec: cfg.timeoutSec,
  });
  const { sessionId, reason, finalText, badLines } = parseRunEvents(run.stdout);
  const outcome = mapOutcome({ reason, timedOut: run.timedOut });
  const secs = Math.round((Date.now() - started) / 1000);
  log(`  dsh 退出码 ${run.code}，用时 ${secs}s，turn_end.reason=${reason ?? '（缺失）'}` +
      (badLines ? `，NDJSON 坏行 ${badLines}` : ''));

  const res = await api(cfg, 'POST', `/api/project-tasks/${task.taskId}/result`, {
    status: outcome.status,
    dshSessionId: sessionId ?? undefined,
    result: { final: finalText.slice(0, 4000), ranSeconds: secs, exitCode: run.code },
    artifacts: [],
    error: outcome.error,
  });
  if (!res.ok) {
    // ⚠️ 回传失败**不能**假装成功。任务会停在 running，由服务端的认领超时回收。
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

  if (!cfg.project) { console.error('缺 --project（或 PROJECT_TASK_PROJECT）'); printHelp(); process.exit(2); }
  if (!cfg.token) { console.error('缺 ALYSIA_WEBUI_TOKEN —— 服务器上 alysia 的 /api/* 强制鉴权'); process.exit(2); }
  if (!process.env.DEEPSEEK_API_KEY) {
    // ⚠️ 只警告不退出：dry-run 与调试时不需要模型凭据
    log('警告：环境里没有 DEEPSEEK_API_KEY —— 真跑任务会 MISSING_CREDENTIAL（见 /root/.dsh-web.env）');
  }

  log(`runner 启动：project=${cfg.project} base=${cfg.base} interval=${cfg.intervalSec}s ` +
      `timeout=${cfg.timeoutSec}s${cfg.dryRun ? ' [dry-run]' : ''}`);

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
