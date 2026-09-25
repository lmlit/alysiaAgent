/**
 * 召回效果探针（只读，不改任何数据）
 *
 * 用真实 DB 跑 MemoryManager.read()，把不同话题的召回结果打出来看质量：
 *   - 相关话题能否捞到对的记忆
 *   - 无关话题会不会硬塞 5 条（无相似度阈值的验证）
 *   - 生活事件（source=life_event）的占比与配额（min(2, limit)）
 *   - 各条 score 分布（`1 - L2距离` 映射是否退化到 0）
 *
 * 用法: cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx scripts/recall-probe.ts
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });
import { AlysiaCore } from '@alysia/core';
import { loadConfig } from '../src/config.ts';

/** 探针话题：覆盖 相关 / 她的生活 / 细节 / 完全无关 四类 */
const QUERIES: Array<{ tag: string; q: string }> = [
  { tag: '相关·具体', q: '你还记得我养的那只猫叫什么吗' },
  { tag: '相关·细节', q: '上次你提过的那本诗集' },
  { tag: '她的生活', q: '你最近都在做什么呀' },
  { tag: '她的感受', q: '你今天心情怎么样' },
  { tag: '无关·技术', q: '帮我讲讲量子力学的波函数坍缩' },
  { tag: '无关·日常', q: '今天股市怎么样' },
];

function age(ts: unknown): string {
  if (typeof ts !== 'string') return '—';
  const d = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(d)) return '—';
  const h = d / 3_600_000;
  if (h < 1) return `${Math.round(d / 60000)}分`;
  if (h < 48) return `${h.toFixed(1)}时`;
  return `${(h / 24).toFixed(1)}天`;
}

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
  const mm = core.memoryManager;

  console.log('='.repeat(78));
  console.log('召回探针 · limit=5（与线上一致）');
  console.log('='.repeat(78));

  for (const { tag, q } of QUERIES) {
    console.log(`\n【${tag}】${q}`);
    try {
      const res = await mm.read({ query: q, mode: 'chat', limit: 5 });
      const items = res.retrieved ?? [];
      if (items.length === 0) {
        console.log('   （无召回）');
        continue;
      }
      const bySource: Record<string, number> = {};
      for (const r of items) {
        const src = String(r.metadata?.source ?? '?');
        bySource[src] = (bySource[src] ?? 0) + 1;
      }
      console.log(
        `   共 ${items.length} 条 · 来源分布 ${JSON.stringify(bySource)}`,
      );
      items.forEach((r, i) => {
        const src = String(r.metadata?.source ?? '?');
        const text = r.text.replace(/\s+/g, ' ').slice(0, 52);
        console.log(
          `   ${i + 1}. [${src.padEnd(12)}] score=${r.score.toFixed(3)} age=${age(
            r.metadata?.created_at ?? r.metadata?.updated_at,
          ).padEnd(6)} ${text}`,
        );
      });
    } catch (err: any) {
      console.log(`   ❌ 失败: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  await core.stop();
}

main().catch((err) => {
  console.error('探针失败:', err);
  process.exit(1);
});
