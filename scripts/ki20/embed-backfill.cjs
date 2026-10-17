/**
 * KI-20 存量修复 · 向量补嵌（**只补库里还没有向量的行，幂等可重跑**）。
 *
 * 为什么需要它：合并把 **550 条 dsh 事件 + 5 条 dsh 摘要**并进了生产库，但**向量库在 DB 之外**
 * （`<dataDir>/workspace/lancedb`，生产上 570M），那些新行**没有向量** ⇒
 * 召回（走向量）取不到它们 = **"记得但搜不到"**。本脚本把那部分补上。
 *
 * 设计（每条都刻意）：
 *   - **幂等**：先读向量表里已有的 id，只处理缺的；重跑无副作用
 *   - **只补不删**：绝不改/删已有向量（`purge-subagent-pollution` 的教训：
 *     垃圾向量比缺向量危险，但**误删好向量**同样危险 ⇒ 本脚本只 add）
 *   - **默认 dry-run**：不带 `--apply` 时**不发一次 API 请求**，只报告要补多少
 *   - **可限定范围**：`--only dsh` 只补 dsh 渠道（本次的目标），不动 QQ 侧
 *
 * 用法（容器内）:
 *   docker exec alysia-server node /app/embed-backfill.cjs --data-dir /app/data --only dsh
 *   docker exec alysia-server node /app/embed-backfill.cjs --data-dir /app/data --only dsh --apply
 * 本地演练:
 *   E:\nodejs24\node.exe scripts/ki20/embed-backfill.cjs --data-dir packages/server/data --only dsh
 */
const fs = require('fs');
const path = require('path');

function loadSqlite() {
  for (const c of [path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', 'better-sqlite3'), 'better-sqlite3']) {
    try { return require(c); } catch { /* 继续 */ }
  }
  console.error('找不到 better-sqlite3'); process.exit(2);
}
function loadLance() {
  const cands = [
    '@lancedb/lancedb',
    path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', '@lancedb', 'lancedb'),
  ];
  for (const c of cands) { try { return require(c); } catch { /* 继续 */ } }
  console.error('找不到 @lancedb/lancedb'); process.exit(2);
}

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const DATA_DIR = arg('--data-dir', '/app/data');
const ONLY = arg('--only');            // 'dsh' | undefined（全部）
const BATCH = Number(arg('--batch', '16'));
const DB_FILE = arg('--db', path.join(DATA_DIR, 'alysia.db'));
const VEC_DIR = path.join(DATA_DIR, 'workspace', 'lancedb');
const TABLE = 'vectors';

// ── 环境（容器 env 优先，退回 .env 文件）────────────────────────
function envFromFile(key) {
  for (const f of ['/app/.env', path.join(process.cwd(), '.env'), path.join(__dirname, '..', '..', '.env')]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* 继续 */ }
  }
  return undefined;
}
const ENV = (k) => process.env[k] || envFromFile(k);
const EMBED_BASE = ENV('EMBED_BASE_URL');
const EMBED_KEY = ENV('EMBED_API_KEY');
const EMBED_MODEL = ENV('EMBED_MODEL') || 'embedding-2';

console.log(`数据目录: ${DATA_DIR}`);
console.log(`模式: ${APPLY ? '**apply（会调用嵌入 API 并写向量）**' : 'dry-run（不发 API 请求、不写任何东西）'}`);
console.log(`范围: ${ONLY ? `只补渠道 ${ONLY}` : '全部缺失行'}`);
console.log(`嵌入配置: base=${EMBED_BASE ? '已设置' : '**缺失**'} key=${EMBED_KEY ? '已设置' : '**缺失**'} model=${EMBED_MODEL}\n`);

