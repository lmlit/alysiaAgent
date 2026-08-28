# Change Proposal: ai-life-intent-system

## 元信息

- **日期**: 2026-08-28
- **类型**: NEW（新功能）
- **状态**: archived
- **影响 spec**: `ai-life-system`

## 动机（为什么做）

昔涟不能"想想再答复你"、不能自己承诺到期兑现、事件想推送但正在忙时只能丢弃——缺少"未来要做的事"。参考 HDSI intent 表设计，新建角色自己的隐式意图系统，与 `reminders`（用户显式提醒）并列共存。

## 需求（做什么）

- [ ] 新建 `ai_life_intents` 表（type: delayed-reply | promise | proactive-contact；status: pending | due | completed | cancelled）
- [ ] 事件生成时产生 intent：generateEvent LLM 返回值新增 `intent` 字段（can_contact=false 时不推送但存 intent，delay_hours 后重查）
- [ ] 对话中产生 intent：LLMAgentStage POST 阶段解析 `[intent:类型|内容|延迟小时数]` 标记（与 [表情包:xxx] 同模式，**不走工具调用**——延迟回复/承诺是角色隐式意愿，LLM 不会主动调工具），解析后从回复剥离（用户不可见）
- [ ] system prompt 加约束（LLMAgentStage）：想延迟回复或承诺时在回复末尾加标记，延迟 1-72h
- [ ] LifeService.tick 扫描到期 intent：proactive-contact → 查 Agency Window 推送；delayed-reply → 生成回复推送；promise → 推送兑现；失败保留 pending 下次再查
- [ ] MemoryManager：saveIntent / listDueIntents / completeIntent / cancelIntent

## 设计决策（怎么做，含备选与取舍）

| 决策点 | 结论 | 备选（否决理由） |
|--------|------|------------------|
| 意图来源 | 双通道：事件生成（life.ts intent 字段）+ 对话 POST 解析（llm-agent.ts [intent:] 标记） | 只做工具调用（LLM 不会主动调工具表达隐式意愿）；只做事件（对话中的"晚点告诉你"是主要场景） |
| 标记格式 | `[intent:type\|content\|hours]`，POST 剥离（用户不可见） | 工具调用（同上）；JSON 副产物（与表情包模式不一致） |
| 到期处理 | LifeService.tick 扫描（事件驱动调度已有 tick 节奏） | 独立定时器（多一套调度） |
| delayed-reply 回复生成 | 到期用 session_id 上下文 + LLM 生成自然回复 → sendProactive | 直接推原文（生硬无上下文） |
| 重复触发 | 处理成功 → completed；Agency 不通过 → 保留 pending 下次重查 | 处理即删（失败丢失） |

## 对账方向确认

- [x] 与现有 spec 不冲突——reminders(用户)与 ai_life_intents(角色)并列，spec 新增一节
- [x] 不涉及 Web API（MemoryManager 新增方法为内部服务，Web 契约可后补）

## 测试计划

- 单元：intent CRUD（save/listDue/complete/cancel）
- 单元：POST 解析（三种类型 + 剥离标记 + 非法格式忽略）
- 单元：事件生成 intent 落库（can_contact=false 时）
- 集成：tick 扫描到期（mock generateEvent）——三种类型处理 + completed 标记
- 回归：`npx vitest run` 全绿
