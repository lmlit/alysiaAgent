# Change Proposal: profile-facts-timestamps

## 元信息

- **日期**: 2026-08-28
- **类型**: FIX（修 bug）
- **状态**: archived
- **影响 spec**: `memory-system`

## 动机（为什么做）

画像事实（ProfileFact）数据层**已有完整时间字段**（valid_from / updated_at / valid_until，32/32 条齐全），但**展示/使用层全部丢弃**：

1. **PromptAssembler 注入**：`- 用户在长沙 [你说过]`——无时间标注，AI 没有事实时效概念。"用户在长沙"是 3 个月前的还是今天的，对对话决策影响完全不同
2. **getProfileSnapshot（Web 画像页数据源）**：facts 只返回 fact/confidence/source/status 四字段，时间/证据被丢，Web 端无法展示

## 需求（做什么）

- [ ] PromptAssembler 注入 facts 加相对时间标注（"今天/昨天/N天前/M月d日"，取 valid_from 较新者；超 30 天显示日期），token 成本 ~3-6/条
- [ ] getProfileSnapshot 返回 facts 加 `updatedAt` / `validFrom`（Web 端画像页展示时间列）

## 设计决策（怎么做，含备选与取舍）

| 决策点 | 结论 | 备选（否决理由） |
|--------|------|------------------|
| 时间基准 | valid_from（事实成立时间）与 updated_at（更新时间）**取较新者** | 只用 valid_from（"用户正在玩绝区零"是 8-01 提取的，但 8-02 被替代更新——较新者更贴近"现在的认知"） |
| 注入格式 | 括号后缀 `(今天)` `(3天前)` `(8月2日)`，附在来源标注后 | 前缀时间（打乱事实可读性） |
| 超 30 天 | 显示日期 `M月d日`（保留可读性，不写年份——30 天内同年代感足够；跨年数据少见） | 写完整日期（token 浪费） |
| Web 快照 | 增量加字段，不破坏现有 4 字段 | 重构返回结构（破坏前端兼容） |

## 对账方向确认

- [x] 与现有 spec 不冲突——ProfileFact 时间字段 spec 已声明，本 change 补展示层实现
- [x] 涉及 Web API：getProfileSnapshot 返回增量加 updatedAt/validFrom，对照 `docs/Web-API-Design.md` 更新契约

## 测试计划

- 单元：相对时间格式化（今天/昨天/N天前/日期/超 30 天）；注入文本含时间标注
- 单元：getProfileSnapshot 返回含 updatedAt/validFrom
- 回归：`npx vitest run` 全绿
