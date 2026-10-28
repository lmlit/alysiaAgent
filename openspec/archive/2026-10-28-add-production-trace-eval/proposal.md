# Change Proposal: add-production-trace-eval

## 元信息

- **日期**: 2026-10-28
- **类型**: TEST（回归/测评）
- **状态**: applied（纯测试，无需部署）
- **来源**: `fix-long-session-compaction` 复盘 —— 1985 条单测全绿，但线上仍出现
  “facts 被挤掉 / 每轮请求摘要 / in-flight 当成失败”的时序与容量问题

## 问题

单测验证的是逻辑分支，覆盖不到真实运行形态：

- 单 QQ 会话永远不结束（313 个窗口）；
- 上下文 ~10k tokens，摘要一次 20–30 秒；
- 用户几十秒到几分钟内继续说话；
- 100+ 条 facts、3 条最近摘要、若干召回记忆同时竞争 3,200 prompt 预算。

这些组合不会出现在现有单测里，所以修完不知道有没有效。

## 需求

- [ ] 新增 `tests/eval/production-trace.test.ts`：
  - 100 条 facts + 3 条最近对话 + 5 条召回 + 生活注入，一次 `assembleWithReport`；
  - 断言 facts 不被丢、事实块在、最近对话/相关记忆至少按目标出现；
  - 断言 facts 注入条数 = `FACTS_IN_PROMPT`。
- [ ] 同一文件模拟 60 秒一轮、持续 25 分钟：10 分钟冷却下只请求 3 次摘要。
- [ ] 断言 `skipped` 不 hold、`failed` 才 hold。
- [ ] 跑测试并根据真实结果调整断言/预算（**不是反过来改测试迁就现状**）。

## 明确不做

- 不做真实 LLM/真实计时的 e2e（会 flaky；由 `pnpm chat` 承担）。
- 不做质量 rubric（“像不像她”另开）。
