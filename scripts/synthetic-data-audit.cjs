/**
 * ★ 2026-10-20（change: `plan-synthetic-data-cleanup`；B6）—— **只读审计 + 备份，不删任何东西**。
 *
 * 用途：把 KI-20 的残留量化出来，让"要不要清、清哪些"变成可以看着数字决定的事。
 *
 *   KI-20 是什么：dsh 的 runtime-context 快照被当成**用户消息**回传入库（role='user'），
 *   造成 ① 画像回吸 ② 人格放大。filter-synthetic-context-inflow 已堵住新数据，
 *   但**存量 116 条**及由其产出的 facts 从没清过。
 *
 * ⚠️ 本脚本**绝不写库**：
 *   - 打开方式是 `readOnly: true`
 *   - `--backup <dir>` 只做**文件级复制**（db / -wal / -shm），不执行任何 SQL 写操作
 *   - 删除/作废的方案在 `docs/PLAN-2026-10-20-clean-synthetic-facts.md`，需人工复核后执行
 *
 * 用法：
 *   node scripts/synthetic-data-audit.cjs --db /path/to/alysia.db
 *   node scripts/synthetic-data-audit.cjs --db ... --json
 *   node scripts/synthetic-data-audit.cjs --db ... --backup /path/to/backups
 *
 * Node ≥ 22（用 `node:sqlite`，不需要 better-sqlite3）。
 */
const fs = require('node:fs');
const path = require('node:path');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const dbPath = arg('db');
if (!dbPath) {
  console.error('用法: node scripts/synthetic-data-audit.cjs --db <alysia.db> [--json] [--backup <dir>]');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库: ${dbPath}`);
  process.exit(2);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('需要 Node ≥ 22（node:sqlite）。这台机器请用 E:\\nodejs24\\node.exe 跑。');
  process.exit(2);
}

// ── 可选备份（纯文件复制，不动库）──────────────────────────────
if (has('backup')) {
  const dir = arg('backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, `${path.basename(src)}.${stamp}.bak`);
    fs.copyFileSync(src, dst);
    console.log(`已备份 ${src} → ${dst}`);
  }
}

const db = new DatabaseSync(dbPath, { readOnly: true });

const q = (sql, ...params) => db.prepare(sql).all(...params);

/**
 * 判据：`payload.synthetic` 非空 或 `payload.skip_profile` 为真。
 * ⚠️ 与 ingest.ts 的写入侧**逐字对应**（那边同时打两个字段，这里两个都认）。
 */
const SYNTH_WHERE = `
  (COALESCE(json_extract(payload, '$.synthetic'), '') <> ''
   OR COALESCE(json_extract(payload, '$.skip_profile'), 0) <> 0)
`;

const totalEvents = q('SELECT COUNT(*) AS n FROM events')[0].n;
const synthEvents = q(`SELECT COUNT(*) AS n FROM events WHERE ${SYNTH_WHERE}`)[0].n;
const synthByKind = q(`
  SELECT COALESCE(json_extract(payload, '$.synthetic'), 'skip_profile_only') AS kind, COUNT(*) AS n
  FROM events WHERE ${SYNTH_WHERE} GROUP BY kind ORDER BY n DESC
`);

const synthIds = q(`SELECT id, session_id, created_at FROM events WHERE ${SYNTH_WHERE} ORDER BY created_at`);

// facts 通过 source_event 指向事件
let factsTotal = 0, factsFromSynth = [];
try {
  const row = q('SELECT facts FROM user_profile WHERE id = 1')[0];
  const facts = JSON.parse(row?.facts ?? '[]');
  factsTotal = facts.length;
  const synthSet = new Set(synthIds.map(e => e.id));
  factsFromSynth = facts.filter(f => synthSet.has(f.source_event));
} catch (err) {
  console.error('读 user_profile.facts 失败（表结构可能不同）:', err.message);
}

// 含 synthetic 事件的会话（摘要可能被污染，但**不能自动判定** —— 需人工看）
const sessionsWithSynth = q(`
  SELECT session_id, COUNT(*) AS n FROM events WHERE ${SYNTH_WHERE} GROUP BY session_id ORDER BY n DESC
`);

const report = {
  db: dbPath,
  events: { total: totalEvents, synthetic: synthEvents, byKind: synthByKind },
  facts: { total: factsTotal, fromSynthetic: factsFromSynth.length },
  sessionsWithSynthetic: sessionsWithSynth,
  sampleSyntheticEvents: synthIds.slice(0, 10),
  sampleFacts: factsFromSynth.slice(0, 10).map(f => ({ fact: f.fact, source_event: f.source_event, status: f.status })),
  note: [
    '本报告只读。清理方案见 docs/PLAN-2026-10-20-clean-synthetic-facts.md。',
    'facts 建议「作废」而不是物理删除（保留审计链，同 memory-correction 的做法）。',
    '含 synthetic 的会话摘要需**人工判断**：不能自动认定整篇摘要都被污染。',
  ],
};

if (has('json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('════ 合成注入数据审计（只读）════');
  console.log(`库: ${dbPath}`);
  console.log(`事件总数: ${totalEvents}；其中 synthetic/skip_profile: ${synthEvents}`);
  for (const k of synthByKind) console.log(`  - ${k.kind}: ${k.n}`);
  console.log(`画像事实: ${factsTotal} 条；其中 source_event 指向 synthetic 事件: ${factsFromSynth.length}`);
  console.log(`涉及的会话数: ${sessionsWithSynth.length}`);
  if (sessionsWithSynth.length) {
    console.log('  前 5 个会话（需人工看摘要是否被污染）:');
    for (const s of sessionsWithSynth.slice(0, 5)) console.log(`   - ${s.session_id} (${s.n} 条)`);
  }
  console.log('\n提示：加 --backup <dir> 可在跑任何清理前做整库备份（只会复制文件）。');
}

db.close();
