#!/usr/bin/env node
/**
 * **dev 主动触发一次「私密日记」**（★ 2026-10-25）
 *
 * 为什么需要它：私密日记是**跨天**触发（写"昨天"），等 0 点太慢。
 * 这个脚本走**真实代码路径**（`LifeService.maybePrivateDiary`）+ **真模型**，
 * 写进**本地**开发库（默认 `.tmp/chat-local/data`），不碰生产。
 *
 * 用法：
 *   node scripts/dev-private-diary.mjs                 # 触发一次
 *   node scripts/dev-private-diary.mjs --force          # 忽略"今天已写过"的去重
 *   node scripts/dev-private-diary.mjs --db <path>      # 指定库
 *
 * ⚠️ 它只调 `maybePrivateDiary`，**不**跑完整 tick（不会生成生活事件、不会推送）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const CORE = join(ROOT, 'packages', 'core', 'dist');
const SERVER = join(ROOT, 'packages', 'server', 'dist');
const argv = process.argv.slice(2);
const dbIdx = argv.indexOf('--db');
const DB = dbIdx >= 0 ? argv[dbIdx + 1] : join(ROOT, '.tmp', 'chat-local', 'data', 'alysia.db');
const FORCE = argv.includes('--force');

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n✖ ${m}`); process.exit(1); };

function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) die('缺 .env（要 API key）');
  const env = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

if (!existsSync(DB)) die(`本地库不存在：${DB}\n  先跑一次 \`pnpm chat\` 建库`);

const env = loadEnv();
const imp = (p) => import(pathToFileURL(p).href);
const { default: Database } = await imp(join(ROOT, 'node_modules', '.pnpm', 'better-sqlite3@12.11.1', 'node_modules', 'better-sqlite3', 'lib', 'index.js'));
const { initializeDatabase } = await imp(join(CORE, 'memory', 'database.js'));
const { MemoryManager } = await imp(join(CORE, 'memory', 'MemoryManager.js'));
const { LifeService } = await imp(join(SERVER, 'life.js'));
const { LIFE_PRIVATE_DIARY_PROMPT } = await imp(join(SERVER, 'prompts', 'life.js'));

const db = new Database(DB);
initializeDatabase(db);
const mm = new MemoryManager(db, null, { embed: async () => [0], dimension: () => 1 }, { complete: async () => '{}' });

// 真模型调用（与生产同一个 prompt / 同一个槽位参数）
const base = (env.OPENAI_BASE_URL || '').replace(/\/v1\/?$/, '');
const callModel = async (systemPrompt, context) => {
  const t0 = Date.now();
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.CHAT_MODEL || 'deepseek-v4-flash',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: context }],
      temperature: 0.9,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const j = await r.json();
  const text = (j.choices?.[0]?.message?.content ?? '').trim();
  console.log(`\n▸ 模型返回（${Date.now() - t0}ms，${text.length} 字，finish=${j.choices?.[0]?.finish_reason}）：`);
  console.log(text.split('\n').map((l) => '  ' + l).join('\n'));
  return text;
};

const svc = new LifeService(mm, { sendProactive: async () => true }, {
  ownerOpenid: 'dev-local',
  generatePrivateDiary: (ctx) => callModel(LIFE_PRIVATE_DIARY_PROMPT, ctx),
});

if (FORCE) (svc).state.privateDiaryDate = null;

// ★ dev 造素材：私密日记按设计"一天什么都没有就不写"（硬写就是编）。
//   本地聊天库没有生活事件 ⇒ 加 --seed 先插两条像样的事件。
if (argv.includes('--seed')) {
  const todayIso = new Date().toISOString();
  const existing = mm.listLifeEvents(1).length;
  if (existing === 0) {
    mm.recordLifeEvent({ type: 'internal', content: '晌午把最后一点米刮进锅里，煮得稀，凑合过了一顿。' });
    mm.recordLifeEvent({ type: 'internal', content: '下午缝薄袄袖子，线老是打结，剪了三回才顺。' });
    console.log(`▸ 已造 2 条生活事件（dev 素材，${todayIso.slice(0, 10)}）`);
  } else {
    console.log(`▸ 已有 ${existing} 条生活事件，不再造`);
  }
}

console.log(`▸ 触发 maybePrivateDiary（库：${DB.replace(ROOT + '\\', '')}）`);
await svc.maybePrivateDiary(new Date());

const rows = mm.listHerRecords({ kind: 'diary', visibility: 'private', limit: 5 });
console.log(`\n▸ 库里现有私密日记 ${rows.length} 篇：`);
for (const r of rows) {
  console.log(`  [${r.date}] ${String(r.content).replace(/\s+/g, ' ').slice(0, 80)}…`);
}
if (rows.length === 0) {
  // ★ 把"为什么没写"说清，别让脚本只会猜
  const evts = mm.listLifeEvents(1).length;
  const sums = mm.listLifeSummaries(3).length;
  console.log('  （没写。诊断：');
  console.log(`     生活事件 ${evts} 条 · 近三天摘要 ${sums} 条 —— 两者都为 0 就会按设计跳过（硬写就是编）`);
  console.log(`     privateDiaryDate=${(svc).state.privateDiaryDate ?? 'null'} — 等于今天说明"今天已写过"`);
  console.log('     先 `--seed` 造素材，或加 `--force` 忽略去重）');
}
db.close();
