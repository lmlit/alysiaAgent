# Change Proposal: add-platforms-endpoint

## 元信息

- **日期**: 2026-08-07
- **类型**: NEW（补契约缺口）
- **状态**: pending（backlog——治理对账登记，暂不实现）
- **影响 spec**: 无独立 spec（属 Web-API-Design.md §3.4）

## 动机（为什么做）

治理对账（2026-08-07）确认：`GET /api/platforms`（平台连接状态）在
Web-API-Design.md §3.4 有契约，但全仓库无路由、core 无 `getPlatformStatus` 方法——
**唯一文档了但完全没实现**的接口。Web 端需要它展示各平台连接状态。

## 需求（做什么）

- [ ] core 暴露 `getPlatformStatus()`：各平台（qq-official / onebot / telegram）连接状态
- [ ] WebUI 路由 `GET /api/platforms`
- [ ] 更新 Web-API-Design.md 状态标记 🟢

## 设计决策

未定（实施时决策：状态数据来源——adapter 心跳/连接时间；只读快照）。

## 对账方向确认

- [x] 契约已声明、impl 完全缺失 → 本 change 是补实现（不改契约）

## 测试计划

- 路由返回各平台状态字段
