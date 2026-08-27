# Change Proposal: memory-character-perspective

## 元信息

- **日期**: 2026-08-28
- **类型**: MODIFY（改现有行为）
- **状态**: archived
- **影响 spec**: `memory-system`

## 动机（为什么做）

当前记忆系统是用户中心的——只记用户的事实、人格只根据用户反馈调整、摘要以用户视角为主。补上角色自己的那一半，让昔涟有独立人格的记忆基础。用户画像不丢，加角色事实。参考 HDS-Interlude NarrativeFact scope 设计（character | world | relationship | event | promise），本 change 是其简化落地。

## 需求（做什么）

- [ ] **角色事实**：`user_profile` 加 `character_facts`（JSON array，复用 ProfileFact 结构）——记录昔涟自己的事（最近在学什么/习惯变化/讨厌什么/对某事的看法）。来源：ProfileExtractor 同一 LLM 调用同时输出用户 facts + 角色 facts（生活事件回写也走提取器 → 生活累积自动进角色事实）。`getProfileSnapshot()` 增加 `characterFacts`
- [ ] **事件视角**：`events` 加 `perspective`（默认 'interaction'，生活事件标记 'self'）；`MemoryManager.ingest` 支持 perspective 透传（LifeService 回写带 'self'）；向量检索可按 perspective 过滤（read 可选参数）
- [ ] **旋钮语义转向角色性格**：retention_bias 文档/prompt 语义从"偏向正面(讨好)"改为"昔涟作为三千万世的人对什么记忆更深"——默认值 0.2 不变，只改描述（PersonaAdapter prompt + spec）
- [ ] **PersonaAdapter 情绪漂移**：生活事件累积 mood_value 驱动自然漂移——连续开心（mood_value≥15 且正方向累积）→ playfulness 微升；连续低落 → empathy 微升。仍走 5 道护栏（apply 路径）。LifeService 每次 mood_value 极性变化时触发
- [ ] **摘要角色视角**：SessionEndProcessor 的 LLM prompt 增加"总结昔涟在这段对话中的感受/变化"→ conversations 加 `character_perspective` 列（ALTER + try-catch）

## 设计决策（怎么做，含备选与取舍）

| 决策点 | 结论 | 备选（否决理由） |
|--------|------|------------------|
| 角色事实来源 | 提取器同一次 LLM 调用双输出（用户 facts + 角色 facts）；生活事件 ingest 走同一提取器 → 生活累积自动入角色事实 | 单独提取器调用（多一次 LLM 成本） |
| character_facts 结构 | 复用 ProfileFact（含分类/TTL/确认机制——8-28 刚建的） | 新类型（重复实现过期/确认逻辑） |
| 视角标记 | events.perspective 列，ingest 参数透传 | 用 payload 标记（检索过滤要解析 JSON，成本高） |
| 情绪漂移触发 | LifeService updateMoodValue 极性跨阈值时调 PersonaAdapter（走 apply 护栏） | Cron 批量（漂移滞后，情绪惯性效果弱） |
| 摘要角色视角 | conversations.character_perspective 列 + LLM JSON 字段 | 拼进 summary 文本（结构污染，Web 展示需解析） |
| retention_bias | 只改语义描述（PersonaAdapter prompt + spec 文档），默认值 0.2 不变 | 改默认值（行为突变，用户没要求） |

## 对账方向确认

- [x] 与现有 spec 不冲突——记忆系统 spec 未覆盖角色视角，本 change 扩展
- [x] 涉及 Web API：getProfileSnapshot 加 characterFacts；ingest 加 perspective（可选参数）；对照 `docs/Web-API-Design.md` 更新

## 测试计划

- 单元：character_facts 读写（复用 ProfileFact CRUD）；perspective 默认 interaction + ingest 透传
- 单元：情绪漂移（连续开心 → playfulness 上调且过护栏；连续低落 → empathy）
- 单元：摘要 prompt 含角色视角要求（mock LLM 返回 character_perspective → 入库）
- 回归：`npx vitest run` 全绿
