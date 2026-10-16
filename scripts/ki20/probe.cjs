/**
 * 探测：给定 db，报告 events 总量、含 runtime-context 字样的事件数（**任意位置**，
 * 不假设在开头），以及几条样本的 content 头部。
 *
 * 用途：定位 KI-20 那 116 条到底在哪个库里、以及 content 的真实形状
 *（我第一次盘点在 `packages/server/data/alysia.db` 上得到 0 条，与记录不符 ⇒ 必须查清）。
 */
const path = require('path');

function loadSqlite() {
  for (const c of [
    path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ]) {
    try { return require(c); } catch { /* 继续 */ }
  }
  console.error('找不到 better-sqlite3'); process.exit(2);
}
const Database = loadSqlite();

const NEEDLE = 'Current runtime context';

for (const dbPath of process.argv.slice(2)) {
  console.log(`\n########## ${dbPath} ##########`);
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    console.log('  打不开:', err.message);
    continue;
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    const hasEvents = tables.includes('events');
    console.log('  表:', tables.join(', ') || '(空)');
    if (!hasEvents) { db.close(); continue; }

    const total = db.prepare('SELECT COUNT(*) n FROM events').get().n;
    const withContent = db.prepare(
      "SELECT COUNT(*) n FROM events WHERE json_extract(payload,'$.content') IS NOT NULL",
    ).get().n;
    const contains = db.prepare(
      "SELECT COUNT(*) n FROM events WHERE json_extract(payload,'$.content') LIKE '%' || ? || '%'",
    ).get(NEEDLE).n;
    const startsWith = db.prepare(
      "SELECT COUNT(*) n FROM events WHERE json_extract(payload,'$.content') LIKE ? || '%'",
    ).get(NEEDLE).n;
    const rawLike = db.prepare("SELECT COUNT(*) n FROM events WHERE payload LIKE '%' || ? || '%'").get(NEEDLE).n;

    console.log(`  events 总数=${total} 有 content=${withContent}`);
    console.log(`  ★ 含 "${NEEDLE}": contains=${contains} startsWith=${startsWith} payload原始LIKE=${rawLike}`);

    if (contains > 0) {
      const samples = db.prepare(
        `SELECT id, session_id, created_at, json_extract(payload,'$.role') AS role,
                substr(json_extract(payload,'$.content'),1,90) AS head
           FROM events WHERE json_extract(payload,'$.content') LIKE '%' || ? || '%'
          ORDER BY created_at LIMIT 4`,
      ).all(NEEDLE);
      for (const s of samples) {
        console.log(`    [${s.created_at}] ${s.session_id} role=${s.role}`);
        console.log(`      head: ${JSON.stringify(s.head)}`);
      }
      const bySess = db.prepare(
        `SELECT session_id, COUNT(*) n FROM events
          WHERE json_extract(payload,'$.content') LIKE '%' || ? || '%'
          GROUP BY session_id ORDER BY n DESC LIMIT 6`,
      ).all(NEEDLE);
      console.log('    按会话 top:', JSON.stringify(bySess));
    }

    // 顺带看看 dsh 会话有多少
    const dsh = db.prepare("SELECT COUNT(*) n FROM events WHERE session_id LIKE 'dsh:%'").get().n;
    console.log(`  dsh: 前缀事件数=${dsh}`);
  } catch (err) {
    console.log('  查询失败:', err.message);
  }
  db.close();
}
