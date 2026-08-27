#!/usr/bin/env bash
# ★ 8-28 服务器 → 本地数据同步（server-data-sync-script）
# 服务器(121.41.111.120)的 alysia.db 是权威数据(线上 24h 积累),
# 本脚本将其同步到本地开发机:在线导出(不停机) → scp 回 → 备份旧库 → 替换 → 校验。
#
# 用法: bash scripts/sync-from-server.sh
# 前置: 本地 6185 服务已停止(脚本会检测并中止), 服务器 SSH 免密已配置
set -euo pipefail

SERVER="hexi@121.41.111.120"
SUDO_PASS="${SUDO_PASS:-pws7OssEIClgVK1W}"
CONTAINER="alysia-server"
LOCAL_DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== [1/6] 检查本地 6185 服务 ==="
if netstat -ano 2>/dev/null | grep -q ":6185.*LISTENING"; then
  echo "✗ 本地 6185 服务正在运行——替换 DB 会导致数据损坏。请先停止本地服务再同步。"
  exit 1
fi
echo "✓ 本地服务未运行"

echo "=== [2/6] 服务器在线导出 DB ==="
scp -q "$SCRIPT_DIR/export-db.cjs" "$SERVER:~/export-db.cjs"
ssh "$SERVER" "echo '$SUDO_PASS' | sudo -S docker cp ~/export-db.cjs $CONTAINER:/app/packages/core/export-db.cjs > /dev/null 2>&1 && \
  echo '$SUDO_PASS' | sudo -S docker exec $CONTAINER sh -c 'cd /app/packages/core && node export-db.cjs /tmp/alysia-sync.db' 2>&1 | tail -1"

echo "=== [3/6] 容器 → 宿主机 → scp 回本地 ==="
ssh "$SERVER" "echo '$SUDO_PASS' | sudo -S docker cp $CONTAINER:/tmp/alysia-sync.db /tmp/alysia-sync.db > /dev/null 2>&1 && echo '$SUDO_PASS' | sudo -S chown \$(id -u):\$(id -g) /tmp/alysia-sync.db && ls -lh /tmp/alysia-sync.db"
scp -q "$SERVER":/tmp/alysia-sync.db "$LOCAL_DATA_DIR/alysia-sync.db"
ls -lh "$LOCAL_DATA_DIR/alysia-sync.db"

echo "=== [4/6] 校验同步文件完整性 ==="
# 在 packages/core 下跑(better-sqlite3 依赖在 core/node_modules);DB 用 ../server/data 相对路径
# ★ Node 24 必需:better-sqlite3 原生模块按 Node 24 ABI(137)编译,系统 PATH 的 Node 20(115)加载失败
(cd "$SCRIPT_DIR/../../core" && PATH="/e/nodejs24:${PATH}" node --input-type=module -e "
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database('../server/data/alysia-sync.db', { readonly: true });
const ok = db.prepare('PRAGMA integrity_check').get().integrity_check;
console.log('  integrity_check:', ok);
console.log('  events:', db.prepare('SELECT COUNT(*) n FROM events').get().n);
console.log('  life_events:', db.prepare('SELECT COUNT(*) n FROM ai_life_events').get().n);
console.log('  facts:', JSON.parse(db.prepare('SELECT facts FROM user_profile WHERE id=1').get().facts).length);
db.close();
if (ok !== 'ok') process.exit(1);
")

echo "=== [5/6] 备份本地旧库 + 替换 ==="
if [ -f "$LOCAL_DATA_DIR/alysia.db" ]; then
  BAK="$LOCAL_DATA_DIR/alysia.db.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$LOCAL_DATA_DIR/alysia.db" "$BAK"
  echo "  旧库已备份: $(basename "$BAK") ($(du -h "$BAK" | cut -f1))"
  # 清理旧 wal/shm(替换主库后残留会污染)
  rm -f "$LOCAL_DATA_DIR/alysia.db-wal" "$LOCAL_DATA_DIR/alysia.db-shm"
fi
mv "$LOCAL_DATA_DIR/alysia-sync.db" "$LOCAL_DATA_DIR/alysia.db"
echo "✓ 已替换主库"

echo "=== [6/6] 清理服务器临时文件 ==="
ssh "$SERVER" "rm -f ~/export-db.cjs; echo '$SUDO_PASS' | sudo -S docker exec $CONTAINER rm -f /app/packages/core/export-db.cjs /tmp/alysia-sync.db 2>/dev/null; echo done"

echo ""
echo "✅ 同步完成。启动本地服务即可使用服务器数据:"
echo "  cd packages/server && PATH=\"/e/nodejs24:\$PATH\" npx tsx src/bootstrap.ts"
