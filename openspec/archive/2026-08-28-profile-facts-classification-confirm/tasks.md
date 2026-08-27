# Tasks: profile-facts-classification-confirm

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [ ] T1 types.ts：ProfileFact 加 `category`（'identity'|'preference'|'status'|'relationship'|'general'）
- [ ] T2 ProfileStore：migrateFact 兜底 'general'；过期时长映射表（identity 365d/preference 90d/status 14d/relationship 90d/general 60d）
- [ ] T3 写入路径：addFact/upsert 按 category 设 valid_until（默认 general 60d；显式传入 valid_until 优先）
- [ ] T4 ProfileExtractor：提取 prompt 加 category 判断要求
- [ ] T5 MemoryManager：listPendingConfirmFacts()（过期 ≤3 天 active）/ confirmProfileFact(id, stillValid)（确认续期/否认 superseded）/ 自动过期清理（>3 天 → expired）
- [ ] T6 PromptAssembler：【待确认的事实】块注入（≤2 条，格式 `- 事实 (M月d日记录的)`）
- [ ] T7 新工具 confirm_profile_fact（tools/ 注册；LLM 在用户明确回答后调用）
- [ ] T8 getProfileSnapshot：facts 加 category（Web 展示）
- [ ] T9 测试：时长映射 / 待确认窗口 / confirm 续期与否认 / 自动过期 / 注入块 ≤2 条

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（最后变更列）
- [ ] 更新 `docs/Web-API-Design.md`（getProfileSnapshot.category + 新方法）
- [ ] 运行测试验证
