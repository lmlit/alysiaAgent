# Tasks: plan-synthetic-data-cleanup

- [x] 方案文档 `docs/PLAN-2026-10-20-clean-synthetic-facts.md`
      （清什么/不清什么、备份、复核 SQL、回滚、完成判据）
- [x] 只读审计脚本 `scripts/synthetic-data-audit.cjs`
      （`node:sqlite`、`readOnly`、`--json`、`--backup` 仅文件复制）
- [x] 自测：最小库 3 事件 / 2 facts → 计数与分类正确（见 proposal）
- [x] 全量测试：**143 文件 / 1771 全绿**（脚本不进测试套件，自测手动做）
- [x] 归档 + 索引 + TODO + HANDOFF

## 待人工（不在本 change 内）

1. 在服务器上跑 `scripts/synthetic-data-audit.cjs --db <alysia.db>`
2. `--backup <dir>` 做整库备份（含 `-wal`）
3. 用方案里的 SQL 导出待作废清单，**人工确认**每条 fact 确实是注入文本学出来的
4. 走 `confirmProfileFact(fact, false)` / `ProfileStore.confirmFact` 作废（不要直接 UPDATE）
5. 复查：`facts.fromSynthetic == 0`，且 `events.synthetic` **仍非 0**（事件不删是对的）
