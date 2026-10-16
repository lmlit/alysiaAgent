/**
 * KI-20 存量盘点 —— **只读**，不改库。
 *
 * 用法（在仓库根目录）：
 *   E:\nodejs24\node.exe scripts/ki20/recon.cjs packages/server/data/alysia.db
 *
 * ★ 为什么要有这个脚本（而不是像 `purge-subagent-pollution` 那样贴几条 SQL）：
 *   本项的判据散在**两处**——
 *     ① `events.payload.content` 的前缀（SQL 就能查）；
 *     ② `user_profile.facts` / `character_facts` / `persona.adaptation_hints`
 *        都是**整块 JSON 存在一列里**，没法用 SQL 逐条筛，必须在 JS 里 parse 出来逐条判。
 *   而且判据本身是"内容是否工程污染"，不是"来源是否指向注入"（先例的教训：
 *   43 条里 39 条是"内容为真、来源错"，一刀切会删掉真实画像）。
 *   ⇒ 盘需要逐条列出来给人看，这正是脚本该干的事。
 *
 * ⚠️ 本脚本**只读**（`readonly: true`）。修复另在 `purge.cjs`（单事务 + 断言）。
 */
const path = require('path');

/**
 * ⚠️ `better-sqlite3` 是**原生模块**（编译过 ABI）：本仓用 pnpm，它只装在
 * `packages/core/node_modules`（不在根）。所以这里按候选路径找，
 * 而不是假设从脚本位置能解析出来。
 * 另外它编译的是 **Node 24** 的 ABI ⇒ 必须用 `E:\nodejs24\node.exe` 跑
 * （默认 `npx` 的 Node 20 会报 NODE_MODULE_VERSION 不匹配）。
 */
function loadSqlite() {
  const candidates = [
    path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ];
  const tried = [];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (err) {
      tried.push(`${c} → ${err.code || err.message}`);
    }
  }
  console.error('找不到 better-sqlite3：\n  ' + tried.join('\n  '));
  process.exit(2);
}
const Database = loadSqlite();

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('用法: node scripts/ki20/recon.cjs <dbPath>');
  process.exit(2);
}

/** 注入文本的抬头（与 adapter / 服务端的判据同源，但这里只用于**盘点**） */
const PREFIX = 'Current runtime context';

const db = new Database(dbPath, { readonly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const line = (s = '') => console.log(s);

// ── 1. 合成注入事件 ─────────────────────────────────────────────
const evs = q(
  `SELECT id, session_id, source, type, created_at, importance, processed,
          json_extract(payload,'$.role')        AS role,
          json_extract(payload,'$.skip_profile') AS skip_profile,
          json_extract(payload,'$.dsh_source')   AS dsh_source,
          length(json_extract(payload,'$.content')) AS len
     FROM events
    WHERE json_extract(payload,'$.content') LIKE ? || '%'
    ORDER BY created_at`,
  PREFIX,
);

line('=== 1. 合成注入事件（events）===');
line(`总数: ${evs.length} | 会话数: ${new Set(evs.map(e => e.session_id)).size}`);
const bySession = {};
for (const e of evs) bySession[e.session_id] = (bySession[e.session_id] || 0) + 1;
line(`按会话: ${JSON.stringify(bySession)}`);
line(`时间范围: ${evs[0]?.created_at} → ${evs[evs.length - 1]?.created_at}`);
line(`role 分布: ${JSON.stringify(evs.reduce((a, e) => ((a[e.role] = (a[e.role] || 0) + 1), a), {}))}`);
line(`已带 skip_profile: ${evs.filter(e => e.skip_profile === 1).length}（修复前应为 0）`);
line(`content 长度 min/中位/max: ${Math.min(...evs.map(e => e.len || 0))} / ${
  evs.map(e => e.len || 0).sort((a, b) => a - b)[Math.floor(evs.length / 2)]} / ${Math.max(...evs.map(e => e.len || 0))}`);

const evIds = new Set(evs.map(e => e.id));
/** 注入事件的时间窗（判 hints 用） */
const lo = Math.min(...evs.map(e => Date.parse(e.created_at))) - 60_000;
const hi = Math.max(...evs.map(e => Date.parse(e.created_at))) + 60_000;

// ── 2. facts（用户事实）──────────────────────────────────────────
line('\n=== 2. user_profile.facts ===');
const prof = db.prepare('SELECT facts, character_facts FROM user_profile WHERE id = 1').get();
const facts = JSON.parse(prof.facts || '[]');
line(`总条数: ${facts.length}`);
const hitFacts = facts.map((f, i) => ({ i, ...f })).filter(f => evIds.has(f.source_event));
line(`★ source_event 指向合成注入的: ${hitFacts.length}`);
for (const f of hitFacts) {
  line(`  [${f.i}] status=${f.status} source=${f.source} cat=${f.category} valid_from=${String(f.valid_from || '').slice(0, 19)}`);
  line(`      fact : ${f.fact}`);
  line(`      event: ${f.source_event}`);
}

// ── 3. character_facts ─────────────────────────────────────────
line('\n=== 3. user_profile.character_facts ===');
const cfs = JSON.parse(prof.character_facts || '[]');
line(`总条数: ${cfs.length}`);
const hitCfs = cfs.map((f, i) => ({ i, ...f })).filter(f => evIds.has(f.source_event));
line(`★ source_event 指向合成注入的: ${hitCfs.length}`);
for (const f of hitCfs) {
  line(`  [${f.i}] status=${f.status} source=${f.source} valid_from=${String(f.valid_from || '').slice(0, 19)}`);
  line(`      fact : ${f.fact}`);
}

// ── 4. adaptation_hints（人格自我调整）──────────────────────────
line('\n=== 4. persona.adaptation_hints ===');
const per = db.prepare('SELECT adaptation_hints FROM persona WHERE id = 1').get();
const hints = JSON.parse(per.adaptation_hints || '[]');
line(`总条数: ${hints.length}`);
const inWindow = hints.map((h, i) => ({ i, ...h })).filter(h => {
  const t = Date.parse(h.appliedAt || h.applied_at || '');
  return Number.isFinite(t) && t >= lo && t <= hi;
});
line(`★ appliedAt 落在注入时间窗内的: ${inWindow.length}`);
for (const h of inWindow) {
  line(`  [${h.i}] ${h.appliedAt} | ${h.dimension} | ${h.change}`);
  line(`      evidence: ${h.evidence}`);
}

// ── 5. conversations（摘要里是否含注入文本）─────────────────────
line('\n=== 5. conversations ===');
const convs = q(
  `SELECT id, session_id, started_at, ended_at, length(summary) AS len,
          summary LIKE '%' || ? || '%' AS polluted, summary_status
     FROM conversations ORDER BY started_at`,
  PREFIX,
);
line(`总条数: ${convs.length}`);
const pol = convs.filter(c => c.polluted === 1);
line(`★ summary 含注入文本的: ${pol.length}`);
for (const c of pol) {
  line(`  ${c.session_id} | ${c.started_at} → ${c.ended_at} | len=${c.len} status=${c.summary_status}`);
}

// ── 6. 这些会话里，合成事件占多少 ───────────────────────────────
line('\n=== 6. 受影响会话的构成（合成 vs 全部）===');
for (const sid of Object.keys(bySession)) {
  const tot = db.prepare(
    "SELECT COUNT(*) n FROM events WHERE session_id = ? AND length(json_extract(payload,'$.content')) > 0",
  ).get(sid).n;
  line(`  ${sid}: 有内容事件=${tot} 其中合成=${bySession[sid]}`);
}

db.close();
