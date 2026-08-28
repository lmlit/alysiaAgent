# Tasks: life-event-message-split

- [x] T1 life.ts generateEvent 返回加 message;解析 JSON message 字段
- [x] T2 tick 推送:sendProactive(message ?? content);intent 用 message
- [x] T3 回写:message 回写 assistant(推送内容)
- [x] T4 bootstrap systemPrompt 加 message 说明
- [x] T5 post-check message 校验(第二人称/长度)
- [x] T6 测试:推送用 message/回落 content/intent 用 message/回写

## Apply
- [x] 合并 spec + index + 测试 + 归档
