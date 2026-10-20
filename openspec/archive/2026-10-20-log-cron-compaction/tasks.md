# Tasks: log-cron-compaction

- [x] `compactOldEvents` 返回标记条数（以前 `void`，外部完全拿不到）
- [x] 统计最老事件天数
- [x] 有积压 → `logger.info`：条数 + 最老天数 + **"只清 getUnprocessed 积压，不影响摘要/画像"**
- [x] >500 条 → 额外 `logger.warn`（提示可能停机过）
- [x] 0 条 → `logger.debug`
- [x] 代码注释写清真实语义（含"我一度误判为放弃学习"的更正）
- [x] 测试 `cron-compaction-log.test.ts`（5 条，含"被标记事件仍能进摘要窗口"）
- [x] `memory-system` §4.1.6（`processed` 只写不读 + compaction 留痕契约）
- [x] `docs/KNOWN-ISSUES.md` **KI-27** 登记（二选一：赋语义 / 删一半）
- [x] 全量：**146 文件 / 1794 测试全绿**
- [x] 归档 + 索引 + TODO + HANDOFF

## 留给独立 change 的

KI-27 的处置：让各处理器**按位判断**是否处理过（那才是位掩码的意义），
或删掉位掩码与 `getUnprocessed`。**不许"留着不用"。**
