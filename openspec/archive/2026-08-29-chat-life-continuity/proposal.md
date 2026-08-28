# Change Proposal: chat-life-continuity

## 元信息
- **日期**: 2026-08-29
- **类型**: MODIFY
- **状态**: archived
- **影响 spec**: `ai-life-system`

## 动机
叙事模型最大残留差距:聊天和生活两条线——用户消息进来时,对话 prompt 不知道"她此刻刚离开什么生活"。HDSI:用户消息是进入主角生活的事件,先补写"到现在的生活"再接话。

## 需求
- [ ] MemoryManager.getLifeContinuityBlock():距上次生活事件 ≤N 分钟 → 返回"此刻的你"补写块(上次事件+时间)
- [ ] llm-agent.ts 组装 system prompt 时注入补写块:"你刚才在: {事件}({时间})——轻月找你说话,自然地从这段生活里走出来接话"(仅私聊;30min 内有事件才注入,避免久远干扰)

## 对账
- [x] 不涉及 Web API;spec 对话注入节更新
