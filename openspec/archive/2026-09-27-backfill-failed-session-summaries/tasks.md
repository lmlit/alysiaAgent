# Tasks: backfill-failed-session-summaries

> 依赖 `fix-session-summary-silent-failure` + `fix-session-event-window-truncation`（都已部署）。

## 侦察结论（2026-09-27，生产库实测）

- [x] **占位符 52 条**，`distinct ended_at` = 52 —— **不是重复**，每条都有独立窗口
      （`distinct started_at` 只有 2，因为 `started_at` 存的是会话首个事件时间，不是窗口起点）
- [x] 窗口 `[上一条会话的 ended_at, 本条 ended_at]`，**52 个窗口全部非空**
- [x] **79 条 message 事件缺向量** —— 首周（7-26~7-30）占 84%，最后一次 9-09
      ⇒ **不是活跃 bug**（最近 18 天零丢失），属早期管线未接好时的历史空洞
- [x] **40 条垃圾 conversation 向量**；0 条孤儿向量

## 实现

- [x] `EventStore.getBySession` 增加 `until`（历史窗口**双边界**都要下推 SQL）
- [x] `SessionEndProcessor.getSessionEvents` / `retryFailedSummary` 透传 `until`
- [x] `scripts/backfill-memory.cjs`：默认 dry-run，`--apply` 才写；幂等
- [x] 修回填脚本自身两个 bug（见下「踩坑」）

## 执行结果（生产库验证）

- [x] 52 条占位符摘要 → **全部重摘要成功**，内容是真实生成的
- [x] 40 条垃圾 conversation 向量 → **0**
- [x] 79 条缺失 chat 向量 → 剩 2 条（内容分别是空字符串/空格，无从 embed，正确跳过）
- [x] 向量库：chat 1470 / conversation 138 / life_event 402 = **2010**
- [x] `summary_status='failed'` = 0
- [x] 抽样人工检查重摘要质量（8-31 那几条内容准确，非占位符）

## ★ 踩坑（值得记住）

1. **脚本给 `ConversationStore` 传了 `null` vectorStore** → `updateSummaryResult` 内部
   `if (vector && this.vectorStore)` 直接跳过 → **52 条摘要全更新成功但 40 条垃圾向量一条没换**，
   而日志全绿。**又一次"成功日志掩盖了没做的事"。**
2. **`retryFailedSummary` 的 embed 失败是空 catch** → 上面那个问题完全无声。
   已改为 `logger.warn`（违反「不静默吞错」硬约束）。

## Apply

- [x] 合并 spec（§2.1 查询语义：签名加 `until` + 新增 until 说明）
- [x] 更新 `openspec/specs/index.md`
- [x] 提交前敏感审查