(async () => {
  const Database = loadSqlite();
  const db = new Database(DB_FILE, { readonly: !APPLY });
  const lancedb = loadLance();
  const conn = await lancedb.connect(VEC_DIR);
  let table;
  try { table = await conn.openTable(TABLE); } catch (e) {
    console.error(`打不开向量表 ${TABLE}: ${e?.message ?? e}`); process.exit(1);
  }

  // 1. 已有向量 id
  // ★★ 必须显式 limit：LanceDB 的 JS `query()` **默认只返回 10 行**！
  //   我为此错过**两次**：先是初始枚举（570M 的库被读成 10 行 → "缺失"算成 555，
  //   若不修就 --apply 会插重复向量），再是结尾的校验（误报"仍未补上 555"）。
  //   ⇒ 现在抽成**同一个函数**，两处共用，杜绝再次分叉。
  const listIds = async () => new Set(
    (await table.query().limit(1_000_000).select(['id']).toArray()).map(r => String(r.id)),
  );
  const tableRows = await table.countRows();
  const have = await listIds();
  if (have.size !== tableRows) {
    console.error(
      `✗ 中止：读到 ${have.size} 个 id，但表里有 ${tableRows} 行 —— ` +
      `说明 id 列表被截断了（默认 limit？）。此时继续会插入重复向量。`,
    );
    process.exit(1);
  }
  console.log(`向量表现有: **${have.size}** 行（countRows=${tableRows}，已核对一致）`);

  // 2. 待补目标：events（dsh 渠道）+ conversations（dsh 渠道）
  const chWhere = ONLY === 'dsh' ? `AND channel = 'dsh'` : '';
  const evs = db.prepare(`SELECT id, payload, channel FROM events
      WHERE 1=1 ${chWhere}`).all()
    .map(r => {
      let content = '';
      try { content = String(JSON.parse(r.payload)?.content || ''); } catch { /* 脏数据跳过 */ }
      return { id: r.id, text: content, channel: r.channel, source: 'event' };
    })
    .filter(r => r.text.trim() !== '');
  const cvs = db.prepare(`SELECT id, summary, session_id FROM conversations
      WHERE 1=1 ${ONLY === 'dsh' ? "AND session_id LIKE 'dsh:%'" : ''}`).all()
    .map(r => ({ id: r.id, text: String(r.summary || ''), channel: 'dsh', source: 'conversation' }))
    .filter(r => r.text.trim() !== '');

  const targets = [...evs, ...cvs].filter(r => !have.has(r.id));
  console.log(`候选: events ${evs.length} + conversations ${cvs.length}；其中**缺向量 ${targets.length}**`);
  const bySrc = targets.reduce((a, r) => (a[r.source] = (a[r.source] || 0) + 1, a), {});
  console.log(`待补分布: ${JSON.stringify(bySrc)}`);

  if (!targets.length) { console.log('\n✅ 没有缺失，无需处理。'); db.close(); return; }
  if (!APPLY) { console.log('\ndry-run 结束，**未发一次 API 请求、未写入**。'); db.close(); return; }

  if (!EMBED_BASE || !EMBED_KEY) { console.error('✗ 缺 EMBED_BASE_URL / EMBED_API_KEY，拒绝执行'); process.exit(1); }

  // 3. 批量嵌入（OpenAI 兼容 /embeddings，支持数组输入）
  const url = EMBED_BASE.replace(/\/$/, '') + '/embeddings';
  let done = 0, failed = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${EMBED_KEY}` },
        body: JSON.stringify({ model: EMBED_MODEL, input: batch.map(b => b.text.slice(0, 2000)) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      const vecs = (j.data || []).sort((a, b) => a.index - b.index).map(d => d.embedding);
      if (vecs.length !== batch.length) throw new Error(`返回 ${vecs.length} 条，期望 ${batch.length}`);
      const addRows = batch.map((b, k) => ({
        id: b.id, vector: vecs[k], text: b.text.slice(0, 2000), source: b.source,
        metadata_json: JSON.stringify({ source: b.source, channel: b.channel, backfill: 'ki20' }),
      }));
      await table.add(addRows);
      done += addRows.length;
      if (i % (BATCH * 8) === 0) console.log(`  进度 ${done}/${targets.length}`);
    } catch (err) {
      failed += batch.length;
      console.error(`  ✗ 批次 ${i}-${i + batch.length} 失败: ${err?.message ?? err}`);
    }
  }

  // 4. 校验
  const after = await listIds();   // ★ 同一个函数（默认 limit 的坑只踩一次就够）
  const stillMissing = targets.filter(t => !after.has(t.id)).length;
  console.log(`\n=== 结果 ===`);
  console.log(`  成功补入 ${done} 条，失败 ${failed} 条`);
  console.log(`  向量表 ${have.size} → **${after.size}** 行`);
  console.log(`  仍未补上: ${stillMissing}`);
  db.close();
  process.exit(stillMissing === 0 ? 0 : 1);
})().catch(err => { console.error('未捕获错误:', err); process.exit(1); });
