# Change Proposal: proactive-memory-closure

## 元信息

- **日期**: 2026-08-09
- **类型**: MODIFY（主动消息记忆闭环）
- **状态**: in-progress（用户确认 A+B+C）
- **影响 spec**: proactive-messages（回写/上下文）+ ai-life-system（internal 回写）

## 动机（为什么做）

8-09 日志确认：主动消息记忆不闭环——
1. 问候（proactive）发送后**无 ingest**（12:30 午安不在 events）
2. 问候/Life 事件生成器的 prompt **无最近对话**（对话有 40 条注入，主动消息没有）
3. Life internal 事件只存 ai_life_events，不进 EventLog

## 需求（做什么）

### A. 问候回写（proactive.ts）
- [x] fireGreeting/tick 关怀推送成功后 ingest assistant（复用 Life writeback 模式：
      role=assistant, source=chat, importance=0.3, session_id=owner 私聊）

### B. 主动消息吃对话上下文
- [x] MemoryManager.getRecentDialogueBlock(sessionId, limit=40)：getRecentMessages +
      "你/昔涟" 短标签 + 时间标记 → 注入块文本（与 memory-retrieval 格式一致）
- [x] bootstrap generateText（问候）prompt 加最近对话块
- [x] bootstrap generateEvent（Life）prompt 加最近对话块（【轻月最近】之外补对话）

### C. Life internal 回写 EventLog（life.ts）
- [x] writeback 从"推送成功分支"移到"所有事件"——internal 也回写（bot 记得自己在做什么）

## 设计决策

- internal 回写后 [最近对话] 会出现"昔涟: 我在画画"——LLM 视角合理（知道 AI 在做什么）
- 深夜 internal 同样回写（AI 的生活记录完整）
- 对话块 token 成本 ~300（40 条）

## 对账方向确认

- [x] proactive-messages spec（回写/上下文）更新随 change；ai-life-system §10 回写节更新
