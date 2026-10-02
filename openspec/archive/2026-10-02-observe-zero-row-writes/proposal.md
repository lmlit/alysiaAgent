# Change Proposal: observe-zero-row-writes

## 元信息

- **日期**: 2026-10-02
- **类型**: NEW（纯观测；**不改任何判断逻辑**）
- **状态**: archived（2026-10-02 实现 + 验证完成；apply 已合并回 `memory-system` §4.7 契约 3）
- **影响 spec**: `memory-system`（§4.7 追加"写入影响行数观测"一条）

## 动机（为什么做）

`docs/KNOWN-ISSUES.md` **KI-11**：全 core **55 个写入点里只有 3 处**检查了
`.run()` 返回的 `changes`（还都在 `LifeStore`）。`UPDATE … WHERE id = ?` 命中 0 行
**不报错**——「改到了」和「什么都没改」完全同形。

这是本项目栽过三次的「**空转伪装成归档**」的**产地**。已知受害点包括
`LifeStore.markDelivered`（"已推送"这一位不可信，反向会导致**重复推送**）、
`WorldbookStore.recordTrigger`（命中计数空转 → 采样权重失真）、
`PersonaStore` 的 8 个 `WHERE is_active = 1` 写方法（没有激活行时
「读到正常人格 + 写入 0 行 + 不报错」三件事同时成立并报成功）。

### ★ 为什么**不**直接改成硬校验

`changes === 0` 有**两种含义**，且**静态分不出来**：

| 含义 | 例子 | 该不该报错 |
|---|---|---|
| **正常**：幂等跳过 | `INSERT OR IGNORE` 遇到已存在的行 | ❌ 不该（会变成每次启动的噪声） |
| **异常**：目标行不存在 | 写错 id / 行被并发删除 / **表结构不对（列没迁上）** | ✅ 该 |

一刀切硬校验会把正常路径变成噪声，**比现在更糟**。
所以本轮**只观测、不拦截**：先收集分布，跑一段时间后按 tag 统计发生率，**再逐点决策**。

> 这与 KI-1 的处理方式同构：**先取证据，再改代码**（HANDOFF 约定 6）。

## 需求（做什么）

- [ ] R1 新增 `packages/core/src/utils/write-trace.ts`：`traceZeroRows(tag, changes, context?)`
      —— `changes !== 0` 直接返回；否则打一行 **warn**（含 tag 与上下文，便于事后按 tag 统计）
- [ ] R2 在**「0 行可疑」**的写点接上（**不是全部 55 个**——幂等 `INSERT OR IGNORE` 不接，
      它们为 0 是正常的）：
      - `LifeStore`：`markDelivered` / `updateState` / `markIntentStatus` / `deferIntent`
      - `WorldbookStore`：`recordTrigger` / `updateEntry`
      - `EventStore`：`markProcessed` / `updateImportance` / `archiveBySession` / `deleteBySession`
      - `ConversationStore`：`updateSummaryResult` / `deleteBySession`
      - `KnowledgeStore`：`archive` / `deleteDoc`
      - `PersonaStore`：`WHERE is_active = 1` 的 8 个写方法
- [ ] R3 日志 tag 统一为 `[WriteTrace]`，**便于事后一条 grep 统计分布**
- [ ] R4 登记的决策入口：`docs/KNOWN-ISSUES.md` KI-11 补一句「观测已上线，按 tag 统计后决策」
- [ ] R5 把「运行一段时间后检查再决策」写进 📌 Backlog（`tune-zero-row-checks`）

## 设计决策（怎么做，含备选与取舍）

1. **只加观测，不动一行判断。** 不 `throw`、不 `return false`、不改调用方的控制流。
   —— 这是本 change 的核心约束，review 时先看有没有夹带逻辑改动。
2. **不做"全 55 个写点"覆盖。** 幂等插入（`INSERT OR IGNORE` / `INSERT OR REPLACE`）
   的 0 行是设计意图，接了只会制造噪声。**只接"0 行可疑"的那些**。
3. **用 `warn` 不是 `debug`。** `debug` 被 `ALYSIA_DEBUG` 门控，产线不输出——
   `LifeStore` 唯一那行日志就是这么变成"等于没有"的（KI-14 的教训）。
4. **tag 走 grep 而不是上指标系统。** 项目还没有指标后端（`add-ops-health-report`
   仍在 backlog）；先用日志把分布拿到手，**不提前造轮子**。

## 对账方向确认

- [x] 是否与现有 spec 冲突？**不冲突**——§4.7 刚立"存储写入留痕契约"，本条是它的延续。
- [x] 涉及 Web API？**不涉及**。
- [x] 是否顺手改 KI-15（`vectorStore` null 静默跳过）/ KI-5 剩余 9 处裸 catch？
      **本 change 不做**（已在 KI 登记）——保持"一次只推一件事"，那两条各自成立。

## 测试计划

- 单测 `packages/core/tests/utils/write-trace.test.ts`：
  - `changes > 0` → **不打日志**（不能变成噪声）
  - `changes === 0` → 打一行 warn，含 tag 与 context
- 单测：挑 2 个接好的写点（`LifeStore.markDelivered` / `WorldbookStore.recordTrigger`）
  验证"目标行不存在 → 出现 `[WriteTrace]` 日志且**函数仍正常返回**"（证明没夹带逻辑改动）
- 回归：core 全量（不含 e2e）+ server 全量。
