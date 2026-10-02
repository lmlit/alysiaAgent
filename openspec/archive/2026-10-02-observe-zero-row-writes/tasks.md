# Tasks: observe-zero-row-writes

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现（**只观测，不拦截**）

- [x] 新增 `packages/core/src/utils/write-trace.ts`：`traceZeroRows(tag, changes, context?)`
      —— `changes !== 0` 直接返回；为 0 时 `logger.warn` 一行 `[WriteTrace] …`
- [x] 从 `src/index.ts` 导出
- [x] 接上「0 行可疑」的写点（**共 22 处**）：
  - `LifeStore`：`updateState` / `markDelivered` / `deferIntent` / `markIntentStatus` / `deleteTemplate`
  - `WorldbookStore`：`recordTrigger` / `updateEntry` / `deleteEntry`
  - `EventStore`：`markProcessed` / `updateImportance` / `archiveBySession` / `deleteBySession`
  - `ConversationStore`：`updateSummaryResult` / `deleteBySession`
  - `KnowledgeStore`：`archive` / `deleteDoc.chunks` / `deleteDoc.docs`
  - `PersonaStore`：私有包装 `updateActive()` + 8 个 `WHERE is_active = 1` 写方法
- [x] **明确不接**：`INSERT OR IGNORE`（`ensureState` / `ensureRow`）、
      `INSERT OR REPLACE`（`addEvent` / `upsertDailySummary` / `addTemplate` / `saveIntent` /
      `EventStore.insert` / `insertChunk`）、纯 `INSERT`、以及**全部读方法**

## 测试

- [x] `tests/utils/write-trace.test.ts`：`changes > 0` **不打日志**（不能变噪声）；
      `changes === 0` 打一行且含 tag/context；不抛不返回（只观测）
- [x] `tests/memory/unit/write-trace-wiring.test.ts`（**store 级**）：
  4 个真实写点在目标行不存在时**既留痕、又照常返回不抛**；
  另 1 条反向保护——**真正改到行时绝不留痕**

## 文档与登记（用户要求「写 todo 里」）

- [x] `docs/KNOWN-ISSUES.md` KI-11：加上「观测已上线，等运行数据」+ 决策入口
- [x] 新建 backlog change **`tune-zero-row-checks`**（`status: pending`）：
      写明采集命令、按 tag 统计口径、三类定性判据（豁免 / 硬校验 / 暂不动）
- [x] `openspec/specs/index.md` 📌 Backlog 表新增该行

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`（§4.7 追加**契约 3**）
- [x] 更新 `openspec/specs/index.md`（memory-system 行）
- [x] 运行 core + server 全量测试
- [x] core 改动**必须 build**（server 走 dist）
- [x] `git diff` 自查**无夹带逻辑改动**（见下）
- [x] 更新 `docs/HANDOFF.md`
- [x] 归档 + 更新索引

## 验收结果（2026-10-02）

| 项 | 结果 |
|---|---|
| core 单测（不含 e2e） | ✅ **622 passed / 64 files**（+4 write-trace 单元 + +5 store 级接线） |
| server 单测 | ✅ **223 passed / 13 files**（无回归） |
| core / server `tsc --noEmit` | ✅ 均退出码 0 |
| `core` build | ✅ 退出码 0 |
| **无夹带逻辑改动** | ✅ `git diff` 复核：被删的行**全是原 `.run()` 调用**；新增的 `return` 仅 3 处，均为把 `.run(...).changes > 0` 拆成 `r.changes > 0`（语义逐字等价）；**无新增 `throw`、无新增分支、SQL 一字未改** |
| 观测点数量 | ✅ **22 处**（原计划 20 + 实施时发现的 `deleteTemplate` / `deleteEntry`） |

## ★ 刻意不做（记录在案）

- ❌ **不改任何判断逻辑**（不 throw / 不改返回值 / 不改控制流 / 不改 SQL）——
      **这是本 change 的核心约束**，且由 `write-trace-wiring.test.ts` 的
      「不抛 + 真正改到时不打日志」两条断言锁住
- ❌ **不接幂等插入**（会制造噪声，比不观测更糟）
- ❌ **不上指标系统** —— 项目还没有指标后端（`add-ops-health-report` 在 backlog），
      先用日志把分布拿到手，不提前造轮子
- ❌ **不做 KI-15**（`vectorStore` null 静默跳过）与 **KI-5 剩余 9 处裸 catch** —— 已在册，各自成立

## 下一步（等运行数据，不在此 change 内）

1. 跑一段时间 → `grep -o '\[WriteTrace\] [^ ]*' alysia-*.log | sort | uniq -c | sort -rn`
2. 按 tag 逐点定性 → 落地 `tune-zero-row-checks`（📌 Backlog）
3. **判定铁律**：没有分布，不许改判断逻辑
