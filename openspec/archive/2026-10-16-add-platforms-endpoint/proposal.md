# Change Proposal: add-platforms-endpoint

## 元信息

- **日期**: 2026-08-07（**2026-10-16 落地并归档**）
- **类型**: NEW（补契约缺口）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: 无独立 spec（属 `Web-API-Design.md` §3.4）；**该文档已同步**

## 动机（为什么做）

治理对账（2026-08-07）确认：`GET /api/platforms`（平台连接状态）在
Web-API-Design.md §3.4 有契约，但全仓库无路由、core 无 `getPlatformStatus` 方法——
**唯一文档了但完全没实现**的接口。Web 端需要它展示各平台连接状态。

## 需求（做什么）

- [ ] core 暴露 `getPlatformStatus()`：各平台（qq-official / onebot / telegram）连接状态
- [ ] WebUI 路由 `GET /api/platforms`
- [ ] 更新 Web-API-Design.md 状态标记 🟢

## 设计决策

### 决策 1（实现时定）：**只报 core 知道的，不编造连接层字段**

原 §3.4 写「各 adapter 的**连接状态**」，但实现时确认 **core 看不到连接层**：
它只知道 `registerPlatform(name)` 被调过；WebSocket 是否连着、上次心跳是什么时候
属于 adapter 运行时状态，**三个适配器都没有暴露**。

⇒ 返回 `{ platforms: [{ name, scheduler }], count }` ——
「**哪些平台 scope 已接到事件总线**」，并**刻意不产出** `connected` / `lastHeartbeat`。

**理由**：假字段比没有字段更糟 —— Web 端会把它当真，而它永远恒为真。
这与「存活指标骗过一次 22 天全绿」是同一类错误，本仓已经吃过一次。
**已接入 ≠ 连通**。

要真做「连接状态」，前置是**适配器先上报心跳**（独立的一块，不在本 change 内）。

其余细节（状态数据来源 / 只读快照）按 backlog 时的预留：**只读快照**。

## 对账方向确认

- [x] 契约已声明、impl 完全缺失 → 本 change 是补实现（不改契约）

## 测试计划

- 路由返回各平台状态字段
