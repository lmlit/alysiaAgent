# Tasks: cr-p0-delete-cleanup

## 实现任务

- [ ] LanceDBStore 补 delete（按 sessionId / docId 过滤）
- [ ] MemoryManager.deleteSession 同步删向量
- [ ] MemoryManager.deleteKnowledgeDoc 同步删向量
- [ ] 5 处空 catch 补 logger.warn
- [ ] 测试：删除后不召回 + mock 失败日志可见

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（状态/最后变更）
- [ ] 运行测试验证
