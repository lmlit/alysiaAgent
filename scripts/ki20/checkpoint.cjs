// 把 WAL 合并回主库，使 .db 单文件自包含（搬运前必须做，否则 WAL 里的改动会丢）
const path = require('path');
function loadSqlite() {
  for (const c of [path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', 'better-sqlite3'), 'better-sqlite3']) {
    try { return require(c); } catch {}
  }
  console.error('找不到 better-sqlite3'); process.exit(2);
}
const Database = loadSqlite();
const file = process.argv[2];
if (!file) { console.error('用法: checkpoint.cjs <db>'); process.exit(2); }
const db = new Database(file);
const r = db.pragma('wal_checkpoint(TRUNCATE)');
console.log('wal_checkpoint:', JSON.stringify(r));
const integrity = db.pragma('integrity_check')[0].integrity_check;
console.log('integrity_check:', integrity);
db.close();
process.exit(integrity === 'ok' ? 0 : 1);
