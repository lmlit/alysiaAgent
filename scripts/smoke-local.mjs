#!/usr/bin/env node
/**
 * **本地真机 smoke —— 推送生产前必须过这一关**（★ 2026-10-25）
 *
 * ## 为什么有这个脚本
 *
 * 2026-10-25 我一整天"改完直接推生产"，把生产当测试环境。
 * 用户原话：「**靠，你什么时候养出来的坏毛病，直接推生产，本地改完本地真机测一下调用 api 测，
 * 测完没问题再推服务器好不好**」
 *
 * 这个仓里靠记性的约束最终都会失效，所以做成**机器闸**：
 * `scripts/deploy.mjs` 在构建/上传前必须先跑本脚本，**不过就不许推**。
 *
 * ## 它做什么
 *
 * 1. 读仓库根 `.env`（只注入本进程，不落盘）
 * 2. 生成**临时配置**：抄本地 `config.yml`，然后
 *    - **删掉整个 `platforms`** ⇒ QQ / OneBot 适配器不会被注册
 *      （⚠️ 关键：同一 AppID 两处同时在线会**互踢**，这是 SOP 明写的红线）
 *    - `server.port` 改成 6187（避开本机 6185 与生产 6186）
 *    - `dataDir` / `workspaceDir` 指向 `.tmp/smoke/`（**不碰本地开发库**）
 * 3. 起真服务（`node dist/bootstrap.js`），等 `/api/health`
 * 4. **调真 API**：`POST /api/memory/read`，断言组装结果里
 *    - 必须有：说话的分寸 / 说话的手感 / 开口可以先有反应
 *    - 必须没有：被产品否决的「合计最多一处」「优先于」
 * 5. 杀掉进程（含异常路径）；任一步失败 ⇒ 退出码非 0
 *
 * 用法：
 *   node scripts/smoke-local.mjs          # 必跑项
 *   node scripts/smoke-local.mjs --life   # 额外验生活推送的 JSON 契约（仍需外网）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SMOKE_DIR = join(ROOT, '.tmp', 'smoke');
const PORT = 6187;
const BASE = `http://127.0.0.1:${PORT}`;
const WITH_LIFE = process.argv.includes('--life');

const log = (m) => console.log(`\n▸ ${m}`);
const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n✖ ${m}`); process.exit(1); };

function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) die('缺 .env（本地真机要 API key / webui token）');
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

/** 生成 smoke 专用配置：去 platforms、改端口、隔离数据目录 */
async function makeSmokeConfig() {
  // ⚠️ Windows：动态 import 绝对路径必须转成 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const { pathToFileURL } = await import('node:url');
  const yamlEntry = join(ROOT, 'node_modules', '.pnpm', 'yaml@2.7.0', 'node_modules', 'yaml', 'dist', 'index.js');
  const { default: YAML } = await import(pathToFileURL(yamlEntry).href);
  const raw = readFileSync(join(SERVER_DIR, 'config.yml'), 'utf8');
  const cfg = YAML.parse(raw);

  // ⚠️ 红线：本地绝不能连 QQ —— 同一 AppID 两处在线会互踢
  delete cfg.platforms;
  cfg.server = { ...(cfg.server || {}), port: PORT, dataDir: join(SMOKE_DIR, 'data'), workspaceDir: join(SMOKE_DIR, 'data', 'workspace') };
  delete cfg.server.host; // 本地必须绑回环，别写成 0.0.0.0

  mkdirSync(SMOKE_DIR, { recursive: true });
  const out = join(SMOKE_DIR, 'config.yml');
  writeFileSync(out, YAML.stringify(cfg), 'utf8');
  return out;
}

