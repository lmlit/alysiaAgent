# Tasks: life-template-self-classify

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [ ] T1 LifeStore.addTemplate：INSERT 带 category/group_name
- [ ] T2 MemoryManager.addLifeTemplate：input 加 category/groupName（默认映射 chat→分享、internal→独处），透传
- [ ] T3 self-evolve.ts `add_life_template` 工具：参数加 category/group_name + description 说明
- [ ] T4 测试：显式分类落库 / 默认映射 / 自加后 listLifeTemplates 分类正确（life-store.test.ts 或 life-methods.test.ts 追加）

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（最后变更列）
- [ ] 运行测试验证
