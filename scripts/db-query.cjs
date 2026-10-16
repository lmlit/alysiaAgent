/**
 * 通用**只读** SQL 查询（排查/对账用）。
 *
 * 用法：
 *   E:\nodejs24\node.exe scripts/db-query.cjs <dbPath> "SELECT ..."
 *
 * ★ 为什么要有它：排查时经常只需要跑一条 SELECT，而
 *   ① PowerShell 里内联 node -e 会被 `*`、引号、中文折腾；
 *   ② 临时脚本散在仓库里更难清理。
 *   ⇒ 一个通用入口，**只读**（`readonly: true`），不写任何库。
 *
 * ⚠️ `better-sqlite3` 是 Node 24 ABI ⇒ 必须用 `E:\nodejs24\node.exe`。
 */
const path = require('path');

function loadSqlite() {
  for (const c of [
    path.join(__dirname, '..', 'packages', 'core', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ]) { try { return require(c); } catch { /* 继续 */ } }
  console.error('找不到 better-sqlite3（需要 Node 24 跑）'); process.exit(2);
}

const [, , dbPath, sql] = process.argv;
if (!dbPath || !sql) {
  console.error('用法: node scripts/db-query.cjs <dbPath> "SELECT ..."');
  process.exit(2);
}

const Database = loadSqlite();
const db = new Database(dbPath, { readonly: true });
try {
  const stmt = db.prepare(sql);
  // get() 还是 all()？按语句形状猜：只读查询一律用 all()，单行也应该能看到
  const rows = stmt.all();
  console.log(rows.length === 1 ? JSON.stringify(rows[0], null, 1) : JSON.stringify(rows, null, 1));
  console.log(`\n(${rows.length} 行)`);
} catch (err) {
  console.error('查询失败:', err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
