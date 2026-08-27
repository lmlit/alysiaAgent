# Change Proposal: profile-extractor-category-fix

## 元信息

- **日期**: 2026-08-28
- **类型**: FIX（修 bug）
- **状态**: archived
- **影响 spec**: `memory-system`

## 动机（为什么做）

8-28 画像分类功能（profile-facts-classification-confirm）上线后，**服务器实测新提取的事实 229 条全是 general 分类**——分类功能实际没生效。

根因（服务器真实 LLM 调用验证）：DeepSeek 返回的 category 是 `location`/`interest`/`hobby` 等自由发挥词，不是 prompt 里定义的枚举 `identity`/`preference`/`status`/`relationship`/`general`。提取器校验 `includes(f.category)` 失败 → 全部回落 `general`。prompt 约束不足 + 代码无容错，双缺陷。

## 需求（做什么）

- [ ] ProfileExtractor prompt 强化：category 枚举加中文语义映射 + 强约束"必须从这五个里选"
- [ ] 提取器容错映射：LLM 自由发挥词 → 标准枚举（location/城市→identity；interest/hobby/口味→preference；current/正在/近况→status；friend/关系→relationship；其他→general）
- [ ] 测试：LLM 返回 location/interest/hobby → 正确映射

## 设计决策（怎么做，含备选与取舍）

| 决策点 | 结论 | 备选（否决理由） |
|--------|------|------------------|
| prompt 强化 | category 枚举值后加中文说明 + "必须且只能从这五个值中选择" 强约束 | 只加枚举（实测 LLM 不遵循） |
| 容错映射 | 同义词表（location→identity 等），命中即映射 | 全部回落 general（功能形同虚设） |
| 存量数据 | 不重分类（存量 general 保持——需重新提取才重分类，成本不值） | 一次性重跑提取（229 条 × LLM，改动面大） |

## 对账方向确认

- [x] spec 已声明分类枚举，本 change 补提取器实现缺陷
- [x] 不涉及 Web API

## 测试计划

- 单元：LLM 返回 location/interest/hobby/current/friend → 映射 identity/preference/preference/status/relationship
- 回归：`npx vitest run` 全绿
