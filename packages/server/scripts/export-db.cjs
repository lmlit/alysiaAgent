// 服务器端 DB 在线导出(由 sync-from-server.sh 通过 docker cp + exec 调用):
// 用 better-sqlite3 的 backup() API 在线备份——WAL 模式下直接 cp 主库文件可能不一致
const Database = require('better-sqlite3');

async function main() {
  const src = '/app/data/alysia.db';
  const dst = process.argv[2] || '/tmp/alysia-sync.db';
  const db = new Database(src, { readonly: true });
  try {
    await db.backup(dst);
    const { execSync } = require('child_process');
    const size = execSync(`stat -c %s ${dst}`).toString().trim();
    console.log(`EXPORT_OK ${dst} ${size} bytes`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('EXPORT_FAIL', err.message);
  process.exit(1);
});
