
---

## ★ 8-28 运维工具：服务器数据同步（server-data-sync-script）

`packages/server/scripts/sync-from-server.sh`——手动脚本，把服务器（121.41.111.120，云端 appid
24h 在线，权威数据）的 alysia.db 全量同步到本地开发机：

1. 服务器容器内用 better-sqlite3 `backup()` **在线导出**（不停机，WAL 一致性安全）
2. scp 回本地 `packages/server/data/`
3. 本地旧库备份 `alysia.db.bak-<时间戳>`（可回滚）
4. 替换主库（清理残留 wal/shm）
5. 校验 `PRAGMA integrity_check` + 关键表计数
6. 本地 6185 服务在跑 → 中止（提示先停服务）

要点：Node 24 运行（better-sqlite3 ABI）；导出脚本需放入容器 `/app/packages/core/`（require 解析）；
触发方式为手动运行，不做定时。
