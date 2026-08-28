# Change Proposal: remove-thinking-indicator

## 元信息
- **日期**: 2026-08-28
- **类型**: MODIFY（删功能）
- **状态**: proposed
- **影响 spec**: `ai-life-system`（附注；主属 qq 适配器行为）

## 动机
模型回复延迟 5 秒时发送的"思考中"提示（THINKING_BY_CATEGORY 场景话术池）是硬编码轻交互，用户确认目前不需要——删除。

## 改动
- [ ] qq-official.ts：删 thinkingTimer/thinkingSent/sendQuickReply/THINKING_BY_CATEGORY/pickThinking
- [ ] coalescer.ts / pipeline/types.ts：删 cancel_thinking 引用
