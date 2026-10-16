/**
 * 判定某个库的"血脉"：里面都是哪些来源的会话、时间跨度、画像规模。
 *
 * 用途：KI-20 存量修复**必须先确认目标库** —— 我第一次盘点在
 * `packages/server/data/alysia.db` 上得到 0 条注入事件（连 dsh 事件都是 0），
 * 与 KI-20 记录的 116 条不符 ⇒ 要么目标不是它，要么它被换过。
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

for (const dbPath of process.argv.slice(2)) {
  console.log(`\n########## ${dbPath} ##########`);
  let db;
  try { db = new Database(dbPath, { readonly: true }); } catch (e) { console.log('  打不开:', e.message); continue; }
  try {
    const total = db.prepare('SELECT COUNT(*) n FROM events').get().n;
    const span = db.prepare('SELECT MIN(created_at) a, MAX(created_at) b FROM events').get();
    console.log(`  events=${total}  时间跨度 ${span.a} → ${span.b}`);

    // 按来源前缀分组（取 session_id 的第一个冒号段）
    const rows = db.prepare(
      `SELECT CASE
                WHEN session_id LIKE 'dsh:session-%'   THEN 'dsh:主会话(session-)'
                WHEN session_id LIKE 'dsh:%'           THEN 'dsh:子会话/其他'
                WHEN session_id LIKE 'webui:%'         THEN 'webui'
                WHEN session_id LIKE 'qq-official%'    THEN 'qq'
                WHEN session_id LIKE 'telegram%'       THEN 'telegram'
                ELSE '其他'
              END AS kind, COUNT(*) n
         FROM events GROUP BY kind ORDER BY n DESC`,
    ).all();
    for (const r of rows) console.log(`    ${r.kind}: ${r.n}`);

    const hinted = db.prepare(
      "SELECT COUNT(*) n FROM events WHERE json_extract(payload,'$.content') LIKE 'Current runtime context%'",
    ).get().n;
    const prof = db.prepare('SELECT facts, character_facts, basics FROM user_profile WHERE id = 1').get();
    const facts = JSON.parse(prof?.facts || '[]');
    const cfs = JSON.parse(prof?.character_facts || '[]');
    const per = db.prepare('SELECT adaptation_hints FROM persona WHERE id = 1').get();
    const hints = JSON.parse(per?.adaptation_hints || '[]');
    console.log(`  注入事件=${hinted}  facts=${facts.length} (active=${facts.filter(f => f.status !== 'superseded').length})` +
      `  character_facts=${cfs.length}  hints=${hints.length}`);
    console.log(`  basics 长度=${String(prof?.basics || '').length}`);
    const convN = db.prepare('SELECT COUNT(*) n FROM conversations').get().n;
    const convPol = db.prepare(
      "SELECT COUNT(*) n FROM conversations WHERE summary LIKE '%Current runtime context%'",
    ).get().n;
    console.log(`  conversations=${convN} 其中摘要含注入=${convPol}`);
  } catch (e) { console.log('  查询失败:', e.message); }
  db.close();
}
