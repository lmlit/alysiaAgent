# Tasks: backfill-failed-session-summaries

> 依赖 `fix-session-summary-silent-failure` + `fix-session-event-window-truncation`（都已落地部署）。

## 侦察结论（2026-09-27，生产库实测）

- [x] **占位符 52 条**，`distinct ended_at` = 52 —— **不是重复**，每条都有独立窗口
      （`distinct started_at` 只有 2，因为 `started_at` 存的是会话首个事件时间，不是窗口起点）
- [x] 窗口划分：`[上一条会话的 ended_at, 本条 ended_at]`，**52 个窗口全部非空**
- [x] **79 条 message 事件缺向量** —— 首周（7-26~7-30）占 84%，最后一次 9-09
      ⇒ **不是活跃 bug**（最近 18 天零丢失），属早期管线未接好时的历史空洞
- [x] **40 条垃圾 conversation 向量**（文本是占位符）
- [x] 0 条孤儿向量（每条向量都能找到对应事件）

## 实现

- [x] `EventStore.getBySession` 增加 `until`（历史窗口**双边界**都要下推 SQL——
      只给 `since` 的话，长会话里近期事件会占满 LIMIT 把老窗口挤出去）
- [x] `SessionEndProcessor.getSessionEvents` / `retryFailedSummary` 透传 `until`
- [x] `scripts/backfill-memory.cjs`：**默认 dry-run**，必须 `--apply` 才写库；幂等
- [x] 单测：长会话取老窗口（只给 since 取不到、加 until 才取到）

## 执行

- [x] dry-run 报告（52 窗口 / 0 空窗 / 52 次 LLM / 79 次 embed / 40 条垃圾向量）
- [ ] 部署含 `until` 的镜像（**必须**，否则历史窗口会"从 since 摘到现在"重复计数）
- [ ] `--apply` 真跑
- [ ] 复核：`summary LIKE 'Session %summary'` 应为 0；垃圾向量应为 0；缺失向量应为 0
- [ ] 抽样人工检查重摘要质量（不能只看计数）

## Apply 任务

- [ ] 合并 spec（本 change 是否需要改 spec 待定——`until` 属 §2.1 查询语义的补充）
- [ ] 更新 `openspec/specs/index.md`
- [ ] 提交前敏感审查