async function waitHealth(timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

(async () => {
  log('本地真机 smoke（推送生产的必经关）');

  const env = loadEnv();
  if (!existsSync(join(SERVER_DIR, 'dist', 'bootstrap.js'))) die('缺 packages/server/dist —— 先 `pnpm -r build`');

  // ★★ 必须先重建：smoke 起的是 `dist/bootstrap.js`，测的是**编译产物**。
  //    改了 src 不重建 ⇒ 这个闸会**验旧代码**（比没有闸更危险：它给你一个假的安全感）。
  if (!process.argv.includes('--no-build')) {
    log('重建（core + server 的 dist 必须是最新的）');
    const b = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['-r', '--filter', '@alysia/core', '--filter', '@alysia/server', 'build'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
    });
    let bout = '';
    b.stdout.on('data', (d) => { bout += d.toString(); });
    b.stderr.on('data', (d) => { bout += d.toString(); });
    const code = await new Promise((res) => b.on('close', res));
    if (code !== 0) { console.error(bout.slice(-1500)); die('重建失败 —— 不许推生产'); }
    say('✓ dist 已重建（测的是当前源码，不是旧产物）');
  }

  const token = env.ALYSIA_WEBUI_TOKEN || '';
  if (!token) die('.env 里没有 ALYSIA_WEBUI_TOKEN');

  // 端口干净检查（有旧进程就先说，别测到旧代码）
  try {
    const probe = await fetch(`${BASE}/api/health`);
    if (probe.ok) die(`端口 ${PORT} 上已有服务在跑 —— 先关掉，否则测的是旧进程`);
  } catch { /* 空着，正合适 */ }

  rmSync(join(SMOKE_DIR, 'data'), { recursive: true, force: true });
  const cfgPath = await makeSmokeConfig();
  say(`✓ 临时配置 ${cfgPath.replace(ROOT + '\\', '')}（已删 platforms ⇒ 不连 QQ；数据目录隔离）`);

  say(`启动 node dist/bootstrap.js …`);
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

  const health = await waitHealth();
  if (!health) {
    console.error('\n--- 服务日志（末 2000 字）---\n' + out.slice(-2000));
    cleanup();
    die('本地服务 90s 内没起来');
  }
  say(`✓ /api/health → ${JSON.stringify(health)}`);

  log('调真 API：POST /api/memory/read');
  const r = await fetch(`${BASE}/api/memory/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: '在干嘛', mode: 'chat', blocks: 'chat', limit: 2 }),
  });
  if (!r.ok) { console.error(out.slice(-1500)); die(`/api/memory/read → HTTP ${r.status}`); }
  const j = await r.json();
  const ctx = j.context || '';
  say(`✓ context ${ctx.length} 字`);

  for (const m of ['【说话的分寸】', '【说话的手感】', '开口可以先有反应']) {
    if (!ctx.includes(m)) die(`组装结果缺「${m}」—— 规则没到模型面前`);
    say(`✓ 含「${m}」`);
  }
  for (const m of ['合计最多一处', '优先于']) {
    if (ctx.includes(m)) die(`出现了被产品否决的「${m}」—— 有人把它加回来了`);
    say(`✓ 不含「${m}」（已被否决）`);
  }

  if (WITH_LIFE) {
    log('调真模型：生活推送第二段的 JSON 契约（worth/why/say）');
    const lifeDist = readFileSync(join(SERVER_DIR, 'dist', 'prompts', 'life.js'), 'utf8');
    if (!lifeDist.includes('"worth"')) die('LIFE_RETELL_PROMPT 丢了 worth 字段');
    say('✓ prompt 里含 worth/why/say 契约');

    const { pathToFileURL } = await import('node:url');
    const { LIFE_RETELL_PROMPT } = await import(
      pathToFileURL(join(SERVER_DIR, 'dist', 'prompts', 'life.js')).href
    );
    const base = (env.OPENAI_BASE_URL || '').replace(/\/v1\/?$/, '');
    const key = env.OPENAI_API_KEY || '';
    if (!base || !key) die('.env 缺 OPENAI_BASE_URL / OPENAI_API_KEY（--life 要真模型）');
    const userMsg = [
      '【此刻时间】14:00',
      '【你刚做的事】新米倒进缸里，按了按米面，指腹上沾了几粒。',
      '【你和轻月】亲密度 82/100（亲近），他今天跟你说过话',
      '判断这件事值不值得占用轻月一次注意力；值得就用一句话讲给他，不值得就 worth=false。只输出 JSON。',
    ].join('\n\n');
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: env.CHAT_MODEL || 'deepseek-v4-flash',
        messages: [{ role: 'system', content: LIFE_RETELL_PROMPT }, { role: 'user', content: userMsg }],
        temperature: 0.85, max_tokens: 2048, response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) die(`转述模型调用 HTTP ${resp.status}`);
    const jr = await resp.json();
    const txt = (jr.choices?.[0]?.message?.content ?? '').trim();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch { /* 下面统一报 */ }
    if (!parsed) die(`转述返回不是合法 JSON：${txt.slice(0, 120) || '(空)'}`);
    if (typeof parsed.worth !== 'boolean') die(`转述 JSON 缺 worth 布尔：${txt.slice(0, 120)}`);
    say(`✓ worth=${parsed.worth} · why=${String(parsed.why ?? '').slice(0, 30)}`);
    if (parsed.worth) {
      const sayText = String(parsed.say ?? '').trim();
      if (!sayText) die('worth=true 但 say 为空');
      if (sayText.length > 70) die(`say 超长（${sayText.length} 字 > 70）：${sayText.slice(0, 40)}`);
      say(`✓ say（${sayText.length} 字）「${sayText}」`);
    }
  }

  cleanup();
  log('本地真机 smoke 通过 ✓ —— 现在可以推生产');
  process.exit(0);
})();
