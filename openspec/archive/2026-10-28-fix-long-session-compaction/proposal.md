# Change Proposal: fix-long-session-compaction

## 元信息

- **日期**: 2026-10-28
- **类型**: FIX（记忆/上下文调度）
- **状态**: applied（2026-10-28 部署，回滚点 `rollback-20261028-010920`）
- **来源**: 2026-10-27 生产日志复盘

## 问题

单 session（QQ 私聊）是常态，现有实现本来用「事件流水 + `summaryAnchor` 窗口 + 分层召回」
处理长会话，不依赖 session 结束。但线上日志显示三个运行假设与实际场景不一致：

1. **触发太密**：`usage.input > 8000` 后**每一轮**都触发 `onSessionEnd`；摘要需 20–30s，
   下一轮触发时被 per-session mutex 判为 `in-flight` 跳过。近 7 天同一 session 产生 313 个窗口。
2. **跳过被当成失败**：`skipped(in-flight)` 也 `markCompactionFailed` → `truncation-policy`
   暂停截断。上下文继续涨，下一轮再触发、再跳过，形成“摘要永远在飞、截断永远暂停”。
3. **facts 被预算挤掉**：`facts` 是 optional，3200 prompt 预算下近 7 天被整块丢弃 **89 次**
   （memories 48 次）。记忆在库里，但这一轮没进 prompt。

## 需求

- [x] 压缩请求加 per-session 冷却（默认 10 分钟）：超阈值不再每轮触发，只按节奏请求。
- [x] `skipped`（in-flight / no-events / no-dialogue）**不再标记压缩失败**，不暂停截断；
      只有 `summary === 'failed'` 或抛错才 hold。
- [x] `facts` 改为 `required`，并限量（置信度前 **20** 条）；超预算时先丢 optional 块，
      不丢“关于你的事实”。（初版 40 条，18h 复盘发现会挤掉 recent/life/memories，已下调。）
- [x] 单测覆盖：冷却判定、facts 策略/限量、skipped 不 mark。
- [x] 本地 `pnpm chat` 真聊验证；部署生产并记录回滚点。

## 明确不做

- 不改召回链路/embedding 缓存（14s 召回另开 change）。
- 不改 `summaryAnchor` 的窗口语义（窗口化本身正确）。
- 不做 313 个历史窗口的合并/重写（只影响后续调度）。
