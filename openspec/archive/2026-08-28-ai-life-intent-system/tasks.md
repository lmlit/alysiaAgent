# Tasks: ai-life-intent-system

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [ ] T1 database.ts：新建 `ai_life_intents` 表 + 索引（CREATE TABLE IF NOT EXISTS）
- [ ] T2 LifeStore：intent CRUD（save/listDue/complete/cancel）
- [ ] T3 MemoryManager：saveIntent / listDueIntents / completeIntent / cancelIntent 包装
- [ ] T4 life.ts 事件生成：LLM 返回值解析 `intent` 字段（type/delay_hours/content），can_contact=false 时存 intent
- [ ] T5 bootstrap.ts：generateEvent system prompt 加 intent 字段说明
- [ ] T6 llm-agent.ts：POST 阶段解析 `[intent:type|content|hours]`（正则 + 剥离 + 存表）；system prompt 加标记约束
- [ ] T7 life.ts tick：扫描到期 intent（proactive-contact → Agency 检查推送；delayed-reply → LLM 生成回复推送；promise → 推送兑现）；成功 completed / 失败保留
- [ ] T8 测试：CRUD 4 例 + POST 解析 4 例 + 事件 intent 2 例 + tick 处理 3 例

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`（★ 从主 spec 拷贝后追加，勿只写新增）
- [ ] 更新 `openspec/specs/index.md`
- [ ] 运行测试验证
