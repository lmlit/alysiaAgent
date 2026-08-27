# Tasks: memory-character-perspective

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [ ] T1 database.ts 迁移：`user_profile` 加 character_facts；`events` 加 perspective；`conversations` 加 character_perspective（全部 ALTER + try-catch）
- [ ] T2 ProfileStore：character_facts CRUD（getAllCharacterFacts/getActiveCharacterFacts/addCharacterFacts，复用 ProfileFact + migrateFact）
- [ ] T3 ProfileExtractor：prompt 同时输出用户 facts + character_facts（角色信息：昔涟的事/感受/变化）
- [ ] T4 EventStore + MemoryManager：ingest 支持 perspective 透传（默认 'interaction'）；read() 支持 perspective 过滤（可选）
- [ ] T5 LifeService 回写：writebackToMemory ingest 带 perspective='self'（生活事件 → 角色视角）
- [ ] T6 PersonaAdapter：adjustFromMood(moodValue)——连续正 → playfulness、连续负 → empathy，走 apply 5 道护栏；LifeService.updateMoodValue 极性跨阈值时触发（经 MemoryManager 暴露）
- [ ] T7 SessionEndProcessor：摘要 prompt 加角色视角要求（character_perspective JSON 字段）→ conversations 入库
- [ ] T8 retention_bias 语义：PersonaAdapter prompt 描述改为"角色性格"语义（默认值不变）
- [ ] T9 getProfileSnapshot 加 characterFacts
- [ ] T10 测试：character_facts CRUD / perspective 透传与过滤 / 情绪漂移护栏 / 摘要角色视角入库

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（最后变更列）
- [ ] 更新 `docs/Web-API-Design.md`（getProfileSnapshot.characterFacts + ingest.perspective）
- [ ] 运行测试验证
