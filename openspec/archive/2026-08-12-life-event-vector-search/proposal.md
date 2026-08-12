# Change Proposal: life-event-vector-search

## 元信息

- **日期**: 2026-08-12
- **类型**: FEATURE（ai-life 二期②：事件向量检索）
- **状态**: pending
- **影响 spec**: ai-life-system（§10 事件流注入 / 二期②）

## 动机（为什么做）

life 事件只进 SQLite（ai_life_events），对话检索（read()）捞不到——用户问
"你上午干嘛了"时 bot 只有今天 top3 注入，更早/未注入的细节无从想起。
与二期①（提示词瘦身：今天只注入 top3）配对——**瘦身掉的细节由向量检索兜底**。

## 需求（做什么）

1. **recordLifeEvent 时嵌入向量**（fire-and-forget）：`vectorStore.insert`
   source='life_event'，metadata 带 created_at/type（沿用 RealtimeProcessor
   模式，embed 失败不阻塞）
2. **read() 检索加一路 life 事件**（`searchByVector(vector, min(2, limit))`）——
   与 conversation/knowledge/event 并列，统一走 applyKnobsToRetrieved
   （created_at 已有 → 衰减生效）
3. 检索命中自动进 [相关记忆]（retrieved 统一注入，无额外改动）

## 设计决策

- 事件向量 insert 放 MemoryManager.recordLifeEvent（单点，所有来源统一）
- 存量事件不回补（增量生效；需要时可脚本补）

## 对账方向确认

- [x] 二期立项项② → 本 change 实现

## 测试计划

- recordLifeEvent → vectorStore.insert 被调（source='life_event'）
- read() 含 life 事件结果（mock vectorStore 按 source 返回）
- embed 失败 → 记录不阻塞
- 全量回归
