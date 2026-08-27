# Tasks: profile-facts-timestamps

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [ ] T1 PromptAssembler：facts 注入加相对时间标注（today/yesterday/N天前/M月d日），超 30 天显示日期；时间基准 = valid_from/updated_at 较新者
- [ ] T2 MemoryManager.getProfileSnapshot：facts 返回加 updatedAt/validFrom（增量，不破坏现有字段）
- [ ] T3 测试：时间格式化边界（今天/昨天/29天/31天）+ 注入含标注 + 快照新字段

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（最后变更列）
- [ ] 更新 `docs/Web-API-Design.md`（getProfileSnapshot 新字段）
- [ ] 运行测试验证
