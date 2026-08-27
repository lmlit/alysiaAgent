/**
 * 世界书 digest 批量生成脚本（一次性/可重跑）：
 * 为所有无 digest 的 text 世界书条目生成 120-150 字「角色简介」——
 * 核心设定 + 与昔涟的关系 + 对生活的意义。事件生成采样注入用 digest 而非截断正文。
 *
 * 幂等：只处理 digest IS NULL / 空串 的 text 条目；失败跳过计数，重跑补齐。
 * ★ 并发：--concurrency N（默认 4）——串行 65 条要 10+ 分钟，DeepSeek 支持并发
 *   且失败根因已修（seed 清空，非限流），并发安全。
 * 用法: PATH="/e/nodejs24:$PATH" npx tsx scripts/digest-worldbook.ts [--dry-run] [--concurrency 4]
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { createRequire } from 'module';
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });
// better-sqlite3 是 CJS，ESM 下 default import 解析失败 → createRequire 加载
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');
import { AlysiaCore, DEFAULT_SAMPLING } from '@alysia/core';
import { loadConfig } from '../src/config.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const concArg = process.argv.indexOf('--concurrency');
const CONCURRENCY = concArg > 0 ? Math.max(1, Math.min(8, Number(process.argv[concArg + 1]) || 4)) : 4;

async function main() {
  const config = loadConfig(process.env.ALYSIA_CONFIG || './config.yml');
  const dbPath = `${config.server.dataDir}/alysia.db`;

  // 先起 core（start 会跑 initializeDatabase 迁移：worldbook_entries 加 digest 列）
  const core = new AlysiaCore({
    dbPath,
    ownerId: config.bot.ownerId,
    workspaceDir: config.server.workspaceDir,
    llmConfig: config.llm,
    embedConfig: config.embed,
    features: config.features ?? { codeMode: false },
    sampling: config.sampling,
  });
  await core.start();

  const db = new Database(dbPath);
  // 无 digest 的 text 条目（life_event/image 不生成）
  const pending = db.prepare(
    "SELECT id, content FROM worldbook_entries WHERE content_type = 'text' AND (digest IS NULL OR digest = '') ORDER BY created_at ASC"
  ).all() as Array<{ id: string; content: string }>;
  if (pending.length === 0) { console.log('没有待生成的条目（digest 已全部就绪）'); db.close(); await core.stop(); return; }
  console.log(`待生成 ${pending.length} 条 text 条目 digest（life_event/image 跳过）`);

  const systemPrompt =
    '你是昔涟的世界书整理助手。把用户提供的世界书条目改写为一段 120-150 字的「角色简介」，' +
    '用于 AI 生活事件生成时的背景参考。要求：① 提炼条目核心设定，不逐字照抄 ② 点明这条设定对昔涟日常生活/性格/关系的影响 ' +
    '③ 涉及角色时写明与昔涟的关系 ④ 语言自然，像角色背景卡。只输出简介文本本身，不要标题、不要解释、不要 markdown。';

  const update = db.prepare('UPDATE worldbook_entries SET digest = ? WHERE id = ?');
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  /** 单条生成（★ 空响应概率 ~20%（DeepSeek 偶发返回空 content）→ 重试 4 次，
   *  失败率 0.2⁵≈0.03%；重试间隔 1s——空响应是快速失败，间隔不用长） */
  async function generateOne(entry: { id: string; content: string }): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await sleep(1000);
      try {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: `世界书条目:\n${entry.content.slice(0, 800)}`,
          sessionId: 'worldbook-digest',
          systemPrompt,
          sampling: { ...DEFAULT_SAMPLING.life.generateSummary }, // 低温/忠
        });
        const digest = resp.role === 'assistant' ? (resp.completionText ?? '').trim() : '';
        if (digest) {
          update.run(digest.slice(0, 200), entry.id);
          return true;
        }
      } catch { /* retry */ }
    }
    return false;
  }

  let okCount = 0, failCount = 0;
  const entries = DRY_RUN ? [] : pending;
  const queue = [...entries];
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= queue.length) return;
      const entry = queue[idx];
      const ok = await generateOne(entry);
      if (ok) okCount++; else failCount++;
      const title = entry.content.split('\n')[0]?.slice(0, 20) ?? entry.id;
      console.log(`[${idx + 1}/${queue.length}] ${title} ${ok ? '✓' : '✗'}`);
    }
  });
  await Promise.all(workers);
  if (DRY_RUN) console.log(`(dry-run) 跳过 ${pending.length} 条`);
  console.log(`\n完成: 成功 ${okCount} / 失败 ${failCount}（重跑可补齐失败项）`);
  await core.stop();
  db.close();
}

main().catch(err => { console.error('digest generation failed:', err); process.exit(1); });
