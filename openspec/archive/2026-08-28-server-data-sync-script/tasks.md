# Tasks: server-data-sync-script

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] T1 `packages/server/scripts/sync-from-server.sh`：
  1. 服务器容器内 node 脚本用 better-sqlite3 `backup()` 在线导出 `/tmp/alysia-sync.db`
  2. scp 回本地 `packages/server/data/`
  3. 本地旧库备份 `alysia.db.bak-<时间戳>`（跳过损坏检查）
  4. 替换主库
  5. 校验：本地 `PRAGMA integrity_check` + 关键表计数对比
  6. 检测 6185 本地服务在跑 → 警告并中止替换（提示先停服务）

## 验证任务

- [x] T2 真实跑一次：服务器数据同步到本地，抽查（画像 facts/生活事件/life_event 世界书/digest 数量与服务器一致）
- [x] T3 本地服务重启后正常启动（迁移幂等）

## Apply 任务（实现完成后）

- [x] 更新 spec（memory-system 附注运维工具节）
- [ ] 更新 `openspec/specs/index.md`
- [ ] 运行测试验证
