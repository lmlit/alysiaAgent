# Tasks: life-event-micro-narrative

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [ ] T1 life.ts 事件生成 prompt：【你正在做的事】块强化"续写推进为主，自然收尾可开新"；9 条约束 ⑨ 改"有前因后果的小片段（2-4 句）"
- [ ] T2 bootstrap systemPrompt：约束 ⑨ 同步（"2-4 句，含前因后果/进展变化"）
- [ ] T3 life.ts post-check：长度 ≤80 → ≤150；重复检测逻辑适配微叙事（前 12 字 → 前 20 字）
- [ ] T4 测试：新长度阈值 / 延续引导注入 / 既有测试适配（长度断言）

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`
- [ ] 运行测试验证
