/**
 * 事件窗口修复验证（跑在**生产库副本**上，不碰生产）
 *
 * ★ 9-26 fix-session-event-window-truncation
 *
 * 复现线上场景：主会话积累 1436 条事件，`getBySession` 的 ASC+LIMIT 1000
 * 只返回最旧的 1000 条 → anchor 之后一条都取不到 → 归档空转。
 *
 * 本脚本用**真实生产数据** + **真实 DeepSeek** 跑一遍归档，验证修复后
 * 是否真的能把窗口内的事件取出来并生成摘要。
 *
 * 用法:
 *   # 先取副本（见 HANDOFF 或 sync-from-server.sh 的做法）
 *   cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx scripts/verify-window-fix.ts [副本路径]
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { createRequire } from 'module';
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });
import { mergeSampling, slotToBody } from '@alysia/core';
import { MemoryManager } from '@alysia/core/memory';

// better-sqlite3 是 @alysia/core 的依赖，packages/server 自身没有 —— 从 core 解析
const requireCore = createRequire(resolve(process.cwd(), '../core/package.json'));
const Database = requireCore('better-sqlite3');

const DB_PATH = process.argv[2] || resolve(process.cwd(), 'data/alysia-prod-copy.db');
const BASE = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';
const KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.CHAT_MODEL || 'deepseek-chat';

const db = new Database(DB_PATH);   // 可写——但写的是副本

// 与 core/src/index.ts 里 llmService 的构造保持一致
const llmService = {
  complete: async (systemPrompt: string, userPrompt: string, sampling?: Record<string, unknown>) => {
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        ...slotToBody(sampling as any),
      }),
    });
    if (!resp.ok) throw new Error(`LLM API error ${resp.status}: ${await resp.text().catch(() => '')}`);
    const data = (await resp.json()) as any;
    return data?.choices?.[0]?.message?.content || '';
  },
};

// 无向量库 → SessionEnd 会跳过 embed（本脚本只验摘要，不验向量）
const embedService = { embed: async () => new Array(1024).fill(0), dimension: () => 1024 };

async function main() {
  if (!KEY) { console.error('✗ 缺少 OPENAI_API_KEY'); process.exit(1); }
  console.log(`副本: ${DB_PATH}\n模型: ${MODEL}\n`);

  const SID = (db.prepare("SELECT session_id, COUNT(*) n FROM events GROUP BY session_id ORDER BY n DESC LIMIT 1").get() as any).session_id;
  const total = (db.prepare('SELECT COUNT(*) n FROM events WHERE session_id = ?').get(SID) as any).n;
  const lastConv = db.prepare('SELECT ended_at FROM conversations ORDER BY ended_at DESC LIMIT 1').get() as any;

  console.log('══ 现场 ══');
  console.log(`  会话: ${SID.slice(-40)}`);
  console.log(`  事件总数: ${total}`);
  console.log(`  anchor（上条摘要 ended_at）: ${lastConv?.ended_at}`);
  const inWindow = (db.prepare('SELECT COUNT(*) n FROM events WHERE session_id = ? AND created_at >= ?').get(SID, lastConv.ended_at) as any).n;
  console.log(`  anchor 之后的事件数: ${inWindow}    ← 这就是应该被摘要的窗口`);

  console.log('\n══ 修复前会怎样（模拟旧查询 ASC LIMIT 1000 + 内存 filter）══');
  const oldRows = db.prepare('SELECT created_at FROM events WHERE session_id = ? ORDER BY created_at ASC LIMIT 1000').all(SID) as any[];
  const oldKept = oldRows.filter(r => r.created_at >= lastConv.ended_at).length;
  console.log(`  取到 ${oldRows.length} 条，其中落在窗口内的: ${oldKept}  → ${oldKept === 0 ? '❌ messageEvents 为空 → process() 空转' : '可摘要'}`);

  console.log('\n══ 跑归档（新代码 + 真实 API）══');
  const before = (db.prepare('SELECT COUNT(*) n FROM conversations').get() as any).n;
  const mm = new MemoryManager(db, null, embedService as any, llmService as any, mergeSampling());
  const t0 = Date.now();
  const archived = await (mm as any).archiveStaleSessions();
  console.log(`  archiveStaleSessions() 返回: ${archived}（用时 ${Date.now() - t0}ms）`);

  const after = (db.prepare('SELECT COUNT(*) n FROM conversations').get() as any).n;
  console.log(`  conversation 数: ${before} → ${after}`);

  console.log('\n══ 新增的摘要 ══');
  const rows = db.prepare(
    `SELECT summary, summary_status, message_count, ended_at FROM conversations ORDER BY rowid DESC LIMIT 3`
  ).all() as any[];
  for (const r of rows) {
    const isPlaceholder = /^Session .+ summary$/.test(r.summary);
    console.log(`  [${r.summary_status}] ${r.message_count}条 ${r.ended_at}`);
    console.log(`     ${(r.summary || '(空)').slice(0, 100)}${isPlaceholder ? '   ❌ 占位符!' : ''}`);
  }

  const ok = after > before && rows[0]?.summary_status === 'ok' && !/^Session .+ summary$/.test(rows[0]?.summary || '');
  console.log(`\n${ok ? '✅ 通过：窗口内事件被正确取出并生成了真实摘要' : '❌ 未通过'}`);
  db.close();
  // ⚠️ 不用 process.exit()：MemoryManager 可能还有未关闭的句柄，
  //    在 Windows 上会触发 libuv 断言（`!(handle->flags & UV_HANDLE_CLOSING)`）。
  //    设置 exitCode 让进程自然退出即可。
  process.exitCode = ok ? 0 : 1;
}

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });
