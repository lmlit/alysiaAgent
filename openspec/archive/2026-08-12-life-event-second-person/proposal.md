# Change Proposal: life-event-second-person

## 元信息

- **日期**: 2026-08-12
- **类型**: FIX（chat 类型生活事件对用户用第三人称"她"）
- **状态**: pending
- **影响 spec**: ai-life-system（事件生成视角契约）

## 动机（为什么做）

用户反馈 + 日志实锤（8-12）：

```
15:09 [chat] pushed: 像她昨晚说"用上了"时的语气
17:39 [chat] pushed: 等她下班推门时，正好能翻到这一页
```

chat 类型事件会**直接推送给用户**，但内容对用户用第三人称"她"——bot 像在
背后议论用户。internal 类型（内心独白，不推送）用"她"合理。
根因：generateEvent systemPrompt 只约束了 bot 自己"第一人称"，未约束
**对用户的称呼**；上下文【轻月最近】是第三人称 facts、历史事件也是"她"
风格，LLM 模仿导致。

## 需求（做什么）

1. **generateEvent systemPrompt 加视角约束**：
   - chat 类型（准备分享给轻月）→ 提到轻月用 **"你"（第二人称直接说话）**，
     禁止"她/他"
   - internal 类型（内心独白，不推送）→ 保持第三人称叙述（"她"）自然
2. 不改上下文素材（facts 第三人称是事实陈述，LLM 负责转换视角）

## 设计决策

- 视角按推送语义区分：chat = 对用户说话（"你"），internal = 独白（"她"）——
  chat 与 internal 的读者不同
- 纯 prompt 约束（无逻辑改动），风险低

## 对账方向确认

- [x] impl 缺陷（prompt 缺称呼视角约束）→ 本 change 记录修复

## 测试计划

- life-service 生成链路：chat 类型 prompt 含"你"约束；internal 允许"她"
- 全量回归
