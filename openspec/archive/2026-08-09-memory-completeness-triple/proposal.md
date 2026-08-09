# Change Proposal: memory-completeness-triple

## 元信息

- **日期**: 2026-08-09
- **类型**: MODIFY（记忆完整性三件套）
- **状态**: in-progress（用户确认 A+B+C）
- **影响 spec**: memory-system（EventLog 写入/摘要/检索）

## 动机（为什么做）

8-09 排查确认记忆 24h 黑洞：
1. **对话回复不入 EventLog**——bot 下一轮看不到自己说过什么（[最近对话] 只有"你:"行）
2. **短对话永不归档**——归档仅当单轮输入 >8000 tokens 触发；超 24h 未归档对话
   无摘要承接，细节彻底不可见
3. **事件向量是死数据**——RealtimeProcessor 每轮写 LanceDB 但 read() 从不查事件

用户确认三件套修复。

## 需求（做什么）

### A. Bot 输出回写（llm-agent POST 段）
- [x] assistant 最终回复 ingest 进 EventLog（role=assistant, source=chat, importance=0.3，
      复用 Life writeback 模式）——下一轮 [最近对话] 出现 "昔涟: …"，输入输出成对

### B. 定期归档（cron 每 6h）
- [x] SessionEndProcessor.process(sessionId, since?)——只摘要 since 之后的消息（防重复）
- [x] 摘要输入含 assistant（带角色标记），prompt 改为"总结以下对话"
- [x] MemoryManager.archiveStaleSessions()：活跃 session（24h 内有消息）→ since =
      该 session 最新摘要 ended_at（ConversationStore.getLatestBySession 新方法）
- [x] bootstrap cron 挂载

### C. 事件向量检索
- [x] EventStore.searchByVector（LanceDB source='chat' 过滤）+ EventStore.getActiveSessions
- [x] MemoryManager.read() 纳入事件向量（topK 3）

## 设计决策

- 回写 content 含表情包标记原文（显示层无碍，与 Life 回写一致）
- 事件向量 source 用 event.source（'chat'），检索过滤 source='chat'（聊天空间，code 模式
  事件不混入聊天检索）
- 摘要 since 用 ended_at（conversations 表已有字段，无需新表）

## 对账方向确认

- [x] memory-system spec（EventLog 契约/摘要策略）更新随 change
