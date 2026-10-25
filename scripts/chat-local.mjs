#!/usr/bin/env node
/**
 * **本地真机对话**（★ 2026-10-25，用户要求）
 *
 * 用户原话：「**本地验证直接对话一波吧，本地的数据调用真机不会被污染**」
 *
 * 上一版 smoke 只调 `/api/memory/read`（验组装结果里有没有规则）。
 * 那只能证明"规则到了模型面前"，**证明不了她说话像不像人**。这个脚本补上后半段：
 * 起本地真服务 → 用 `POST /api/chat/prompt` **真的跟她聊几轮** → 把她的原话打出来 + 算几个指标。
 *
 * 安全边界（与 smoke 相同）：
 * - **删掉 `platforms`** ⇒ 不连 QQ（同一 AppID 两处在线会互踢）
 * - 端口 6188、数据目录 `.tmp/chat-local/`（**不碰生产、也不碰 smoke 的临时库**）
 * - 全程只读生产：一个字节都不发到服务器
 *
 * 用法：
 *   node scripts/chat-local.mjs                 # 默认 3 轮
 *   node scripts/chat-local.mjs --fresh         # 清空本地对话库（要从头开始）
 *   node scripts/chat-local.mjs --say "在干嘛"  # 只发一句
 *   node scripts/chat-local.mjs --turns 5       # 改轮数
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const DATA_DIR = join(ROOT, '.tmp', 'chat-local');
const PORT = 6188;
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const FRESH = argv.includes('--fresh');
const sayIdx = argv.indexOf('--say');
const ONLY_SAY = sayIdx >= 0 ? argv[sayIdx + 1] : null;
const turnsIdx = argv.indexOf('--turns');
const TURNS = turnsIdx >= 0 ? Number(argv[turnsIdx + 1]) : 3;

const log = (m) => console.log(`\n▸ ${m}`);
const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n✖ ${m}`); process.exit(1); };

/** 默认台词：挑几种不同语气（闲聊 / 喊累 / 分享吃的），一次看够 */
const DEFAULT_LINES = [
  '在干嘛呢',
  '我今天有点累',
  '刚吃了牛肉丸+鸡蛋+泡面',
  '早点睡吧',
  '嗯',
];

function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) die('缺 .env');
  const env = { ...process.env };
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

async function makeConfig() {
  const yamlEntry = join(ROOT, 'node_modules', '.pnpm', 'yaml@2.7.0', 'node_modules', 'yaml', 'dist', 'index.js');
  const { default: YAML } = await import(pathToFileURL(yamlEntry).href);
  const cfg = YAML.parse(readFileSync(join(SERVER_DIR, 'config.yml'), 'utf8'));
  delete cfg.platforms; // ⚠️ 红线：本地绝不连 QQ
  delete cfg.projects;  // 本地没有宿主 runner
  cfg.server = { ...(cfg.server || {}), port: PORT, dataDir: join(DATA_DIR, 'data'), workspaceDir: join(DATA_DIR, 'data', 'workspace') };
  delete cfg.server.host;
  mkdirSync(DATA_DIR, { recursive: true });
  const out = join(DATA_DIR, 'config.yml');
  writeFileSync(out, YAML.stringify(cfg), 'utf8');
  return out;
}

/** 数她的回复：长度 / 语气词 / 问号 / ♪ —— 只做展示，不做判定（口味由人定） */
function metrics(text) {
  const t = String(text ?? '');
  const particles = (t.match(/[呀呢啦哦嘛吧诶欸咯喽]/g) || []).length;
  return {
    len: t.length,
    particles,
    q: /[？?]/.test(t),
    note: t.includes('♪'),
    open: /^[\s「]*(欸|哦|嗯|啊|诶|哈)/.test(t),
  };
}

(async () => {
  log('本地真机对话（不碰生产）');
  const env = loadEnv();
  if (!existsSync(join(SERVER_DIR, 'dist', 'bootstrap.js'))) die('缺 dist —— 先 `pnpm -r build`（或跑 pnpm smoke）');

  if (FRESH) { rmSync(join(DATA_DIR, 'data'), { recursive: true, force: true }); say('已清空本地对话库'); }
  try {
    const probe = await fetch(`${BASE}/api/health`);
    if (probe.ok) die(`端口 ${PORT} 已有服务在跑 —— 先关掉`);
  } catch { /* 空着 */ }

  const cfgPath = await makeConfig();
  const child = spawn(process.execPath, ['dist/bootstrap.js'], {
    cwd: SERVER_DIR,
    env: { ...env, ALYSIA_CONFIG: cfgPath, ALYSIA_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const cleanup = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
  process.on('exit', cleanup);

  // 等健康
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 90_000) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) { console.error(out.slice(-2000)); cleanup(); die('本地服务没起来'); }
  say(`✓ 服务就绪（${PORT}，数据目录 .tmp/chat-local）`);

  // ★ 启动期修复要看得见（不静默改数据）：把 persona-seed 的 warn 抖出来
  const repair = out.split('\n').filter((l) => /第三人称|冲空的人格列/.test(l));
  for (const l of repair) say(`⚠ 启动修复：${l.replace(/^\[[^\]]*\]\s*/, '').trim()}`);

  const token = env.ALYSIA_WEBUI_TOKEN || '';
  const sessionId = `local-${Date.now()}`;
  const lines = ONLY_SAY ? [ONLY_SAY] : DEFAULT_LINES.slice(0, TURNS);

  log(`开始对话（session ${sessionId.slice(-8)}，${lines.length} 轮）`);
  const results = [];
  for (const line of lines) {
    const t = Date.now();
    let r;
    try {
      const resp = await fetch(`${BASE}/api/chat/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: line, sessionId }),
        signal: AbortSignal.timeout(120_000),
      });
      r = await resp.json();
    } catch (e) {
      r = { ok: false, error: String(e?.message ?? e) };
    }
    const ms = Date.now() - t;
    if (!r.ok) {
      console.log(`\n他：${line}\n她：（失败 ${r.error}，${ms}ms）`);
      // ★ 失败时把服务端日志抖出来 —— 否则"All providers failed"这种话等于没说
      const tail = out.split('\n').filter((l) => /LLM|Provider|error|ERROR|WARN|fail/i.test(l)).slice(-12).join('\n');
      if (tail) console.log('    --- 服务端相关日志 ---\n' + tail.split('\n').map((l) => '    ' + l).join('\n'));
      continue;
    }
    const m = metrics(r.reply);
    console.log(`\n他：${line}`);
    console.log(`她：${r.reply}`);
    console.log(`    ${m.len} 字 · 语气词 ${m.particles} 个 · ${m.q ? '有问句' : '无问句'}${m.note ? ' · 含♪' : ''}${m.open ? ' · 语气词起头' : ''} · ${ms}ms`);
    results.push({ line, reply: r.reply, ...m });
  }

  if (results.length) {
    log('汇总（口味你自己判断，我只把这些摆出来）');
    const avg = Math.round(results.reduce((s, x) => s + x.len, 0) / results.length);
    say(`平均 ${avg} 字 · 含问句 ${results.filter((x) => x.q).length}/${results.length} · 语气词起头 ${results.filter((x) => x.open).length}/${results.length}`);
    say(`本地库在 .tmp/chat-local/data（多轮会累积记忆，下次可 --fresh 重来）`);
  }

  cleanup();
  // ★ 不用 process.exit：Windows 上强退会撞 uv_async 句柄（Assertion failed ... async.c）
  //   ⇒ 明明成功却返回 0xC0000409。改成设 exitCode 让事件循环自然排空。
  process.exitCode = results.length ? 0 : 1;
})();
