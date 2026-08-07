# Change Proposal: <change-name>

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: YYYY-MM-DD
- **类型**: NEW（新功能）/ MODIFY（改现有行为）/ FIX（修 bug）/ DOC（纯文档）
- **状态**: proposed → in_progress → applied → archived
- **影响 spec**: `<slug>`（涉及哪个主 spec）

## 动机（为什么做）

<问题或机会描述，背景事实>

## 需求（做什么）

- [ ] <需求点 1>
- [ ] <需求点 2>

## 设计决策（怎么做，含备选与取舍）

<关键决策 + 理由；被否决的方案简记一句为什么>

## 对账方向确认

- [ ] 是否与现有 spec 冲突？若 gap 方向是 doc 已声明 impl 没接 → **改 impl 不改 doc**
- [ ] 涉及 Web API？先对照 `docs/Web-API-Design.md`，新方法同步更新契约

## 测试计划

<如何验证>
