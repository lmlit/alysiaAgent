# Change Proposal: promise-obligation-loop

## 元信息

- **日期**: 2026-08-28
- **类型**: MODIFY（改现有行为）
- **状态**: proposed
- **影响 spec**: `ai-life-system`

## 动机（为什么做）

意图系统（8-28）的 promise 到期只"推一次或留 pending"——没有**延期/取消**路径。参考 HDSI 承诺回访：到期回合必须有可见结果（履行 / 延期说明 / 取消说明），无结果不静默完成。承诺要有"责任感"。

## 需求（做什么）

- [ ] promise 到期处理升级：LLM 裁决三选一——兑现（推送）/ 延期（说明原因 + 重排 trigger_at）/ 取消（推送说明作废）
- [ ] delayed-reply 保持现状（到期即回复，无延期语义）

## 设计决策（怎么做，含备选与取舍）

| 决策点 | 结论 | 备选（否决理由） |
|--------|------|------------------|
| 裁决方式 | 到期时调 generateIntentMessage 上下文带三选项，LLM 返回 {action, content?, delay_hours?} JSON | 固定规则（延期/取消需要 LLM 判断合理性） |
| 延期 | action=defer → 用返回的 delay_hours 重排 trigger_at（1-72h 钳制），status 保持 pending | 固定延 24h（不贴合承诺性质） |
| 取消 | action=cancel → 推送"之前说的那件事,我想了想还是算了"说明 + 标记 cancelled | 静默取消（无义务感，违背本 change 目的） |
| 兑现 | action=fulfill → 现有推送路径 + completed | — |

## 对账方向确认

- [x] spec 意图系统节扩展 promise 生命周期
- [x] 不涉及 Web API

## 测试计划

- 单元：裁决解析（fulfill/defer/cancel 三分支 + 钳制）
- 集成：tick 到期 promise → 三分支处理（mock generateIntentMessage）
- 回归：`npx vitest run` 全绿
