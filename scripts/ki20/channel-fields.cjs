/**
 * 「两种记忆能不能用字段区分」的现状核查（**只读**）。
 *
 * 背景：用户要 QQ 端也能操作编程 ⇒ 需要接 dsh 记忆 ⇒ 两类记忆并存。
 * 并问「可以有字段区分不，后续可能会特殊处理」。
 *
 * 本脚本逐层回答：**每一层现在到底能不能把 dsh 来源与 QQ 来源分开**，
 * 以及"不能"的那些层缺什么字段。
 *
 * 用法: E:\nodejs24\node.exe scripts/ki20/channel-fields.cjs <db>
 */
const path = require('path');
function loadSqlite() {
  for (const c of [
    path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ]) { try { return require(c); } catch { /* 继续 */ } }
  console.error('找不到 better-sqlite3'); process.exit(2);
}
const Database = loadSqlite();
const db = new Database(process.argv[2], { readonly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const pct = (a, b) => (b === 0 ? '—' : ((a / b) * 100).toFixed(1) + '%');

console.log(`库: ${path.basename(process.argv[2])}\n`);

// ── 1. events：能否区分 ────────────────────────────────────────
const evTotal = db.prepare('SELECT COUNT(*) n FROM events').get().n;
const evDsh = db.prepare("SELECT COUNT(*) n FROM events WHERE session_id LIKE 'dsh:%'").get().n;
const evCode = db.prepare("SELECT COUNT(*) n FROM events WHERE source = 'code'").get().n;
console.log('① events');
console.log(`   总数 ${evTotal}；session_id 前缀=dsh: 的 ${evDsh}；source='code' 的 ${evCode}`);
console.log('   ⇒ **能区分**：两个字段都可用（`session_id` 前缀 + `source`）');

// ── 2. conversations ──────────────────────────────────────────
const cTotal = db.prepare('SELECT COUNT(*) n FROM conversations').get().n;
const cDsh = db.prepare("SELECT COUNT(*) n FROM conversations WHERE session_id LIKE 'dsh:%'").get().n;
const cCols = q('PRAGMA table_info(conversations)').map(r => r.name);
console.log('\n② conversations');
console.log(`   总数 ${cTotal}；session_id=dsh: 的 ${cDsh}`);
console.log(`   列: ${cCols.join(', ')}`);
console.log(`   ⇒ **能区分**：只有 \`session_id\` 前缀这一个判据（**没有** source/渠道列）`);
console.log(`      ⚠️ 若将来有会话不带前缀（或前缀被改），这条就断了`);

// ── 3. user_profile.facts / character_facts ────────────────────
const prof = db.prepare('SELECT facts, character_facts FROM user_profile WHERE id = 1').get();
for (const [label, col] of [['③ user_profile.facts', 'facts'], ['④ user_profile.character_facts', 'character_facts']]) {
  const arr = JSON.parse(prof[col] || '[]');
  const byDsh = arr.filter(f => String(f.source_event || '').startsWith('dsh-')).length;
  const noSrc = arr.filter(f => !f.source_event).length;
  const keys = new Set();
  for (const f of arr.slice(0, 40)) Object.keys(f).forEach(k => keys.add(k));
  console.log(`\n${label}`);
  console.log(`   总数 ${arr.length}；source_event 以 'dsh-' 开头的 ${byDsh}（${pct(byDsh, arr.length)}）；**没有 source_event 的 ${noSrc}**`);
  console.log(`   条目字段: ${[...keys].join(', ') || '(空)'}`);
  console.log(`   ⇒ ${byDsh > 0 || noSrc === 0 ? '**部分能**' : '**不能**'}：没有渠道字段，只能靠 \`source_event\` **反查**`);
  if (noSrc > 0) console.log(`      ⚠️ 有 ${noSrc} 条**连 source_event 都没有** ⇒ 事后无法归因`);
}

// ── 5. persona.adaptation_hints ───────────────────────────────
const hints = JSON.parse(db.prepare('SELECT adaptation_hints FROM persona WHERE id = 1').get()?.adaptation_hints || '[]');
const hKeys = new Set();
for (const h of hints.slice(0, 40)) Object.keys(h).forEach(k => hKeys.add(k));
console.log('\n⑤ persona.adaptation_hints');
console.log(`   总数 ${hints.length}`);
console.log(`   条目字段: ${[...hKeys].join(', ') || '(空)'}`);
console.log('   ⇒ **不能区分**：没有来源/渠道字段，`evidence` 是自由文本');
console.log('      ⚠️ 而且本仓已有一条契约：「`source_event` 造的是**合成 id**，不可用于溯源」');

// ── 6. 汇总 ───────────────────────────────────────────────────
console.log('\n=== 汇总 ===');
console.log('能区分（现在就有字段）：events（session_id 前缀 + source）、conversations（session_id 前缀）');
console.log('不能区分（缺字段）：facts / character_facts（只能反查 source_event，且有缺失条目）、adaptation_hints（完全无来源）');
console.log('⇒ 若要"后续特殊处理"，**应在写入侧加显式渠道字段**，而不是事后靠 id 猜。');

db.close();
