# Tasks: chat-life-continuity

- [x] T1 MemoryManager.getLifeContinuityBlock():最近生活事件(30min 内)→ "你刚才在 {事件}({时间})"块;无则空
- [x] T2 llm-agent.ts:私聊 + 有块 → 注入 system prompt(自然接话引导)
- [x] T3 测试:块生成(有/无事件)/注入(私聊)/非私聊不注入

## Apply
- [x] 合并 spec + index + 测试 + 归档
