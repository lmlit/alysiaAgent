# Change Proposal: cr-p0-delete-cleanup

## 元信息

- **日期**: 2026-08-29
- **类型**: FIX（修 bug）
- **状态**: proposed
- **影响 spec**: `memory-system`

## 动机（为什么做）

CR 2026-08-29 P0-4：
1. WebUI"彻底删除"的会话/知识文档**不清理向量**——[相关记忆] 仍会召回已删内容（隐私 + 体验）；
2. LLM 摘要失败静默写垃圾摘要入库、embed 失败全空 catch 无任何日志——故障期间系统"看起来正常"地写坏数据，事后排查无从下手（违反项目"不静默吞错"约定）。

## 需求（做什么）

- [ ] `deleteSession` / `deleteKnowledgeDoc` 同步调用 vectorStore 删除对应向量
- [ ] 空 catch 补日志（5 处）：
  - `processors/SessionEndProcessor.ts:150-152`
  - `MemoryManager.ts:767-774` / `:511` / `:1073`
  - `processors/RealtimeProcessor.ts:93-95`
- [ ] 日志至少 `logger.warn(err + 上下文)`，不吞错

## 设计决策（怎么做，含备选与取舍）

- **删除路径统一收口**：deleteSession/deleteKnowledgeDoc 是删除入口，在 MemoryManager 层同步删向量（LanceDBStore 补 delete 方法，按 sessionId/文档 id 过滤）。
- 向量删除失败 → warn 但不阻断主流程（数据库删除已完成，向量残留可后续重建——日志可见即可）。
- 空 catch 统一补 `logger.warn('[<context>] ...failed:', err.message)`，与现有代码风格一致。

## 对账方向确认

- [x] memory-system spec 未声明"删除同步清向量" → 本 change 新增约束
- [x] 涉及 Web API？无新方法（deleteSession/deleteKnowledgeDoc 已存在），契约无变更

## 测试计划

- 删除会话/知识文档后：SQLite 行消失且向量检索不再召回
- 空 catch 路径触发（mock 失败）→ 日志可见 warn
