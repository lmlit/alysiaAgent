/**
 * 同步前的**数据丢失体检**（只读）：比较"本机库"与"即将覆盖它的远端库"，
 * 报出**本机独有的、一同步就会永久消失**的东西。
 *
 * 背景（真实事故）：`sync-from-server.sh` 是**整库覆盖**本机库的。
 * 2026-10-15 那次同步把本机独有的 **730 条 dsh 事件**换成了服务器的 QQ 数据 ——
 * 本机的 dsh 血脉从此**只剩备份**（这件事直到做 KI-20 存量修复时才被发现）。
 * 脚本本身有"先备份"是好的，但**备份不是保护**：没人会去翻一个自己不知道存在的备份。
 * 它缺的是"**覆盖前告诉你将失去什么**"。
 *
 * 用法:
 *   node scripts/check-sync-data-loss.cjs --local <本机库> --incoming <远端库>
 * 退出码:
 *   0 = 没有本机独有的数据（覆盖是安全的）
 *   1 = **有**本机独有的数据（覆盖会永久失去它们）→ 调用方应当中止
 *   2 = 用法/文件问题
 *
 * ⚠️ 纯只读：不写任何库、不产生中间文件。
 */
const fs = require('fs');
const path = require('path');

function loadSqlite() {
  for (const c of [path.join(__dirname, '..', 'packages', 'core', 'node_modules', 'better-sqlite3'), 'better-sqlite3']) {
    try { return require(c); } catch { /* 继续 */ }
  }
  console.error('找不到 better-sqlite3'); process.exit(2);
}

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const LOCAL = arg('--local');
const INCOMING = arg('--incoming');
if (!LOCAL || !INCOMING) { console.error('用法: --local <本机库> --incoming <远端库>'); process.exit(2); }
for (const f of [LOCAL, INCOMING]) {
  if (!fs.existsSync(f)) { console.error(`找不到 ${f}`); process.exit(2); }
}

const Database = loadSqlite();
const ids = (db, sql) => new Set(db.prepare(sql).all().map(r => String(r.id)));
const jparse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

const L = new Database(LOCAL, { readonly: true });
const I = new Database(INCOMING, { readonly: true });

try {
  const lEv = ids(L, 'SELECT id FROM events');
  const iEv = ids(I, 'SELECT id FROM events');
  const lCv = ids(L, 'SELECT id FROM conversations');
  const iCv = ids(I, 'SELECT id FROM conversations');

  const evOnly = [...lEv].filter(id => !iEv.has(id));
  const cvOnly = [...lCv].filter(id => !iCv.has(id));

  // 这些是本机独有的 —— 覆盖后就没了
  // 按渠道归类（渠道列可能还不存在，退回按 session_id 前缀判）
  const cols = L.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  const chExpr = cols.includes('channel') ? 'channel' : "CASE WHEN session_id LIKE 'dsh:%' THEN 'dsh' WHEN session_id LIKE 'qq%' THEN 'qq' WHEN session_id LIKE 'webui:%' THEN 'webui' ELSE 'unknown' END";
  const byChannel = {};
  if (evOnly.length) {
    const ph = evOnly.map(() => '?').join(',');
    for (const r of L.prepare(`SELECT ${chExpr} AS ch, COUNT(*) n FROM events WHERE id IN (${ph}) GROUP BY ch`).all(...evOnly)) {
      byChannel[r.ch] = r.n;
    }
  }

  // 派生状态的变化（不阻止同步，但要让人看见）
  const prof = (db) => {
    const r = db.prepare('SELECT facts, character_facts FROM user_profile WHERE id = 1').get() || {};
    return { facts: jparse(r.facts).length, char: jparse(r.character_facts).length };
  };
  const lp = prof(L), ip = prof(I);

  console.log(`本机库:   ${LOCAL}`);
  console.log(`远端库:   ${INCOMING}`);
  console.log(`  事件    本机 ${lEv.size} / 远端 ${iEv.size}`);
  console.log(`  会话    本机 ${lCv.size} / 远端 ${iCv.size}`);
  console.log(`  facts   本机 ${lp.facts} / 远端 ${ip.facts}；character_facts 本机 ${lp.char} / 远端 ${ip.char}`);

  if (evOnly.length === 0 && cvOnly.length === 0) {
    console.log('\n✅ 本机没有独有的数据 —— 覆盖是安全的。');
    process.exit(0);
  }

  console.log(`\n⛔ **本机独有、一旦覆盖就永久消失**：`);
  console.log(`  事件 ${evOnly.length} 条   ${JSON.stringify(byChannel)}`);
  console.log(`  会话 ${cvOnly.length} 条`);
  console.log('  样例事件 id: ' + evOnly.slice(0, 3).join(', '));
  console.log('\n服务器数据更完整**不代表**本机独有的那部分不重要 ——');
  console.log('2026-10-15 那次就是这么丢掉 730 条 dsh 事件的（只活了下来备份里）。');
  console.log('继续的两种方式：');
  console.log('  · 先把本机独有的数据并进去（推荐）：scripts/ki20/merge.cjs');
  console.log('  · 确认可以丢：ALYSIA_SYNC_ALLOW_LOCAL_LOSS=1 再跑同步');
  process.exit(1);
} finally { L.close(); I.close(); }
