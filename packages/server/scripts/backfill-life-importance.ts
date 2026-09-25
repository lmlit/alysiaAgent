/**
 * 回填生活事件的 importance 到向量 metadata（一次性 / 幂等）
 *
 * change: tune-recall-with-runtime-data
 *
 * 为什么需要：`wire-importance-signal` 之前写入的 `life_event` 向量**没有 importance 字段**，
 * 所以 `applyKnobsToRetrieved` 的 `+0.15` 分支在这些老数据上永远不触发。
 * 不回填的话，「重要度加分触发率」这个观测指标要等新数据攒够才有效样本。
 *
 * 做什么：读 `ai_life_events` 的 mood_delta/origin → 用同一个 `lifeEventImportance()`
 * 算分 → **重新嵌入该事件文本**并 upsert 向量（metadata 带上 importance）。
 *
 * 安全性：只动 `source='life_event'` 的向量；重复跑结果一致（upsert 语义）。
 *
 * 用法:
 *   # 先看会改什么（不写库）
 *   cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx scripts/backfill-life-importance.ts --dry
 *   # 真跑
 *   cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx scripts/backfill-life-importance.ts
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });
import { AlysiaCore } from '@alysia/core';
// importance 从 memory 子路径导入（主入口不转出 memory 桶）
import { lifeEventImportance } from '@alysia/core/memory';
import { loadConfig } from '../src/config.ts';

const DRY = process.argv.includes('--dry');
/** 并发上限：embed 是外部 API，别把配额打爆 */
const CONCURRENCY = 4;

async function main(): Promise<void> {
  const config = loadConfig(process.env.ALYSIA_CONFIG || './config.yml');
  const core = new AlysiaCore({
    dbPath: `${config.server.dataDir}/alysia.db`,
    ownerId: config.bot.ownerId,
    workspaceDir: config.server.workspaceDir,
    llmConfig: config.llm,
    embedConfig: config.embed,
    features: config.features ?? { codeMode: false },
    sampling: config.sampling,
  });
  await core.start();

  const mm: any = core.memoryManager;
  const db: any = mm.db;
  const vs: any = mm.vectorStore;

  const events = db
    .prepare('SELECT id, content, mood_delta, type, created_at, origin FROM ai_life_events')
    .all() as Array<{
    id: string;
    content: string;
    mood_delta: string | null;
    type: string;
    created_at: string;
    origin: string | null;
  }>;

  console.log(`  生活事件总数: ${events.length}${DRY ? '  【DRY RUN —— 不写库】' : ''}`);

  // 已带 importance 的向量（跳过，保证幂等且省 embedding 额度）
  const existing = new Set<string>();
  try {
    const rows = await vs.table.query().where(`source = "life_event"`).limit(100000).toArray();
    for (const r of rows) {
      const meta = JSON.parse(r.metadata_json ?? '{}');
      if (typeof meta.importance === 'number') existing.add(r.id as string);
    }
  } catch (err: any) {
    console.warn('  ⚠️ 读已有向量失败，将全量回填:', err.message);
  }
  console.log(`  其中向量已带 importance: ${existing.size}`);

  const todo = events.filter(e => !existing.has(e.id));
  if (todo.length === 0) {
    console.log('  ✅ 无需回填');
    await core.stop();
    return;
  }

  const dist: Record<string, number> = {};
  const scored = todo.map(e => {
    const importance = lifeEventImportance({ moodDelta: e.mood_delta, origin: e.origin ?? undefined });
    const bucket = importance.toFixed(2);
    dist[bucket] = (dist[bucket] ?? 0) + 1;
    return { ...e, importance };
  });

  // ⚠️ 括号不能省：`a > b ?? c` 会被解析成 `(a > b) ?? c`，
  //    而 b 为 undefined 时 `a > undefined` 恒 false —— 实测这个 bug 让统计静默输出 0
  const threshold = config.memory?.importanceThreshold ?? 0.4;
  const over = scored.filter(s => s.importance > threshold).length;
  console.log(`  待回填: ${todo.length}`);
  console.log('  importance 分布:', JSON.stringify(dist));
  console.log(`  超过默认阈值 0.4 的: ${over} 条（这些会让 +0.15 分支真正触发）`);

  if (DRY) {
    console.log('\n  示例（前 5 条）:');
    for (const s of scored.slice(0, 5)) {
      console.log(`    ${s.importance.toFixed(2)}  mood=${String(s.mood_delta ?? '(无)').padEnd(6)} ${s.content.replace(/\s+/g, ' ').slice(0, 40)}`);
    }
    console.log('\n  （--dry 模式，未写库）');
    await core.stop();
    return;
  }

  // 并发受限地重新嵌入 + upsert
  let done = 0;
  let failed = 0;
  const queue = [...scored];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        try {
          const vector = await mm.embedService.embed(item.content);
          await vs.insert(item.id, vector, item.content, {
            source: 'life_event',
            type: item.type,
            created_at: item.created_at,
            importance: item.importance,
          });
          done++;
        } catch (err: any) {
          failed++;
          console.warn(`    ⚠️ ${item.id.slice(0, 24)} 失败: ${err.message}`);
        }
        if ((done + failed) % 20 === 0) {
          console.log(`    进度 ${done + failed}/${scored.length}`);
        }
      }
    }),
  );

  console.log(`\n  ✅ 回填完成: 成功 ${done} / 失败 ${failed}`);
  await core.stop();
}

main().catch(err => {
  console.error('回填失败:', err);
  process.exit(1);
});
