# Change Proposal: profile-facts-classification-confirm

## 元信息

- **日期**: 2026-08-28
- **类型**: MODIFY（改现有行为）
- **状态**: archived
- **影响 spec**: `memory-system`

## 动机（为什么做）

画像事实目前无分类、永不过期（valid_until=null）、过期也无确认闭环。用户要求：

1. **分类**：身份/偏好/状态/关系，不同类别不同过期时间
2. **过期确认**：事实过期后，昔涟在对话中**选择性**询问确认是否仍生效（确认 → 续期；否认 → 淘汰）

数据层已有 valid_until/expired 机制（getActiveFacts 已过滤过期），本 change 补分类维度 + 过期时长 + 确认闭环。

## 需求（做什么）

- [ ] ProfileFact 加 `category`：'identity' | 'preference' | 'status' | 'relationship' | 'general'（存量 migrateFact 兜底 'general'）
- [ ] 过期时长按分类：identity 365 天 / preference 90 天 / status 14 天 / relationship 90 天 / general 60 天——写入时按分类设 valid_until（存量 null 保持不过期，不强制）
- [ ] ProfileExtractor 提取时 LLM 判分类（prompt 加分类要求）
- [ ] 确认闭环：
  - `listPendingConfirmFacts()`：过期 ≤3 天（valid_until 在过去 3 天内且 status='active'）→ 待确认
  - PromptAssembler 注入【待确认的事实】块（≤2 条，带记录时间）——昔涟对话中自然问
  - 新工具 `confirm_profile_fact(fact_id, still_valid)`：确认 → 按分类重设 valid_until + updated_at；否认 → superseded
  - 超 3 天未确认 → 自动 status='expired'（不反复打扰）
- [ ] getProfileSnapshot facts 加 `category`（Web 展示分类/筛选）

## 设计决策（怎么做，含备选与取舍）

| 决策点 | 结论 | 备选（否决理由） |
|--------|------|------------------|
| 分类来源 | ProfileExtractor LLM 判类（提取时顺带，无额外调用） | 规则推断（"正在/最近"→status，误判多；LLM 语义理解更准） |
| 待确认窗口 | 过期 ≤3 天 才问；超 3 天自动 expired | 全部过期都问（旧事实反复打扰） |
| 确认入口 | 对话工具 confirm_profile_fact（LLM 判断用户回答后调用） | 推送确认消息（打扰）；规则解析（"还在吗"→LLM 语义映射更稳） |
| 确认动作 | 确认 → 按分类重设 valid_until（续期一个周期）；否认 → superseded | 确认只延长固定 30 天（不匹配分类语义） |
| 存量数据 | valid_until=null 保持（不强制标过期） | 按分类迁移补 valid_until（"用户在测试"类 8 月事实突然失效，误伤） |

## 对账方向确认

- [x] 与现有 spec 不冲突——ProfileFact 时间/状态机制已声明，本 change 补分类 + 确认闭环
- [x] 涉及 Web API：getProfileSnapshot facts 增量加 category；新方法 listPendingConfirmFacts/confirmProfileFact 对照 `docs/Web-API-Design.md` 更新

## 测试计划

- 单元：分类过期时长映射（4 类 + 默认）；写入按分类设 valid_until
- 单元：待确认窗口（过期 1 天 → 待确认；过期 5 天 → 自动 expired；未过期 → 不出现）
- 单元：confirmProfileFact 确认续期 / 否认 superseded
- 单元：PromptAssembler【待确认】块注入（≤2 条、含时间）
- 回归：`npx vitest run` 全绿
